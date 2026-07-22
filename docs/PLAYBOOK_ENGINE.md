# Playbook Engine - Architecture Reference

This is the canonical reference for the playbook engine. Every Phase 2+ piece of work must align with this document. If reality diverges from this doc, update this doc first, then code.

## The shift

Today, categories are tags with settings. Categorisation, drafting, sheet rules, and auto-reply are sibling primitives that the user must wire together mentally.

Tomorrow, **categories own playbooks**. A playbook is a multi-step flow: extract info, find sheet rows, ask the customer for missing info, update sheets, hold for human approval, send replies. Each thread runs an isolated instance of a playbook with its own context bag and step cursor.

The user's mental model: "I'm writing a SOP for a new staff member, and the AI follows it."

## Core concepts

### Playbook
A named, versioned sequence of steps attached to a category. Owned by a workspace.

### Step
A unit of work. Has a unique ID within the playbook, a type, and type-specific config.

### Run
A per-thread execution of a playbook. Has a context bag (variables collected so far), a current step cursor, and a status.

### Step execution
A record of one step running. Captures inputs, outputs, AI calls, errors, timing.

### Context bag
A `Record<string, unknown>` per run. Stores extracted variables (`order_number`, `customer_name`), references (`row_number`), and any state collected by steps. Persists across pauses.

## Data model

```
playbooks
  id, workspace_id, category_id, name,
  plain_language_description (the source-of-truth text the user wrote),
  steps (jsonb array of structured step definitions),
  version (incremented on edit), is_active

playbook_runs
  id, workspace_id, thread_id, playbook_id, playbook_version,
  current_step_id (text id of step the run is positioned at),
  status (running, waiting_for_customer, waiting_for_human, complete, failed, escalated),
  context (jsonb)

playbook_step_executions
  id, run_id, step_id, step_type,
  status (pending, running, success, failed, skipped),
  input (jsonb), output (jsonb), error,
  ai_calls (jsonb array of {model, prompt, response, tokens}),
  created_at, completed_at
```

## Step types

| Type | Purpose | Config | Decision |
|---|---|---|---|
| `extract` | AI reads thread, pulls named variables into context | `variables: string[]` | advance |
| `find_sheet_row` | Search sheet for a matching row, save row number to context | `match_attempts: [{column, context_var}]` | advance / fail |
| `update_sheet` | Write specific columns on a row | `row_var: string, updates: [{column, value_or_var}]` | advance |
| `ask_customer` | AI-driven: writes a contextual message to gather missing info. Skips if info already present. Escalates if conversation is stuck. | `goal: string, required_context: string[], on_reply_goto: string, voice_hint?: string, message?: string` (message is legacy fallback) | pause(waiting_for_customer) or advance_to or fail |
| `branch` | Deterministic routing on a simple condition. Use only for literal null/value checks. | `condition: string, if_true: string, if_false: string` | advance to chosen step |
| `evaluate` | AI-driven three-way routing. Use when the decision requires judgment: "do we have enough info?", "is the conversation stuck?". | `goal: string, required_context: string[], if_satisfied_goto: string, if_missing_goto: string, if_escalate_goto: string` | advance to chosen step |
| `triage` | AI-driven route selection for intent/actionability decisions ("is this worth replying to?", "which workflow applies?"). Distinct from `evaluate`, which is a variable-presence gate rather than an intent router. | `goal: string, routes: [{label, description, goto}], fallback_goto: string, confidence_threshold?: number` | advance to the chosen route, or `fallback_goto` when unsure, invalid, or below threshold |
| `manual_approval` | Hold for human. Captures free-text input (e.g. Stripe transaction ID) when `capture_input: true`. | `reason: string, capture_input?: boolean, input_prompt?: string, input_context_key?: string, on_approve: string, on_reject: string` | pause(waiting_for_human) |
| `send_reply` | Send reply. Preferred: AI-drafted from goal + reference_context. Fallback: literal message. | `goal?: string, reference_context?: string[], voice_hint?: string, message?: string` | advance |
| `complete` | End the run cleanly | none | complete |
| `escalate` | End the run, flag for human, leave thread in review | `reason: string` | fail |

## Step execution flow

```
┌─────────────────────────────────────────┐
│  Inbound email arrives on thread T      │
└─────────────────┬───────────────────────┘
                  │
                  ▼
       ┌──────────────────┐
       │ Active run on T? │
       └────┬─────────┬───┘
            │ yes     │ no
            ▼         ▼
    ┌───────────┐  ┌──────────────┐
    │ Resume    │  │ Categorise   │
    │ run from  │  └──────┬───────┘
    │ current   │         ▼
    │ step      │  ┌────────────────┐
    └─────┬─────┘  │ Category has   │
          │        │ active playbook?│
          │        └────┬───────┬───┘
          │             │ yes   │ no
          │             ▼       ▼
          │      ┌──────────┐ ┌────────────────┐
          │      │ Create   │ │ Place thread    │
          │      │ run, run │ │ in_review for   │
          │      │ from     │ │ manual triage   │
          │      │ step 1   │ └────────────────┘
          │      └────┬─────┘
          │           │
          ▼           ▼
       ┌───────────────────────┐
       │ Step executor loop:   │
       │ - load step           │
       │ - run handler         │
       │ - apply decision      │
       │ - persist execution   │
       │ - if 'advance', loop  │
       │ - if 'pause', stop    │
       │ - if 'complete', stop │
       │ - if 'fail', escalate │
       └───────────────────────┘
```

