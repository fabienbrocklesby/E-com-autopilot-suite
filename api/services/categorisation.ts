/**
 * Categorisation service.
 * Categorises a thread then routes to the playbook engine if the category
 * has an active playbook. Without a playbook the thread is placed in_review
 * for manual handling. The legacy auto-draft flow is removed.
 */
import { query, queryOne, transaction } from "../db/client.ts";
import {
  AppError,
  Thread,
  Message,
  Category,
  Setting,
  OAuthToken,
} from "../types/index.ts";
import { categoriseEmail } from "./ai.ts";
import { applyLabel } from "./gmail.ts";
import { evaluateRules } from "./sheet-rules.ts";
import { startRun } from "./playbook/executor.ts";
import type { Playbook } from "./playbook/types.ts";

/**
 * Categorise a thread and route it to the appropriate playbook.
 * If the matched category has an active playbook and confidence meets the
 * playbook's threshold, the playbook engine takes over.
 * If no playbook is available the thread is placed in_review for manual handling.
 */
export async function categoriseAndDraft(threadId: number): Promise<{
  thread: Thread;
  categoryId: number | null;
  confidence: number;
  reasoning: string;
  draftCreated: boolean;
}> {
  const thread = await queryOne<Thread>(
    "SELECT * FROM threads WHERE id = $1",
    [threadId],
  );
  if (!thread) throw new AppError(404, "Thread not found");

  const workspaceId = thread.workspace_id;

  // Fix 2: If thread already has a category AND a pending draft, skip re-categorisation
  // to avoid clobbering existing state. Resume logic is Phase 2.
  if (thread.category_id !== null) {
    const existingPendingDraft = await queryOne(
      "SELECT id FROM drafts WHERE thread_id = $1 AND status = 'pending'",
      [threadId],
    );
    if (existingPendingDraft) {
      console.log(`[categorisation] Thread ${threadId} already categorised with pending draft - skipping`);
      const currentThread = await queryOne<Thread>(
        "SELECT * FROM threads WHERE id = $1",
        [threadId],
      ) as Thread;
      return {
        thread: currentThread,
        categoryId: thread.category_id,
        confidence: 1,
        reasoning: "Already categorised with pending draft; skipping re-categorisation.",
        draftCreated: false,
      };
    }
  }

  const [messages, categories, settingRows] = await Promise.all([
    query<Message>(
      "SELECT * FROM messages WHERE thread_id = $1 ORDER BY received_at ASC",
      [threadId],
    ),
    query<Category>(
      "SELECT * FROM categories WHERE workspace_id = $1 ORDER BY name ASC",
      [workspaceId],
    ),
    query<Setting>(
      "SELECT key, value FROM settings WHERE workspace_id = $1",
      [workspaceId],
    ),
  ]);

  const globalSettings = Object.fromEntries(settingRows.map((s) => [s.key, s.value]));

  // AI calls - outside transaction (slow; must not hold a DB connection open).
  const { categoryId, confidence, reasoning } = await categoriseEmail(
    thread,
    messages,
    categories,
    workspaceId,
  );

  const category = categories.find((c) => c.id === categoryId) ?? null;

  // Apply Gmail label - fire-and-forget, don't fail categorisation on label errors.
  if (category?.gmail_label_id) {
    const tokenRow = await queryOne<OAuthToken>(
      "SELECT * FROM oauth_tokens WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1",
      [workspaceId],
    );
    if (tokenRow) {
      applyLabel(tokenRow.email, thread.gmail_thread_id, category.gmail_label_id).catch(
        (err) => console.error("[categorisation] Failed to apply Gmail label:", err),
      );
    }
  }

  // Phase 2: If the chosen category has an active playbook, route to the playbook engine
  // instead of the legacy draft flow.
  if (categoryId) {
    const playbook = await queryOne<Playbook>(
      "SELECT * FROM playbooks WHERE category_id = $1 AND is_active = true ORDER BY version DESC LIMIT 1",
      [categoryId],
    );
    if (playbook) {
      // Set the category on the thread first
      await transaction(async (tx) => {
        await tx.queryObject({
          text: "UPDATE threads SET category_id = $1 WHERE id = $2",
          args: [categoryId, threadId],
        });
      });

      // Playbook confidence threshold gates whether the run starts automatically.
      // Below threshold: thread sits in_review for manual triage.
      if (confidence < playbook.confidence_threshold) {
        await transaction(async (tx) => {
          await tx.queryObject({
            text: "UPDATE threads SET status = 'in_review' WHERE id = $1",
            args: [threadId],
          });
        });
        console.log(`[categorisation] Confidence ${confidence} below playbook threshold ${playbook.confidence_threshold} for thread ${threadId} - placing in_review`);
      } else {
        console.log(`[categorisation] Category ${categoryId} has playbook "${playbook.name}" - routing to engine`);
        try {
          await startRun(workspaceId, threadId, playbook.id);
        } catch (err) {
          console.error(`[categorisation] Playbook run failed for thread ${threadId}:`, err);
        }
      }

      const updatedThread = await queryOne<Thread>(
        "SELECT * FROM threads WHERE id = $1",
        [threadId],
      ) as Thread;

      return {
        thread: updatedThread,
        categoryId,
        confidence,
        reasoning,
        draftCreated: false,
      };
    }
  }

  // No active playbook for this category (or no category matched).
  // Place thread in_review for manual handling.
  await transaction(async (tx) => {
    await tx.queryObject({ text: "UPDATE threads SET category_id = $1, status = 'in_review' WHERE id = $2", args: [categoryId, threadId] });
  });

  evaluateRules(threadId, workspaceId).catch(
    (err: unknown) => console.error("[categorisation] Sheet rule evaluation error:", err),
  );

  const updatedThread = await queryOne<Thread>(
    "SELECT * FROM threads WHERE id = $1",
    [threadId],
  ) as Thread;

  return { thread: updatedThread, categoryId, confidence, reasoning, draftCreated: false };
}
