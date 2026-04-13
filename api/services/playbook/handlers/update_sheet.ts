/**
 * Update sheet handler.
 * Reads row_number from context (via row_var), resolves each column/value,
 * and writes to the sheet. value_or_var supports literal strings or
 * {{variable_name}} / {variable_name} placeholders referencing context variables.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep, UpdateSheetStep } from "../types.ts";
import { queryOne } from "../../../db/client.ts";
import { getGoogleAccessToken } from "../../google-auth.ts";
import { AppError } from "../../../types/index.ts";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export const updateSheetHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const updateStep = step as UpdateSheetStep;

    const rowNumber = ctx.variables[updateStep.row_var];
    if (rowNumber === null || rowNumber === undefined) {
      return {
        decision: { action: "fail", error: `Context variable "${updateStep.row_var}" is not set; cannot write to sheet` },
      };
    }
    const row = Number(rowNumber);
    if (!Number.isFinite(row) || row < 2) {
      return {
        decision: { action: "fail", error: `Invalid row number: ${rowNumber}` },
      };
    }

    const workspace = await queryOne<{
      sheet_id: string | null;
      sheet_name: string;
    }>("SELECT sheet_id, sheet_name FROM workspaces WHERE id = $1", [ctx.workspaceId]);

    if (!workspace?.sheet_id) {
      return { decision: { action: "fail", error: "No sheet configured for workspace" } };
    }

    const written: Record<string, string> = {};

    for (const upd of updateStep.updates) {
      // Resolve column letter from sheet_columns.
      const colRow = await queryOne<{ column_letter: string }>(
        `SELECT column_letter FROM sheet_columns
         WHERE workspace_id = $1 AND (column_letter = $2 OR header_name = $2)
         LIMIT 1`,
        [ctx.workspaceId, upd.column],
      );
      if (!colRow) {
        console.warn(`[playbook] update_sheet: column "${upd.column}" not in sheet_columns for workspace ${ctx.workspaceId}`);
        continue;
      }

      const value = interpolate(upd.value_or_var, ctx.variables);
      await writeCell(ctx.email, workspace.sheet_id, workspace.sheet_name, colRow.column_letter, row, value);
      written[upd.column] = value;
    }

    return {
      decision: { action: "advance" },
      output: { row, written },
    };
  },
};

/** Interpolate {{var}} and {var} placeholders from context. */
function interpolate(template: string, variables: Record<string, unknown>): string {
  return template
    .replace(/\{\{(\w+)\}\}/g, (_m, k) => {
      const v = variables[k];
      return v !== null && v !== undefined ? String(v) : "";
    })
    .replace(/\{(\w+)\}/g, (_m, k) => {
      const v = variables[k];
      return v !== null && v !== undefined ? String(v) : "";
    });
}

async function writeCell(
  email: string,
  spreadsheetId: string,
  sheetName: string,
  columnLetter: string,
  rowNumber: number,
  value: string,
): Promise<void> {
  const { token } = await getGoogleAccessToken(email);
  const cellRange = `${sheetName}!${columnLetter}${rowNumber}`;
  const res = await fetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(cellRange)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        range: cellRange,
        majorDimension: "ROWS",
        values: [[value]],
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(
      res.status as 400 | 401 | 403 | 404 | 500,
      `Sheets API write failed for ${cellRange}`,
      detail,
    );
  }
  console.log(`[playbook] update_sheet: wrote "${value}" to ${cellRange}`);
}
