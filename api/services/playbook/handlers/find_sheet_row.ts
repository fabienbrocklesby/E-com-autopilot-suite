/**
 * Find sheet row handler.
 * Tries each match_attempt in order. On first match, writes row_number to
 * context and advances. If no attempt matches, writes row_number = null and
 * advances so the playbook can branch on the result.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep, FindSheetRowStep } from "../types.ts";
import { queryOne } from "../../../db/client.ts";
import { chatCompletion, getModel } from "../../ai.ts";
import { getGoogleAccessToken } from "../../google-auth.ts";
import { AppError } from "../../../types/index.ts";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export const findSheetRowHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const findStep = step as FindSheetRowStep;

    const workspace = await queryOne<{
      sheet_id: string | null;
      sheet_name: string;
    }>("SELECT sheet_id, sheet_name FROM workspaces WHERE id = $1", [ctx.workspaceId]);

    if (!workspace?.sheet_id) {
      return { decision: { action: "fail", error: "No sheet configured for workspace" } };
    }

    const model = await getModel(ctx.workspaceId);
    const transcript = ctx.messages
      .map((m) => `From: ${m.from_address}\n${m.body_plain}`)
      .join("\n\n---\n\n");

    for (const attempt of findStep.match_attempts) {
      const contextValue = ctx.variables[attempt.context_var];
      if (contextValue === null || contextValue === undefined || contextValue === "") {
        continue;
      }

      // Resolve column letter — attempt.column may be a letter or a header name.
      const colRow = await queryOne<{ column_letter: string }>(
        `SELECT column_letter FROM sheet_columns
         WHERE workspace_id = $1 AND (column_letter = $2 OR header_name = $2)
         LIMIT 1`,
        [ctx.workspaceId, attempt.column],
      );
      if (!colRow) {
        console.warn(`[playbook] find_sheet_row: column "${attempt.column}" not in sheet_columns for workspace ${ctx.workspaceId}`);
        continue;
      }

      const range = `${workspace.sheet_name}!${colRow.column_letter}2:${colRow.column_letter}1000`;
      const values = await readColumn(ctx.email, workspace.sheet_id, range);
      const candidates = values
        .map((v, i) => ({ row: i + 2, value: v }))
        .filter((c) => c.value.trim() !== "");

      if (candidates.length === 0) continue;

      const { match, aiPrompt, aiResponse } = await findMatchingRow(
        transcript,
        String(contextValue),
        candidates,
        model,
      );

      const aiCalls = [{ model, prompt: aiPrompt, response: aiResponse }];

      if (match) {
        return {
          decision: { action: "advance" },
          output: {
            found: true,
            row_number: match.rowNumber,
            matched_value: match.matchedValue,
            column: attempt.column,
            context_var: attempt.context_var,
          },
          contextUpdates: { row_number: match.rowNumber },
          aiCalls,
        };
      }
    }

    // No match found across all attempts.
    return {
      decision: { action: "advance" },
      output: { found: false },
      contextUpdates: { row_number: null },
    };
  },
};

async function readColumn(
  email: string,
  spreadsheetId: string,
  range: string,
): Promise<string[]> {
  const { token } = await getGoogleAccessToken(email);
  const res = await fetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(res.status as 400 | 401 | 403 | 404 | 500, "Sheets API error", detail);
  }
  const data = await res.json() as { values?: string[][] };
  return (data.values ?? []).map((row) => row[0] ?? "");
}

async function findMatchingRow(
  transcript: string,
  searchValue: string,
  candidates: Array<{ row: number; value: string }>,
  model: string,
): Promise<{ match: { rowNumber: number; matchedValue: string } | null; aiPrompt: string; aiResponse: string }> {
  const candidateList = candidates.map((c) => `Row ${c.row}: "${c.value}"`).join("\n");

  const prompt = `You are a data matching assistant. Identify which spreadsheet row corresponds to the entity described in this email thread.

Search value: ${searchValue}

Candidates:
${candidateList}

Email thread:
${transcript}

Return JSON: { "row": <row number or null>, "matched_value": "<cell value or null>" }
If no confident match, return { "row": null, "matched_value": null }.`;

  const response = await chatCompletion(
    [{ role: "user", content: prompt }],
    model,
    { type: "json_object" },
  );

  let parsed: { row: number | null; matched_value: string | null };
  try {
    parsed = JSON.parse(response);
  } catch {
    return { match: null, aiPrompt: prompt, aiResponse: response };
  }

  if (!parsed.row || !parsed.matched_value) {
    return { match: null, aiPrompt: prompt, aiResponse: response };
  }

  return {
    match: { rowNumber: parsed.row, matchedValue: parsed.matched_value },
    aiPrompt: prompt,
    aiResponse: response,
  };
}
