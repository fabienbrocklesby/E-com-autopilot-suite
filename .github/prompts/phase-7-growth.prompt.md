---
agent: 'agent'
description: 'Phase 7: growth features - playbook templates, testing harness, learning loop, richer step types'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query', 'mcp_playwright']
---

# Phase 7: Growth

Goal: The engine is smart (Phase 5) and hardened (Phase 6). Now make it easier for new clients to adopt and for existing clients to get better results over time. This phase is about multiplying value from the foundation we've built.

## Required reading

- `docs/PLAYBOOK_ENGINE.md`
- `docs/TASK_LOG.md` - Phase 6 done, system stable in production
- `docs/CLIENT_GUIDE.md` - the handoff doc from Phase 4

## The 5 growth tasks

Implement whichever makes the most business sense first. These are roughly independent and can be sequenced based on what clients are asking for.

### 1. Playbook template library

Problem: every new client has to write their playbooks from scratch. High friction to onboard.

**Schema**: new table `playbook_templates`:

```sql
CREATE TABLE playbook_templates (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,          -- "refund", "tracking", "order_change", etc
  industry TEXT,                   -- "ecommerce", "saas", etc
  description TEXT NOT NULL,
  plain_language TEXT NOT NULL,    -- the source description
  steps JSONB NOT NULL,            -- pre-parsed steps
  voice_examples TEXT,             -- example writing style
  required_sheet_columns TEXT[],   -- what columns the sheet needs
  is_official BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Seed data**: create `api/db/seeds/playbook_templates.sql` with 10-15 templates:
- E-commerce: refund, tracking, order change, damaged item, cancellation, address change, return, exchange
- Customer service: FAQ, feedback, complaint, compliment
- Ops: supplier query, B2B enquiry, press enquiry

Each template is a fully-formed playbook that works out of the box.

**Backend**:
- `GET /playbook-templates` - list
- `GET /playbook-templates/:slug` - detail
- `POST /playbooks/from-template` - body `{template_slug, category_id, customizations?}` - creates a new playbook for the workspace based on the template

**Frontend**: new page `/playbooks/new/+page.svelte`:
- "Start from scratch" vs "Start from template" choice
- Template browser: cards grouped by category, search, filter by industry
- Clicking a template shows preview of steps + what sheet columns it needs
- "Use this template" → prompts for category and any customisations → creates playbook

This is the biggest onboarding accelerator. A new Light Lane client goes from zero to running in 20 minutes instead of a day.

### 2. Playbook testing harness

Problem: clients change playbooks and don't know if they broke something. No regression testing.

**Schema**: new tables:

```sql
CREATE TABLE playbook_tests (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL,
  playbook_id INT NOT NULL,
  name TEXT NOT NULL,
  input_email JSONB NOT NULL,       -- {subject, from, body}
  expected_outcomes JSONB NOT NULL, -- {final_status, must_extract: [...], must_update_sheet?: [...], must_send_reply_matching?: "regex"}
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE playbook_test_runs (
  id SERIAL PRIMARY KEY,
  test_id INT NOT NULL REFERENCES playbook_tests(id) ON DELETE CASCADE,
  playbook_version INT NOT NULL,
  passed BOOLEAN NOT NULL,
  failure_reason TEXT,
  actual_trace JSONB,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Backend**: test runner that:
1. Creates a sandboxed playbook run (no real emails sent, no real sheet writes)
2. Injects the test input as the first message
3. Executes through the playbook
4. Captures the full trace
5. Compares against expected outcomes
6. Records pass/fail

Endpoint: `POST /playbooks/:id/tests/run-all` - runs all tests for this playbook, returns results.

Auto-run: every time a playbook is saved, all its tests run. Block save if a regression appears (with override option).

**Frontend**:
- Tests tab on playbook detail page
- "Create test from current thread" button on any thread - captures the email content and asks the user to define expected outcomes
- Test results visible per playbook version

This is what unlocks confident iteration on playbooks.

### 3. Learning loop from human corrections

Problem: when a human edits an AI-drafted reply in the review queue, we record it in `interactions` but don't feed it back effectively. The AI keeps making the same mistakes.

**Schema**: extend `interactions` with:

```sql
ALTER TABLE interactions ADD COLUMN category_id INT REFERENCES categories(id);
ALTER TABLE interactions ADD COLUMN playbook_id INT REFERENCES playbooks(id);
ALTER TABLE interactions ADD COLUMN step_type TEXT;
ALTER TABLE interactions ADD COLUMN diff_summary TEXT;  -- AI-generated summary of what changed
```

**Backend**:
- When a human edits and approves a draft, call AI to generate a `diff_summary`: "Human changed the greeting from 'Dear Sir' to 'Hey mate' and removed the formal sign-off."
- Store this with the interaction
- When generating future drafts, include relevant recent diff_summaries as additional context: "Note: recent human edits on this category have preferred casual greetings over formal ones."

**Frontend**: on the playbook detail page, add a "Recent human corrections" section showing the diffs. Helps the client see what the AI keeps getting wrong and update their playbook guidance.

This makes the system measurably better over time without any manual prompt tuning.

### 4. Richer step types for common integrations

Problem: the 9 step types cover the core but clients ask for more. Add integrations as first-class steps, not custom code per workspace.

**New step types** (implement each using the ai-driven-step skill pattern):

- `lookup_tracking` - takes a tracking number, queries a shipping API (NZ Post, Shippit, AfterShip as configurable providers), stores status in context. Handler config: `{tracking_var, provider, store_to}`.

- `notify_slack` - posts a message to a Slack webhook. Config: `{webhook_url_ref (from settings), message_template, include_context_keys}`. Useful for "notify ops when a refund > $500 needs approval".

- `wait_until` - schedules the run to advance at a specific time. Config: `{duration_hours}` or `{condition_context_key_set: true}`. Enables "follow up with customer in 48 hours if no reply" patterns.

- `ai_classify` - pure AI classification step, doesn't ask or reply, just categorises something and stores to context. Config: `{goal, classes: [{name, description}], store_to}`. Useful for nested decisions like "is this complaint about shipping, product, or service?"

- `sheet_append_row` - adds a new row to a sheet. Config: `{sheet_id?, values: [{column, value_or_var}]}`. Useful for lead capture flows.

Each one follows the ai-driven-step pattern from Phase 5. Parser updates to teach the AI when to suggest them.

### 5. Multi-playbook workspaces: playbook routing

Problem: currently one playbook per category. Some categories benefit from multiple playbooks chosen at runtime.

Example: a "general enquiry" category might have different playbooks for B2B vs B2C customers. Or a "refund" category might have a different flow for orders under $50 vs over $50.

**Schema**: add `routing_conditions JSONB` to `playbooks` (nullable). If multiple playbooks exist for a category, route based on these conditions.

```json
{
  "conditions": [
    {"context_var": "order_total", "operator": "gt", "value": 50, "priority": 1},
    {"context_var": "customer_type", "operator": "eq", "value": "b2b", "priority": 2}
  ],
  "default": false
}
```

**Backend**: when a thread is categorised, if multiple active playbooks exist for the category:
1. Run `extract` step first (at the category level, before any playbook starts) to get basic vars
2. Evaluate routing conditions in priority order
3. First match wins; if no match, use the playbook marked `default: true`

**Frontend**: playbook editor gets a "Routing conditions" section when more than one playbook exists for the category.

This keeps things simple for clients who only need one playbook per category while unlocking power users.

## Workflow

Pick the task that matches what clients are asking for. Rough business priority:

1. **Template library (#1)** - if you're onboarding new clients. Biggest go-to-market impact.
2. **Testing harness (#2)** - if existing clients are hesitant to edit playbooks. Biggest confidence-unlock.
3. **Richer step types (#4)** - if clients are asking "can it do X?". Biggest capability-unlock.
4. **Learning loop (#3)** - if AI reply quality is the top complaint.
5. **Playbook routing (#5)** - only when a client specifically needs it. Adds complexity, do last.

Each task is a 3-5 day effort. Don't try to do all 5 in one phase.

## Workflow per task

1. Design first: sketch the schema, the API shape, the UI
2. Get Fabien to confirm the shape before building
3. Implement: migration → backend service → backend route → frontend → test
4. Document in `docs/CLIENT_GUIDE.md`
5. Update `docs/PLAYBOOK_ENGINE.md` if architecture changes
6. Update `docs/TASK_LOG.md`

## Done criteria (per task)

Task 1: new client can onboard in under 30 minutes using templates
Task 2: client can iterate on a playbook without fear of breaking existing flows
Task 3: AI-drafted replies show measurable improvement over 2 weeks of corrections
Task 4: each new step type is documented, parser-aware, and used in at least one real playbook
Task 5: a workspace runs multiple playbooks on the same category with correct routing

## What NOT to do in this phase

- Don't rebuild core engine pieces. Phase 5 made them smart. Trust them.
- Don't add payment step types (Stripe charges). Regulatory and liability minefield.
- Don't build a "no-code automation builder" UI. Playbooks are the UI.
- Don't add a public API for external automation. Keep this internal.
- Don't chase features just because they're easy. Each task should tie back to revenue or adoption.
