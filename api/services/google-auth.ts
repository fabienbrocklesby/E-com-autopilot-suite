/**
 * Google OAuth token service — single source of truth for access tokens.
 * All services that call Gmail or Sheets APIs go through `getGoogleAccessToken`.
 *
 * Tokens are stored encrypted (AES-256-GCM) in the oauth_tokens table.
 * Plaintext columns were dropped in migration 007. ENCRYPTION_KEY is required.
 *
 * To generate a key:
 *   openssl rand -base64 32
 */
import { queryOne, execute } from "../db/client.ts";
import { AppError } from "../types/index.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ─── Encryption helpers ───────────────────────────────────────────────────────

let _encryptionKey: CryptoKey | null = null;

async function loadEncryptionKey(): Promise<CryptoKey> {
  if (_encryptionKey) return _encryptionKey;

  const keyB64 = Deno.env.get("ENCRYPTION_KEY");
  if (!keyB64) {
    throw new AppError(500, "ENCRYPTION_KEY is not configured — run `openssl rand -base64 32` and add to .env");
  }

  const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) {
    throw new AppError(500, "ENCRYPTION_KEY must be exactly 32 bytes (256-bit AES key)");
  }

  _encryptionKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return _encryptionKey;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a Uint8Array of [iv (12 bytes) || ciphertext].
 * Requires ENCRYPTION_KEY to be set.
 */
export async function encryptToken(plaintext: string): Promise<Uint8Array> {
  const key = await loadEncryptionKey();

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out;
}

/**
 * Decrypt a Uint8Array produced by encryptToken.
 * Requires ENCRYPTION_KEY to be set.
 */
export async function decryptToken(data: Uint8Array): Promise<string> {
  const key = await loadEncryptionKey();

  const iv = data.slice(0, 12);
  const ct = data.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ─── Token row type ───────────────────────────────────────────────────────────

interface OAuthTokenRow {
  id: number;
  workspace_id: number;
  email: string;
  expiry: Date;
  last_history_id: string | null;
  created_at: Date;
  updated_at: Date;
  access_token_encrypted: Uint8Array | null;
  refresh_token_encrypted: Uint8Array | null;
}

// ─── Token access ─────────────────────────────────────────────────────────────

/**
 * Return a valid Google access token for the given email address, refreshing
 * the token automatically if it is within 60 seconds of expiry.
 */
export async function getGoogleAccessToken(
  email: string,
): Promise<{ token: string; email: string }> {
  const tokenRow = await queryOne<OAuthTokenRow>(
    "SELECT * FROM oauth_tokens WHERE email = $1",
    [email],
  );
  if (!tokenRow) {
    throw new AppError(401, `No OAuth token stored for ${email}`);
  }
  if (!tokenRow.access_token_encrypted || !tokenRow.refresh_token_encrypted) {
    throw new AppError(
      401,
      `OAuth token for ${email} is not encrypted. Re-authenticate via Settings → Connect Google Account.`,
    );
  }

  const expiryMs = new Date(tokenRow.expiry).getTime();
  if (Date.now() < expiryMs - 60_000) {
    const token = await decryptToken(tokenRow.access_token_encrypted);
    return { token, email };
  }

  // Token expired or about to expire — refresh.
  const refreshToken = await decryptToken(tokenRow.refresh_token_encrypted);
  const token = await refreshAndPersist(email, refreshToken);
  return { token, email };
}

/**
 * Exchange a refresh token for a new access token and persist it encrypted.
 */
async function refreshAndPersist(email: string, refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new AppError(500, "Google OAuth credentials are not configured");
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(502, "Failed to refresh Google access token", detail);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  const expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
  const encryptedAccess = await encryptToken(data.access_token);

  await execute(
    "UPDATE oauth_tokens SET access_token_encrypted = $1, expiry = $2 WHERE email = $3",
    [encryptedAccess, expiry, email],
  );

  return data.access_token;
}
