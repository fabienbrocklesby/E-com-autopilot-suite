/**
 * Categorisation service.
 * Orchestrates fetching thread data, calling the AI service, storing results,
 * and optionally triggering an auto-reply.
 */
import { query, queryOne, execute } from "../db/client.ts";
import { AppError, Thread, Message, Category, Setting } from "../types/index.ts";
import { categoriseEmail, draftReply } from "./ai.ts";

/**
 * Categorise a thread and generate a draft reply if the category allows it.
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

  const [messages, categories, settingRows] = await Promise.all([
    query<Message>(
      "SELECT * FROM messages WHERE thread_id = $1 ORDER BY received_at ASC",
      [threadId],
    ),
    query<Category>("SELECT * FROM categories ORDER BY name ASC"),
    query<Setting>("SELECT key, value FROM settings"),
  ]);

  const globalSettings = Object.fromEntries(settingRows.map((s) => [s.key, s.value]));

  const { categoryId, confidence, reasoning } = await categoriseEmail(
    thread,
    messages,
    categories,
  );

  // Persist the categorisation result.
  await execute(
    "UPDATE threads SET category_id = $1 WHERE id = $2",
    [categoryId, threadId],
  );

  // Determine whether to auto-draft.
  const category = categories.find((c) => c.id === categoryId) ?? null;
  const globalThreshold = parseFloat(globalSettings["default_confidence_threshold"] ?? "0.8");
  const autoReplyEnabled = globalSettings["auto_reply_enabled"] === "true";
  const categoryThreshold = category?.confidence_threshold ?? globalThreshold;

  let draftCreated = false;

  if (
    category &&
    category.allow_auto_reply &&
    autoReplyEnabled &&
    confidence >= categoryThreshold
  ) {
    const { body } = await draftReply(thread, messages, category, globalSettings);

    await execute(
      "INSERT INTO drafts (thread_id, body, status) VALUES ($1, $2, $3)",
      [threadId, body, "pending"],
    );

    draftCreated = true;
  }

  const updatedThread = await queryOne<Thread>(
    "SELECT * FROM threads WHERE id = $1",
    [threadId],
  ) as Thread;

  return { thread: updatedThread, categoryId, confidence, reasoning, draftCreated };
}
