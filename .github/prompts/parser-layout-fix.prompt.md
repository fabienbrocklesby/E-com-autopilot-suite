---
agent: 'agent'
description: 'Improve the playbook parser to lay out steps in logical reading order so happy-path falls through correctly without relying on branches'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query', 'mcp_context7', 'mcp_filesystem']
---

# Parser Layout Improvement

The parser correctly generates `evaluate` steps and AI-driven `ask_customer` shapes (Phase 5 audit confirmed). But it lays out the step array in a way that requires `branch` steps to skip over fallback steps. When the bug in `ask_customer` skip semantics combined with this layout, runs looped 13 times.

The `ask_customer` skip bug is fixed separately. This prompt fixes the structural layout issue in the parser so the happy path reads naturally top-to-bottom and fallback steps live below the happy path.

## Required reading

1. `.github/MCP_DOCTRINE.md`
2. `.github/copilot-instructions.md`
3. `docs/PLAYBOOK_ENGINE.md`
4. `skills/ai-driven-step/SKILL.md`
5. `docs/TASK_LOG.md` - especially the diagnosis showing parser produced bad layout

## Pre-build MCP work

### 1. filesystem - current parser

```
filesystem: read api/services/playbook/parser.ts (full)
filesystem: list api/services/playbook/handlers/ (so you know all step types)
```

Pay attention to:
- The full system prompt
- The few-shot examples
- The validation logic
- The available step type list

### 2. postgres - current playbook layouts

```sql
-- See the actual step ordering of existing playbooks
SELECT id, name, version, jsonb_pretty(steps)
FROM playbooks
WHERE workspace_id = 1 AND is_active = true;
```

For each playbook, walk the step array:
- What's the happy path through the steps (start at index 0, follow advance/advance_to)?
- Are there any cases where the happy path falls through into a fallback step that's only meant to be reached by explicit advance_to?

This is the bug pattern. Document which playbooks have it and how.

### 3. context7 - fetch docs

Fetch:
- **OpenAI Chat Completions** docs for `response_format: json_object`, structured outputs, and best practices for getting reliable JSON
- **Few-shot prompting** patterns if there's good current guidance
- Any **JSON schema validation** library docs if you're going to add stronger validation (consider `zod` for Deno or built-in checking)

### 4. Test the current parser behaviour

Before changing anything, run the current parser against this exact input and record the output:

```
Plain language input:
"When someone asks for a refund, find them in the sheet using their email or name. If you can't find them, ask once for more info. Once you have the row, update Status to Refund Requested. Pause for me to process the refund in Stripe. After I approve, update Status to Refunded with my notes, then send a casual reply confirming the refund."
```

Save the output JSON. You'll compare it after the fix.

## The structural rule

**Happy path goes top to bottom. Fallback paths live below the happy path or at the end.**

A step's "natural next step" (sequential advance) should always be a happy-path next step. If a step is only reachable via explicit `advance_to`, it should not sit between happy-path steps.

### Bad layout (current Refund v2)

```
0: extract_1
1: branch_1     (jumps over ask_1 to find_1)
2: find_1       (sequential next is ask_1 ← WRONG)
3: ask_1        (only reached when branch_1 routes here)
4: evaluate_1   (intended to follow find_1 but unreachable via sequential advance)
5: update_1
6: approval_1
7: send_1
8: complete_1
9: escalate_1
```

Problem: `find_1`'s sequential advance lands on `ask_1`, but `ask_1` is a fallback. The happy path requires the engine to skip over `ask_1` somehow, and that's what created the routing bug.

### Good layout (target)

```
HAPPY PATH (top to bottom, sequential advance works):
0: extract_1        → sequential advance to find_1
1: find_1           → sequential advance to evaluate_1
2: evaluate_1       → satisfied: advance_to update_1, missing: advance_to ask_1, escalate: advance_to escalate_1
3: update_1         → sequential advance to approval_1
4: approval_1       → on_approve: advance_to update_2, on_reject: advance_to escalate_1
5: update_2         → sequential advance to send_1
6: send_1           → sequential advance to complete_1
7: complete_1       (terminal)

FALLBACK / TERMINAL (below happy path):
8: ask_1            → on_reply_goto: advance_to extract_1
9: escalate_1       (terminal)
```

Key changes:
- No `branch_1` - the routing is in `evaluate_1`
- `find_1` falls through naturally to `evaluate_1`
- `evaluate_1` routes explicitly: satisfied (forward), missing (back to ask_1), escalate (terminal)
- `ask_1` lives at the bottom as a clear fallback
- `escalate_1` and `complete_1` are terminal markers

## Parser changes

### Update the system prompt

