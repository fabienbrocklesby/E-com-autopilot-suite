---
agent: 'agent'
description: 'Make find_sheet_row aggressive: exact match → fuzzy match → AI-powered fallback using full context'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query', 'mcp_context7', 'mcp_filesystem']
---

# Aggressive find_sheet_row

The current `find_sheet_row` tries each match attempt in order and returns the first hit. That works when customers quote order numbers. Real customers say "the radiator for my Ranger" and expect us to figure it out.

This prompt upgrades `find_sheet_row` to a 3-tier matcher: exact → fuzzy → AI fallback. The AI fallback is the unlock — it sees the full context and ALL candidate rows, and picks the right one.

## Required reading

1. `.github/MCP_DOCTRINE.md`
2. `.github/copilot-instructions.md`
3. `.github/instructions/backend.instructions.md`
4. `skills/ai-driven-step/SKILL.md` (the AI fallback follows this pattern)
5. `docs/PLAYBOOK_ENGINE.md`
6. `docs/TASK_LOG.md`

## Pre-build MCP work

### 1. filesystem — current implementation

```
filesystem: read api/services/playbook/handlers/find_sheet_row.ts (full)
filesystem: read api/services/sheets.ts (or wherever Sheets API calls live)
filesystem: read api/services/ai.ts (for chatCompletion signature)
filesystem: list api/services/playbook/handlers/ (all handlers, to match patterns)
```

Note exactly what the current handler does. What's the StepDecision return? What's the config shape?

### 2. postgres — workspace sheet structure

```sql
-- What columns does the workspace's sheet have?
SELECT * FROM sheet_columns WHERE workspace_id = 1;

-- Sample of actual row data the matcher will work against
-- (You may need to look at the Google Sheet directly via the API or 
-- check if there's a cache table in the dev DB)

-- Existing find_sheet_row config in active playbooks
SELECT id, name, jsonb_pretty(steps)
FROM playbooks 
WHERE steps::text LIKE '%find_sheet_row%' AND is_active = true;

-- Past find_sheet_row executions to see what worked and what didn't
SELECT step_id, status, jsonb_pretty(input), jsonb_pretty(output)
FROM playbook_step_executions
WHERE step_type = 'find_sheet_row'
ORDER BY created_at DESC
LIMIT 20;
```

You're looking for: which columns customers reference, what kinds of mismatches happened, were any matches WRONG (matched the wrong row)?

### 3. context7 — fetch docs

Critical. Fetch:
- **Google Sheets API** v4 `spreadsheets.values.get` and `spreadsheets.values.batchGet` for reading whole columns or ranges efficiently
- **OpenAI Chat Completions** for the AI fallback call, especially `response_format: json_object` and how to keep token usage low when sending many candidate rows
- **Levenshtein** or string similarity library options for Deno/TypeScript — if there's a standard library option, use it; if not, find a small well-maintained npm package

Specifically for fuzzy matching, options to check:
- `fuzzysort` (npm)
- `string-similarity` (npm)
- Hand-rolled Levenshtein (if dependencies are scarce)

Don't just pick the first one. Read the docs, look at maintainership, check it works in Deno.

## The new config schema

```ts
interface FindSheetRowConfig {
  // Match strategy:
  //   "exact_only" — only exact string matches
  //   "exact_then_fuzzy" — exact, then Levenshtein < threshold
  //   "aggressive" (default) — exact, fuzzy, then AI fallback
  match_strategy?: "exact_only" | "exact_then_fuzzy" | "aggressive";

  // Match attempts in priority order. Each attempt tries one column 
  // against one context variable.
  match_attempts: Array<{
    column: string;          // sheet column header (e.g. "Email", "Name")
    context_var: string;     // context bag key to read value from (e.g. "customer_email")
    fuzzy?: boolean;         // allow fuzzy matching for this attempt (default false)
    fuzzy_threshold?: number; // Levenshtein distance threshold (default 3)
  }>;

  // AI fallback config (only used in "aggressive" mode)
  ai_fallback?: {
    // Which context variables to provide to the AI for matching
    context_vars: string[];  // default: all keys in context bag
    // Which sheet columns to read for AI inspection (empty = all)
    inspect_columns?: string[];
    // Max rows to send to the AI (cost control)
    max_rows?: number;       // default 50
    // Min confidence to accept the AI's match (0-1)
    min_confidence?: number; // default 0.7
  };

  // Where to store the matched row number
  store_to: string;          // default "row_number"

  // What to do when nothing matches (sequential advance is default)
  // The downstream evaluate step typically handles this by routing to ask_customer
}
```

Backward compat: if existing playbooks don't specify `match_strategy`, default to `aggressive`. They'll get smarter automatically.

## The matcher implementation

Structure the handler in three clear phases. Each phase is a separate function for testability.

