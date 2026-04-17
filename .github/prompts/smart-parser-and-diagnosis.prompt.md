---
agent: 'agent'
description: 'Root-cause the current run failure, extract parser prompt into editable markdown, and rewrite it to be sheet-aware and variable-agnostic'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query', 'mcp_context7', 'mcp_filesystem', 'mcp_playwright']
---

# Make Playbook Generation Actually Smart

This prompt does three things in one session because they're tangled:

1. **Diagnose** why run #5 failed even though find_sheet_row succeeded (the context bag shows row_number=2, but escalate_1 fired with reason "Could not find order in sheet")
2. **Extract** the parser's system prompt from TypeScript into `docs/PLAYBOOK_DESIGN_GUIDE.md` so it's editable without code changes
3. **Rewrite** the design guide to be sheet-aware and variable-agnostic - playbooks should adapt to what's in the actual sheet, not assume order_number exists

## Required reading

1. `.github/MCP_DOCTRINE.md` - MCP rules, non-negotiable
2. `.github/copilot-instructions.md`
3. `docs/PLAYBOOK_ENGINE.md`
4. `skills/ai-driven-step/SKILL.md`
5. `docs/TASK_LOG.md`

## Part 1: Diagnose run #5 failure

### Step 1.1: Get the full execution trace

```sql
SELECT step_id, step_type, status,
       jsonb_pretty(input) as input,
       jsonb_pretty(output) as output,
       created_at, completed_at
FROM playbook_step_executions
WHERE run_id = 5
ORDER BY created_at;
```

Report back the full trace. Pay special attention to:
- What did `approval_1` output say? (Did someone reject? Did it timeout? Did it pause normally?)
- What's the step_id of whatever ran between `approval_1` and `escalate_1`?
- The 76-second gap between approval_1 (11:38:33) and escalate_1 (11:39:49) - what happened in that window?

### Step 1.2: Check for concurrent runs on the thread

```sql
-- All runs on the same thread
SELECT id, status, current_step_id, created_at, updated_at
FROM playbook_runs
WHERE thread_id = (SELECT thread_id FROM playbook_runs WHERE id = 5)
ORDER BY created_at;
```

If there are multiple active runs, that's an architectural problem - a thread shouldn't have concurrent runs fighting each other.

### Step 1.3: Check for inbound messages during the run

```sql
SELECT id, direction, received_at, LEFT(body_plain, 100) as body_preview
FROM messages
WHERE thread_id = (SELECT thread_id FROM playbook_runs WHERE id = 5)
ORDER BY received_at;
```

If a new inbound message arrived while the run was paused at approval_1, it may have triggered inbox polling / categorisation which did something unexpected.

### Step 1.4: Inspect the approval endpoint behavior

```
filesystem: read api/routes/playbook-runs.ts (or wherever approve/reject live)
filesystem: read api/services/playbook/handlers/manual_approval.ts
```

Understand: when the manual approval pause is rejected, what step_id does it route to? When it's approved, where does it go? Is there a default/timeout behavior that triggers escalate?

### Step 1.5: Report the diagnosis

Write a clear analysis:
- What specifically caused escalate_1 to fire
- Whether it was user action (rejection), system action (timeout), or a bug (inbound message handling)
- What the actual behavior SHOULD have been

Do NOT proceed to Part 2 until this is understood. If the root cause is a bug, fix it before continuing.

## Part 2: Extract the parser prompt into markdown

The parser's system prompt is currently hardcoded in `api/services/playbook/parser.ts`. This means every tweak to "how playbooks should be designed" requires code changes and deploys. Move it out.

### Step 2.1: Read current parser

```
filesystem: read api/services/playbook/parser.ts (full)
```

Identify the system prompt template. Note the template variables (which values get interpolated in - workspace sheet columns, available step types, etc.).

### Step 2.2: Create the design guide

Create `docs/PLAYBOOK_DESIGN_GUIDE.md`. This file has TWO audiences:

