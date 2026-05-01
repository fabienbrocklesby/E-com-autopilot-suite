/**
 * Shared email text normalisation for AI prompts and stored message text.
 *
 * Gmail sometimes gives HTML-only bodies. The dashboard can render that HTML,
 * but playbook AI prompts need readable text or they lose quoted thread context.
 */
import { convert } from "npm:html-to-text@10.0.0";

export interface EmailTextSource {
  body_plain?: string | null;
  body_html?: string | null;
}

export interface TranscriptMessage extends EmailTextSource {
  from_address: string;
  direction: "inbound" | "outbound";
  received_at: Date | string;
}

const INVISIBLE_CHARS = /[\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

export function normaliseEmailText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE_CHARS, "")
    .replace(/\u00a0/g, " ")
    .replace(/\u00ad/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToReadableText(html: string): string {
  const text = convert(html, {
    wordwrap: false,
    preserveNewlines: true,
    selectors: [
      { selector: "[hidden]", format: "skip" },
      { selector: '[style*="display:none"]', format: "skip" },
      { selector: '[style*="display: none"]', format: "skip" },
      { selector: ".preheader", format: "skip" },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  });

  return normaliseEmailText(text);
}

export function getReadableEmailText(source: EmailTextSource): string {
  const plain = normaliseEmailText(source.body_plain ?? "");
  if (plain) return plain;

  const html = source.body_html ?? "";
  if (!html.trim()) return "";

  return htmlToReadableText(html);
}

export function formatTranscriptMessage(message: TranscriptMessage): string {
  const speaker = message.direction === "inbound" ? "CUSTOMER" : "US";
  const receivedAt = message.received_at instanceof Date
    ? message.received_at.toISOString()
    : new Date(message.received_at).toISOString();
  const body = getReadableEmailText(message);

  return `[${receivedAt}] ${speaker} (${message.from_address}):\n${body || "(no readable body)"}`;
}

export function formatTranscript(messages: TranscriptMessage[]): string {
  return messages.map(formatTranscriptMessage).join("\n\n---\n\n");
}
