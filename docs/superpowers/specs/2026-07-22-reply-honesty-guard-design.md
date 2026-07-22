# Reply honesty guard + Tracking Wanted rebuild

Date: 2026-07-22
Branch: `feature/email-autopilot-rethink` (prod runs this branch via Dokploy; not merged to main)
Status: approved design, pre-implementation

## Problem

Client (Exclusive Motors, NZ auto-parts store) reports AI replies are "dumb" and sometimes
fabricate. Concrete failure: a "Tracking Wanted" reply to a customer (Nick) invented a
seller email (`exclusiveparts3@gmail.com`) and told the customer to "contact the seller
directly", as if Exclusive Motors is not itself the seller.

Root causes, evidence-based (live prod + code inspection):

1. **Playbooks bluff.** The `Tracking Wanted` playbook (id 24, the highest-volume one, most
   of the ~100 review-queue approvals) is: extract(customer_name, order_number) -> evaluate
   -> send_reply goal *"Reassure the customer that their order is on the way"* -> complete.
   There is **no lookup step**. The order number is extracted then discarded. The reply goal
   instructs an unverifiable assertion, so GPT-4o fills the gap with mush ("I'll chase our
   shipping partners") or invention (a fake seller email).

2. **The generator teaches bluffing.** `docs/PLAYBOOK_DESIGN_GUIDE.md` (read at runtime by
   the parser to generate playbooks) never states "don't claim what you can't verify". Its
   `send_reply` section is silent on null/missing `reference_context`, and Example 5 models
   the bad pattern: a no-lookup playbook whose goal is *"Tell the customer their order has
   been dispatched and will be with them shortly"*. So the bug regenerates with every new
   playbook, not just this one.

3. **No identity anchor / anti-fabrication rule in the composer.** `composer.ts` injects a
   `STORE CONTEXT` block "to use naturally" but never tells the model it *is* the seller and
   never forbids inventing contact details, tracking, or dates.

Not the cause (ruled out): model is `gpt-4o` (fine); store profile is rich and correct (the
"48h / 3-12 day" figures in replies are real, sourced from `workspaces.store_description`,
not hallucinated); the trust ramp works (all replies are Draft-only, nothing auto-sent).

## Non-goals

- No sheet or Shopify tracking lookup. The client has no tracking data ("we just say it's on
  its way") and `sheet_columns` is not synced for the workspace. A lookup would be theatre.
  Genuinely-smart tracking (auto-escalate orders older than ~12 days, name the exact item) is
  a clean **Phase 2**: sync sheet columns + add a `find_sheet_row` step. Parked, not built.
- No change to categorisation, the trust ramp, or OAuth.

## Design

Four changes, each targeting a different level where the bluff originates.

### 1. Composer honesty + identity guard (code)

File: `api/services/playbook/composer.ts`. Add one shared, exported constant used by BOTH
`composeReplyBody` (reply RULES, ~L226-236) and `composeAskDecision` (ask RULES, ~L132-142),
so the two prompts cannot drift (the file's stated reason to exist):

```
- You are writing as our store (see STORE CONTEXT) - you ARE the seller the customer bought
  from. Never tell the customer to contact "the seller", a supplier, or any other company or
  email address about their own order; they are already talking to us.
- Only state facts present in STORE CONTEXT, WHAT WE KNOW, or the thread. Never invent or
  guess an order number, tracking number, email address, phone number, URL, price, refund
  amount, or delivery date. If the customer asks for something we don't have (e.g. a tracking
  number), say honestly that we don't have it to hand and give the real next step.
```

This is the safety net that applies to every playbook regardless of its goal text, and is the
single change that would have stopped the Nick reply. Applies to reply + ask paths (both
customer-facing). Requires a redeploy to take effect.

### 2. Design-guide anti-bluff rule (docs)

Files: `docs/PLAYBOOK_DESIGN_GUIDE.md` AND `api/docs/PLAYBOOK_DESIGN_GUIDE.md` (byte-identical
duplicates; dev reads the git-mounted `./docs` copy, prod reads the copy baked into the image,
so both must change and stay in sync). Add a canonical rule in the `send_reply` section
(~L350-390) making the buried Example-2 wisdom a hard rule:

> **Never bluff.** A reply goal may only promise information the playbook actually has. If a
> fact (tracking number, dispatch date, refund amount) is not produced by an earlier step or
> present in the store profile, the goal must instruct an honest fallback (e.g. "let them know
> we'll email tracking once it ships"), never an unverifiable claim (e.g. "tell them it has
> shipped"). If a reply needs order-specific data, add a `find_sheet_row` step before it.

And fix Example 5 (~L892-945): change its bluffing goal to an honest one so the generator stops
learning the pattern. Requires a redeploy for prod generation to pick it up.

### 3. Rebuild the Tracking Wanted playbook (prod data, via dashboard editor)

Keep the 6-step shape, change two goals; no new step types, all within current engine
capability (`evaluate` branches satisfied / missing / escalate):

1. `extract`: customer_name, order_number (unchanged)
2. `evaluate`: triage. Goal: "Do we have an order number or enough detail to identify the
   order, and is this a normal 'where is my order' chase rather than an angry/repeated
   complaint or an order that sounds significantly overdue (e.g. more than ~2 weeks)?"
   - if_satisfied_goto -> send_1 (normal chase)
   - if_missing_goto -> ask_1 (no order number/details)
   - if_escalate_goto -> escalate_1 (upset / long-overdue / repeat)
3. `send_reply` (honest goal): "Reply as Exclusive Motors to a customer asking where their
   order is. Acknowledge them by name and reference their order. Let them know it's on its way
   and being processed. Give our real timeline: we usually dispatch within about 48 hours and
   NZ-wide delivery normally takes around 3 to 12 days. Be upfront that we don't have a live
   tracking number to share, and invite them to reply if it's already been longer than about
   12 days so we can chase it up. Do NOT invent a tracking number, order status, or any
   contact details, and never tell them to contact anyone else. Short, NZ-friendly voice."
   reference_context: [customer_name, order_number]
4. `complete`
5. `ask_customer` (unchanged intent): ask for the missing order number/details
6. `escalate`: "Customer chasing an order that appears significantly overdue, or is upset or
   repeating - needs a human to check and reply personally."

Takes effect immediately in prod (data), no deploy. Verify with the editor's "Test with
example email" before activating.

### 4. Store profile identity line (prod data, zero deploy)

Append to the workspace store profile (Settings -> Workspaces -> STORE PROFILE):

> We are the seller. Customers buy directly from Exclusive Motors (we are not a marketplace
> middleman). If a customer needs to reach us they simply reply to this email - never direct
> them to another email address, supplier, or company.

Immediate mitigation that reduces fabrication the moment it is saved, before the code redeploys.

## Rollout

- **Code (1 + 2):** commit on `feature/email-autopilot-rethink`; Fabien redeploys via Dokploy.
- **Prod data (3 + 4):** applied live in the dashboard, no deploy. Owner: TBD (Fabien to
  confirm whether Claude makes these live changes or he does).
- Suggested order: profile line (4) now as instant mitigation -> ship code (1 + 2) -> once
  deployed, rebuild + Test + activate Tracking Wanted (3).

## Testing & verification

- **TDD** for change 1: failing tests first in `api/services/playbook/composer_test.ts`
  asserting the guard text is present in both the reply and ask system prompts. Run with
  `DATABASE_URL=postgres://emaildash:changeme@localhost:5432/emaildash API_SECRET=test-secret
  deno test` from `api/`. Whole suite (79 tests today) must stay green.
- **Change 3:** editor "Test with example email" against a Nick-style headlight enquiry;
  confirm no invented email/tracking and a correct honest reply, before activating.
- **Prod smoke:** after redeploy, one live-ish reply generation reviewed in the queue to
  confirm the guard fires end to end.

## Open items to confirm during implementation

1. Which guide copy is baked into the prod image (`COPY` lines in `api/Dockerfile`) - edit both
   regardless; verify the live one picks up the change post-deploy.
2. Whether the playbook editor supports editing a step's goal text inline, or whether change 3
   is done by rewriting the plain-language description + "Generate Steps" (needs guide 2
   deployed first for an honest regeneration) or by direct step-JSON edit.
3. Ownership of the two prod-data changes (3 + 4).
