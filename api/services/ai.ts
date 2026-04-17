/**
 * AI service - OpenAI API integration.
 * Uses raw fetch against the /v1/chat/completions endpoint.
 * Reference: https://platform.openai.com/docs/api-reference/chat/create
 */
import { AppError, CategorisationResult, Category, DraftReplyResult, Thread, Message } from "../types/index.ts";
import { queryOne, query } from "../db/client.ts";
import { Setting, Interaction } from "../types/index.ts";
import { logger } from "./logger.ts";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

function getApiKey(): string {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new AppError(500, "OPENAI_API_KEY is not configured");
  return key;
}

export async function getModel(workspaceId = 1): Promise<string> {
  const setting = await queryOne<Setting>(
    "SELECT value FROM settings WHERE workspace_id = $1 AND key = 'openai_model'",
    [workspaceId],
  );
  return setting?.value ?? Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ── Circuit breaker ────────────────────────────────────────────────────────────
const CB_WINDOW_MS = 60_000;   // 60 seconds
const CB_THRESHOLD = 5;        // failures before opening
const CB_COOL_MS   = 120_000;  // 2 minutes cool-off

const cbFailures: number[] = []; // epoch ms of recent failures
let cbOpenedAt = 0;              // 0 = closed

function cbRecord(): void {
  const now = Date.now();
  const cutoff = now - CB_WINDOW_MS;
  while (cbFailures.length > 0 && cbFailures[0] < cutoff) cbFailures.shift();
  cbFailures.push(now);
  if (cbOpenedAt === 0 && cbFailures.length >= CB_THRESHOLD) {
    cbOpenedAt = now;
    logger.warn("ai.circuit_breaker_opened", { failure_count: cbFailures.length });
  }
}

function cbCheck(): void {
  if (cbOpenedAt === 0) return;
  const now = Date.now();
  if (now - cbOpenedAt > CB_COOL_MS) {
    cbOpenedAt = 0;
    cbFailures.length = 0;
    logger.info("ai.circuit_breaker_closed");
    return;
  }
  throw new AppError(503, "AI temporarily unavailable");
}

function cbSuccess(): void {
  if (cbOpenedAt !== 0 || cbFailures.length > 0) {
    logger.info("ai.circuit_breaker_reset", { after_failures: cbFailures.length });
  }
  cbOpenedAt = 0;
  cbFailures.length = 0;
}

export function getCircuitBreakerState(): { open: boolean; openedAt: number | null; failureCount: number } {
  const open = cbOpenedAt > 0 && Date.now() - cbOpenedAt <= CB_COOL_MS;
  return {
    open,
    openedAt: open ? cbOpenedAt : null,
    failureCount: cbFailures.length,
  };
}

export function resetCircuitBreaker(): void {
  cbOpenedAt = 0;
  cbFailures.length = 0;
  logger.info("ai.circuit_breaker_reset_manual");
}

// Retriable HTTP status codes from OpenAI
const RETRIABLE_STATUSES = [429, 500, 502, 503, 504];

/**
 * Make a chat completion request to OpenAI.
 * Retries up to 3 times on transient errors (429, 5xx) with exponential backoff.
 * Honouring Retry-After header on 429.
 * Opens a circuit breaker after 5 consecutive failures in 60 seconds.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  model: string,
  responseFormat?: { type: "json_object" },
): Promise<string> {
  cbCheck();

  const apiKey = getApiKey();
  const startedAt = Date.now();

  const reqBody = {
    model,
    messages,
    store: false,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  };

  const doRequest = (): Promise<Response> =>
    fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(reqBody),
    });

  const MAX_ATTEMPTS = 4; // 1 initial + 3 retries
  const BACKOFF_SECS = [1, 2, 4];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await doRequest();
    } catch (err) {
      // Network error - retriable
      cbRecord();
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = BACKOFF_SECS[attempt] ?? 4;
        logger.warn("ai.network_error_retry", { attempt, delay_s: delay, error: String(err) });
        await new Promise((r) => setTimeout(r, delay * 1000));
        continue;
      }
      throw new AppError(502, `OpenAI network error: ${String(err)}`);
    }

    if (RETRIABLE_STATUSES.includes(res.status)) {
      cbRecord();
      if (attempt < MAX_ATTEMPTS - 1) {
        const retryAfterHeader = res.headers.get("Retry-After");
        const delaySec = retryAfterHeader
          ? parseInt(retryAfterHeader)
          : (BACKOFF_SECS[attempt] ?? 4);
        logger.warn("ai.rate_limited_retry", { attempt, status: res.status, delay_s: delaySec });
        await new Promise((r) => setTimeout(r, delaySec * 1000));
        continue;
      }
      const detail = await res.text();
      throw new AppError(502, `OpenAI API error: ${res.status}`, detail);
    }

    if (!res.ok) {
      cbRecord();
      const detail = await res.text();
      throw new AppError(502, `OpenAI API error: ${res.status}`, detail);
    }

    const data = await res.json() as OpenAIResponse;
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      cbRecord();
      throw new AppError(502, "OpenAI returned an empty response");
    }

    cbSuccess();
    logger.debug("ai.completion", {
      model,
      tokens: data.usage?.total_tokens,
      duration_ms: Date.now() - startedAt,
    });
    return content;
  }

  // Should never reach here, but satisfies TypeScript
  throw new AppError(502, "OpenAI: exhausted retries");
}

/**
 * Load up to `limit` recent approved/edited interactions for a workspace
 * to use as few-shot examples in AI prompts.
 */
async function getFewShotExamples(
  workspaceId: number,
  limit = 5,
): Promise<Interaction[]> {
  return query<Interaction>(
    `SELECT * FROM interactions
     WHERE workspace_id = $1
       AND outcome IN ('approved', 'edited')
       AND original_body IS NOT NULL
       AND final_body IS NOT NULL
     ORDER BY created_at DESC
     LIMIT $2`,
    [workspaceId, limit],
  );
}

/**
 * Categorise an email thread by matching it against the available categories.
 *
 * @returns categoryId (null if no category meets the threshold), confidence 0–1,
 *          and a short reasoning string.
 */
export async function categoriseEmail(
  thread: Thread,
  messages: Message[],
  categories: Category[],
  workspaceId = 1,
): Promise<CategorisationResult> {
  if (categories.length === 0) {
    return { categoryId: null, confidence: 0, reasoning: "No categories defined" };
  }

  const model = await getModel(workspaceId);
  const examples = await getFewShotExamples(workspaceId);

  const categoryDescriptions = categories
    .map((cat) =>
      `ID: ${cat.id}\nName: ${cat.name}\nDescription: ${cat.description}\nInstructions: ${cat.instructions}`
    )
    .join("\n\n---\n\n");

  const messageHistory = messages
    .map((m) => `From: ${m.from_address}\n${m.body_plain}`)
    .join("\n\n---\n\n");

  const exampleMessages: ChatMessage[] = examples.flatMap((ex) => [
    {
      role: "user" as const,
      content: `Email:\n${ex.original_body ?? ""}`,
    },
    {
      role: "assistant" as const,
      content: JSON.stringify({
        categoryId: ex.category_id,
        confidence: 0.9,
        reasoning: "From a previous approved example.",
      }),
    },
  ]);

  const systemPrompt = `You are an email categorisation assistant. Analyse the email thread and choose the most appropriate category from the list provided. Return a JSON object with these exact fields:
- categoryId: number (the ID of the best matching category) or null if none fits
- confidence: number between 0.0 and 1.0
- reasoning: string (one sentence explaining the choice)

Available categories:
${categoryDescriptions}`;

  const userPrompt = `Thread subject: ${thread.subject}

Email history:
${messageHistory}`;

  const content = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      ...exampleMessages,
      { role: "user", content: userPrompt },
    ],
    model,
    { type: "json_object" },
  );

  let parsed: { categoryId: number | null; confidence: number; reasoning: string };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AppError(502, "Failed to parse categorisation response from OpenAI", content);
  }

  // Validate and clamp the confidence value.
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  const categoryId = categories.find((c) => c.id === parsed.categoryId)?.id ?? null;

  return { categoryId, confidence, reasoning: parsed.reasoning ?? "" };
}

