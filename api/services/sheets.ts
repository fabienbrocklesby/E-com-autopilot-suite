/**
 * Google Sheets service.
 * Raw HTTP calls to the Sheets REST API v4.
 * Reference: https://developers.google.com/sheets/api/reference/rest
 *
 * Provides:
 *  - readColumnHeaders: fetch header row to build column-letter→name map
 *  - syncColumns: persist column map to sheet_columns table
 *  - writeCell: write a single cell value by range
 *  - readColumn: read a flat array of values from a column range
 */
import { execute } from "../db/client.ts";
import { AppError } from "../types/index.ts";
import { getGoogleAccessToken } from "./google-auth.ts";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

// ─── Sheets API helpers ───────────────────────────────────────────────────────

async function sheetsGet<T>(email: string, path: string): Promise<T> {
  const { token: accessToken } = await getGoogleAccessToken(email);
  const res = await fetch(`${SHEETS_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
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

