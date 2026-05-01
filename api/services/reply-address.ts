/**
 * Resolve the real customer address for replies.
 *
 * Some inbound messages are form notifications from Shopify or another store
 * system. In those cases the message sender is the platform, while the real
 * customer address is a labelled field in the email body.
 */
import { getReadableEmailText } from "./email-text.ts";

export interface ReplyAddressMessage {
  from_address: string;
  body_plain?: string | null;
  body_html?: string | null;
}

export interface ReplyAddressResolution {
  address: string;
  source: "sender" | "form_field";
  reason: string;
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const FORM_INDICATORS = [
  /contact form/i,
  /online store'?s contact form/i,
  /you received a new message/i,
  /^country code:/im,
  /^body:/im,
  /^phone:/im,
];

const AUTOMATED_SENDER_HINTS = [
  /shopify/i,
  /no-?reply/i,
  /notification/i,
  /mailer/i,
  /contact form/i,
];

export function resolveReplyAddress(message: ReplyAddressMessage): ReplyAddressResolution {
  const body = getReadableEmailText(message);
  const formEmail = extractContactFormEmail(body);

  if (formEmail && isLikelyFormNotification(message.from_address, body)) {
    return {
      address: formEmail,
      source: "form_field",
      reason: "Detected contact form notification with labelled customer email field",
    };
  }

  return {
    address: message.from_address,
    source: "sender",
    reason: "Using inbound message sender",
  };
}

export function extractContactFormEmail(body: string): string | null {
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];
    const sameLine = current.match(/^e-?mail\s*:\s*(.+)$/i);
    if (sameLine) {
      const match = sameLine[1].match(EMAIL_PATTERN);
      if (match) return match[0];
    }

    if (/^e-?mail\s*:?\s*$/i.test(current)) {
      const next = lines[i + 1]?.match(EMAIL_PATTERN);
      if (next) return next[0];
    }
  }

  return null;
}

function isLikelyFormNotification(fromAddress: string, body: string): boolean {
  const hasFormShape = FORM_INDICATORS.some((pattern) => pattern.test(body));
  if (!hasFormShape) return false;

  const senderLooksAutomated = AUTOMATED_SENDER_HINTS.some((pattern) => pattern.test(fromAddress));
  const hasMultipleFormLabels = ["name", "email", "body", "phone", "country code"]
    .filter((label) => new RegExp(`^${label}:`, "im").test(body))
    .length >= 3;

  return senderLooksAutomated || hasMultipleFormLabels;
}
