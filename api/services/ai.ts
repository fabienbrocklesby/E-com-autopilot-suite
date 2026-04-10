/**
 * AI service — OpenAI API integration.
 * Uses raw fetch against the /v1/chat/completions endpoint.
 * Reference: https://platform.openai.com/docs/api-reference/chat/create
 */
import { AppError, CategorisationResult, Category, DraftReplyResult, Thread, Message } from "../types/index.ts";
import { queryOne } from "../db/client.ts";
import { Setting } from "../types/index.ts";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

function getApiKey(): string {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new AppError(500, "OPENAI_API_KEY is not configured");
  return key;
}

async function getModel(): Promise<string> {
  const setting = await queryOne<Setting>(
    "SELECT value FROM settings WHERE key = 'openai_model'",
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

/**
 * Make a chat completion request to OpenAI. Handles rate limiting (429) with a
 * single retry after the duration specified in the Retry-After header.
 */
async function chatCompletion(
  messages: ChatMessage[],
  model: string,
  responseFormat?: { type: "json_object" },
): Promise<string> {
  const apiKey = getApiKey();

  const body = {
    model,
    messages,
    store: false,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  };

  const doRequest = async (): Promise<Response> =>
    await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

  let res = await doRequest();

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "5");
    console.warn(`[ai] Rate limited. Retrying after ${retryAfter}s`);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    res = await doRequest();
  }

  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(502, `OpenAI API error: ${res.status}`, detail);
  }

  const data = await res.json() as OpenAIResponse;
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new AppError(502, "OpenAI returned an empty response");
  }

  return content;
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
): Promise<CategorisationResult> {
  if (categories.length === 0) {
    return { categoryId: null, confidence: 0, reasoning: "No categories defined" };
  }

  const model = await getModel();

  const categoryDescriptions = categories
    .map((cat) =>
      `ID: ${cat.id}\nName: ${cat.name}\nDescription: ${cat.description}\nInstructions: ${cat.instructions}`
    )
    .join("\n\n---\n\n");

  const messageHistory = messages
    .map((m) => `From: ${m.from_address}\n${m.body_plain}`)
    .join("\n\n---\n\n");

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
): Promise<DraftReplyResult> {
  const model = await getModel();

  const messageHistory = messages
    .map((m) => `From: ${m.from_address}\n${m.body_plain}`)
    .join("\n\n---\n\n");

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
      { role: "user", content: userPrompt },
    ],
    model,
  );

  return { body };
}
