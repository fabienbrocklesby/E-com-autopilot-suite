/**
 * Learning service — records human-feedback interactions for few-shot learning.
 * Called whenever a draft is approved, edited, or rejected.
 */
import { execute } from "../db/client.ts";

export interface RecordInteractionOptions {
  workspaceId: number;
  threadId: number | null;
  categoryId: number | null;
  draftId: number | null;
  outcome: "approved" | "rejected" | "edited";
  originalBody: string | null;
  finalBody: string | null;
}

/**
 * Persist a human-feedback interaction record.
 * These records are used by the AI service as few-shot examples.
 */
export async function recordInteraction(
  opts: RecordInteractionOptions,
): Promise<void> {
  const wasEdited = opts.outcome === "edited" ||
    (opts.originalBody !== null &&
      opts.finalBody !== null &&
      opts.originalBody.trim() !== opts.finalBody.trim());

  await execute(
    `INSERT INTO interactions
       (workspace_id, thread_id, category_id, draft_id, outcome,
        original_body, final_body, was_edited)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      opts.workspaceId,
      opts.threadId,
      opts.categoryId,
      opts.draftId,
      wasEdited ? "edited" : opts.outcome,
      opts.originalBody,
      opts.finalBody,
      wasEdited,
    ],
  );
}
