/**
 * Backfill script: verify encrypted OAuth tokens are intact.
 *
 * The plaintext columns have already been dropped (migration 007 was applied before
 * this codebase state). This script is kept for reference and can be used to validate
 * that all existing token rows have non-NULL encrypted values.
 *
 * To verify:
 *   ENCRYPTION_KEY=<base64-32-bytes> deno run --allow-all api/scripts/encrypt_tokens.ts
 */
import { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { decryptToken } from "../services/google-auth.ts";

const connectionString = Deno.env.get("DATABASE_URL");
if (!connectionString) {
  console.error("DATABASE_URL is required");
  Deno.exit(1);
}

if (!Deno.env.get("ENCRYPTION_KEY")) {
  console.error("ENCRYPTION_KEY is required");
  Deno.exit(1);
}

const pool = new Pool(connectionString, 1, true);

interface TokenRow {
  id: number;
  email: string;
  access_token_encrypted: Uint8Array | null;
  refresh_token_encrypted: Uint8Array | null;
}

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.queryObject<TokenRow>({
      text: "SELECT id, email, access_token_encrypted, refresh_token_encrypted FROM oauth_tokens",
    });

    const rows = result.rows;
    console.log(`Found ${rows.length} token row(s).`);

    let ok = 0;
    let missing = 0;

    for (const row of rows) {
      if (!row.access_token_encrypted || !row.refresh_token_encrypted) {
        console.warn(`  [missing] ${row.email} - encrypted tokens are NULL. User needs to re-authenticate.`);
        missing++;
        continue;
      }

      try {
        const accessToken = await decryptToken(row.access_token_encrypted);
        const refreshToken = await decryptToken(row.refresh_token_encrypted);
        if (!accessToken || !refreshToken) throw new Error("Decrypted to empty string");
        console.log(`  [ok] ${row.email}`);
        ok++;
      } catch (err) {
        console.error(`  [ERROR] ${row.email} - decryption failed:`, err);
        Deno.exit(1);
      }
    }

    console.log(`\nDone. OK: ${ok}, Missing (needs re-auth): ${missing}`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  Deno.exit(1);
});
