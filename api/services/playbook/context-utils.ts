/**
 * Shared context-assembly helpers used by AI-facing playbook steps.
 * Centralises variable-presence semantics and transcript capping so every
 * judgment-type step (ask_customer, evaluate, triage, the composer) agrees
 * on what "known" and "recent" mean, instead of each maintaining its own
 * slightly different check.
 */
import type { Message } from "../../types/index.ts";
import { formatTranscript } from "../email-text.ts";
import type { ThreadBrief } from "./brief.ts";

const RECENT_MESSAGE_COUNT = 10;
const FULL_TRANSCRIPT_CAP = 30;

/**
 * Whether a context-bag value counts as "known". Null, undefined, and
 * whitespace-only strings are absent; everything else (including 0 and
 * false) is present. A single definition replaces the two checks that used
 * to disagree (`== null` in ask_customer, `=== null || === undefined || === ""`
 * in evaluate) and silently produced different behaviour for the same var.
 */
export function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

/**
 * Format a thread transcript for an AI prompt, capped so very long threads
 * don't blow the context window or bury the recent conversation. Threads at
 * or under 30 messages get the full transcript, unchanged. Longer threads
 * get the brief summary standing in for everything before the last 10
 * messages, which are shown in full.
 */
export function formatCappedTranscript(messages: Message[], summary: string | null): string {
  if (messages.length <= FULL_TRANSCRIPT_CAP) {
    return formatTranscript(messages);
  }

  const recent = messages.slice(-RECENT_MESSAGE_COUNT);
  const earlierCount = messages.length - recent.length;
  const summaryLine = summary
    ? `EARLIER CONVERSATION (summary): ${summary}`
    : `EARLIER CONVERSATION (summary): (${earlierCount} earlier messages not shown; no summary available yet)`;

  return `${summaryLine}\n\n---\n\n${formatTranscript(recent)}`;
}

/**
 * Render a thread's brief (durable facts plus, once the thread is long
 * enough, a rolling summary) as a THREAD BRIEF prompt section. evaluate and
 * triage only see formatCappedTranscript's transcript, which only carries a
 * summary once a thread crosses 30 messages and never carries extracted
 * facts at all - this closes that gap so both judgment steps see what the
 * thread already knows, the same way the composer's own inline THREAD BRIEF
 * section does for customer-facing replies. Returns "" (nothing to prepend)
 * when the brief has neither facts nor a summary yet.
 */
export function formatBriefBlock(brief: ThreadBrief): string {
  const sections: string[] = [];

  if (Object.keys(brief.facts).length > 0) {
    const factLines = Object.entries(brief.facts)
      .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
      .join("\n");
    sections.push(`Facts:\n${factLines}`);
  }

  if (brief.summary) {
    sections.push(`Summary: ${brief.summary}`);
  }

  if (sections.length === 0) return "";
  return `THREAD BRIEF:\n${sections.join("\n\n")}`;
}
