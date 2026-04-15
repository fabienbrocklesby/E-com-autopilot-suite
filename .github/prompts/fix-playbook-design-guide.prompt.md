# Fix: Playbook Design Guide — "Ask If Missing" Pattern

## Context

You are working on a Deno + Hono + SvelteKit 5 email automation dashboard.
The playbook engine drives multi-step AI workflows over customer emails.

Use the **filesystem MCP** to read all files referenced below before making changes.
Use the **postgres MCP** to inspect current playbook step shapes stored in the DB if needed.
Use **context7** to look up any Deno/Hono/TypeScript APIs if you need them.
Do NOT use playwright or svelte for this task — it is backend/docs only.

---

## The problem

The playbook parser (`api/services/playbook/parser.ts`) reads
`docs/PLAYBOOK_DESIGN_GUIDE.md` as its GPT-4o system prompt at runtime.

A user wrote this plain-language playbook description:

> "When someone asks about tracking or where their order is, ask them for their
> order number if they did not give one. Once we have an order number, just reply
> saying their order has been dispatched and will be with them shortly.
> No need to check the sheet."

The parser generated these steps (WRONG):
1. extract — extracts `customer_name`, `product_description` (speculative, not needed)
2. find_sheet_row — sheet lookup (description explicitly said not to)
3. evaluate — checks for info, but routes `missing order_number → escalate` (WRONG)
4. send_reply
5. complete
6. ask_customer (dead — never reached because evaluate escalated)
7. escalate

What actually happened at runtime: the run escalated immediately because
`order_number` was not in the first email. The customer never got asked.

---

## Root cause

`docs/PLAYBOOK_DESIGN_GUIDE.md` does not have a canonical example of the
**"check if variable missing → ask customer → resume → reply"** pattern.

Without a clear example, GPT-4o defaults to escalate when a required variable
is absent, which is almost never correct.

Additionally the guide's "match complexity to description" principle is not
enforced strongly enough — the parser added `find_sheet_row` despite the
description explicitly saying "no need to check the sheet."

---

## What you must do

### Step 1 — Read the files

Use the filesystem MCP to read:
- `docs/PLAYBOOK_DESIGN_GUIDE.md` (the file you will edit)
- `api/services/playbook/parser.ts` (understand how the guide is injected)
- `api/services/playbook/types.ts` (understand PlaybookStep shape)
- `api/services/playbook/handlers/evaluate.ts` (understand routing options)
- `api/services/playbook/handlers/ask_customer.ts` (understand pause/resume)

Use the postgres MCP to run:
```sql
SELECT id, name, plain_language_description, steps
FROM playbooks
WHERE is_active = true
ORDER BY created_at DESC
LIMIT 5;
```
Study real step shapes so your examples exactly match the schema in production.

### Step 2 — Add the canonical "ask if missing" pattern to the design guide

In `docs/PLAYBOOK_DESIGN_GUIDE.md`, add a clearly labelled section (or update
an existing patterns/examples section) that teaches GPT-4o this pattern:

**Pattern: "Ask customer for missing info, then reply once we have it"**

The correct step sequence is:

```
1. extract        — attempt to extract the variable (e.g. order_number).
                    Mark it optional. It may be null if the customer didn't include it.

2. evaluate       — check: do we have order_number in context?
                    on_true  → send_reply step (happy path)
                    on_false → ask_customer step (NOT escalate)
                    on_unsure → ask_customer step

3. send_reply     — happy path: send the reply (template or AI-drafted)

4. complete       — terminal success

5. ask_customer   — ask the customer for the missing variable.
                    This PAUSES the run (status: waiting_for_customer).
                    When the customer replies, the run resumes from THIS step.
                    The ask_customer handler on resume advances to the NEXT step.

6. extract (second instance, or re-evaluate)
                    — after customer replies, extract the variable from their reply.
                    Then advance to send_reply.

7. escalate       — only if the customer never replied (handled by silence timeout,
                    not by evaluate routing). Should NOT appear as a routing target
                    from evaluate when the variable is simply missing.
```

Key rules to state explicitly in the guide:
- **Never route `on_false → escalate` just because a variable is missing.**
  Escalate is for situations where the system cannot make progress even with
  more information (e.g. fraud, policy limit exceeded, unknown product).
  Missing info → ask the customer.
- **ask_customer pauses the run.** On resume (customer reply), the run
  continues from the step AFTER ask_customer in array order.
  So the step immediately after ask_customer in the array is what runs next
  on the customer's reply. Design the array order accordingly.
- **escalate should sit at the bottom of the step array** as a last resort,
  reachable only by explicit `advance_to` from evaluate or branch when
  the situation is genuinely unresolvable.

### Step 3 — Strengthen the "match complexity to description" rule

Find where the design guide talks about matching complexity to description.
Make the rule more explicit with these additions:

- If the description says "no need to check the sheet" or "don't look up the sheet"
  or any equivalent, do NOT generate `find_sheet_row` or `update_sheet` steps.
- If the description is a pure conversational flow (ask → reply), do NOT add
  sheet steps. Sheet steps require explicit mention of sheet lookups in the description.
- If in doubt: fewer steps is better. The client can always add steps later.

### Step 4 — Add a worked example

Add a complete worked example to the design guide for this exact scenario:

**Description:** "When someone asks about tracking, ask for their order number
if they didn't include it. Once we have it, reply that their order has been
dispatched and will arrive shortly. No sheet lookup needed."

**Expected steps output:**
Show the full JSON step array that GPT-4o should generate for this description,
using the exact field names and shapes from the real schema you read in Step 1.
Make sure `evaluate` routes `on_false → ask_customer`, not escalate.
Make sure there is no `find_sheet_row` step.

### Step 5 — Verify no other patterns in the guide teach wrong escalation routing

Scan the rest of `docs/PLAYBOOK_DESIGN_GUIDE.md` for any examples where
`evaluate` routes `on_false → escalate` for a simple missing-variable case.
Fix them to route to `ask_customer` or document why escalate is correct there.

---

## Constraints

- Do NOT change `api/services/playbook/parser.ts` or any handler code.
  The fix is entirely in the design guide document.
- Do NOT add new step types or change the schema.
- Do NOT break the workspace-aware column injection — the guide already has
  a section about this. Leave it intact.
- Write the guide additions in clear, direct language. GPT-4o reads this as
  a system prompt — it needs to be unambiguous, not prose-heavy.
- Use concrete JSON examples with real field names from the schema.

---

## Definition of done

- `docs/PLAYBOOK_DESIGN_GUIDE.md` contains a clear canonical section for
  the "ask if missing" pattern with correct routing.
- The "match complexity to description" rule explicitly covers the no-sheet case.
- A worked example exists for the tracking scenario above.
- No existing examples in the guide teach the wrong `on_false → escalate` routing
  for simple missing-variable cases.
- You have verified the step schema in the worked example matches what the
  postgres query showed for real active playbooks.
