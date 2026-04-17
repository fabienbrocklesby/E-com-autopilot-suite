---
agent: 'agent'
description: 'Update docs/TASK_LOG.md based on what was done in this session'
tools: ['search/codebase', 'edit', 'runCommands']
---

# Update task log

## Steps

1. **Run `git log --oneline -20`** to see recent commits in this session.

2. **Run `git diff HEAD~N --stat`** (where N is the number of commits this session) to see file-level changes.

3. **Read current `docs/TASK_LOG.md`** to see existing entries and format.

4. **Append a new entry** at the top (most recent first):

   ```markdown
   ## YYYY-MM-DD - <session topic>

   **Phase**: <which phase, e.g. "Phase 0" or "Cross-cutting">
   **Status**: <"in progress" | "complete" | "blocked">

   ### What was done
   - Bullet list of meaningful changes (not every commit, the meaningful ones)
   - Reference files touched
   - Reference migrations added

   ### Validation
   - How was this verified? (manual test, Postgres MCP query, Playwright run, etc.)
   - Link to evidence if applicable

   ### Decisions made
   - Any architectural or product decisions made during this session

   ### Open questions / blockers
   - Anything Fabien needs to weigh in on
   - Anything that's blocking next steps

   ### Next
   - What should happen next session
   ```

5. **Confirm the entry** is written and saved.

6. **Suggest a commit message** if anything else needs committing: `docs: update task log for <session topic>`
