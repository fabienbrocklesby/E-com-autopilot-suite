# Playbook Design Guide

This document is the canonical reference for how playbooks should be structured. It is loaded into the parser AI's system prompt at runtime. Edit this file to change how the AI designs playbooks — no code changes required.

## What a playbook is

A playbook is a multi-step flow attached to an email category. When an inbound email is categorised, the system runs the matching playbook: extracting info from the email, finding the customer in a Google Sheet, updating the sheet, asking the customer for missing info, pausing for human approval, and sending replies. Each thread runs an isolated instance with its own context bag (variables collected during execution) and step cursor.

The output of a playbook is one of: a completed resolution (customer helped, sheet updated, reply sent), an escalation to a human (something the system can't handle), or a pause waiting for input (customer reply or human action).

## Available step types

### extract

**Purpose:** AI reads the email thread and pulls named variables into the context bag.

**When to use:** Always first. Run once at the start of every playbook.

**When NOT to use:** Don't use mid-flow to re-read the same thread. If a customer replies and the run resumes, the engine re-runs extract automatically from the `on_reply_goto` target.

**Config schema:**
```json
{
  "id": "extract_1",
  "type": "extract",
  "variables": ["customer_name", "product_description"]
}
```

**Fields:**
- `variables` (string[], required): Names of variables to extract. Choose ONLY variables that (a) match a column in the workspace sheet, or (b) are explicitly referenced by a later step's config. Do not extract variables speculatively.

**Common variable names** (use these for consistency across playbooks):
- `customer_name` — the sender's name
- `customer_email` — the sender's email address (useful only if the sheet has an Email column)
- `product_description` — what the customer is writing about
- `refund_reason` — why they want a refund
- `issue_description` — the problem they're reporting

**Example (correct):**
```json
{ "id": "extract_1", "type": "extract", "variables": ["customer_name", "product_description"] }
```

**Example (wrong — extracting variables with no sheet column or later use):**
```json
{ "id": "extract_1", "type": "extract", "variables": ["order_number", "tracking_number", "customer_email", "phone_number"] }
```

### find_sheet_row

**Purpose:** Search the workspace's Google Sheet for a row matching context variables.

**When to use:** Whenever the playbook needs to look up or update a customer's row in the sheet.

**When NOT to use:** Don't use if the playbook doesn't interact with the sheet at all (e.g. a general enquiry that just needs a human reply).

**Config schema:**
```json
{
  "id": "find_1",
  "type": "find_sheet_row",
  "match_attempts": [
    { "column": "Name", "context_var": "customer_name" },
    { "column": "Order/Item", "context_var": "product_description" }
  ]
}
```

**Fields:**
- `match_attempts` (array, required): Each entry is `{ column, context_var }`. The engine tries each in order. `column` MUST be a column that exists in the workspace sheet. `context_var` must be a variable set by a prior extract step. Use ALL available signals for matching — don't rely on a single column.

**Design rules:**
- List match attempts from strongest signal to weakest (Email > Name > product description)
- Only reference columns that exist in the workspace sheet (see Workspace Context section below)
- The handler saves `row_number` to context on success. All subsequent sheet operations use this.
- If no match is found, `row_number` stays null. Use `evaluate` after this to decide what to do.

### update_sheet

**Purpose:** Write values to specific columns on a found row.

**When to use:** After a successful `find_sheet_row` (row_number is in context) when you need to record status changes, notes, or other data.

**When NOT to use:** Don't call before `find_sheet_row`. Don't call if `row_number` might be null — gate it behind an `evaluate` step.

**Config schema:**
```json
{
  "id": "update_1",
  "type": "update_sheet",
  "row_var": "row_number",
  "updates": [
    { "column": "Status", "value_or_var": "Refund Requested" },
    { "column": "Things to add", "value_or_var": "{refund_reason}" }
  ]
}
```

**Fields:**
- `row_var` (string, required): Context variable holding the row number. Almost always `"row_number"`.
- `updates` (array, required): Each entry is `{ column, value_or_var }`. Literal strings are written as-is. Wrap context variable names in `{}` to interpolate: `"{customer_name}"` writes the value of `customer_name`.
- `column` MUST be a column that exists in the workspace sheet.

### ask_customer

**Purpose:** AI-drafted message to gather missing information from the customer. The AI writes the actual message at runtime based on the goal, thread history, and voice settings.

**When to use:** When `find_sheet_row` couldn't match or essential context is missing. ALMOST ALWAYS placed below the happy path as a fallback.

**When NOT to use:** Don't use before attempting `find_sheet_row` — always try to match first with whatever we have. Don't use to send confirmation messages (use `send_reply` for that).

**Config schema:**
```json
{
  "id": "ask_1",
  "type": "ask_customer",
  "goal": "Find out which product the customer ordered so we can locate their row in the sheet",
  "required_context": ["customer_name"],
  "on_reply_goto": "extract_1"
}
```

**Fields:**
- `goal` (string, required): Describes WHAT we need and WHY, in one sentence. The AI drafts the actual message.
- `required_context` (string[], required): Variables that must be present for this step to be satisfied. If already present, the step auto-skips.
- `on_reply_goto` (string, required): Step ID to jump to when the customer replies. Usually `"extract_1"` to re-extract with the new info.
- `voice_hint` (string, optional): Tone guidance for the AI draft.
- `message` (string, optional): Legacy — literal message text. Do NOT use in new playbooks.

**Design rules:**
- `on_reply_goto` loops back to extract or find, NEVER to itself.
- For sheet-aware playbooks, the truly required context is usually just `row_number` — if we can't find the customer, we ask for more info.
- Place ask_customer steps BELOW the happy path in the step array.

### branch

**Purpose:** Deterministic routing based on a simple null/value check.

**When to use:** ONLY for literal null-checks or simple value comparisons. Example: "is customer_name null?"

**When NOT to use:** NEVER for judgment calls. Don't use for "do we have enough info?" — use `evaluate` instead. Don't use for conversation-state decisions.

**Config schema:**
```json
{
  "id": "branch_1",
  "type": "branch",
  "condition": "context.customer_name != null",
  "if_true": "find_1",
  "if_false": "ask_1"
}
```

**Fields:**
- `condition` (string, required): Pattern: `"context.VAR != null"`, `"context.VAR == null"`, or `"context.VAR"` (truthy check).
- `if_true` (string, required): Step ID when condition is true.
- `if_false` (string, required): Step ID when condition is false.

### evaluate

**Purpose:** AI-driven three-way routing. The AI judges whether the run has enough context to proceed, needs more info, or is stuck.

**When to use:** When the decision requires judgment: "do we have enough to proceed?", "is the conversation going nowhere?", "is something wrong?"

**When NOT to use:** Don't use for simple null checks (use `branch`). Don't use to make business decisions (humans do that via `manual_approval`).

**Config schema:**
```json
{
  "id": "evaluate_1",
  "type": "evaluate",
  "goal": "Do we have a sheet row to proceed with the refund?",
  "required_context": ["row_number"],
  "if_satisfied_goto": "update_1",
  "if_missing_goto": "ask_1",
  "if_escalate_goto": "escalate_1"
}
```

**Fields:**
- `goal` (string, required): What the AI is judging.
- `required_context` (string[], required): The MINIMUM variables needed. For any sheet-aware playbook, usually just `["row_number"]`.
- `if_satisfied_goto` (string, required): Happy path — proceed.
- `if_missing_goto` (string, required): Missing info — usually routes to `ask_customer`.
- `if_escalate_goto` (string, required): Stuck/broken — routes to `escalate`.

### manual_approval

**Purpose:** Pause the run for a human to take action or review.

**When to use:** When a human must do something external (process a refund in Stripe, fix an order, contact a supplier) or review before sending.

**When NOT to use:** Don't use for automated decisions. Don't use if the system can handle it without human intervention.

**Config schema:**
```json
{
  "id": "approval_1",
  "type": "manual_approval",
  "reason": "Process the refund in Stripe and enter the transaction ID",
  "capture_input": true,
  "input_prompt": "Stripe transaction ID and amount (e.g. 'txn_abc123, $89.99')",
  "input_context_key": "refund_notes",
  "reference_context": ["customer_name", "product_description", "amount"],
  "on_approve": "update_2",
  "on_reject": "escalate_1"
}
```

**Fields:**
- `reason` (string, required): Tell the human WHAT to do, not just "review this." Be specific: "Process the refund in Stripe and enter the transaction ID."
- `capture_input` (boolean, optional, default false): Set `true` when the human performs an external action and you need their notes or reference back.
- `input_prompt` (string, optional): What to enter. Only relevant when `capture_input: true`.
- `input_context_key` (string, optional, default "human_notes"): Where captured text lands in context.
- `reference_context` (string[], optional): Variable names whose values the human needs to see to act (customer name, product, amount, etc.).
- `on_approve` (string, required): Step ID after approval.
- `on_reject` (string, required): Step ID after rejection. Should point to an `escalate` step or a different escalation path.

**Design rules:**
- Always set `capture_input: true` when the human is performing an external action.
- The `reason` should say WHAT the human does, not just "approve/reject."
- Include `reference_context` with all variables needed for the human to act.
- `on_reject` should route to an escalate step with a contextually appropriate reason (e.g. "Human rejected the refund request"), NOT a generic "could not find order" message.

### send_reply

**Purpose:** Send a reply to the customer. Prefer AI-drafted from goal + reference_context.

**When to use:** After all actions are complete, to inform the customer of the outcome.

**When NOT to use:** Don't use to ask questions (use `ask_customer`). Don't use before the actual work is done.

**Config schema (AI-drafted, preferred):**
```json
{
  "id": "send_1",
  "type": "send_reply",
  "goal": "Confirm the refund has been processed and mention the amount and product",
  "reference_context": ["customer_name", "product_description", "amount", "refund_notes"],
  "voice_hint": "casual, NZ-friendly"
}
```

**Config schema (literal message, rare):**
```json
{
  "id": "send_1",
  "type": "send_reply",
  "message": "Your request has been received."
}
```

**Fields:**
- `goal` (string, preferred): Describes what the reply should communicate. The AI writes the actual text at runtime.
- `reference_context` (string[], optional): Variable names whose values should naturally appear in the reply.
- `voice_hint` (string, optional): Tone guidance.
- `message` (string, legacy): Literal text. Only for very simple fixed replies.

### complete

**Purpose:** End the run successfully.

**When to use:** After all actions and replies are done. Every happy path must end here.

**Config schema:**
```json
{ "id": "complete_1", "type": "complete" }
```

### escalate

**Purpose:** End the run, flag the thread for human review.

**When to use:** When the system can't resolve the issue — missing info after asking, human rejection, unexpected state.

**When NOT to use:** Don't use as the only terminal. Every playbook should have a `complete` step for the happy path.

**Config schema:**
```json
{ "id": "escalate_1", "type": "escalate", "reason": "Customer did not provide enough information after being asked" }
```

**Fields:**
- `reason` (string, required): A SPECIFIC reason for escalation. Each escalate step should have a reason that matches WHY it's reached. Don't reuse one escalate step for multiple failure paths with a generic reason.

**Design rules:**
- Use SEPARATE escalate steps for different failure paths with specific reasons:
  - `"escalate_no_match"` with reason "Could not find customer in the sheet after asking for more details"
  - `"escalate_rejected"` with reason "Human reviewer rejected the request"

## Workspace context (injected at runtime)

This section is replaced at runtime with the actual workspace sheet columns and configuration. The parser injects this before sending to the AI. You will see the specific columns available for this workspace here when the prompt is assembled.

## Design principles

### Principle 1: The sheet is the source of truth

Playbooks only reference columns that exist in the workspace's sheet. The runtime Workspace Context section lists them. Never generate steps that reference columns not in that list.

Extraction variables should map to sheet columns. If the sheet has a "Name" column but no "Email" column, extract `customer_name` but don't extract `customer_email` — we can't match on it. Exception: extract `customer_email` if a later step (like `send_reply`) explicitly needs it AND it's available in the email headers.

### Principle 2: Match with whatever the customer provides

Customers rarely quote order numbers. They give their name, mention the product, describe the issue. The `find_sheet_row` step should match aggressively using ALL available signals, not require any specific one.

If the workspace sheet has columns for Name and Order/Item, match on those. If Email exists, use it as the strongest signal. Don't require any specific column to have a value before attempting to match.

### Principle 3: Don't invent variables that aren't useful

If `order_number` doesn't correspond to any sheet column and the customer rarely quotes it, don't extract it. Don't branch on it. Don't ask for it.

The extract step should list only variables that:
- Have a matching sheet column to find rows by, OR
- Are used later in the flow (referenced by `update_sheet`, `send_reply`, `manual_approval` reference_context, etc.)

### Principle 4: Happy path first, top to bottom

Step array order matches execution order for the happy path. The steps should read like: extract → find → evaluate → update → approve → update → send → complete.

Fallback steps (`ask_customer`) and terminal failure steps (`escalate`) go at the bottom of the array. They are reached only via routing from `evaluate`, `branch`, or `manual_approval` rejection.

### Principle 5: Fail gracefully to humans

Every playbook ends with either `complete` (success) or `escalate` (hand to human). Don't design playbooks that loop forever hoping the customer provides info. Ask once, then escalate.

Use separate escalate steps with specific reasons for different failure paths.

### Principle 6: Messages are AI-drafted, not templates

`ask_customer` takes a `goal`, not a literal message. `send_reply` takes a `goal` + `reference_context`, not a literal message. The AI writes the actual text at runtime based on thread history, context variables, and voice settings.

## Rules for step generation

- Each step `id` must be unique, short, and descriptive in `snake_case` (e.g. `"extract_1"`, `"find_order_1"`).
- Steps run sequentially unless a `branch`/`evaluate` redirects flow.
- `ask_customer.on_reply_goto` must reference an existing step ID.
- `branch.if_true` and `branch.if_false` must reference existing step IDs.
- `evaluate.if_satisfied_goto`, `if_missing_goto`, and `if_escalate_goto` must reference existing step IDs.
- `manual_approval.on_approve` and `on_reject` must reference existing step IDs.
- Every playbook must end with `complete` or `escalate`.
- Return ONLY a JSON object: `{ "steps": [...] }`. No explanation. No markdown fences.

## Examples

### Example 1: Refund (sheet with Name, Order/Item, Status, Amount columns)

Description: "When someone asks for a refund, find them in the sheet, mark it as refund requested, pause for me to process in Stripe, then confirm to the customer."

```json
{
  "steps": [
    {
      "id": "extract_1",
      "type": "extract",
      "variables": ["customer_name", "product_description", "refund_reason"]
    },
    {
      "id": "find_1",
      "type": "find_sheet_row",
      "match_attempts": [
        { "column": "Name", "context_var": "customer_name" },
        { "column": "Order/Item", "context_var": "product_description" }
      ]
    },
    {
      "id": "evaluate_1",
      "type": "evaluate",
      "goal": "Do we have the customer's sheet row so we can process the refund?",
      "required_context": ["row_number"],
      "if_satisfied_goto": "update_1",
      "if_missing_goto": "ask_1",
      "if_escalate_goto": "escalate_no_match"
    },
    {
      "id": "update_1",
      "type": "update_sheet",
      "row_var": "row_number",
      "updates": [
        { "column": "Status", "value_or_var": "Refund Requested" },
        { "column": "Things to add", "value_or_var": "{refund_reason}" }
      ]
    },
    {
      "id": "approval_1",
      "type": "manual_approval",
      "reason": "Process the refund in Stripe. Enter the transaction ID and amount when done.",
      "capture_input": true,
      "input_prompt": "Stripe transaction ID and amount (e.g. 'txn_abc123, $89.99')",
      "input_context_key": "refund_notes",
      "reference_context": ["customer_name", "product_description", "amount"],
      "on_approve": "update_2",
      "on_reject": "escalate_rejected"
    },
    {
      "id": "update_2",
      "type": "update_sheet",
      "row_var": "row_number",
      "updates": [
        { "column": "Status", "value_or_var": "Refunded" },
        { "column": "Things to add", "value_or_var": "{refund_notes}" }
      ]
    },
    {
      "id": "send_1",
      "type": "send_reply",
      "goal": "Confirm the refund has been processed. Mention the product and amount. Keep it casual and NZ-friendly.",
      "reference_context": ["customer_name", "product_description", "amount", "refund_notes"]
    },
    {
      "id": "complete_1",
      "type": "complete"
    },
    {
      "id": "ask_1",
      "type": "ask_customer",
      "goal": "We couldn't find their order in the sheet. Ask for more details about what they ordered so we can locate it.",
      "required_context": ["row_number"],
      "on_reply_goto": "extract_1"
    },
    {
      "id": "escalate_no_match",
      "type": "escalate",
      "reason": "Could not find customer in the sheet after asking for more details"
    },
    {
      "id": "escalate_rejected",
      "type": "escalate",
      "reason": "Human reviewer rejected the refund request"
    }
  ]
}
```

**Why this shape:**
- `extract_1` pulls only variables that map to sheet columns (Name → customer_name, Order/Item → product_description) plus refund_reason for the update step.
- `find_1` matches on Name and Order/Item — the two columns most likely to identify the customer. No order_number because the sheet has no such column.
- `evaluate_1` checks only `row_number` — the minimum needed to proceed.
- `ask_1` is at the bottom, only reached if evaluate routes there.
- Two separate escalate steps with specific reasons for each failure path.
- `approval_1` has `capture_input: true` because the human processes a Stripe refund and we need the transaction details back.

### Example 2: Tracking enquiry (sheet with Name, Order/Item, Tracking columns)

Description: "When someone asks where their order is, find them in the sheet and reply with the tracking info."

```json
{
  "steps": [
    {
      "id": "extract_1",
      "type": "extract",
      "variables": ["customer_name", "product_description"]
    },
    {
      "id": "find_1",
      "type": "find_sheet_row",
      "match_attempts": [
        { "column": "Name", "context_var": "customer_name" },
        { "column": "Order/Item", "context_var": "product_description" }
      ]
    },
    {
      "id": "evaluate_1",
      "type": "evaluate",
      "goal": "Do we have the customer's sheet row with tracking info?",
      "required_context": ["row_number"],
      "if_satisfied_goto": "send_1",
      "if_missing_goto": "ask_1",
      "if_escalate_goto": "escalate_1"
    },
    {
      "id": "send_1",
      "type": "send_reply",
      "goal": "Share the tracking information from the sheet. If there's no tracking number yet, let them know we'll update them when it ships.",
      "reference_context": ["customer_name", "product_description"]
    },
    {
      "id": "complete_1",
      "type": "complete"
    },
    {
      "id": "ask_1",
      "type": "ask_customer",
      "goal": "We couldn't find their order. Ask for their name and what they ordered so we can look it up.",
      "required_context": ["row_number"],
      "on_reply_goto": "extract_1"
    },
    {
      "id": "escalate_1",
      "type": "escalate",
      "reason": "Could not locate the customer's order after asking for details"
    }
  ]
}
```

**Why this shape:**
- No `update_sheet` — tracking enquiries are read-only.
- No `manual_approval` — the reply can be sent automatically.
- Simpler flow: extract → find → evaluate → send → complete.

### Example 3: Order change (sheet with Name, Order/Item, Status, Amount, Address, Quantity columns)

Description: "When someone wants to change their order, find it in the sheet, pause for me to check if it's changeable, then update and confirm."

```json
{
  "steps": [
    {
      "id": "extract_1",
      "type": "extract",
      "variables": ["customer_name", "product_description", "issue_description"]
    },
    {
      "id": "find_1",
      "type": "find_sheet_row",
      "match_attempts": [
        { "column": "Name", "context_var": "customer_name" },
        { "column": "Order/Item", "context_var": "product_description" }
      ]
    },
    {
      "id": "evaluate_1",
      "type": "evaluate",
      "goal": "Do we have the customer's order row to check if changes are possible?",
      "required_context": ["row_number"],
      "if_satisfied_goto": "approval_1",
      "if_missing_goto": "ask_1",
      "if_escalate_goto": "escalate_no_match"
    },
    {
      "id": "approval_1",
      "type": "manual_approval",
      "reason": "Check if this order can be changed. The customer wants to change: see issue_description. Update the order if possible and note what was changed.",
      "capture_input": true,
      "input_prompt": "What changes were made? (or 'cannot change' with reason)",
      "input_context_key": "change_notes",
      "reference_context": ["customer_name", "product_description", "issue_description"],
      "on_approve": "update_1",
      "on_reject": "escalate_rejected"
    },
    {
      "id": "update_1",
      "type": "update_sheet",
      "row_var": "row_number",
      "updates": [
        { "column": "Status", "value_or_var": "Order Changed" },
        { "column": "Things to add", "value_or_var": "{change_notes}" }
      ]
    },
    {
      "id": "send_1",
      "type": "send_reply",
      "goal": "Confirm the order has been changed. Mention what was changed based on the human's notes.",
      "reference_context": ["customer_name", "product_description", "change_notes"]
    },
    {
      "id": "complete_1",
      "type": "complete"
    },
    {
      "id": "ask_1",
      "type": "ask_customer",
      "goal": "We couldn't find their order. Ask for their name and what they ordered.",
      "required_context": ["row_number"],
      "on_reply_goto": "extract_1"
    },
    {
      "id": "escalate_no_match",
      "type": "escalate",
      "reason": "Could not find the customer's order in the sheet"
    },
    {
      "id": "escalate_rejected",
      "type": "escalate",
      "reason": "Order change was not possible — human reviewer rejected"
    }
  ]
}
```

### Example 4: General enquiry (no sheet lookup needed)

Description: "When someone has a general question, just pause for me to answer it manually."

```json
{
  "steps": [
    {
      "id": "extract_1",
      "type": "extract",
      "variables": ["customer_name", "issue_description"]
    },
    {
      "id": "approval_1",
      "type": "manual_approval",
      "reason": "Reply to this general enquiry. The customer's question is in issue_description.",
      "capture_input": true,
      "input_prompt": "Your reply to the customer (or notes for the AI to draft from)",
      "input_context_key": "human_reply",
      "reference_context": ["customer_name", "issue_description"],
      "on_approve": "send_1",
      "on_reject": "escalate_1"
    },
    {
      "id": "send_1",
      "type": "send_reply",
      "goal": "Reply to the customer's enquiry using the human's notes as the basis for the response.",
      "reference_context": ["customer_name", "issue_description", "human_reply"]
    },
    {
      "id": "complete_1",
      "type": "complete"
    },
    {
      "id": "escalate_1",
      "type": "escalate",
      "reason": "General enquiry could not be handled"
    }
  ]
}
```

**Why this shape:**
- No `find_sheet_row` or `update_sheet` — general enquiries don't need sheet lookup.
- Straight to `manual_approval` after extracting basic info.
- Simple: extract → approve → send → complete.

## Anti-patterns

### Extracting variables that don't map to anything

```
WRONG: { "variables": ["order_number", "tracking_number", "customer_email", "phone_number"] }
  (when the sheet has no Order Number, Tracking, Email, or Phone columns)

RIGHT: { "variables": ["customer_name", "product_description"] }
  (Name and Order/Item columns exist in the sheet)
```

### Gating find_sheet_row on a specific variable

```
WRONG: branch on "do we have order_number" → find_sheet_row only if yes
RIGHT: Always run find_sheet_row with all available signals, let it match on whatever it can
```

### Asking the customer before trying to find them

```
WRONG: extract → ask_customer "what's your order number?" → find_sheet_row
RIGHT: extract → find_sheet_row → evaluate → (if not found) ask_customer → (on reply) extract
```

### Literal messages in ask_customer and send_reply

```
WRONG: { "type": "ask_customer", "message": "Hi! Could you please provide your order number so I can look into this for you?" }
RIGHT: { "type": "ask_customer", "goal": "Get more details about their order so we can find it in the sheet", "required_context": ["row_number"], "on_reply_goto": "extract_1" }
```

### Single escalate step for multiple failure paths

```
WRONG: One escalate_1 with reason "Could not process request" used by both evaluate and manual_approval rejection

RIGHT: Separate escalate steps:
  - escalate_no_match: "Could not find customer in the sheet after asking for details"
  - escalate_rejected: "Human reviewer rejected the request"
```

### Wrong step ordering

```
WRONG: extract → branch → find → ask → evaluate → update → approval → send → complete → escalate
  (ask_customer in the middle of the happy path)

RIGHT: extract → find → evaluate → update → approval → update → send → complete → ask (fallback) → escalate
  (happy path flows top to bottom, fallbacks at the end)
```

### Manual approval without capture_input for external actions

```
WRONG: { "type": "manual_approval", "reason": "Review the refund request for approval.", "capture_input": false }
  (human processes a Stripe refund but can't record the transaction ID)

RIGHT: { "type": "manual_approval", "reason": "Process the refund in Stripe and enter the transaction ID", "capture_input": true, "input_prompt": "Stripe transaction ID and amount", "input_context_key": "refund_notes" }
```