1. The runtime parser AI (GPT-4o) - loaded into system prompt every generation
2. Humans (Fabien, future developers) - reviewing and editing how playbooks should be designed

Structure:

```markdown
# Playbook Design Guide

This document is the canonical reference for how playbooks should be structured.
It is loaded into the parser AI's system prompt at runtime. Edit this file to
change how the AI designs playbooks - no code changes required.

## What a playbook is

[Brief: purpose, how it runs, what outcomes it produces]

## Available step types

[Full reference for each: extract, find_sheet_row, update_sheet,
ask_customer, evaluate, branch, manual_approval, send_reply, complete, escalate]

[For each: when to use, config schema, examples of good vs bad usage]

## Workspace context (injected at runtime)

[Placeholder section. The parser injects the actual sheet columns and any
workspace-specific variables here before sending to the AI.]

## Design principles

[The core rules for building good playbooks]

## Examples

[Full worked examples: refund, tracking, order change, damaged item]

## Anti-patterns

[Common mistakes with concrete WRONG vs RIGHT examples]
```

### Step 2.3: Update parser.ts to load the guide

Instead of inlining the system prompt, read the file at runtime:

```ts
// api/services/playbook/parser.ts

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Per Deno docs (context7, fetched this session): for static files loaded
// at module init, we can use await at module level. For files that might
// change, load on each call.
const DESIGN_GUIDE_PATH = join(Deno.cwd(), "docs", "PLAYBOOK_DESIGN_GUIDE.md");

/**
 * Load the playbook design guide from disk. Cached in memory but reloadable
 * in development. In production, deploy triggers a restart which re-reads it.
 */
let cachedGuide: string | null = null;
let lastLoadedAt = 0;
const CACHE_MS = Deno.env.get("DENO_ENV") === "development" ? 0 : 60_000;

async function loadDesignGuide(): Promise<string> {
  const now = Date.now();
  if (cachedGuide && now - lastLoadedAt < CACHE_MS) {
    return cachedGuide;
  }
  const content = await Deno.readTextFile(DESIGN_GUIDE_PATH);
  cachedGuide = content;
  lastLoadedAt = now;
  return content;
}

export async function parsePlaybook(input: {
  description: string;
  workspaceId: number;
}): Promise<ParseResult> {
  const guide = await loadDesignGuide();

  // Inject workspace-specific context into the guide
  const workspaceContext = await buildWorkspaceContext(input.workspaceId);
  const systemPrompt = guide.replace(
    "## Workspace context (injected at runtime)",
    `## Workspace context\n\n${workspaceContext}`
  );

  const response = await chatCompletion({
    workspaceId: input.workspaceId,
    system: systemPrompt,
    user: input.description,
    responseFormat: "json_object",
    temperature: 0.3,
  });

  // ... rest of parsing logic
}

