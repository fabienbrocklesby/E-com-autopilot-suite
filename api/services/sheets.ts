/**
 * Google Sheets service.
 * Raw HTTP calls to the Sheets REST API v4.
 * Reference: https://developers.google.com/sheets/api/reference/rest
 *
 * Provides:
 *  - readColumnHeaders: fetch header row to build column-letter→name map
 *  - syncColumns: persist column map to sheet_columns table
 *  - findRowByValue: locate a row where a given column matches a value
 *  - applyUpdates: write cell values and store an audit record in sheet_updates
 */
import { queryOne, execute, query } from "../db/client.ts";
import { AppError, OAuthToken, SheetColumn, SheetUpdate } from "../types/index.ts";

/** Describes a single cell write with the row-matching key. Used by applyUpdates(). */
interface SheetUpdateInstruction {
  column: string;
  value: string;
  matchColumn: string;
  matchValue: string;
}

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

/**
 * Read the header row (row 1) of a sheet and return a map from
 * column letter → header name.
 */
export async function readColumnHeaders(
  email: string,
  spreadsheetId: string,
  sheetName: string,
): Promise<Map<string, string>> {
  const range = `${sheetName}!1:1`;
  const data = await sheetsGet<{ values?: string[][] }>(
    email,
    `/${spreadsheetId}/values/${encodeURIComponent(range)}`,
  );
  const headers = data.values?.[0] ?? [];
  const map = new Map<string, string>();
  for (let i = 0; i < headers.length; i++) {
    const letter = columnIndexToLetter(i);
    map.set(letter, headers[i]);
  }
  return map;
}

/**
 * Persist the column header map into the sheet_columns table for a workspace,
 * replacing any previous mapping.
 */
export async function syncColumns(
  workspaceId: number,
  columnMap: Map<string, string>,
): Promise<void> {
  await execute("DELETE FROM sheet_columns WHERE workspace_id = $1", [workspaceId]);
  for (const [letter, name] of columnMap.entries()) {
    if (!name?.trim()) continue;
    await execute(
      `INSERT INTO sheet_columns (workspace_id, column_letter, header_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, column_letter) DO UPDATE SET header_name = EXCLUDED.header_name`,
      [workspaceId, letter, name.trim()],
    );
  }
}

/**
 * Find the 1-based row number where column `colLetter` equals `value`.
 * Returns null if no match is found.
 * Reads the entire column (starting at row 2 to skip header).
 */
export async function findRowByValue(
  email: string,
  spreadsheetId: string,
  sheetName: string,
  colLetter: string,
  value: string,
): Promise<number | null> {
  const range = `${sheetName}!${colLetter}2:${colLetter}`;
  const data = await sheetsGet<{ values?: string[][] }>(
    email,
    `/${spreadsheetId}/values/${encodeURIComponent(range)}`,
  );
  const rows = data.values ?? [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.[0] === value) {
      return i + 2; // +2 because we started at row 2
    }
  }
  return null;
}

/**
 * Apply a list of cell update instructions to a Google Sheet.
 * For each instruction:
 *  - Resolve the column letter from sheet_columns by header name
 *  - Find the matching row
 *  - Write the new value
 *  - Record the outcome in sheet_updates (applied or with error)
 *
 * Never throws — all errors are stored in the audit log.
 */
export async function applyUpdates(
  email: string,
  workspaceId: number,
  threadId: number | null,
  spreadsheetId: string,
  sheetName: string,
  instructions: SheetUpdateInstruction[],
): Promise<void> {
  // Load the column map for this workspace.
  const cols = await query<SheetColumn>(
    "SELECT * FROM sheet_columns WHERE workspace_id = $1",
    [workspaceId],
  );
  const headerToLetter = new Map(cols.map((c) => [c.header_name.toLowerCase(), c.column_letter]));

  for (const inst of instructions) {
    const matchColLetter = headerToLetter.get(inst.matchColumn.toLowerCase());
    const writeColLetter = headerToLetter.get(inst.column.toLowerCase());

    let appliedFlag = false;
    let errorMsg: string | null = null;

    if (!matchColLetter) {
      errorMsg = `No column found with header "${inst.matchColumn}"`;
    } else if (!writeColLetter) {
      errorMsg = `No column found with header "${inst.column}"`;
    } else {
      try {
        const rowNumber = await findRowByValue(
          email,
          spreadsheetId,
          sheetName,
          matchColLetter,
          inst.matchValue,
        );

        if (rowNumber === null) {
          errorMsg = `No matching row found for ${inst.matchColumn}=${inst.matchValue}`;
        } else {
          const cellRange = `${sheetName}!${writeColLetter}${rowNumber}`;
          await sheetsPut(email, `/${spreadsheetId}/values/${encodeURIComponent(cellRange)}?valueInputOption=USER_ENTERED`, {
            range: cellRange,
            majorDimension: "ROWS",
            values: [[inst.value]],
          });
          appliedFlag = true;
          console.log(`[sheets] Updated ${cellRange} = "${inst.value}" for workspace ${workspaceId}`);
        }
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
      }
    }

    // Always write an audit record.
    await execute(
      `INSERT INTO sheet_updates
         (workspace_id, thread_id, column_letter, match_column, match_value, new_value, applied, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        workspaceId,
        threadId,
        writeColLetter ?? "?",
        inst.matchColumn,
        inst.matchValue,
        inst.value,
        appliedFlag,
        errorMsg,
      ],
    );

    if (errorMsg) {
      console.warn(`[sheets] Sheet update not applied: ${errorMsg}`);
    }
  }
}

/**
 * Read all rows from the threads tracking sheet (legacy helper — kept for
 * backwards compatibility).
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

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Convert a 0-based column index to a spreadsheet column letter (A, B, … Z, AA, …). */
function columnIndexToLetter(index: number): string {
  let letter = "";
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

