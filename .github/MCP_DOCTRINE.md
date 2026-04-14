# MCP Usage Doctrine

This document defines how every prompt in this project uses the available MCP servers. All prompts reference this doctrine and apply it without exception.

## The 5 MCP servers and their roles

You have access to:
- **postgres** — query the live dev database for schema, data, and validation
- **filesystem** — read and edit files in the repo with full directory awareness  
- **context7** — fetch real, current documentation for any library or framework before using it
- **svelte** — official Svelte/SvelteKit MCP for runes, kit features, and best practices
- **playwright** — drive a real browser to verify UI changes end to end

You use ALL of them in every non-trivial task. Not as decoration. Each one has a specific job.

## Mandatory usage rules

### Rule 1: context7 before any external API or library usage

Before writing code that uses ANY library, framework, or external API, you MUST fetch its current docs via context7. Your training data is stale. The library has shipped breaking changes since.

This applies to:
- Hono routing, middleware, context, validation
- Deno runtime APIs (file I/O, fetch, std library, KV)
- node-postgres / deno-postgres pool, transaction, type mapping
- OpenAI Chat Completions API, response_format, tool calling
- Gmail API endpoints, scopes, response shapes
- Google Sheets API endpoints, batchUpdate, value ranges
- AES-GCM Web Crypto API
- Any npm package being added or upgraded

You DO NOT write code based on memory. You fetch the docs first, you read them, then you write code that matches the current API. If you find yourself writing `import { something } from 'library'` without having read the current docs for that library this session, stop and fetch them.

When you fetch docs, cite the specific section in your output. Example:

> Per Hono context docs (context7, fetched this session), `c.req.json()` 
> returns Promise<unknown> and we need to validate before use.

### Rule 2: svelte MCP for any frontend work

For ANY change to `frontend/**`, use the svelte MCP. SvelteKit 5 with runes is recent and the API has changed substantially from Svelte 4. Specifically check:
- Runes (`$state`, `$derived`, `$effect`, `$props`, `$bindable`)
- Page state vs stores (`$app/state` not `$app/stores` in recent versions)
- Form actions, load functions, layout patterns
- Component composition with snippets

Don't write Svelte 4 syntax even if it would compile. Don't guess at runes API. Fetch the current docs.

### Rule 3: postgres MCP for everything data-related

Before writing any code that touches the database:

1. **Inspect the current schema** for tables you'll touch. Don't guess column names or types.
2. **Sample real data** to understand actual values, edge cases, nulls.
3. **After writing code**, validate with the MCP that the data state matches expectations.

After applying any migration, query `\d <table_name>` equivalent (or the `information_schema` query) to verify the schema is what you intended.

After running any flow end-to-end, query the relevant tables to confirm side effects landed correctly.

### Rule 4: filesystem MCP for repo awareness

Before assuming any file exists or has any structure, list the directory. Before assuming an import path, search the repo for the actual export. Before adding a new file, check if a similar file exists you should match patterns from.

This means: if you're about to add a service file, first list `api/services/` to see existing files and their naming conventions. If you're adding a Svelte component, list the existing components and match their style.

### Rule 5: playwright MCP for any UI verification

If your changes touch the frontend or change behaviour visible in the dashboard, use playwright to verify:

1. Navigate to the affected page
2. Verify it renders without console errors (check via playwright)
3. Interact with the change you made (click, type, submit)
4. Verify the expected outcome
5. Take a screenshot for the TASK_LOG entry

Do not declare frontend work done without a playwright verification pass.

## Per-task MCP usage pattern

Every implementation task follows this pattern:

```
1. UNDERSTAND
   - filesystem: list relevant directories, read existing patterns
   - postgres: inspect current schema and data state
   - context7: fetch docs for libraries/APIs you'll use
   - svelte: fetch docs if frontend work

2. PLAN
   - State explicitly what you'll change, in what order, and why
   - Cite which docs informed each decision

3. IMPLEMENT
   - Edit files via filesystem
   - Reference docs you fetched (don't write from memory)
   - Match existing code patterns from repo

4. VERIFY  
   - postgres: query DB to confirm data side effects
   - playwright: drive UI to confirm visual/interactive behaviour
   - Run any existing tests, lint, type check via terminal

5. DOCUMENT
   - Update docs/TASK_LOG.md with what was done and how it was verified
   - Reference any docs sections that were critical to the implementation
```

## Code quality bar

Every line of code you write must be:

1. **Senior-level**: clear naming, single responsibility per function, explicit error handling, no clever tricks
2. **Documented inline** where intent isn't obvious from code (the WHY, not the WHAT)
3. **Type-safe**: no `any` unless absolutely justified with a comment explaining why
4. **Tested or testable**: pure functions where possible, dependencies injected, side effects isolated
5. **Convention-matching**: matches the patterns already in this repo (verified via filesystem MCP)
6. **Doc-aligned**: uses APIs as documented in current docs (verified via context7), not from memory

## What NOT to do

- Don't write code that "should work" without verifying APIs against current docs
- Don't skip the postgres verification step ("it should have worked")
- Don't ship frontend without playwright verification
- Don't add a library without checking its current docs and current major version
- Don't catch errors silently
- Don't use `any`, `unknown` without narrowing, or `as` casts without justification
- Don't commit code you wouldn't be proud of in 6 months

## Output format for every task

When reporting back, structure your response:

```
## What I did

<concise summary of changes>

## MCP usage trace

- context7 fetched: <list of doc topics fetched, with brief note on what each informed>
- postgres queries: <key queries run, with what they confirmed>
- svelte docs: <if applicable>
- filesystem: <key directory listings or reads that shaped the approach>
- playwright: <pages tested, interactions performed, screenshots taken>

## Key code decisions

<3-5 bullets explaining non-obvious choices and what doc/data informed them>

## Verification

<concrete evidence the change works: postgres query results, playwright observations, terminal output>

## TASK_LOG entry

<the entry that was added to docs/TASK_LOG.md>
```

This format is mandatory. It makes your work reviewable and creates a paper trail.