/**
 * Generate a draft reply for an email thread based on category instructions and
 * global settings.
 *
 * @returns An object with the draft body text.
 */
export async function draftReply(
  thread: Thread,
  messages: Message[],
  category: Category,
  globalSettings: Record<string, string>,
  workspaceId = 1,
): Promise<DraftReplyResult> {
  const model = await getModel(workspaceId);
  const examples = await getFewShotExamples(workspaceId);

  const messageHistory = messages
    .map((m) => `From: ${m.from_address}\n${m.body_plain}`)
    .join("\n\n---\n\n");

  const exampleMessages: ChatMessage[] = examples
    .filter((ex) => ex.category_id === category.id && ex.original_body && ex.final_body)
    .flatMap((ex) => [
      { role: "user" as const, content: `Draft a reply to:\n${ex.original_body ?? ""}` },
      { role: "assistant" as const, content: ex.final_body ?? "" },
    ]);

  const systemPrompt = `You are an email assistant drafting a reply on behalf of a business.

Category instructions: ${category.instructions}
Writing style: ${category.writing_style}
${globalSettings["reply_signature"] ? `Signature: ${globalSettings["reply_signature"]}` : ""}

Return only the plain-text body of the email reply. Do not include subject lines, greetings framing, or JSON. Write the reply directly.`;

  const userPrompt = `Thread subject: ${thread.subject}

Full email conversation:
${messageHistory}

Draft a reply.`;

  const body = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      ...exampleMessages,
      { role: "user", content: userPrompt },
    ],
    model,
  );

  return { body };
}
