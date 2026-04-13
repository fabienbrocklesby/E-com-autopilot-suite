/**
 * Categorisation service.
 * Orchestrates fetching thread data, calling the AI service, storing results,
 * and optionally triggering an auto-reply and Gmail labelling.
 * Sheet rule evaluation is handled by evaluateRules() after the reply decision.
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
import { categoriseEmail, draftReply } from "./ai.ts";
import { applyLabel, sendReply } from "./gmail.ts";
import { evaluateRules } from "./sheet-rules.ts";

/**
 * Categorise a thread and generate a draft reply if the category allows it.
 * Also applies a Gmail label and triggers any sheet updates the AI detects.
 * Called both by the webhook pipeline and the manual "re-categorise" endpoint.
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
      console.log(`[categorisation] Thread ${threadId} already categorised with pending draft — skipping`);
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

  // AI calls — outside transaction (slow; must not hold a DB connection open).
  const { categoryId, confidence, reasoning } = await categoriseEmail(
    thread,
    messages,
    categories,
    workspaceId,
  );

  const category = categories.find((c) => c.id === categoryId) ?? null;

  // Apply Gmail label — fire-and-forget, don't fail categorisation on label errors.
  if (category?.gmail_label_id) {
    const tokenRow = await queryOne<OAuthToken>(
      "SELECT * FROM oauth_tokens WHERE workspace_id = $1 LIMIT 1",
      [workspaceId],
    );
    if (tokenRow) {
      applyLabel(tokenRow.email, thread.gmail_thread_id, category.gmail_label_id).catch(
        (err) => console.error("[categorisation] Failed to apply Gmail label:", err),
      );
    }
  }

  // Determine whether to auto-draft or auto-send.
  // Auto-reply is gated solely on the per-category toggle and threshold — no global switch.
  const globalThreshold = parseFloat(globalSettings["default_confidence_threshold"] ?? "0.8");
  const categoryThreshold = category?.confidence_threshold ?? globalThreshold;

  // Resolve draft body and send outcome before opening the transaction.
  let draftBody: string | null = null;
  let modelUsed: string | null = null;
  let autoSendSuccess = false;

  if (category && category.allow_auto_reply && confidence >= categoryThreshold) {
    const modelSetting = await queryOne<Setting>(
      "SELECT value FROM settings WHERE workspace_id = $1 AND key = 'openai_model'",
      [workspaceId],
    );
    modelUsed = modelSetting?.value ?? null;

    const { body } = await draftReply(thread, messages, category, globalSettings, workspaceId);
    draftBody = body;

    // Resolve the connected email. Use the last *inbound* message as reply target
    // so we never accidentally reply to our own sent messages.
    const tokenRow = await queryOne<OAuthToken>(
      "SELECT * FROM oauth_tokens WHERE workspace_id = $1 LIMIT 1",
      [workspaceId],
    );
    const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound") ?? null;

    if (tokenRow && lastInbound?.from_address) {
      try {
        await sendReply(
          tokenRow.email,
          thread.gmail_thread_id,
          thread.subject,
          lastInbound.from_address,
          body,
          lastInbound.message_id_header,
        );
        autoSendSuccess = true;
        console.log(`[categorisation] Auto-sent reply for thread ${threadId}`);
      } catch (err) {
        console.error(`[categorisation] Auto-send failed for thread ${threadId}, saving as draft:`, err);
      }
    }
  }

  // Fix 3: Wrap all DB writes in a single transaction.
  await transaction(async (tx) => {
    await tx.queryObject({ text: "UPDATE threads SET category_id = $1 WHERE id = $2", args: [categoryId, threadId] });

    if (draftBody !== null) {
      // Remove any stale pending draft — one draft per thread at a time.
      await tx.queryObject({ text: "DELETE FROM drafts WHERE thread_id = $1 AND status = 'pending'", args: [threadId] });

      if (autoSendSuccess) {
        // Auto-send succeeded — record as sent and mark thread replied.
        await tx.queryObject({
          text: "INSERT INTO drafts (thread_id, body, status, was_auto_sent, ai_model_used, sent_at) VALUES ($1, $2, 'sent', true, $3, now())",
          args: [threadId, draftBody, modelUsed],
        });
        await tx.queryObject({
          text: "UPDATE threads SET status = 'replied', auto_replied = true WHERE id = $1",
          args: [threadId],
        });
      } else {
        // Fix 1: Pending draft — move thread to in_review so it appears in the review queue.
        await tx.queryObject({
          text: "INSERT INTO drafts (thread_id, body, status, was_auto_sent, ai_model_used) VALUES ($1, $2, 'pending', false, $3)",
          args: [threadId, draftBody, modelUsed],
        });
        await tx.queryObject({
          text: "UPDATE threads SET status = 'in_review' WHERE id = $1",
          args: [threadId],
        });
      }
    }
  });

  const draftCreated = draftBody !== null;

  // Evaluate sheet rules after the reply decision. Must not block or affect the
  // email flow — failures are logged and stored but never propagated up.
  evaluateRules(threadId, workspaceId).catch(
    (err: unknown) => console.error("[categorisation] Sheet rule evaluation error:", err),
  );

  const updatedThread = await queryOne<Thread>(
    "SELECT * FROM threads WHERE id = $1",
    [threadId],
  ) as Thread;

  return { thread: updatedThread, categoryId, confidence, reasoning, draftCreated };
}