async function buildWorkspaceContext(workspaceId: number): Promise<string> {
  const columns = await query<SheetColumn>(
    `SELECT column_letter, header_name FROM sheet_columns
     WHERE workspace_id = $1 ORDER BY column_letter`,
    [workspaceId]
  );

  const columnList = columns
    .map(c => `- "${c.header_name}" (column ${c.column_letter})`)
    .join("\n");

  return `This workspace's Google Sheet has these columns:

${columnList}

The playbook you generate MUST only reference columns that exist in this list.
Match logic should only use context variables that can be extracted from
typical customer emails AND have a corresponding column in this sheet.`;
}
```

Document this in the code with comments explaining WHY we load from disk (editability without deploys).

### Step 2.4: Verify the extraction works

1. Fetch context7 docs for `Deno.readTextFile` and module-level await to confirm the approach
2. After implementing, run a parse request through the API and verify the AI receives the content from the markdown file (log the final system prompt temporarily to verify)
3. Change a word in the markdown file, restart the server, verify the change flows through

## Part 3: Rewrite the design guide to be smart

Now the actual quality work. The current parser prompt has baked-in assumptions (order_number, email, name) that don't fit every workspace. Rewrite so playbooks adapt to:

- What columns actually exist in the sheet
- What's actually askable from customers vs what should be inferred from email context
- The specific type of flow (refund logic differs from tracking logic)

### The new design guide contents

Write `docs/PLAYBOOK_DESIGN_GUIDE.md` with these principles:

**Principle 1: The sheet is the source of truth.**

Playbooks only reference columns that exist in the workspace's sheet. The runtime workspace context section lists them. Never generate steps that reference columns not in that list.

Extraction variables should map to sheet columns. If the sheet has a "Name" column but no "Email" column, extract customer_name but don't bother extracting customer_email - we can't match on it anyway.

**Principle 2: Match with whatever the customer actually provides.**

Customers rarely quote order numbers. They give their name, mention the product, describe the issue. The `find_sheet_row` step should match aggressively using ALL available signals, not require any specific one.

If the workspace sheet has columns for Name and Order/Item, match on those. If Email exists, use it as the strongest signal. Don't require any specific column.

**Principle 3: Don't invent variables that aren't useful.**

If `order_number` doesn't correspond to any sheet column and the customer rarely quotes it, don't extract it. Don't branch on it. Don't ask for it.

The extraction step should list only the variables that:
- Have a matching sheet column to find rows by, OR
- Are used later in the flow (referenced by update_sheet, send_reply, etc.)

**Principle 4: Happy path first, top to bottom.**

Step array order matches execution order for the happy path. Fallbacks (ask_customer) and terminals (complete, escalate) at the bottom.

**Principle 5: Fail gracefully to humans.**

Every playbook ends with either `complete` (success) or `escalate` (hand to human). Don't design playbooks that loop forever hoping the customer provides info. Ask once, then escalate.

**Principle 6: Messages are AI-drafted, not templates.**

`ask_customer` takes a `goal`, not a literal message. `send_reply` takes a `goal` + `reference_context`, not a literal message. The AI writes the actual text at runtime based on thread history and voice.

### The rewritten step type reference

For each step type, document:

- **Purpose**: one sentence
- **When to use**: concrete conditions
- **When NOT to use**: common mistakes
- **Config schema**: all fields with types and defaults
- **Example (correct usage)**: valid JSON
- **Reasoning**: why this shape, not some other shape

Specific improvements over the current prompt:

For `extract`:
- Variables should be chosen from: (a) matches a workspace sheet column, or (b) explicitly needed by a later step's config. Don't extract everything.
- Document common variable names so playbooks use consistent vocabulary

For `find_sheet_row`:
- List the actual available columns in the workspace context (injected at runtime)
- Match attempts should span all columns that might identify the customer, not just one
- The `match_strategy` defaults to "aggressive" - use it

For `evaluate`:
- Use when the decision is "do we have enough to proceed" with AI judgment
- The required_context should be the MINIMUM needed - usually just `row_number` for any sheet-aware playbook
- Routing: `if_satisfied_goto` (happy path), `if_missing_goto` (usually ask_customer, back of playbook), `if_escalate_goto` (escalate step)

For `ask_customer`:
- ALMOST ALWAYS placed below the happy path
- The `required_context` should be what we truly need, which (for sheet-aware playbooks) is usually just `row_number`
- `on_reply_goto` loops back to the extraction or find step, not to itself

For `manual_approval`:
- Always set `capture_input: true` when the human actually performs an external action
- The `reason` should say WHAT the human does: "Process the refund in Stripe and enter the transaction ID"
- Always include `reference_context` pointing to the variables the human needs to see (customer_name, product, amount, etc.)

For `send_reply`:
- Default to AI-drafted using `goal` + `reference_context`
- Only use literal `message` if the client specifically asked for a fixed reply

### The rewritten examples

Include 3-4 worked examples covering different shapes:

**Example 1: Refund on a sheet with Name, Order/Item, Status, Amount columns**
- Extract: customer_name, product_description, customer_email
- Find: match on Name, fuzzy on Order/Item using product_description
- Evaluate on row_number
- Update Status to "Refund Requested"
- Manual approval with capture_input: "Stripe transaction ID"
- Update Status to "Refunded" with notes
- Send_reply AI-drafted referencing amount and product

**Example 2: Tracking on a sheet with only Name, Order/Item, Tracking columns**
- Extract: customer_name only (no email column exists)
- Find: match on Name, fuzzy on Order/Item
- Evaluate on row_number
- If row found, update_sheet logs the query
- Send_reply AI-drafted with the Tracking value from the row

**Example 3: Order change on a sheet with extensive columns**
- More elaborate, showing branching between different kinds of changes

**Example 4: General enquiry on a sheet that doesn't need matching**
- No find_sheet_row at all, just manual_approval directly

### The anti-patterns section

Concrete wrong/right pairs:

```
WRONG: Extracting order_number when the sheet has no order number column
RIGHT: Extract only variables that map to sheet columns or later-used config

