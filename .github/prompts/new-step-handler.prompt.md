---
agent: 'agent'
description: 'Add a new playbook step type with handler, registry entry, and editor UI'
tools: ['search/codebase', 'edit', 'runCommands']
---

# Add a new playbook step handler

Step type to add: ${input:stepType:Step type name (snake_case)}
What it does: ${input:description:One sentence description}

## Steps

1. **Read `docs/PLAYBOOK_ENGINE.md`** section "Step type definitions" for the schema and conventions.

2. **Add the type definition** to `api/services/playbook/types.ts`:
   - Extend the `PlaybookStep` discriminated union with the new type
   - Define the input schema (what config the step takes)
   - Define the output schema (what it produces in context)

3. **Implement the handler** at `api/services/playbook/handlers/${input:stepType}.ts`:
   - Export a `StepHandler` matching the interface in `types.ts`
   - Validate inputs against the schema
   - Perform the action (DB write, AI call, external API call)
   - Return the next-step decision: `advance` | `pause('waiting_for_customer'|'waiting_for_human')` | `complete` | `fail`
   - Write any context updates back

4. **Register it** in `api/services/playbook/registry.ts`.

5. **Add the editor UI** at `frontend/src/lib/components/playbook-steps/${input:stepType}.svelte`:
   - Form for editing the step config
   - Use SvelteKit 5 runes
   - Match the styling of existing step editors

6. **Wire it into the parser prompt** in `api/services/playbook/parser.ts`:
   - Add the step type to the available types list
   - Add an example of when to use it
   - Add an example of how it should be configured

7. **Test**:
   - Use Postgres MCP to insert a test playbook using the new step
   - Run a thread through it
   - Verify execution log shows the step running correctly
   - Verify the editor UI loads, edits, and saves the step config

8. **Update docs**:
   - Add the new step type to `PLAYBOOK_ENGINE.md` step type table
   - Update `TASK_LOG.md` with what was added and why
