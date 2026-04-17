---
agent: 'agent'
description: 'Phase 5: upgrade the playbook engine from rigid template-following to AI-driven contextual behaviour'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query', 'mcp_playwright']
---

# Phase 5: Smart Playbooks

Goal: The current engine executes playbooks like a dumb script. `ask_customer` fires the same hardcoded question regardless of context. `branch` checks rigid conditions and loops forever when reality doesn't fit. `send_reply` sends canned messages. `manual_approval` doesn't let the human capture what they actually did.

This phase makes the engine **AI-driven where it needs to be, deterministic where it should be**. Playbooks become guides, not scripts. The AI reads context and decides, the playbook constrains and guides.

## Required reading before starting

- `docs/PLAYBOOK_ENGINE.md` - the architecture as it stands
- `docs/TASK_LOG.md` - confirm Phase 4 done
- `skills/ai-driven-step/SKILL.md` - the new pattern for AI-driven steps (read this carefully, it's the template for all the changes below)
- The current handler files: `api/services/playbook/handlers/ask_customer.ts`, `branch.ts`, `send_reply.ts`, `manual_approval.ts`
- `api/services/playbook/executor.ts` - the dispatch loop

## The problem we're solving

Demo thread that proved the issue:

> Customer: "I need a refund"
> Bot: "Could you please provide the name or the product you ordered?"
> Customer: "It was a radiator for a Polaris Ranger"
> Bot: "Could you please provide the name or the product you ordered?"
> Customer: "I did, it was a radiator! You know my name as well"
> Bot: "Could you please provide the name or the product you ordered?"
> [repeats 5 more times]

Execution log showed: extract pulled the name and product successfully, find_sheet_row found row 2, but the `branch` step kept checking `order_number != null` which stayed null, so every cycle went back to `ask_customer` with its hardcoded message.

Also: no `manual_approval` step in the playbook. Even if the info-gathering loop had terminated, it would have told the customer "refund sent" without Fabien ever processing it.

## The 6 changes

Implement in this order. Each is committable on its own.

### Change 1: Loop detection in the executor

**Ship this first** - it stops the bleeding even before the smarter changes land. Any playbook currently in production gets protected.

**File**: `api/services/playbook/executor.ts`

In `advanceRun`, before executing the next step:

```ts
const recentExecutions = await query<PlaybookStepExecution>(
  `SELECT * FROM playbook_step_executions
   WHERE run_id = $1
   ORDER BY created_at DESC
   LIMIT 10`,
  [runId]
);

const sameStepCount = recentExecutions.filter(e => e.step_id === currentStepId).length;
if (sameStepCount >= 3) {
  await escalateRun(runId, `Loop detected: step ${currentStepId} fired ${sameStepCount} times without progress`);
  return;
}
```

Also add a global "too many steps total" guard:

```ts
if (recentExecutions.length === 0) {
  // fine, new run
} else {
  const totalStepsForRun = await queryOne<{count: string}>(
    "SELECT COUNT(*) as count FROM playbook_step_executions WHERE run_id = $1",
    [runId]
  );
  if (parseInt(totalStepsForRun?.count ?? "0") > 50) {
    await escalateRun(runId, "Exceeded 50 step executions, likely stuck in a loop");
    return;
  }
}
```

`escalateRun` should set status to `escalated`, insert a step execution record with type `_loop_detected` for visibility, and leave the thread in the review queue with the reason surfaced.

**Validation**: Take the stuck run from the demo thread (find it via Postgres MCP). Manually reset it to `running` and let a new inbound trigger it. Within 3 cycles it should auto-escalate.

### Change 2: AI-driven `ask_customer`

**File**: `api/services/playbook/handlers/ask_customer.ts`

Old config:
```ts
{
  message: string,
  on_reply_goto: string
}
```

New config:
```ts
{
  goal: string,                    // what we're trying to find out
  required_context: string[],      // variable names we need
  voice_hint?: string,             // optional override, else use category writing_style
  on_reply_goto: string,
  message?: string                 // optional literal fallback (backward compat)
}
```

Handler logic:

1. Load:
   - Context bag
   - Last 5 messages on the thread
   - Category `writing_style`
   - List of all previous `ask_customer` messages sent on this run (scan execution log)

2. Check: do we already have all `required_context` variables populated in the context bag?
   - If yes: return `{ decision: advance(on_reply_goto), contextUpdates: {} }` - skip asking entirely
   - Log this as output: `{ action: "skipped", reason: "all required context present" }`

3. If we do need to ask, call AI:

```
System prompt:
You are helping a support agent handle an email thread. You write the next message to send to the customer.

Your goal: {step.goal}
Variables we still need: {missing variables}
Variables we already have: {context bag, formatted}
Voice/style: {voice_hint or category.writing_style}

Previous messages we already sent in this thread:
{list of previous outbound messages}

The customer's most recent message:
{last inbound message}

Decide what to do. Return JSON:
- If the customer's message actually gave us enough info (even if we haven't extracted it yet), return {"action": "skip", "extracted": {var1: value, ...}, "reasoning": "..."}
- If the customer seems frustrated, confused, repeating themselves, or this conversation is going in circles, return {"action": "escalate", "reason": "..."}
- Otherwise write a brief, contextual message that:
  - References what the customer just told us (acknowledge them)
  - Does NOT repeat a question we already asked
  - Asks specifically for what's still missing
  - Matches the voice
  Return {"action": "ask", "message": "..."}

Output JSON only.
```

4. Apply the response:
   - `skip`: merge `extracted` into context, advance to `on_reply_goto`
   - `escalate`: return decision `fail` with the reason; executor handles escalation
   - `ask`: send the message via Gmail, return decision `pause('waiting_for_customer', resumeStepId: current step)`

**Validation**: Create a test playbook with one `ask_customer` step targeting `order_number`. Send an email that already contains an order number in the body. Verify the step returns `skip` without sending a message.

Then send one that doesn't. Verify the AI writes something contextual referencing the customer's actual words. Reply frustrated. Verify the AI escalates.

### Change 3: Add `evaluate` step type

**File**: `api/services/playbook/handlers/evaluate.ts` (new)
**Update**: `api/services/playbook/types.ts` to add `EvaluateStep` to the discriminated union
**Update**: `api/services/playbook/registry.ts` to register it
**Update**: `api/services/playbook/parser.ts` system prompt to teach the AI when to generate `evaluate` steps

Purpose: three-way AI-driven routing that replaces `branch` for squishy conditions.

Config:
```ts
{
  goal: string,                    // what are we deciding
  required_context: string[],      // what we need to have
  if_satisfied_goto: string,       // have everything, proceed
  if_missing_goto: string,         // need more info, usually back to ask_customer
  if_escalate_goto: string,        // something's off, human handle it
  optional_context?: string[]      // nice-to-have but not required
}
```

Handler logic:

1. Load context bag + last 5 messages + category voice
2. Check deterministically: are all `required_context` variables present and non-null?
   - If yes, call AI to confirm: "We have X, Y, Z. Goal: {goal}. Is this actually sufficient to proceed, or is something weird going on?"
   - If AI confirms: advance to `if_satisfied_goto`
   - If AI flags an issue (e.g. "customer_name says 'idk' which isn't a real name"): advance to `if_escalate_goto`
3. If required vars missing:
   - Call AI: "We have {have}, we need {missing}. Recent messages: {messages}. Is the customer giving us the info in a different form we can extract? Is the conversation stuck? Is this escalate-worthy?"
   - AI returns `{action: "missing" | "escalate" | "actually_have_it", extracted?: {...}, reason: "..."}`
   - Apply accordingly

Keep the old `branch` step for deterministic routing (e.g. "if row_number is null, take path A, else path B"). `evaluate` is explicitly for AI-judged routing.

**Validation**: Build a test playbook with `evaluate` between `extract` and downstream steps. Feed it an email with partial info. Verify correct routing.

### Change 4: AI-drafted `send_reply` by default

**File**: `api/services/playbook/handlers/send_reply.ts`

Old config:
```ts
{
  message: string
}
```

New config:
```ts
{
  message?: string,                // if provided, use literally
  goal?: string,                   // what should this reply accomplish
  reference_context?: string[],    // variable names to make sure appear in the reply
  voice_hint?: string              // else category writing_style
}
```

Handler:
- If `message` is provided and `goal` is not: send literally (backward compat)
- Otherwise: call AI with goal, context bag, thread history, required references, voice → get drafted message → send

AI prompt:
```
Write a brief reply to this email thread.

Goal: {goal}
Must reference (naturally, not robotically): {reference_context variables with their values}
Voice: {voice_hint or writing_style}
Recent thread:
{last 3 messages}
Context bag for this run:
{full context}

Rules:
- Brief. One short paragraph unless the customer asked multiple things.
- Match the voice. Don't sound corporate unless the voice says so.
- Reference facts from context naturally (e.g. the amount refunded, the order number) - don't list them like a form.
- Don't start with "Thank you for" unless the voice specifically calls for it.
- Sign off the way the category voice suggests.

Return only the message body. No JSON, no quotes around it.
```

**Validation**: Build a `send_reply` step with goal "confirm refund is on its way, mention the amount" after a populated context. Verify output references the amount and matches voice.

### Change 5: `manual_approval` with input capture

**Backend file**: `api/services/playbook/handlers/manual_approval.ts`
**Frontend file**: `frontend/src/routes/review/+page.svelte` (and any related components)

Old config:
```ts
{
  reason: string,
  draft_template?: string,
  on_approve: string,
  on_reject: string
}
```

New config:
```ts
{
  reason: string,                          // what the human needs to do
  capture_input?: boolean,                 // show a text area?
  input_prompt?: string,                   // placeholder / label
  input_context_key?: string,              // where to store input, default "human_notes"
  draft_preview?: { goal: string, reference_context?: string[] },  // optional: show a preview of what the next send_reply will look like
  on_approve: string,
  on_reject: string
}
```

**Backend changes**:
- Handler on first run: send decision `pause('waiting_for_human', resumeStepId: current step)`, store config in execution output so the review UI can render it
- When the UI hits "approve" endpoint: accept an optional `input` body, merge into context as `{[input_context_key ?? "human_notes"]: input}`, advance to `on_approve`
- When the UI hits "reject" endpoint: advance to `on_reject`

**API routes needed** (extend existing if they exist):
- `POST /playbook-runs/:id/approve` - body: `{ input?: string }`
- `POST /playbook-runs/:id/reject` - body: `{ reason?: string }`

**Frontend changes**:
- Review queue shows the reason prominently
- If `capture_input` is true, show a text area with `input_prompt` as label/placeholder
- "Approve" button submits with whatever's in the text area (or undefined if empty)
- "Reject" button with optional reason field
- If `draft_preview` is set, call a new backend endpoint that returns a preview of what the next `send_reply` would write (without actually sending). Show it above the approve button so the human sees what the customer will receive.

**Validation**:
1. Build a playbook with `manual_approval` + `capture_input: true`
2. Trigger a run that reaches it
3. In the review UI: verify text area appears with the right prompt
4. Type something, click approve
5. Use Postgres MCP to verify context bag now has `human_notes: "<your text>"`
6. Verify the next step executed with that context available

### Change 6: Parser updates to generate the new step shapes

**File**: `api/services/playbook/parser.ts`

Update the system prompt the parser uses to:

1. Teach the AI about `evaluate` and when to use it (vs `branch`)
2. Teach it that `ask_customer` now takes `goal` + `required_context` instead of a literal message
3. Teach it that `send_reply` should use `goal` + `reference_context` by default
4. Teach it that `manual_approval` supports `capture_input` and that this should be ON for steps where the human actually does something (not just "check this is ok")
5. Give it examples using the new shapes

Example update section in the prompt:

```
Step types available:

- `extract`: Pull named variables from the email into context. Config: { variables: string[] }
- `find_sheet_row`: Locate a row in the workspace sheet. Config: { match_attempts: [{column, context_var}] }
- `update_sheet`: Write to a row. Config: { row_var, updates: [{column, value_or_var}] }
- `ask_customer`: Ask the customer for missing info. The AI writes the actual message at runtime based on goal + context. Config: { goal: string, required_context: string[], on_reply_goto: string }
- `evaluate`: AI-driven three-way routing. Use when the decision involves judgment about the conversation state. Config: { goal, required_context, if_satisfied_goto, if_missing_goto, if_escalate_goto }
- `branch`: Deterministic routing on a simple condition. Use when the decision is a literal check like "is row_number null". Config: { condition, if_true, if_false }
- `manual_approval`: Pause for a human. Set capture_input: true when the human is performing an external action (process refund, fix an order). Config: { reason, capture_input?, input_prompt?, input_context_key?, on_approve, on_reject }
- `send_reply`: Send a reply. Prefer goal + reference_context for AI-drafted contextual replies over hardcoded messages. Config: { goal?, reference_context?, message? }
- `complete` / `escalate`

When generating playbooks:
- Use `evaluate` for "do we have enough info to proceed" style decisions
- Use `branch` only for literal null-checks or enum comparisons
- `ask_customer` goal should describe WHAT we need and WHY, in one sentence. Don't write the literal message.
- `send_reply` should almost always use `goal` + `reference_context`. Only use literal `message` for very simple fixed replies.
- Any step where the human does an action (refund, fix, contact someone externally) should have `manual_approval` with `capture_input: true`
```

Also add examples at the end of the prompt showing correct usage.

**Validation**:
1. Take the plain-language description of the refund playbook (see below)
2. Run it through the parser
3. Verify the output uses `evaluate`, AI-driven `ask_customer`, `manual_approval` with `capture_input`, and AI-drafted `send_reply`

## The refund playbook - rebuild it after the changes

Once all 6 changes are in, regenerate the refund playbook from this description (in the UI):

> When someone asks for a refund, figure out who they are and what they ordered. Try to match them against a row in the sheet using their email, name, or any order number they mention. If after one round of asking you still can't match them, escalate to me. Once you've got the row and a reason for the refund, update the sheet status to "Refund Requested" with the reason. Then pause and wait for me to process the refund in Stripe. I'll enter the transaction ID and amount when I approve. Once I'm done, update the sheet status to "Refunded" with my notes. Then send them a brief contextual reply confirming the refund, mentioning the amount if we have it. Keep the voice casual NZ-friendly matching the category style.

Expected parse (validate this):

```json
[
  {"id": "extract_1", "type": "extract", "config": {"variables": ["order_number", "customer_name", "customer_email", "refund_reason", "product_mentioned"]}},
  {"id": "find_1", "type": "find_sheet_row", "config": {"match_attempts": [
    {"column": "Order #", "context_var": "order_number"},
    {"column": "Email", "context_var": "customer_email"},
    {"column": "Name", "context_var": "customer_name"}
  ]}},
  {"id": "evaluate_1", "type": "evaluate", "config": {
    "goal": "Do we have a sheet row and a refund reason? If yes proceed. If missing, ask. If conversation is stuck, escalate.",
    "required_context": ["row_number", "refund_reason"],
    "if_satisfied_goto": "update_1",
    "if_missing_goto": "ask_1",
    "if_escalate_goto": "escalate_1"
  }},
  {"id": "ask_1", "type": "ask_customer", "config": {
    "goal": "Get whatever we still need to process the refund - their order info or reason",
    "required_context": ["row_number", "refund_reason"],
    "on_reply_goto": "extract_1"
  }},
  {"id": "update_1", "type": "update_sheet", "config": {
    "row_var": "row_number",
    "updates": [
      {"column": "Status", "value": "Refund Requested"},
      {"column": "Reason", "value_or_var": "refund_reason"}
    ]
  }},
  {"id": "approve_1", "type": "manual_approval", "config": {
    "reason": "Process this refund in Stripe. Enter the transaction ID and amount when done.",
    "capture_input": true,
    "input_prompt": "Stripe transaction ID and amount (e.g. 'txn_abc123, $89.99')",
    "input_context_key": "refund_notes",
    "on_approve": "update_2",
    "on_reject": "escalate_1"
  }},
  {"id": "update_2", "type": "update_sheet", "config": {
    "row_var": "row_number",
    "updates": [
      {"column": "Status", "value": "Refunded"},
      {"column": "Notes", "value_or_var": "refund_notes"}
    ]
  }},
  {"id": "send_1", "type": "send_reply", "config": {
    "goal": "Confirm the refund has been processed and is on its way",
    "reference_context": ["refund_notes", "customer_name"]
  }},
  {"id": "complete_1", "type": "complete"},
  {"id": "escalate_1", "type": "escalate", "config": {"reason": "Refund needs manual handling"}}
]
```

## End-to-end test

After all 6 changes are deployed and the playbook is regenerated:

1. Send the original demo email: "Hey mate I need a refund sorry mate but this is shit. Cheers, Fabien"
2. Expected:
   - extract pulls: customer_name="Fabien", refund_reason="this is shit", product_mentioned=null, order_number=null, customer_email="fabienbrocklesby@icloud.com"
   - find_sheet_row matches row 2 by email or name
   - evaluate_1: has row_number and refund_reason → satisfied → goto update_1
   - update_1: sheet status set to "Refund Requested"
   - approve_1: pauses, shows up in review queue with text area for Stripe details
3. You in the UI: type "txn_test123, $89.99", click approve
4. Expected:
   - update_2: sheet status set to "Refunded", Notes set to your input
   - send_1: AI drafts a contextual message referencing the $89.99 and addressing Fabien by name, in category voice
   - complete
5. Verify in Gmail that the sent reply actually references the amount and doesn't sound robotic
6. Verify the sheet row shows both status updates

## Workflow

1. Read everything in "Required reading"
2. Ship Change 1 (loop detection) first as its own commit - lands in prod immediately to protect against current stuck runs
3. Ship Change 2 (AI-driven ask_customer) - biggest impact
4. Ship Change 3 (evaluate step) - enables smart routing
5. Ship Change 4 (AI-drafted send_reply) - polish
6. Ship Change 5 (manual_approval input) - backend + frontend together
7. Ship Change 6 (parser updates)
8. Regenerate refund playbook from plain language, test end to end
9. Regenerate tracking + order change + damaged playbooks, test each
10. Update `docs/PLAYBOOK_ENGINE.md` with the new step shapes
11. Update `docs/TASK_LOG.md`

## Done criteria

- [ ] Loop detection escalates stuck runs within 3 cycles
- [ ] `ask_customer` no longer sends duplicate or templated messages
- [ ] `evaluate` step type implemented, registered, parser aware of it
- [ ] `send_reply` defaults to AI-drafted contextual messages
- [ ] `manual_approval` accepts human input on approve, stores it in context
- [ ] Parser generates playbooks using the new step shapes
- [ ] Refund playbook regenerated and runs end to end correctly on the demo email
- [ ] Tracking, order change, damaged playbooks also regenerated and tested
- [ ] PLAYBOOK_ENGINE.md updated with new step shapes
- [ ] TASK_LOG.md updated

## What NOT to do in this phase

- Don't add new step types beyond `evaluate`
- Don't refactor the executor beyond what Change 1 needs
- Don't change the data model (no new tables or columns)
- Don't touch the legacy `categoriseAndDraft` path (it's deprecated)
- Don't change how the parser UI works, only how its output is shaped