Note: "Place thread in_review for manual triage" is a terminal state for that path, there is no run to hand off to the step executor loop, since no playbook exists for the category. This replaces the removed legacy behaviour, which used to auto-generate a draft in the now-retired `drafts` table.

## Plain-language to structured magic

The client writes:

> When someone asks for a refund, find their order in the sheet using their order number, name, or email. If you can't find it, ask them for the order number. If they didn't say why, ask them. Once you've got both, mark the sheet status as Refund Requested and send it to me for approval. Once I approve, reply to confirm.

The parser turns this into structured steps. The system prompt tells the AI:

- The available step types (table above)
- The available context variables (from extraction history)
- The available sheet columns for this workspace
- The voice/tone settings for replies

The AI returns JSON. We validate, render in the UI as cards, the client tunes individual steps if needed.

**Edits**: when the client rewrites the description, we re-parse but preserve manual edits to specific steps where step IDs match. If a step ID is gone in the new parse, we keep the old step as orphaned and let the client decide.

## UX principles

1. **Plain language is the source of truth**, structured is the projection
2. **Every step is editable individually** - don't make the user re-write the whole thing to change one question
3. **Dry-run before activate** - paste an example email, see the trace, before turning it on
4. **Per-thread visibility** - the thread page shows current playbook, current step, context bag, full execution log
5. **Pause states are first-class** - "waiting for customer" and "waiting for human" must be visually distinct from "running"

## Versioning

When a playbook is edited, increment `version`. Active runs continue on the version they started with. New runs use the latest version.

There's no automatic migration of in-flight runs to new versions. If the client wants that, they can manually escalate the run and let it re-start.

## Sheet rules - the migration

In Phase 4, sheet rules become single-step playbooks (or get absorbed into multi-step ones). A sheet rule with one match column and three updates becomes:

```
1. find_sheet_row { match_attempts: [{column, context_var}] }
2. update_sheet { row_var, updates: [...] }
3. complete
```

Sheet rules running today already produce the same effect; this is purely a code consolidation.

## Open architectural questions

These need answers before Phase 2 starts. Track resolutions here:

1. **Where does customer-silence timeout live?** Per-step config (`pause_timeout_hours`)? Per-playbook? Workspace default? **Decision**: per-playbook setting `customer_silence_hours: int` defaulting to 168 (7 days). After timeout, run goes to `escalated`.

2. **Can a playbook switch categories mid-run?** Customer asks about tracking, then mid-thread asks about a refund. **Decision** for v1: no, the run continues on the original playbook. The `manual_approval` step is the escape hatch - the human can re-categorise from the review queue.

3. **Multiple playbooks per category?** v1: one per category. The category determines the playbook deterministically. If you need conditional playbook selection, do it inside one playbook with a `branch` step.

4. **Variable name conventions?** Free-form per playbook for v1. Phase 4 may introduce a workspace-level "context schema" that constrains variable names for consistency.

5. **What about extract on every step vs only at thread start + customer reply?** Only at start and customer reply, to save tokens. Steps that need a value from the email content can re-extract via a sub-AI-call if absolutely needed, but should prefer reading from context.

## Gmail label sync

**Default source of truth**: two-way sync between dashboard categories and user-created Gmail labels.

**Optional Gmail-authoritative mode**: when the `gmail_labels_authoritative` setting is `true`, Gmail labels are the routing source of truth. Inbound emails skip AI categorisation; the first Gmail label ID that matches a dashboard category's `gmail_label_id` determines the category, and the active playbook for that category starts with confidence `1`. If no Gmail label matches, the thread goes to `in_review` without an AI categorisation attempt.

### Behaviours (settled as of Phase 0)

| Scenario | Behaviour |
|---|---|
| Create category in dashboard | Gmail label created with same name on next `/labels/sync` |
| Rename category in dashboard | Gmail label renamed via `users.labels.patch` on next sync |
| Delete category in dashboard | Gmail label is NOT deleted automatically (manual cleanup) |
| Create label in Gmail | Category and blank inactive playbook created on next `/labels/sync` |
| Rename label in Gmail | On next sync, dashboard sees the old linked label id still exists, so no rename propagates back - the Gmail label takes the dashboard name on next rename sync |
| Enable Gmail-authoritative mode | Label sync no longer creates or renames Gmail labels from dashboard categories; it only links/imports Gmail labels into dashboard categories |

### Implementation

- `syncLabels(email, workspaceId)` in `api/services/gmail.ts`
- Pass 1: categories → Gmail (create missing labels, rename mismatched ones)
- Pass 2: Gmail → dashboard (import untracked user labels as blank categories with inactive playbooks)
- Gmail-authoritative mode skips Pass 1 and uses `categoriseFromGmailLabels()` during ingestion
- `gmailPatch<T>` helper added for `PATCH /gmail/v1/users/{userId}/labels/{id}`

## What this engine does NOT do (yet)

- External API calls beyond Gmail and Sheets (no shipping APIs, no Stripe, no Slack - those are step types we add later)
- Scheduled triggers (no "remind me in 24 hours" without a customer reply)
- Cross-thread orchestration (each thread is independent)
- A/B testing of playbooks (Phase 4 might add this)
- Versioned context schemas (Phase 5+)

## How this doc evolves

Update this doc when:
- A new step type is added (update the table)
- An open question is decided (move from "open" to a settled section)
- Architecture changes (then the code follows)

Don't update this doc retroactively to match what was built. If something diverges, it's either a bug or an architecture change that needs explicit acknowledgment.
