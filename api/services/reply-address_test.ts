import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractContactFormEmail, resolveReplyAddress } from "./reply-address.ts";

Deno.test("extractContactFormEmail reads Shopify contact form email field on next line", () => {
  const body = `You received a new message from your online store's contact form.
Country Code:
NZ
Name:
Lenox
Email:
lenoxh55@icloud.com
Phone:
0204776358
Body:
I found my order number it is 4525`;

  assertEquals(extractContactFormEmail(body), "lenoxh55@icloud.com");
});

Deno.test("resolveReplyAddress replies to form field for Shopify contact notification", () => {
  const result = resolveReplyAddress({
    from_address: "store+notifications@shopifyemail.com",
    body_plain: `You received a new message from your online store's contact form.
Country Code:
NZ
Name:
Lenox
Email:
lenoxh55@icloud.com
Phone:
0204776358
Body:
I found my order number it is 4525`,
  });

  assertEquals(result.address, "lenoxh55@icloud.com");
  assertEquals(result.source, "form_field");
});

Deno.test("resolveReplyAddress keeps sender for normal customer email", () => {
  const result = resolveReplyAddress({
    from_address: "Lenox <lenoxh55@icloud.com>",
    body_plain: "Please email my partner at other@example.com if needed.",
  });

  assertEquals(result.address, "Lenox <lenoxh55@icloud.com>");
  assertEquals(result.source, "sender");
});

Deno.test("resolveReplyAddress can read HTML-only contact form notifications", () => {
  const result = resolveReplyAddress({
    from_address: "notifications@shopify.com",
    body_plain: "",
    body_html: `
      <p>You received a new message from your online store's contact form.</p>
      <p>Name:<br>Lenox</p>
      <p>Email:<br>lenoxh55@icloud.com</p>
      <p>Body:<br>I found my order number it is 4525</p>
    `,
  });

  assertEquals(result.address, "lenoxh55@icloud.com");
  assertEquals(result.source, "form_field");
});
