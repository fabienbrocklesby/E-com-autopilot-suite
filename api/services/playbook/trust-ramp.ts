/**
 * Trust ramp service.
 * Tracks consecutive clean (unedited) draft approvals per playbook and
 * promotes reply_mode from draft_only to auto_reply once the streak target
 * is reached. Editing a draft before approval, or rejecting it outright,
 * resets the streak, since the ramp only rewards drafts a human found good
 * enough to send unchanged.
 */
import { queryOne } from "../../db/client.ts";
import { publish } from "../event-bus.ts";
import { sendAlert } from "../alerts.ts";
import type { Playbook } from "./types.ts";

export type ApprovalOutcome = "approved_clean" | "approved_edited" | "rejected";

export interface StreakState {
  approvalStreak: number;
  autoSendStreakTarget: number;
  replyMode: "auto_reply" | "draft_only";
}

export interface StreakTransition {
  nextApprovalStreak: number;
  nextReplyMode: "auto_reply" | "draft_only";
  graduated: boolean;
}

/**
 * Pure decision: given the current streak state and what just happened,
 * what the new streak and reply_mode should be. Kept free of I/O so the
 * ramp logic itself is directly unit-testable.
 */
export function computeStreakTransition(
  state: StreakState,
  outcome: ApprovalOutcome,
): StreakTransition {
  const advanced = outcome === "approved_clean" ? state.approvalStreak + 1 : 0;
  const graduated = state.replyMode === "draft_only" && advanced >= state.autoSendStreakTarget;

  return {
    nextApprovalStreak: graduated ? state.autoSendStreakTarget : advanced,
    nextReplyMode: graduated ? "auto_reply" : state.replyMode,
    graduated,
  };
}

/**
 * Updates the streak for the playbook behind the given run and, when the
 * transition graduates it to auto_reply, announces the graduation over the
 * event bus and the alert webhook.
 */
export async function recordApprovalOutcome(
  runId: number,
  outcome: ApprovalOutcome,
): Promise<{ graduated: boolean }> {
  const run = await queryOne<{ playbook_id: number; workspace_id: number }>(
    "SELECT playbook_id, workspace_id FROM playbook_runs WHERE id = $1",
    [runId],
  );
  if (!run) return { graduated: false };

  const playbook = await queryOne<Playbook>(
    "SELECT * FROM playbooks WHERE id = $1",
    [run.playbook_id],
  );
  if (!playbook) return { graduated: false };

  const transition = computeStreakTransition(
    {
      approvalStreak: playbook.approval_streak,
      autoSendStreakTarget: playbook.auto_send_streak_target,
      replyMode: playbook.reply_mode,
    },
    outcome,
  );

  const updated = await queryOne<Playbook>(
    `UPDATE playbooks SET approval_streak = $1, reply_mode = $2 WHERE id = $3 RETURNING *`,
    [transition.nextApprovalStreak, transition.nextReplyMode, playbook.id],
  );
  if (!updated) return { graduated: false };

  if (transition.graduated) {
    publish({
      type: "playbook_graduated",
      workspaceId: run.workspace_id,
      playbook: {
        id: updated.id,
        name: updated.name,
        category_id: updated.category_id,
        reply_mode: updated.reply_mode,
      },
    });
    // Graduation is a happy-path event: never let an alert-webhook failure
    // surface a successful send + streak update as an approve error. Matches
    // the .catch guard on every other sendAlert side effect (executor, workers).
    await sendAlert(run.workspace_id, "playbook_graduated", {
      playbook_id: updated.id,
      playbook_name: updated.name,
      category_id: updated.category_id,
    }).catch(() => {});
  }

  return { graduated: transition.graduated };
}

/**
 * One-click revert: sends the playbook back to draft_only and resets the
 * approval streak to zero, so it must re-earn auto-send.
 */
export async function revertToDraftOnly(playbookId: number): Promise<Playbook | null> {
  return await queryOne<Playbook>(
    `UPDATE playbooks SET reply_mode = 'draft_only', approval_streak = 0 WHERE id = $1 RETURNING *`,
    [playbookId],
  );
}