WRONG: Gating find_sheet_row on "do we have order_number"
RIGHT: Always run find_sheet_row with all available signals, let it do the matching

WRONG: ask_customer before find_sheet_row ("let me know your order number first")
RIGHT: Try to match with whatever came in the email first, only ask if find_sheet_row returned no row

WRONG: Literal messages in ask_customer and send_reply
RIGHT: goal + required_context (for ask) or goal + reference_context (for send)

WRONG: Step order: extract, branch, find, ask, evaluate, update, ...
RIGHT: Step order: extract, find, evaluate, update, approval, update, send, complete, ask (fallback), escalate
```

## Part 4: Regenerate the refund playbook to validate

After all three parts above are done:

1. Go to the playbook editor in the UI
2. Paste this description for the Refund playbook:

> When someone asks for a refund, find them in the sheet using whatever we know about them - their name, email if we have it, what they bought. Don't require an order number. Once we find the row, update the Status to "Refund Requested" and store their reason. Pause for me to process the refund in Stripe and enter the transaction details. After I approve, update Status to "Refunded" with my notes. Send them a casual NZ-friendly reply confirming the refund and mentioning the amount.

3. Click "Generate Steps"
4. Verify the output:
   - No `order_number` in extract variables (sheet has no order number column)
   - find_sheet_row uses match_attempts on Name and Order/Item columns
   - Step order is happy-path first
   - ask_customer is at the bottom as a fallback
   - evaluate checks `row_number`, nothing else
   - manual_approval has capture_input: true with reference_context including customer_name, product, amount

5. Save and activate as "Refund v3"
6. Send a test email and verify it runs cleanly in 7-9 step executions with no loop

## Done criteria

- [ ] Run #5 root cause diagnosed and documented in TASK_LOG
- [ ] If run #5 was a bug, bug fixed
- [ ] Parser system prompt extracted into `docs/PLAYBOOK_DESIGN_GUIDE.md`
- [ ] Parser.ts loads the guide at runtime with caching
- [ ] Workspace sheet columns injected into the guide before sending to GPT-4o
- [ ] Guide rewritten with 6 principles, full step reference, 4 examples, anti-patterns
- [ ] Refund v3 playbook regenerated with correct shape (no order_number, happy-path layout, all new step shapes)
- [ ] End-to-end test on fresh email passes cleanly
- [ ] TASK_LOG updated with full MCP trace, context7 citations, before/after playbook comparison
- [ ] Commit messages:
  - `fix(playbook): <run #5 root cause description>`
  - `refactor(parser): extract design guide to docs/PLAYBOOK_DESIGN_GUIDE.md`
  - `feat(playbook): sheet-aware design guide with adaptive variables`

## What NOT to do

- Don't add new step types
- Don't change step handler code
- Don't modify the engine executor
- Don't add a caching layer for the guide beyond the simple in-memory cache shown
- Don't version the guide (one file, one source of truth, git history is enough)
- Don't build a UI for editing the guide (markdown in repo is fine for now)
