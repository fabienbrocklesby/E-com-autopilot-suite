# Execution Order

These prompts are designed to be run in a specific order. Each one is independent enough to commit on its own, but they build on each other.

## Drop into your repo

```
.github/MCP_DOCTRINE.md                        ← read this once, it governs all prompts
.github/prompts/fix-ask-customer-loop.prompt.md
.github/prompts/manual-action-banner.prompt.md
.github/prompts/tighter-loop-detection.prompt.md
.github/prompts/aggressive-find-sheet-row.prompt.md
.github/prompts/parser-layout-fix.prompt.md
```

## Run order

### Day 1 - Stop the bleeding (1-2 hours)

```
/fix-ask-customer-loop
```

**Agent**: `@implementer`
**Model**: Claude Sonnet 4.6
**Why first**: This is the actual bug causing your demo to fail. Tiny code change, big behaviour change. Verify with a fresh test email before moving on.

After this, your refund playbook works end to end. You'll still have to approve via curl, but the engine is correct.

### Day 1-2 - Make the human-in-loop usable (3-4 hours)

```
/manual-action-banner
```

**Agent**: `@implementer`
**Model**: GPT-5.4 or Claude Sonnet 4.6 (UI work)
**Why second**: Stops you having to curl to approve. The banner is the visible UX that turns the engine from "technically working" into "actually pleasant to use."

After this, the full demo flow works through the UI: customer emails → engine processes → banner appears on thread → you type Stripe details → click Done → reply sends.

### Day 2 - Insurance against future bugs (1-2 hours)

```
/tighter-loop-detection
```

**Agent**: `@implementer`
**Model**: Claude Sonnet 4.6
**Why third**: The ask_customer fix prevents this specific loop. Tighter detection prevents future loops you haven't thought of yet. Cheap insurance, ship it before adding new playbook complexity.

Specifically: per-step limit of 2, pair-loop detection, no-progress detection, max 30 steps. Plus structured escalation reasons so the UI can show WHY a run died.

### Day 3 - Parser improvement (2-3 hours)

```
/parser-layout-fix
```

**Agent**: `@implementer`
**Model**: Claude Opus 4.6 (prompt engineering - worth the upgrade)
**Why fourth**: The handler bug is fixed but the parser is still generating fragile layouts. Once the parser is laying steps out correctly, every new playbook is robust without depending on the handler fix.

Test by regenerating the refund playbook and comparing to the old structure.

### Day 3-4 - Aggressive matching (3-4 hours)

```
/aggressive-find-sheet-row
```

**Agent**: `@implementer`
**Model**: Claude Sonnet 4.6 (with Opus for the AI prompt design)
**Why last**: Your demo case worked once we fixed the routing - `find_sheet_row` did find the row. But for harder cases (typos, partial product descriptions, missing identifiers), the AI fallback unlocks a lot of automation. Ship after the fundamentals are solid.

After this, even sloppy customer emails like "I want to refund the radiator thingy" can match correctly.

## Total time estimate

If `@implementer` runs without major issues: **2-3 days** of focused work. Each prompt is designed to be a single session.

## How each prompt enforces quality

Every prompt requires:

1. **Pre-work MCP usage** - context7 for current docs, postgres for current state, filesystem for repo awareness, svelte for frontend specifics
2. **Structured planning** - explicit before doing
3. **Inline doc citations** - code comments reference fetched docs, not memory
4. **Postgres verification** - every change is validated against actual DB state
5. **Playwright verification** - frontend changes verified by driving a real browser
6. **TASK_LOG entry** - with the full MCP usage trace

If `@implementer` skips any of these steps, push back. The prompts are designed to produce senior-level work because they require senior-level rigour.

## A note on the MCP_DOCTRINE.md file

This is the most important file in the bundle. It defines HOW the implementer agent uses each MCP server. Every prompt references it. If you ever feel the implementer is being lazy (writing code from memory, skipping verification, not citing docs), point at the doctrine.

You can also reinforce it inline:

> Per `.github/MCP_DOCTRINE.md` rule 1, fetch context7 docs for [thing] before writing this code.

## When to skip the doctrine

Almost never. The only time is for trivial mechanical edits (rename a variable, fix a typo). For anything that adds or changes behaviour, the doctrine applies.

## How to use these prompts effectively

1. Drop them in `.github/prompts/`
2. Type `/` in Copilot chat to see them autocomplete
3. Pick the right one, hit enter
4. Watch what the implementer does - does it follow the MCP doctrine?
5. If output quality is below bar, ask: "Did you fetch context7 docs for X? Did you verify with postgres?"
6. After completion, review the TASK_LOG entry. If it's vague, ask for specifics.

## Each prompt is self-contained

You don't need any other context to run them. They reference the project files via filesystem MCP and self-load the relevant convention files, skills, and architecture docs.

This is by design - when you're 6 weeks deep in implementation, you shouldn't have to remember which file to read first. The prompt knows.
