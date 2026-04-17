---
agent: 'agent'
description: 'Phase 1: consolidate duplication, delete dead code, encrypt tokens'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query']
---

# Phase 1: Cleanup and Consolidation

Goal: Eliminate the duplication and dead code that will make Phase 2 (the playbook engine) miserable to build on top of. Also close the OAuth/token security gaps before we expand the system.

## Required reading

- `docs/TASK_LOG.md` - confirm Phase 0 is done
- `api/services/gmail.ts`, `api/services/sheets.ts`, `api/services/sheet-rules.ts` - token refresh duplication lives here
- `api/services/ai.ts` - the OpenAI wrapper to consolidate around

## Tasks

### 1. Consolidate token refresh into `services/google-auth.ts`

Currently `getValidAccessToken` exists in `gmail.ts`, `sheets.ts`, and `sheet-rules.ts` (as `getAccessToken`). Three copies of the same flow.

Create `api/services/google-auth.ts` with:
```ts
export async function getGoogleAccessToken(workspaceId: number): Promise<{ token: string; email: string }> {
  // Fetch oauth_tokens row
  // Check expiry, refresh if needed (within 60s buffer)
  // Persist new token + expiry
  // Return { token, email }
}
```

Update all three files to import and use this. Delete the three local implementations.

**Validation**:
- Use Postgres MCP to confirm oauth_tokens table is updated correctly after a refresh
- Run a test: temporarily set an expiry to 30 seconds in the future, trigger any flow that uses Gmail or Sheets, verify the token gets refreshed exactly once

### 2. Consolidate OpenAI calls

`services/sheet-rules.ts` has its own `complete()` function that duplicates `chatCompletion` from `ai.ts`. Same for the two `getModel()` functions.

- Migrate all callers in `sheet-rules.ts` to use `chatCompletion` from `ai.ts`
- Delete the local `complete()` and `getModel()` from `sheet-rules.ts`
- Make sure `chatCompletion` supports the JSON response format mode used by sheet rules

### 3. Encrypt OAuth tokens at rest

Add an `ENCRYPTION_KEY` env var (32 bytes, base64-encoded). Use Web Crypto AES-GCM.

Migration `006_encrypt_oauth_tokens.sql`:
- Add columns `access_token_encrypted BYTEA`, `refresh_token_encrypted BYTEA`
- Leave old columns for now (drop in 007 after backfill)

Backfill script `api/scripts/encrypt_tokens.ts`:
- Read each row, encrypt with the new key, write to new columns
- Verify decryption works
- Log progress

In `google-auth.ts`, read from encrypted columns. After verifying everything works in dev, write migration `007_drop_plain_oauth_tokens.sql` to drop the old columns.

**Don't drop the old columns until you've manually verified decryption works in dev.**

### 4. Fix OAuth state verification

`api/routes/auth.ts` generates a state UUID but never stores or verifies it on callback.

Fix:
- Store state in a short-lived table `oauth_states (state TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
- Migration `008_oauth_states.sql` creates the table with a 10-minute TTL implied
- On callback: verify state exists and is < 10 min old, then delete it
- Reject callback if state missing or expired

### 5. Delete dead code

Delete from the codebase (verify with grep first that nothing imports them):

- `api/middleware/error.ts` (the `errorMiddleware` export - unused)
- `api/services/sheets.ts` functions: `applyUpdates`, `readThreadsSheet`, `findRowByValue`, `sheetsAppend`
- `sheet_updates` table - migration `009_drop_sheet_updates.sql`

If grep finds an import you didn't expect, investigate before deleting.

## Workflow

1. Confirm Phase 0 done in `TASK_LOG.md`
2. Do tasks in order: 1, 2, 3 (token consolidation must come before encryption since encryption changes the auth flow), 4, 5
3. Each task is a separate commit
4. Update `TASK_LOG.md` after each task
5. After all done: write a summary, propose Phase 2

## Done criteria

- [ ] One token refresh function, used by Gmail/Sheets/sheet-rules
- [ ] One OpenAI wrapper, used everywhere
- [ ] OAuth tokens encrypted at rest, old columns dropped
- [ ] OAuth state verified on callback
- [ ] All listed dead code deleted
- [ ] Existing tests/flows still work
- [ ] `TASK_LOG.md` updated
