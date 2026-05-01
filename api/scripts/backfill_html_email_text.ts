/**
 * Backfill readable text for HTML-only messages.
 *
 * Usage:
 *   deno run --allow-net --allow-env scripts/backfill_html_email_text.ts
 *   deno run --allow-net --allow-env scripts/backfill_html_email_text.ts --apply --limit=500
 */
import { query, transaction } from "../db/client.ts";
import { getReadableEmailText } from "../services/email-text.ts";

interface MessageRow {
  id: number;
  body_plain: string;
  body_html: string;
}

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = Deno.args.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

const apply = Deno.args.includes("--apply");
const limit = Math.max(1, Math.min(parseInt(argValue("limit") ?? "1000"), 5000));

const rows = await query<MessageRow>(
  `SELECT id, body_plain, body_html
   FROM messages
   WHERE btrim(coalesce(body_plain, '')) = ''
     AND btrim(coalesce(body_html, '')) <> ''
   ORDER BY id ASC
   LIMIT $1`,
  [limit],
);

const updates = rows
  .map((row) => ({
    id: row.id,
    text: getReadableEmailText(row),
  }))
  .filter((row) => row.text.length > 0);

console.log(`Found ${rows.length} HTML-only message(s); ${updates.length} can be backfilled.`);

for (const update of updates.slice(0, 5)) {
  console.log(`- message ${update.id}: ${JSON.stringify(update.text.slice(0, 160))}`);
}

if (!apply) {
  console.log("Dry run only. Re-run with --apply to update messages.body_plain.");
  Deno.exit(0);
}

await transaction(async (tx) => {
  for (const update of updates) {
    await tx.queryObject({
      text: "UPDATE messages SET body_plain = $1 WHERE id = $2",
      args: [update.text, update.id],
    });
  }
});

console.log(`Backfilled ${updates.length} message(s).`);
