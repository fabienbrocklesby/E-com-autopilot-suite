import {
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatTranscript, getReadableEmailText, normaliseEmailText } from "./email-text.ts";

Deno.test("getReadableEmailText prefers non-empty plain text", () => {
  const text = getReadableEmailText({
    body_plain: " Plain body with order #1234 ",
    body_html: "<p>HTML body with order #9999</p>",
  });

  assertEquals(text, "Plain body with order #1234");
});

Deno.test("getReadableEmailText converts HTML-only quoted replies", () => {
  const html = `
    <div class="preheader">\u200c \u200c \u200c Hidden preview copy</div>
    <p>Hello, I have not received my package.</p>
    <div>On Mon, Apr 20, 2026 Kadin wrote:</div>
    <blockquote>
      <p>I bought a ducktail spoiler.</p>
      <p>Order number #4593</p>
    </blockquote>
  `;

  const text = getReadableEmailText({ body_plain: "", body_html: html });

  assertStringIncludes(text, "Hello, I have not received my package.");
  assertStringIncludes(text, "Order number #4593");
  assertFalse(text.includes("\u200c"));
  assertFalse(text.includes("Hidden preview copy"));
});

Deno.test("formatTranscript includes HTML-derived body text and message metadata", () => {
  const transcript = formatTranscript([
    {
      direction: "inbound",
      from_address: "Kadin Gloyn <kadingloyn@icloud.com>",
      received_at: "2026-05-01T04:51:36.000Z",
      body_plain: "",
      body_html: "<p>Where is my package?</p><p>Order number #4593</p>",
    },
  ]);

  assertStringIncludes(transcript, "[2026-05-01T04:51:36.000Z] CUSTOMER");
  assertStringIncludes(transcript, "Kadin Gloyn <kadingloyn@icloud.com>");
  assertStringIncludes(transcript, "Order number #4593");
});

Deno.test("normaliseEmailText removes invisible characters and collapses excess blank lines", () => {
  assertEquals(normaliseEmailText("\u200bHello\r\n\r\n\r\nthere\u00a0"), "Hello\n\nthere");
});
