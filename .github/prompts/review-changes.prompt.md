---
agent: 'agent'
description: 'Review uncommitted changes against project conventions and architecture'
tools: ['search/codebase', 'runCommands']
---

# Review changes

## Steps

1. **Run `git diff` and `git status`** to see uncommitted changes.

2. **Read the relevant convention files** for the areas being changed:
   - `.github/copilot-instructions.md` - always
   - `.github/instructions/backend.instructions.md` - if `api/**` changes
   - `.github/instructions/frontend.instructions.md` - if `frontend/**` changes
   - `.github/instructions/sql.instructions.md` - if `*.sql` changes
   - `docs/PLAYBOOK_ENGINE.md` - if playbook engine changes

3. **Check for**:
   - Convention violations (style, patterns, banned APIs)
   - Architecture mismatches (does this fit the playbook vision?)
   - Missing transactions on multi-statement DB writes
   - Workspace scoping on queries
   - Duplication of existing utilities (token refresh, OpenAI wrapper)
   - Dead code being added
   - Fire-and-forget patterns being added
   - Svelte 4 syntax sneaking in
   - Missing error handling
   - Hardcoded values that should be config
   - Missing TASK_LOG updates for non-trivial work

4. **Output**:
   - **Blockers**: things that must be fixed before commit
   - **Warnings**: things that should be fixed but aren't blocking
   - **Suggestions**: nice-to-haves
   - **Compliments**: what was done well (keep it short, real)

5. Don't apply fixes. Just report.