```ts
// api/services/playbook/handlers/find_sheet_row.ts

import type { StepHandler, StepContext } from "../types.ts";
import { chatCompletion } from "../../ai.ts";
import { readSheetColumn, readSheetRows } from "../../sheets.ts";
import { fuzzyMatch, exactMatch } from "./find_sheet_row_matchers.ts";

export const findSheetRowHandler: StepHandler = {
  type: "find_sheet_row",

  validate(config) {
    // ... validation per the schema above
    // Throw clear errors for missing required fields
    return config;
  },

  async execute(step, ctx) {
    const config = step.config;
    const strategy = config.match_strategy ?? "aggressive";
    const storeTo = config.store_to ?? "row_number";

    // Phase 1: exact matching
    const exactResult = await tryExactMatch(config, ctx);
    if (exactResult.matched) {
      return advanceWithMatch(exactResult, storeTo, "exact");
    }

    // Phase 2: fuzzy matching (if enabled)
    if (strategy === "exact_then_fuzzy" || strategy === "aggressive") {
      const fuzzyResult = await tryFuzzyMatch(config, ctx);
      if (fuzzyResult.matched) {
        return advanceWithMatch(fuzzyResult, storeTo, "fuzzy");
      }
    }

    // Phase 3: AI fallback (aggressive only)
    if (strategy === "aggressive") {
      const aiResult = await tryAiMatch(config, ctx);
      if (aiResult.matched) {
        return advanceWithMatch(aiResult, storeTo, "ai");
      }
    }

    // No match found. Advance sequentially with row_number = null.
    // The downstream evaluate step decides what to do.
    return {
      decision: { action: "advance" },
      contextUpdates: { [storeTo]: null },
      output: { 
        action: "no_match", 
        attempted_strategies: getAttemptedStrategies(strategy),
        attempted_columns: config.match_attempts.map(a => a.column),
      },
      aiCalls: aiResult?.aiCalls ?? [],
    };
  },
};

function advanceWithMatch(
  result: MatchResult, 
  storeTo: string, 
  strategy: string
) {
  return {
    decision: { action: "advance" as const },
    contextUpdates: { 
      [storeTo]: result.row_number,
      // Also store any additional row data the AI extracted
      ...(result.extracted_row_data ?? {}),
    },
    output: { 
      action: "matched",
      strategy,
      row_number: result.row_number,
      matched_column: result.matched_column,
      matched_value: result.matched_value,
      confidence: result.confidence,
      reasoning: result.reasoning,
    },
    aiCalls: result.aiCalls ?? [],
  };
}
```

### Phase 1: exact match

```ts
async function tryExactMatch(
  config: FindSheetRowConfig, 
  ctx: StepContext
): Promise<MatchResult> {
  for (const attempt of config.match_attempts) {
    const searchValue = ctx.context[attempt.context_var];
    if (searchValue == null || searchValue === "") continue;

    // Read the column from the sheet
    const columnValues = await readSheetColumn(
      ctx.workspaceId, 
      attempt.column
    );

    // Find the row index (1-indexed, accounting for header row)
    const rowIndex = columnValues.findIndex(
      v => normalizeForCompare(v) === normalizeForCompare(String(searchValue))
    );

    if (rowIndex >= 0) {
      return {
        matched: true,
        row_number: rowIndex + 2, // +1 for 0-index, +1 for header row
        matched_column: attempt.column,
        matched_value: String(searchValue),
        confidence: 1.0,
      };
    }
  }
  return { matched: false };
}

function normalizeForCompare(s: string): string {
  return s.toLowerCase().trim();
}
```

### Phase 2: fuzzy match

```ts
async function tryFuzzyMatch(
  config: FindSheetRowConfig, 
  ctx: StepContext
): Promise<MatchResult> {
  const fuzzyAttempts = config.match_attempts.filter(a => a.fuzzy);

  for (const attempt of fuzzyAttempts) {
    const searchValue = ctx.context[attempt.context_var];
    if (searchValue == null || searchValue === "") continue;

    const columnValues = await readSheetColumn(
      ctx.workspaceId, 
      attempt.column
    );

    const threshold = attempt.fuzzy_threshold ?? 3;
    const matches = columnValues
      .map((v, idx) => ({
        value: v,
        index: idx,
        distance: levenshtein(
          normalizeForCompare(v), 
          normalizeForCompare(String(searchValue))
        ),
      }))
      .filter(m => m.distance <= threshold)
      .sort((a, b) => a.distance - b.distance);

    if (matches.length > 0) {
      const best = matches[0];
      return {
        matched: true,
        row_number: best.index + 2,
        matched_column: attempt.column,
        matched_value: best.value,
        confidence: 1 - (best.distance / Math.max(best.value.length, 1)),
        reasoning: `Fuzzy match: distance ${best.distance}`,
      };
    }
  }

  return { matched: false };
}
```

