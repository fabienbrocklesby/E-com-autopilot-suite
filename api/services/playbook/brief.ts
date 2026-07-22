/**
 * Thread brief - durable, thread-scoped AI memory.
 *
 * Every playbook run advancing a thread learns things (extracted variables,
 * a rolling summary of the conversation). Without a shared store, that
 * knowledge lived only in the run's own context bag and vanished the moment
 * a second run started on the same thread (recategorisation, or the
 * customer returning weeks later). threads.brief fixes that: extract writes
 * facts here as it goes, and startRun seeds a new run's context from it, so
 * context loss becomes structurally impossible instead of something patched
 * in one code path.
 */
import { execute, queryOne } from "../../db/client.ts";
import { AppError, Message } from "../../types/index.ts";
import { chatCompletion, getModel } from "../ai.ts";
import { formatTranscript } from "../email-text.ts";
import { getStoreProfile } from "../store-profile.ts";

export type ThreadBrief = {
  summary: string | null;
  facts: Record<string, unknown>;
  updated_at: string | null;
};

interface ThreadBriefRow {
  brief: Partial<ThreadBrief> | string | null;
}

// Below this message count a thread is short enough that the full transcript
// is cheap to send on every AI call - summarising it would cost tokens
// without saving any.
const SUMMARY_MIN_MESSAGES = 8;

/**
 * Read a thread's brief. Always returns a fully-populated ThreadBrief, even
 * for a thread that has never had one written (the migration default is
 * '{}', so summary/facts/updated_at all come back empty rather than every
 * caller having to null-check the whole object).
 */
export async function getThreadBrief(threadId: number): Promise<ThreadBrief> {
  const row = await queryOne<ThreadBriefRow>(
    "SELECT brief FROM threads WHERE id = $1",
    [threadId],
  );
  if (!row) {
    throw new AppError(404, `Thread ${threadId} not found`);
  }

  // deno-postgres sometimes hands back a JSONB column as a string rather
  // than a pre-parsed object depending on how the row was fetched -
  // executor.ts's run.context has the same quirk, so mirror its guard here.
  const raw = typeof row.brief === "string" ? JSON.parse(row.brief) : (row.brief ?? {});

  return {
    summary: raw.summary ?? null,
    facts: raw.facts ?? {},
    updated_at: raw.updated_at ?? null,
  };
}

/**
 * Merge new facts into a thread's brief, preserving keys already there that
 * aren't part of this update. Deterministic and cheap - called after every
 * extract step, no AI cost. Deliberately never touches `updated_at`: that
 * field tracks summary freshness (see shouldRegenerateSummary below), and a
 * fact merge happening in the same run that just read the thread's messages
 * must not make a stale summary look fresh.
 *
 * threadId is not re-scoped by workspace_id here: it is already a trusted,
 * globally unique primary key sourced from a workspace-scoped RunContext by
 * every caller, matching the same WHERE id = $1 pattern executor.ts already
 * uses for single-row thread updates.
 */
export async function mergeBriefFacts(
  threadId: number,
  facts: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(facts).length === 0) return;

  await execute(
    `UPDATE threads
     SET brief = jsonb_set(brief, '{facts}', COALESCE(brief->'facts', '{}'::jsonb) || $2::jsonb, true)
     WHERE id = $1`,
    [threadId, JSON.stringify(facts)],
  );
}

/**
 * Pure decision logic for whether ensureBriefSummary needs to pay for a
 * chatCompletion call. Exported beyond the four signatures the AI layer
 * spec calls for, purely so this one piece of real business logic gets a
 * TDD cycle without touching Postgres or OpenAI - mirrors the
 * resolveTriageDecision / triageHandler split already used in triage.ts.
 */
export function shouldRegenerateSummary(messages: Message[], brief: ThreadBrief): boolean {
  if (messages.length <= SUMMARY_MIN_MESSAGES) return false;

  const latest = messages[messages.length - 1];
  const latestReceivedAt = latest.received_at instanceof Date
    ? latest.received_at
    : new Date(latest.received_at);

  if (!brief.updated_at) return true;
  return new Date(brief.updated_at) <= latestReceivedAt;
}

/**
 * Return the thread's summary, regenerating it first if the thread has
 * grown past the point a full transcript is cheap to send and the existing
 * summary (if any) predates the latest message. Short threads never pay for
 * summarisation; long, quiet threads reuse the cached summary indefinitely.
 */
export async function ensureBriefSummary(
  workspaceId: number,
  threadId: number,
  messages: Message[],
): Promise<string | null> {
  const brief = await getThreadBrief(threadId);

  if (!shouldRegenerateSummary(messages, brief)) {
    return brief.summary;
  }

  const [storeProfile, model] = await Promise.all([
    getStoreProfile(workspaceId),
    getModel(workspaceId),
  ]);

  const prompt =
    `You maintain a running summary of an email support thread so other AI steps have shared memory of what happened earlier in a long conversation.
${storeProfile ? `\nStore context:\n${storeProfile}\n` : ""}
Summarise the conversation below in 2-4 sentences: what the customer wants, what has been established, offered, or promised, and where things currently stand. Plain text only, no markdown, no greeting or signature.

Thread transcript:
${formatTranscript(messages)}`;

  const response = await chatCompletion([{ role: "user", content: prompt }], model);
  const summary = response.trim();

  await execute(
    `UPDATE threads
     SET brief = jsonb_set(jsonb_set(brief, '{summary}', to_jsonb($2::text)), '{updated_at}', to_jsonb($3::text))
     WHERE id = $1`,
    [threadId, summary, new Date().toISOString()],
  );

  return summary;
}
