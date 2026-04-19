import type { Message } from "../types/index.ts";
import type { PlaybookRun, StepExecution } from "./playbook/types.ts";

export type BusEvent =
  | { type: "thread_created"; workspaceId: number; thread: Record<string, unknown> }
  | { type: "thread_updated"; workspaceId: number; thread: Record<string, unknown> }
  | { type: "message_created"; workspaceId: number; threadId: number; message: Message }
  | { type: "run_updated"; workspaceId: number; threadId: number; run: PlaybookRun & { playbook_name?: string } }
  | { type: "step_execution_created"; workspaceId: number; runId: number; threadId: number; execution: StepExecution }
  | { type: "step_execution_updated"; workspaceId: number; runId: number; threadId: number; execution: StepExecution };

const subscribers = new Map<number, Set<(event: BusEvent) => void>>();

export function publish(event: BusEvent): void {
  const set = subscribers.get(event.workspaceId);
  if (!set?.size) return;
  for (const cb of set) {
    try {
      cb(event);
    } catch (_) {
      // never let a subscriber error affect the publisher
    }
  }
}

export function subscribe(workspaceId: number, callback: (event: BusEvent) => void): () => void {
  if (!subscribers.has(workspaceId)) {
    subscribers.set(workspaceId, new Set());
  }
  subscribers.get(workspaceId)!.add(callback);
  return () => {
    subscribers.get(workspaceId)?.delete(callback);
  };
}
