import { queryOne } from "./client.ts";
import type { ThreadListItem } from "../types/index.ts";

export async function fetchThreadListItem(
  threadId: number,
  workspaceId: number,
): Promise<ThreadListItem | null> {
  return queryOne<ThreadListItem>(
    `SELECT
       t.*,
       cat.name AS category_name,
       COUNT(d.id)::int AS draft_count,
       EXISTS(
         SELECT 1 FROM playbook_runs r
         JOIN playbooks rp ON rp.id = r.playbook_id
         WHERE r.thread_id = t.id
           AND r.workspace_id = t.workspace_id
           AND r.status = 'waiting_for_human'
           AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements(COALESCE(r.steps_snapshot, rp.steps)) AS step
             WHERE step->>'id' = r.current_step_id
           )
       ) AS has_pending_action,
       lr.id AS latest_run_id,
       lr.status AS latest_run_status,
       lr.current_step_id AS latest_run_step,
       lp.name AS latest_run_playbook_name,
       lr.updated_at AS latest_run_updated_at,
       (SELECT COUNT(*)::int FROM jsonb_array_elements(lp.steps)) AS latest_run_total_steps,
       (SELECT COUNT(*)::int FROM playbook_step_executions pse WHERE pse.run_id = lr.id AND pse.status = 'success') AS latest_run_completed_steps
     FROM threads t
     LEFT JOIN categories cat ON cat.id = t.category_id
     LEFT JOIN drafts d ON d.thread_id = t.id
     LEFT JOIN LATERAL (
       SELECT pr.* FROM playbook_runs pr
       WHERE pr.thread_id = t.id
       ORDER BY pr.created_at DESC LIMIT 1
     ) lr ON true
     LEFT JOIN playbooks lp ON lp.id = lr.playbook_id
     WHERE t.id = $1 AND t.workspace_id = $2
     GROUP BY t.id, cat.name, lr.id, lr.status, lr.current_step_id, lp.name, lr.updated_at, lp.steps`,
    [threadId, workspaceId],
  );
}
