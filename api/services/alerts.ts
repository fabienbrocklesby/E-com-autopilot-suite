/**
 * Alert webhook service.
 * Posts a JSON payload to the configured webhook URL for enabled events.
 */
import { queryOne } from "../db/client.ts";
import { logger } from "./logger.ts";

export type AlertEvent =
  | "run_escalated"
  | "run_failed"
  | "ingestion_failed_permanently"
  | "circuit_breaker_opened"
  | "rate_limit_sustained"
  | "playbook_graduated";

export async function sendAlert(
  workspaceId: number,
  event: AlertEvent,
  data: Record<string, unknown> = {},
): Promise<void> {
  const urlRow = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE workspace_id = $1 AND key = 'alert_webhook_url'",
    [workspaceId],
  );
  if (!urlRow?.value) return;

  const eventsRow = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE workspace_id = $1 AND key = 'alert_events'",
    [workspaceId],
  );

  let enabledEvents: string[] = [];
  try {
    enabledEvents = eventsRow ? JSON.parse(eventsRow.value) : [];
  } catch {
    enabledEvents = [];
  }

  // If alert_events is set but this event isn't in it, skip
  if (enabledEvents.length > 0 && !enabledEvents.includes(event)) return;

  try {
    const response = await fetch(urlRow.value, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        workspace_id: workspaceId,
        timestamp: new Date().toISOString(),
        ...data,
      }),
    });
    if (!response.ok) {
      logger.warn("alerts.webhook_non_ok", { event, status: response.status, workspace_id: workspaceId });
    }
  } catch (err) {
    logger.warn("alerts.webhook_failed", { event, error: String(err), workspace_id: workspaceId });
  }
}