Use the Levenshtein function from whatever library you chose, or implement it yourself if it's small (it's ~30 lines).

### Phase 3: AI fallback

This is where the magic happens. Read all rows (capped), give the AI everything we know, ask it to pick.

```ts
async function tryAiMatch(
  config: FindSheetRowConfig, 
  ctx: StepContext
): Promise<MatchResult> {
  const fallbackConfig = config.ai_fallback ?? {};
  const maxRows = fallbackConfig.max_rows ?? 50;
  const minConfidence = fallbackConfig.min_confidence ?? 0.7;

  // Decide which columns to read for inspection
  const columnsToRead = fallbackConfig.inspect_columns 
    ?? config.match_attempts.map(a => a.column);

  // Read all rows for those columns
  const rows = await readSheetRows(
    ctx.workspaceId, 
    columnsToRead, 
    maxRows
  );

  // Build the context payload for the AI
  const contextVars = fallbackConfig.context_vars 
    ?? Object.keys(ctx.context);
  const contextPayload: Record<string, unknown> = {};
  for (const key of contextVars) {
    if (ctx.context[key] != null) {
      contextPayload[key] = ctx.context[key];
    }
  }

  const system = `You match a customer to a row in a spreadsheet.

CONTEXT WE KNOW ABOUT THE CUSTOMER:
${JSON.stringify(contextPayload, null, 2)}

CANDIDATE ROWS (row_number is 1-indexed including header, so first data row is 2):
${rows.map((row, i) => 
  `Row ${i + 2}: ${JSON.stringify(row)}`
).join('\n')}

YOUR TASK:
Pick the row that best matches this customer. Match aggressively:
- Email exact match is strongest
- Name match (even partial, even with typos) is strong
- Product description fuzzy match is moderate (e.g. "radiator for my Ranger" matches "Radiator for Polaris Ranger RZR 570 900 1000 Crew XP")
- Combinations of weak signals can add up to a strong match

If multiple rows could match, pick the one with the most matching signals.
If no row matches confidently, return null.

Return JSON:
{
  "row_number": <integer 2+, or null>,
  "matched_column": "<which column gave the strongest signal, or null>",
  "matched_value": "<the actual cell value that matched, or null>",
  "confidence": <0-1>,
  "reasoning": "<one sentence on why this row, or why no match>"
}

Return JSON only.`;

  const startTime = Date.now();
  let response;
  try {
    response = await chatCompletion({
      workspaceId: ctx.workspaceId,
      system,
      user: "Match the customer to a row.",
      responseFormat: "json_object",
      temperature: 0.2, // low — we want consistent matching, not creativity
    });
  } catch (e) {
    return { 
      matched: false, 
      aiCalls: [{ 
        error: e instanceof Error ? e.message : String(e),
        duration_ms: Date.now() - startTime,
      }] 
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    return { 
      matched: false, 
      aiCalls: [recordCall(system, response, startTime)],
    };
  }

  if (
    parsed.row_number == null || 
    typeof parsed.row_number !== "number" ||
    parsed.confidence < minConfidence
  ) {
    return { 
      matched: false, 
      aiCalls: [recordCall(system, response, startTime)],
    };
  }

  return {
    matched: true,
    row_number: parsed.row_number,
    matched_column: parsed.matched_column ?? "ai_inferred",
    matched_value: parsed.matched_value ?? "",
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    aiCalls: [recordCall(system, response, startTime)],
  };
}
```

### Helpers

Put `levenshtein`, `normalizeForCompare`, `recordCall`, and the type definitions in a shared file:

```
api/services/playbook/handlers/find_sheet_row_helpers.ts
```

Keeps the main handler focused on orchestration, helpers focused on logic.

## Sheets service updates

You may need to add or improve `readSheetRows` in `api/services/sheets.ts`:

```ts
/**
 * Read multiple rows from a sheet, returning each row as an object 
 * keyed by the requested column headers.
 * 
 * Per Google Sheets API docs (context7, fetched this session): 
 * uses spreadsheets.values.batchGet for efficiency when reading 
 * multiple non-contiguous columns.
 */
export async function readSheetRows(
  workspaceId: number,
  columns: string[],
  maxRows: number = 50
): Promise<Array<Record<string, string>>> {
  // Implementation using current Sheets API patterns
  // Cite the docs section that informed batchGet vs single get choice
}
```

If `readSheetColumn` doesn't exist either, add it:

```ts
/**
 * Read all values from a single column. Returns values for data rows 
 * (skips header). 
 */
export async function readSheetColumn(
  workspaceId: number,
  columnHeader: string
): Promise<string[]> {
  // 1. Look up the column letter from sheet_columns table
  // 2. Read the column range A2:A1000 (or whatever)
  // 3. Return as flat array
}
```

