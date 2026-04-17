# Architecture

This is the canonical architecture reference for the Email Automation system. It supersedes `PLAYBOOK_ENGINE.md` (kept for historical context).

---

## System overview

A dashboard that sits between Gmail + Google Sheets and the client's manual workflow. Inbound emails are categorised by AI, then:
- Assigned to a **playbook** - a multi-step automation flow
- Or (for categories without a playbook) processed by the **legacy draft flow** - a single AI draft queued for review

The client uses Gmail + Google Sheets as source of truth. The system labels Gmail threads and writes back to the sheet when threads progress.

---

## Stack

- **Backend**: Deno + Hono (TypeScript), running in Docker
- **Database**: Postgres 16. Migrations in `api/db/migrations/`, applied sequentially via `api/db/migrate.ts`
- **Frontend**: SvelteKit 5 with runes (`$state`, `$derived`, `$effect`)
- **Deployment**: Docker Compose locally; Dokploy on VPS in production
- **External APIs**: Gmail REST v1, Sheets REST v4, OpenAI Chat Completions
- **Auth**: Single `API_SECRET` bearer token; no per-user sessions

---

## Core concepts

### Category
A named type of email (e.g. "Refund Request", "Tracking Request"). Owns a playbook. The AI classifies inbound threads into categories.

### Playbook
A named, versioned sequence of steps attached to a category. Created and edited by the client in plain language - the AI interprets the description into structured steps. Stored in `playbooks.steps` as JSONB.

### Run
A per-thread execution of a playbook. Has a context bag (key-value variables collected during execution), a current step cursor, and a status. Stored in `playbook_runs`.

### Step execution
A record of one step running within a run. Captures inputs, outputs, AI calls, errors, timing. Stored in `playbook_step_executions`.

### Context bag
A `Record<string, unknown>` per run. Stores extracted variables (`order_number`, `customer_name`), found row references (`row_number`), and other state. Persists across pauses.

---

## Data model

```
workspaces
  id, name, gmail_address, sheet_id, sheet_name

categories
  id, workspace_id, name, description, instructions,
  allow_auto_reply, confidence_threshold, writing_style, gmail_label_id

threads
  id, workspace_id, gmail_thread_id, subject, snippet, thread_summary,
  category_id, status, auto_replied

messages
  id, thread_id, gmail_message_id, from_address, body_plain, body_html,
  received_at, direction, message_id_header

drafts
  id, thread_id, body, status, was_auto_sent, ai_model_used

playbooks
  id, workspace_id, category_id, name,
  plain_language_description,    -- client-written text (source of truth)
  steps (jsonb),                  -- structured step definitions
  version, is_active

playbook_runs
  id, workspace_id, thread_id, playbook_id, playbook_version,
  current_step_id, status, context (jsonb)

playbook_step_executions
  id, run_id, step_id, step_type,
  status, input (jsonb), output (jsonb), error,
  ai_calls (jsonb), created_at, completed_at

sheet_columns
  id, workspace_id, column_letter, header_name

sheet_rules
  id, workspace_id, name, description, is_active, category_ids,
  match_instruction, match_column, updates (jsonb), auto_apply

sheet_rule_executions
  id, workspace_id, rule_id, thread_id, status, match_value,
  row_number, proposed_updates (jsonb), error, applied_at

oauth_tokens
  id, workspace_id, email, access_token_encrypted, refresh_token_encrypted,
  token_expiry, scopes

oauth_states
  state, created_at

settings
  id, workspace_id, key, value
```

---

## Step types

