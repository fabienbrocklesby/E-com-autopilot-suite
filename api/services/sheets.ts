/**
 * Google Sheets service.
 * Raw HTTP calls to the Sheets REST API v4.
 * Reference: https://developers.google.com/sheets/api/reference/rest
 *
 * Methods are scoped to the specific operations the app actually needs:
 * reading thread summaries and writing processed results back to a sheet.
 */
import { queryOne, execute } from "../db/client.ts";
import { AppError, OAuthToken } from "../types/index.ts";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ─── Token management ─────────────────────────────────────────────────────────

async function getValidAccessToken(email: string): Promise<string> {
  const tokenRow = await queryOne<OAuthToken>(
    "SELECT * FROM oauth_tokens WHERE email = $1",
    [email],
  );
  if (!tokenRow) throw new AppError(401, `No OAuth token stored for ${email}`);

  const expiryMs = new Date(tokenRow.expiry).getTime();
  if (Date.now() < expiryMs - 60_000) return tokenRow.access_token;

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
      refresh_token: tokenRow.refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(502, "Failed to refresh Google access token", detail);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  const expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await execute(
    "UPDATE oauth_tokens SET access_token = $1, expiry = $2 WHERE email = $3",
    [data.access_token, expiry, email],
  );
  return data.access_token;
}

// ─── Sheets API helpers ───────────────────────────────────────────────────────

async function sheetsGet<T>(email: string, path: string): Promise<T> {
  const accessToken = await getValidAccessToken(email);
  const res = await fetch(`${SHEETS_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(res.status as 400 | 401 | 403 | 404 | 500, `Sheets API error`, detail);
  }
  return res.json() as Promise<T>;
}

async function sheetsPut<T>(email: string, path: string, body: unknown): Promise<T> {
  const accessToken = await getValidAccessToken(email);
  const res = await fetch(`${SHEETS_BASE}${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(res.status as 400 | 401 | 403 | 404 | 500, `Sheets API error`, detail);
  }
  return res.json() as Promise<T>;
}

async function sheetsAppend<T>(email: string, path: string, body: unknown): Promise<T> {
  const accessToken = await getValidAccessToken(email);
  const res = await fetch(`${SHEETS_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(res.status as 400 | 401 | 403 | 404 | 500, `Sheets API error`, detail);
  }
  return res.json() as Promise<T>;
}

// ─── Public methods ───────────────────────────────────────────────────────────

export interface SheetThreadRow {
  threadId: string;
  subject: string;
  category: string;
  status: string;
  confidence: string;
  processedAt: string;
}

/**
 * Read all rows from the threads tracking sheet.
 * Assumes the first row is a header row; returns the data rows.
 */
export async function readThreadsSheet(
  email: string,
  spreadsheetId: string,
  sheetName: string,
): Promise<string[][]> {
  const range = `${sheetName}!A2:Z`;
  const data = await sheetsGet<{ values?: string[][] }>(
    email,
    `/${spreadsheetId}/values/${encodeURIComponent(range)}`,
  );
  return data.values ?? [];
}

/**
 * Append a processed thread row to the tracking sheet.
 */
export async function appendThreadRow(
  email: string,
  spreadsheetId: string,
  sheetName: string,
  row: SheetThreadRow,
): Promise<void> {
  const values = [
    [
      row.threadId,
      row.subject,
      row.category,
      row.status,
      row.confidence,
      row.processedAt,
    ],
  ];

  await sheetsAppend(
    email,
    `/${spreadsheetId}/values/${encodeURIComponent(sheetName)}:append?valueInputOption=USER_ENTERED`,
    { values },
  );
}

/**
 * Update a specific cell range in the sheet.
 */
export async function updateSheetRange(
  email: string,
  spreadsheetId: string,
  range: string,
  values: string[][],
): Promise<void> {
  await sheetsPut(
    email,
    `/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { range, majorDimension: "ROWS", values },
  );
}