## Verification

### 1. Type and lint checks

```bash
cd api && deno check services/playbook/handlers/find_sheet_row.ts
```

### 2. Postgres — set up test data

You need controlled test scenarios. Make sure the workspace's Google Sheet has known rows you can match against. Examples:

- Row 2: Name="Fabien Brocklesby", Email="fabien@example.com", Order/Item="Radiator for Polaris Ranger RZR 570 900 1000 Crew XP"
- Row 3: Name="Jane Smith", Email="jane@example.com", Order/Item="LED light bar 30 inch"
- Row 4: Name="John Doe", Email="john@example.com", Order/Item="Roof rack universal mount"

### 3. Test scenarios

Run these as actual playbook executions, or write a small test runner that calls the handler directly with mocked context.

**Scenario A: exact email match**
- Context: `{ customer_email: "fabien@example.com" }`
- Expected: row_number=2, strategy="exact", confidence=1.0, no AI calls

**Scenario B: exact name match** 
- Context: `{ customer_name: "Fabien Brocklesby" }`
- Expected: row_number=2, strategy="exact"

**Scenario C: fuzzy name match (typo)**
- Context: `{ customer_name: "Fabien Brockesby" }` (missing 'l')
- Expected: row_number=2, strategy="fuzzy", confidence~0.95

**Scenario D: AI fallback for partial product description**
- Context: `{ customer_name: "Fab", product_name: "radiator for my ranger" }`
- Expected: row_number=2, strategy="ai", confidence > 0.7
- Should make ONE AI call

**Scenario E: no match**
- Context: `{ customer_name: "Random Person", product_name: "lawnmower" }`
- Expected: row_number=null, strategy="none", `output.action == "no_match"`

**Scenario F: ambiguous match** (multiple rows could match)
- Add a row with similar product to row 2
- Context: `{ product_name: "radiator" }` (matches multiple)
- Expected: AI picks the one with strongest combined signals, returns reasoning

For each scenario, query the execution log:

```sql
SELECT step_type, jsonb_pretty(output)
FROM playbook_step_executions
WHERE run_id = <test_run> 
ORDER BY created_at DESC LIMIT 1;
```

Verify the `output` matches expectations.

### 4. AI cost check

For Scenario D (AI fallback used), check the `aiCalls` in the execution output. Note the token count. If a single match call uses > 2000 tokens, the prompt is too verbose — trim it.

### 5. Integration test with the refund playbook

Run the actual refund playbook against the original demo email: "I need a refund for the radiator I bought."

Expected:
- find_sheet_row tries exact match on email → fails (customer didn't quote email)
- Tries exact on name → succeeds (Fabien Brocklesby is in the email From header → extracted by extract_1)
- Strategy = "exact" or fuzzy depending on extraction
- row_number = 2

If the customer's email is in the From header AND extract pulls it into context, exact email match should win. If not, fuzzy or AI handles it.

### 6. Wrong-match prevention

Important safety check. Build a scenario where the AI MIGHT match the wrong row:

- Sheet has two rows with same first name but different last names
- Context: `{ customer_name: "Fabien" }` (no last name)
- Expected: AI returns confidence below threshold, no match. We DO NOT want a confidently-wrong match.

Verify the `min_confidence` threshold prevents this.

## Doc citations

In your TASK_LOG entry, cite:
- Google Sheets API docs section that informed `batchGet` choice
- Levenshtein library docs (or your hand-rolled implementation rationale)
- OpenAI API docs section on `response_format: json_object` reliability and `temperature` for matching tasks

## Done criteria

- [ ] `FindSheetRowConfig` schema implemented with backward compat for existing playbooks
- [ ] Three-phase matcher: exact → fuzzy → AI fallback
- [ ] Helpers split into `find_sheet_row_helpers.ts`
- [ ] `readSheetColumn` and `readSheetRows` in sheets service (added or improved)
- [ ] All 6 test scenarios pass
- [ ] AI fallback uses < 2000 tokens per call for typical workspaces
- [ ] Wrong-match prevention works (confidence threshold respected)
- [ ] Refund playbook runs successfully against demo email
- [ ] All TypeScript checks pass
- [ ] TASK_LOG updated with MCP usage trace and doc citations
- [ ] Commit message: `feat(playbook): aggressive find_sheet_row with exact/fuzzy/AI matching`

## What NOT to do

- Don't change the parser to require `match_strategy` (default makes it work for old playbooks)
- Don't add a new step type (this is improving the existing one)
- Don't over-engineer the fuzzy threshold tuning (default of 3 is fine)
- Don't cache sheet reads in this prompt (rate limiting comes in Phase 6)
- Don't change find_sheet_row's StepDecision return shape
