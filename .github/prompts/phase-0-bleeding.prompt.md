---
agent: 'agent'
description: 'Phase 0: fix critical bugs in the current system before architectural work'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query']
---

# Phase 0: Stop the Bleeding

Goal: Fix the 5 critical bugs in the current system that make it feel broken to the client. This phase ships in 1-2 days and immediately improves trust before we start architectural work in Phase 2.

## Required reading before starting

- `docs/PLAYBOOK_ENGINE.md` - for context on where we're going
- `docs/TASK_LOG.md` - to see what's already done
- `api/services/categorisation.ts` - most fixes touch this
- `api/services/sheet-rules.ts` - fix #4 is here

## The 5 fixes

### Fix 1: Threads with pending drafts must move to `in_review` status

**File**: `api/services/categorisation.ts`, function `categoriseAndDraft`

**Current bug**: When auto-reply is below confidence or send fails, a pending draft is created but the thread status stays `new`. The `/review` page filters by `status='in_review'`, so these threads are invisible.

**Fix**: After inserting a draft with `status='pending'`, update the thread to `status='in_review'`. Wrap both writes in a transaction.

**Validation**:
- Use the Postgres MCP to check: `SELECT t.id, t.status, d.status FROM threads t LEFT JOIN drafts d ON d.thread_id = t.id WHERE d.status = 'pending'` - every row should show `t.status = 'in_review'`
- After the fix, manually trigger categorisation on a thread with low confidence and verify it appears in `/review`

### Fix 2: Stop re-categorising threads that already have a category

**File**: `api/services/categorisation.ts` and `api/services/gmail.ts` (where `categoriseAndDraft` is called from `ingestMessage`)

**Current bug**: Every inbound message on a thread runs full categorisation, potentially overwriting the existing category and deleting any pending draft.

**Fix**: In `categoriseAndDraft`, if the thread already has a `category_id` AND a pending draft exists, skip re-categorisation entirely and just notify (or no-op). The proper resume-the-playbook behaviour comes in Phase 2 - for now, just stop the destructive re-categorisation.

If the thread has a category but NO pending draft, it's safe to draft a new reply if conditions allow (this is the "customer replied to a sent reply" case).

**Validation**: Send two messages to the same thread in dev. Verify the second doesn't change the category and doesn't delete the existing draft.

### Fix 3: Wrap `categoriseAndDraft` writes in a transaction

**File**: `api/services/categorisation.ts`

**Current bug**: Multiple sequential writes (update category, delete old draft, insert new draft, update thread status) with no transaction. A crash mid-way leaves inconsistent state.

**Fix**: Wrap the write phase in `transaction()` from `db/client.ts`. The AI calls happen before the transaction (they're slow and shouldn't hold a DB transaction open).

**Pattern**:
```ts
// AI calls first, no transaction needed
const categorisation = await categoriseEmail(...);
const draft = category.allow_auto_reply ? await draftReply(...) : null;

// Then all DB writes in one transaction
await transaction(async (tx) => {
  await tx.queryArray("UPDATE threads SET category_id = $1 WHERE id = $2", ...);
  await tx.queryArray("DELETE FROM drafts WHERE thread_id = $1 AND status = 'pending'", ...);
  if (draft) {
    await tx.queryArray("INSERT INTO drafts (...) VALUES (...)", ...);
    await tx.queryArray("UPDATE threads SET status = $1 WHERE id = $2", ...);
  }
});
```

### Fix 4: Fix recursive 429 retry in sheet-rules

**File**: `api/services/sheet-rules.ts`, function `complete`

**Current bug**: On 429 response, `complete()` calls itself recursively with no max retries. Sustained rate limiting = stack overflow.

**Fix**: Replace recursive call with a bounded retry loop (max 3 retries, exponential backoff: 1s, 2s, 4s).

```ts
async function complete(model: string, system: string, user: string): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(/* ... */);
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "0");
        const delayMs = retryAfter > 0 ? retryAfter * 1000 : Math.pow(2, attempt) * 1000;
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      if (!res.ok) throw new Error(`OpenAI error: ${res.status}`);
      const data = await res.json();
      return data.choices[0].message.content;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr ?? new Error("OpenAI complete failed after retries");
}
```

### Fix 5: Verify and document Gmail label sync direction

**File**: `api/services/gmail.ts`, function `syncLabels`

**Current state**: Two-way sync exists but it's never been verified end-to-end and the rename case is broken (renaming a category in the app doesn't rename the Gmail label).

**Fix**:
1. Read the current `syncLabels` implementation carefully
2. Test the four scenarios using Postgres MCP and the Gmail API:
   - Create category in app → Gmail label appears with same name ✓
   - Create label in Gmail → Category appears in app ✓
   - Rename category in app → Gmail label renamed (probably broken)
   - Delete category in app → Gmail label deleted (verify behaviour)
3. **Decision**: Make the dashboard the source of truth. Implement rename propagation (category rename → Gmail label rename via `users.labels.patch`). For Gmail-side renames, on next sync: surface as "untracked label" rather than auto-syncing.
4. Document the final behaviour in `docs/PLAYBOOK_ENGINE.md` under a new "Gmail label sync" section.

## Workflow

1. Start by reading `docs/TASK_LOG.md` to confirm none of these fixes are already done
2. Use the Postgres MCP to check current data state for fixes 1 and 2 (find example bad rows)
3. Fix in this order: 4 (cheapest), 3 (foundational), 1, 2, 5
4. After each fix:
   - Update `docs/TASK_LOG.md` with what changed and how it was verified
   - Suggest a commit message
5. After all 5: write a summary in `TASK_LOG.md` and propose moving to Phase 1

## What to flag, not fix

If you find any of these while working, flag them but don't fix here:
- Token refresh duplication (Phase 1)
- Dead code (Phase 1)
- OAuth state CSRF (Phase 1)
- Unencrypted tokens (Phase 1)
- Anything related to the playbook engine itself (Phase 2)

## Done criteria

- [ ] All 5 fixes implemented and tested
- [ ] No regression in the working flows (still categorises, still auto-replies, still updates sheets)
- [ ] `TASK_LOG.md` updated with what was done and validation steps
- [ ] A clean commit per fix, or one commit per fix grouped logically