| Type | Purpose | Config | Decision |
|---|---|---|---|
| `extract` | AI reads thread, pulls named variables into context | `variables: string[]` | advance |
| `find_sheet_row` | Search sheet for a matching row, save row_number to context | `match_attempts: [{column, context_var}]` | advance (row_number = null if not found) |
| `update_sheet` | Write specific columns on a found row | `row_var: string, updates: [{column, value_or_var}]` | advance |
| `ask_customer` | Send a question, pause until customer replies | `message: string, on_reply_goto: string` | pause(waiting_for_customer) |
| `branch` | Route based on condition over context | `condition: string, if_true: string, if_false: string` | advance to chosen step |
| `manual_approval` | Hold for human, with optional pre-drafted reply | `reason: string, draft_template?: string, on_approve: string, on_reject: string` | pause(waiting_for_human) |
| `send_reply` | Send reply (template or AI-generated) | `message: string \| { ai_generate_using_category_voice: true }` | advance |
| `complete` | End the run cleanly | none | complete |
| `escalate` | End the run, flag for human review | `reason: string` | fail/escalated |

**Variable interpolation** in `message` and `value_or_var` fields: `{{variable_name}}` or `{variable_name}` substitutes context bag values.

**Branch conditions** supported: `context.X != null`, `context.X == null`, `context.X` (truthy check).

---

## Inbound email flow

```
Inbound email
  │
  ▼
ingestMessage() - gmail.ts
  │  Upsert thread + message records
  │
  ├─ Thread has active waiting_for_customer run?
  │    └─ YES: resumeRun() - advance from current step
  │
  └─ NO: categoriseAndDraft() - categorisation.ts
           │
           ├─ Category has active playbook?
           │    └─ YES: startRun() - create playbook run, begin executing
           │
           └─ NO: Legacy draft flow (AI draft + optional auto-send)
```

---

## Step executor loop

Located in `api/services/playbook/executor.ts`:

```
advanceRun(runId)
  └─ loop (max 50 iterations):
       load step at current_step_id
       call handler.execute(step, ctx)
       apply contextUpdates to variables
       persist step_execution record
       apply decision:
         advance     → move to next step in sequence
         advance_to  → jump to named step
         pause       → save status, stop loop
         complete    → mark run complete, stop
         fail        → mark run failed/escalated, stop
```

---

## Handler files

```
api/services/playbook/
  executor.ts          - advanceRun, resumeRun, startRun
  registry.ts          - maps step type → handler
  types.ts             - all type definitions
  parser.ts            - plain-language → steps AI call
  dry-run.ts           - sandbox execution (no side effects)
  mod.ts               - barrel exports
  handlers/
    extract.ts
    find_sheet_row.ts  - real Sheets API call (Phase 4)
    update_sheet.ts    - real Sheets API cell write (Phase 4)
    ask_customer.ts
    branch.ts
    manual_approval.ts
    send_reply.ts
    complete.ts
    escalate.ts
```

---

## Frontend routes

```
/                          - Thread list
/threads/[id]              - Thread detail + playbook run panel
/review                    - Review queue (drafts + playbook approvals)
/categories                - Category CRUD
/playbooks                 - Playbook list
/playbooks/[id]            - Playbook editor (description → steps → dry-run → activate)
/sheet-rules               - Sheet rule CRUD
/sheet-updates             - Sheet rule execution history
/settings                  - Workspace config + model settings
```

---

## Security

- All external-facing API calls require `Authorization: Bearer <API_SECRET>` header.
- OAuth tokens stored AES-256 encrypted at rest (`ENCRYPTION_KEY` env var).
- OAuth state parameter verified to prevent CSRF (stored in `oauth_states` table, expires after 10 min).
- All DB queries filter by `workspace_id` - no row-level security in Postgres.

---

## Known limitations (v1)

- One connected Gmail account per workspace. Multi-account is Phase 5+.
- One playbook per category. Conditional playbook selection requires a `branch` step inside one playbook.
- No scheduled triggers - timeouts for silent customers require a separate Deno cron job (not yet implemented).
- Sheet writes go directly to Google Sheets on every step - no batching or queuing.
- Playbook parser uses `gpt-4o` regardless of workspace model setting (parser needs best reasoning).