In `api/services/playbook/parser.ts`, find the system prompt. Add a new section after the step type reference, BEFORE the examples:

```
STEP LAYOUT RULES (CRITICAL - get this wrong and runs will loop):

1. The step array is the visual order. Lay out the HAPPY PATH first, top to bottom.

2. Every step's natural sequential next step (the next item in the array) should
   be a step that comes next on the happy path. The engine advances sequentially
   when a step returns "advance" without specifying a destination. If a fallback
   step sits in the middle of the array, the happy path will accidentally fall
   into it.

3. After the happy path, place FALLBACK steps (steps only reachable via explicit
   advance_to from elsewhere in the playbook).

4. After fallbacks, place TERMINAL steps (complete, escalate).

5. Use `evaluate` to route between happy path and fallbacks. Do NOT use `branch`
   to skip over fallback steps in the array.

6. `ask_customer` is almost always a fallback (we ask only when needed). Place
   it below the happy path. Its `on_reply_goto` typically routes back to the
   step before the routing decision (usually `extract_X`).

WRONG LAYOUT EXAMPLE (will loop):
[
  {"id": "extract_1"},
  {"id": "branch_1", "if_true": "find_1", "if_false": "ask_1"},  // skips ask_1
  {"id": "find_1"},
  {"id": "ask_1"},  // happy path falls into this
  {"id": "evaluate_1"},  // never reached via sequential advance
  ...
]

RIGHT LAYOUT EXAMPLE:
[
  {"id": "extract_1"},
  {"id": "find_1"},
  {"id": "evaluate_1", "if_satisfied_goto": "update_1", "if_missing_goto": "ask_1", "if_escalate_goto": "escalate_1"},
  {"id": "update_1"},
  {"id": "approval_1", "on_approve": "update_2", "on_reject": "escalate_1"},
  {"id": "update_2"},
  {"id": "send_1"},
  {"id": "complete_1"},
  // Fallbacks below happy path:
  {"id": "ask_1", "on_reply_goto": "extract_1"},
  {"id": "escalate_1"}
]

When you generate steps, write the happy path first, end with terminal steps,
and put fallbacks just before the terminals.
```

### Update the examples in the prompt

Find the existing few-shot examples in the parser prompt. Replace at least one of them with a refund playbook that demonstrates the correct layout. Use the Right Layout Example above as the baseline.

Add a second example (tracking request) showing a simpler playbook that also follows the layout rule.

### Update validation

In the parser's validation logic, add a structural check:

```ts
// In parser.ts, after JSON parsing and before returning

function validateStepLayout(steps: PlaybookStep[]): string[] {
  const warnings: string[] = [];

  for (let i = 0; i < steps.length - 1; i++) {
    const current = steps[i];
    const next = steps[i + 1];

    // For steps that advance sequentially (no explicit nextStepId in
    // common cases), check that the next step is a sensible happy-path next.

    // If `current` is `find_sheet_row`, the next step should usually be
    // `evaluate` (to check if a row was found). If next is `ask_customer`,
    // that's the bad pattern.
    if (current.type === "find_sheet_row" && next.type === "ask_customer") {
      warnings.push(
        `Step '${current.id}' (${current.type}) is followed by '${next.id}' (${next.type}). ` +
        `find_sheet_row should usually be followed by evaluate, not ask_customer. ` +
        `ask_customer is a fallback and should live below the happy path.`
      );
    }

    // If `current` is `extract`, next shouldn't typically be a fallback
    if (current.type === "extract" && next.type === "ask_customer") {
      warnings.push(
        `Step '${current.id}' (extract) is followed directly by '${next.id}' (ask_customer). ` +
        `Usually extract is followed by find_sheet_row or evaluate.`
      );
    }
  }

  // Check that ask_customer steps appear AFTER any non-fallback steps that
  // might use them. A simple heuristic: ask_customer should not appear in
  // the first half of the playbook unless the playbook is genuinely
  // ask-first.
  const askIndices = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.type === "ask_customer");

  for (const { s, i } of askIndices) {
    if (i < steps.length / 2) {
      warnings.push(
        `Step '${s.id}' (ask_customer) appears in the first half of the playbook. ` +
        `Consider moving it to the fallback section (below the happy path).`
      );
    }
  }

  return warnings;
}
```

The parser should return these warnings alongside the steps so the UI can surface them. They're not blocking errors - sometimes a playbook genuinely is ask-first - but they prompt the human to double-check.

If your parser has a return shape like `{ steps, warnings }`, add the layout warnings to the warnings array. If not, extend the return type.

### Update the "post-process" step

Some parsers do a post-process pass to canonicalize structures. If yours does, add a layout-correction pass:

