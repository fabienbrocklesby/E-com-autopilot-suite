---
agent: 'agent'
description: 'Phase 4: migrate existing categories to playbooks, deprecate old paths, polish'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query', 'mcp_playwright']
---

# Phase 4: Migration and Polish

Goal: Move all existing category logic into playbooks. Deprecate `categoriseAndDraft` legacy path. Absorb sheet rules into step types. Add multi-workspace UI. Document for handoff.

## Required reading

- `docs/PLAYBOOK_ENGINE.md`
- `docs/TASK_LOG.md` - Phase 3 done with passing Playwright test
- All existing categories and sheet rules in production data (use Postgres MCP to inspect)

## Tasks

### 1. Migrate existing categories one at a time

For each existing category in production:
1. Talk to Fabien about what the category should actually do (the current behaviour is auto-reply or manual review based on confidence - that's it)
2. Write a playbook for it using the editor built in Phase 3
3. Activate it on a small percentage of incoming threads (use a feature flag in workspace settings, e.g. `playbook_rollout_percentage`)
4. Monitor for 24 hours
5. Roll up to 100% if no issues

Order of migration (least risky first):
1. Tracking requests (read-only, simple)
2. Refund requests (sheet writes + manual approval)
3. Order changes (branching logic)
4. Damaged/wrong item (manual-heavy)
5. General/fallback (catch-all)

### 2. Sheet rules → playbook step types

Existing sheet rules become single-step playbooks or get absorbed into multi-step ones.

Migration script `api/scripts/migrate_sheet_rules_to_playbooks.ts`:
- For each `sheet_rules` row, generate a playbook with `find_sheet_row` + `update_sheet` steps
- Link to the same categories the rule applied to
- Mark the original sheet rule as `is_active = false`

After 2 weeks of stable operation:
- Migration `013_drop_sheet_rules.sql` removes the sheet_rules and sheet_rule_executions tables

### 3. Deprecate `categoriseAndDraft` legacy path

Once every category has an active playbook:
- Add a fallback playbook auto-created for any category without one
- Remove the legacy branch in `gmail.ts` `ingestMessage`
- Delete `categoriseAndDraft` from `categorisation.ts`
- Move the residual categorisation call into a step type or a pre-playbook hook

### 4. Multi-workspace UI

Currently hardcoded to workspace_id=1. Now:
- Add workspace selector to top of `+layout.svelte` (dropdown, persisted to localStorage)
- All API calls include the selected workspace_id as a query param or header
- Backend respects it
- Add workspace creation flow in `/settings`

This unlocks selling the system to multiple stores.

### 5. Polish

- **Loading skeletons** instead of "Loading…" text on key pages
- **Error boundaries** in SvelteKit with proper `+error.svelte` files
- **Real-time updates** on review queue and thread detail (SSE or polling-with-stale-while-revalidate)
- **Retry buttons** on failed step executions
- **Search** on threads page (subject + customer + body)

### 6. Documentation

Write `docs/CLIENT_GUIDE.md`:
- "How to write a playbook" with screenshots
- "How to interpret the thread timeline"
- "How to handle stuck threads"
- "How to add a new category + playbook"
- "How to test before going live (dry-run)"

Write `docs/OPERATIONS.md`:
- Deployment procedure (Dokploy)
- Rollback procedure
- How to inspect production state (read-only DB access patterns)
- How to handle Gmail OAuth re-auth
- How to handle quota limits

Write `docs/ARCHITECTURE.md`:
- Update PLAYBOOK_ENGINE.md to reflect what was actually built
- Move it to ARCHITECTURE.md as the canonical reference

## Workflow

1. Confirm Phase 3 done
2. Migrate categories one at a time, with rollout monitoring
3. After all categories migrated and stable for 2+ weeks: drop legacy path
4. Sheet rules migration in parallel with category migration
5. Multi-workspace UI when ready (no rush)
6. Polish + docs as you go
7. Final commit: update TASK_LOG with phase complete, project at v1.0

## Done criteria

- [ ] Every category has an active playbook
- [ ] Legacy `categoriseAndDraft` deleted
- [ ] Sheet rules migrated, old tables dropped
- [ ] Multi-workspace UI working
- [ ] All polish items done
- [ ] All docs written
- [ ] Client successfully wrote a new playbook themselves without help
- [ ] System has run for 2+ weeks with no manual interventions outside of explicit manual_approval steps