```ts
function reorderForLayout(steps: PlaybookStep[]): PlaybookStep[] {
  // Identify happy path: starts at first step, follows advance/advance_to chains
  // until terminal or until we hit a step we've seen before (loop guard)
  const happyPath = traceHappyPath(steps);
  const fallbacks = steps.filter(s =>
    !happyPath.includes(s) &&
    s.type !== "complete" &&
    s.type !== "escalate"
  );
  const terminals = steps.filter(s =>
    s.type === "complete" || s.type === "escalate"
  );

  return [...happyPath, ...fallbacks, ...terminals];
}
```

Whether to add this is a judgment call. If the AI-generated steps are usually correctly laid out after the prompt update, the post-process is unnecessary complexity. If the AI keeps misordering, post-process catches it.

I'd recommend **NOT** adding the post-process initially. Try the prompt update alone first, see if the AI gets it right consistently. If 8/10 generations are correct, ship it. If 5/10 are wrong, add the post-process.

## Verification

### 1. Type and lint checks

```bash
cd api && deno check services/playbook/parser.ts
```

### 2. Re-run the parser against the test input

Use the same input from pre-work step 4. Compare output to before:

```ts
// Use the API or call the service directly
const result = await parsePlaybook({
  description: "When someone asks for a refund...",
  workspaceId: 1,
});

console.log(JSON.stringify(result.steps, null, 2));
console.log("Warnings:", result.warnings);
```

Expected:
- The steps array follows happy-path-first layout
- `evaluate` step exists for routing
- `ask_customer` is below the happy path
- No `branch` steps unless genuinely needed for a deterministic check
- Warnings array is empty (or has only intentional warnings)

### 3. Generate 5 different playbooks and check consistency

Run the parser against 5 different plain-language descriptions:
1. Refund (the one above)
2. Tracking ("when someone asks where their order is...")
3. Order change ("when someone wants to change their order...")
4. Damaged item ("when someone reports a damaged item...")
5. General enquiry ("when someone has a general question...")

For each, verify the layout follows the rule. Document the percentage that came out correctly. Target: 5/5.

If less than 5/5, iterate on the prompt. The few-shot examples are the strongest signal - adjust them to cover the failure cases.

### 4. Postgres - save the new playbooks for testing

For the refund playbook generation, save it to a new playbook record:

```sql
-- Save the AI-generated steps as a new playbook for validation
INSERT INTO playbooks (workspace_id, category_id, name, plain_language_description, steps, version, is_active)
VALUES (1, <category_id>, 'Refund v3 (post-layout-fix)', '<the description>', '<the AI-generated JSON>'::jsonb, 1, false);
```

Mark it inactive so it doesn't override the working v2. Use this for end-to-end testing.

### 5. End-to-end test on a fresh thread

Activate the new playbook, deactivate Refund v2, send a fresh test email. Watch the execution trace via postgres. Verify:
- The execution order matches the new layout
- Total step executions for the happy path is small (~7-9)
- No loops, no escalations from loop detection
- Manual approval pause works
- Send_reply produces a reasonable contextual message

After the test, swap back to the playbook the client was using if needed.

### 6. Test the layout warnings

Manually craft a bad-layout playbook in JSON and submit it via the parser's validation path (or an internal API if exposed). Verify warnings are returned with the right messages.

## Doc citation requirements

In your TASK_LOG entry, cite:
- OpenAI docs section on JSON output reliability that informed temperature/system-prompt choices
- Any structured-output guidance that informed the validation approach

## Done criteria

- [ ] Parser system prompt includes the STEP LAYOUT RULES section
- [ ] At least 2 few-shot examples updated to use correct layout
- [ ] Parser validates layout and returns warnings (not blocking errors) for suspicious patterns
- [ ] Generated playbook for refund description has correct layout
- [ ] 5/5 test playbook generations follow correct layout
- [ ] End-to-end test on fresh thread shows the happy path completing in ~7-9 step executions
- [ ] Layout warnings appear correctly when given a bad-layout input
- [ ] Existing Refund v2 playbook still works (backward compat - handler fix is what really matters)
- [ ] All TypeScript checks pass
- [ ] TASK_LOG updated with before/after parser output, MCP usage trace, doc citations
- [ ] Commit message: `feat(parser): step layout rules - happy path first, fallbacks below`

## What NOT to do

- Don't add the post-process reordering step initially (try prompt-only first)
- Don't change the step types or their config schemas
- Don't migrate existing playbooks automatically (let the client regenerate when ready)
- Don't add zod or another validation library just for this (manual checks are fine)
- Don't change parser's return shape if you can avoid it (add to existing warnings array)
