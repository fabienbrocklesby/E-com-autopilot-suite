/**
 * Sheet Rules service.
 * Evaluates user-configured sheet rules against an email thread and either
 * applies the resulting updates immediately or queues them for manual review.
 *
 * Each rule defines:
 *  - A match instruction (AI extracts a value from the email, e.g. order number)
 *  - A match column (which sheet column to search for that value)
 *  - A list of update definitions (fixed values or AI-determined values)
 *  - Whether to auto-apply or send to review queue
 */
import { query, queryOne, execute } from "../db/client.ts";
import {
  AppError,
  OAuthToken,
  SheetColumn,
  SheetRule,
  SheetRuleExecution,
  RuleUpdateDefinition,
  Thread,
  Workspace,
} from "../types/index.ts";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const GOOGLE_TOKEN_URL_SR = "https://oauth2.googleapis.com/token";

function getApiKey(): string {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new AppError(500, "OPENAI_API_KEY is not configured");
  return key;
}

async function getModel(workspaceId: number): Promise<string> {
  const row = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE workspace_id = $1 AND key = 'openai_model'",
    [workspaceId],
  );
  return row?.value ?? Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
}

/** Single-purpose chat completion — returns the raw content string. */
async function complete(
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model,
      store: false,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "5");
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return complete(model, system, user);
  }

  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(502, `OpenAI API error: ${res.status}`, detail);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new AppError(502, "OpenAI returned an empty response");
  return content;
}

/**
 * Use AI to find the best matching row number from a list of candidate cell values.
 *
 * Rather than extracting a value and doing an exact string match, we pass the
 * full column contents to the AI alongside the email and let it reason about
 * which row is the best match (handles name-from-email inference, fuzzy names,
 * different formats, etc.).
 *
 * Returns a 1-based row number, or null if no confident match was found.
 */
async function findMatchingRow(
  threadContent: string,
  matchInstruction: string,
  candidates: Array<{ row: number; value: string }>,
  model: string,
): Promise<{ rowNumber: number; matchedValue: string } | null> {
  if (candidates.length === 0) return null;

  const candidateList = candidates
    .map((c) => `Row ${c.row}: "${c.value}"`)
    .join("\n");

  const system = `You are a data matching assistant. Your job is to identify which row in a spreadsheet corresponds to the person or entity in an email thread.

Matching instruction: ${matchInstruction}

Here are the candidate rows from the spreadsheet column:
${candidateList}

Analyse the email and pick the single row that best matches.
Return a JSON object:
  { "row": <row number>, "matched_value": "<cell value>" }
If you cannot confidently identify a match, return:
  { "row": null, "matched_value": null }

Be liberal but sensible — e.g. "john@smith.com" can reasonably match "John Smith".`;

  const content = await complete(model, system, threadContent);

  let parsed: { row: number | null; matched_value: string | null };
  try {
    parsed = JSON.parse(content);
  } catch {
    console.warn("[sheet-rules] findMatchingRow: failed to parse AI response", content);
    return null;
  }

  if (!parsed.row || !parsed.matched_value) return null;
  return { rowNumber: parsed.row, matchedValue: parsed.matched_value };
}

/**
 * Use AI to determine the value for a single column update.
 */
async function resolveAiUpdateValue(
  threadContent: string,
  column: string,
  instruction: string,
  model: string,
): Promise<string> {
  const system = `You are a data extraction assistant. Determine the appropriate value for a spreadsheet column based on an email thread.
Column: ${column}
Instruction: ${instruction}
Return a JSON object: { "value": "determined value" }`;

  const content = await complete(model, system, threadContent);

  let parsed: { value: string };
  try {
    parsed = JSON.parse(content);
  } catch {
    console.warn("[sheet-rules] resolveAiUpdateValue: failed to parse AI response for column", column, content);
    return "";
  }

  return parsed.value ?? "";
}

/**
 * Resolve all update definitions for a rule into a concrete column→value map.
 * Fixed-mode entries are used as-is; AI-mode entries make an AI call.
 */
async function resolveUpdates(
  threadContent: string,
  updates: RuleUpdateDefinition[],
  model: string,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const upd of updates) {
    if (upd.mode === "fixed") {
      resolved[upd.column] = upd.value ?? "";
    } else if (upd.mode === "ai" && upd.instruction) {
      resolved[upd.column] = await resolveAiUpdateValue(
        threadContent,
        upd.column,
        upd.instruction,
        model,
      );
    }
  }

  return resolved;
}

/**
 * Write the proposed updates for an execution to the sheet.
 * Looks up each column header in sheet_columns to find the column letter, then
 * writes each cell at the matched row.
 */
async function writeToSheet(
  email: string,
  spreadsheetId: string,
  sheetName: string,
  rowNumber: number,
  proposedUpdates: Record<string, string>,
  workspaceId: number,
): Promise<void> {
  const accessToken = await getAccessToken(email);

  for (const [columnLetter, value] of Object.entries(proposedUpdates)) {
    const cellRange = `${sheetName}!${columnLetter}${rowNumber}`;
    const res = await fetch(
      `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(cellRange)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
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

    console.log(`[sheet-rules] Wrote "${value}" to ${cellRange}`);
  }
}

/** Get a fresh access token for the email — delegates to stored token with refresh. */
async function getAccessToken(email: string): Promise<string> {
  const tokenRow = await queryOne<OAuthToken>(
    "SELECT * FROM oauth_tokens WHERE email = $1",
    [email],
  );
  if (!tokenRow) throw new AppError(401, `No OAuth token stored for ${email}`);

  const expiryMs = new Date(tokenRow.expiry).getTime();
  if (Date.now() < expiryMs - 60_000) return tokenRow.access_token;

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new AppError(500, "Google OAuth credentials not configured");

  const res = await fetch(GOOGLE_TOKEN_URL_SR, {
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

/** Read a single column range from a sheet, returns a flat array of cell values (row 2 onward). */
async function sheetsGetColumn(
  email: string,
  spreadsheetId: string,
  range: string,
): Promise<string[]> {
  const accessToken = await getAccessToken(email);
  const res = await fetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(res.status as 400 | 401 | 403 | 404 | 500, "Sheets API error", detail);
  }
  const data = await res.json() as { values?: string[][] };
  return (data.values ?? []).map((row) => row[0] ?? "");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate all active sheet rules for a thread after categorisation.
 * Failures per-rule are stored as executions with status="failed" and never
 * propagated — the email pipeline must not break due to sheet rule errors.
 */
export async function evaluateRules(threadId: number, workspaceId: number): Promise<void> {
  const workspace = await queryOne<Workspace>(
    "SELECT * FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  if (!workspace?.sheet_id) return;
  if (!workspace.gmail_address) return;

  const tokenRow = await queryOne<OAuthToken>(
    "SELECT * FROM oauth_tokens WHERE email = $1",
    [workspace.gmail_address],
  );
  if (!tokenRow) return;

  const thread = await queryOne<Thread>(
    "SELECT * FROM threads WHERE id = $1",
    [threadId],
  );
  if (!thread) return;

  // Load active rules that apply to this thread's category.
  // NULL category_ids means the rule applies to all categories.
  const rules = await query<SheetRule>(
    `SELECT * FROM sheet_rules
     WHERE workspace_id = $1
       AND is_active = true
       AND (category_ids IS NULL OR $2 = ANY(category_ids))`,
    [workspaceId, thread.category_id],
  );

  if (!rules.length) return;

  const model = await getModel(workspaceId);

  // Build a rich context string for the AI: includes subject, sender, and summary.
  // This ensures extraction instructions like "get the sender's email" work correctly.
  const firstMessage = await queryOne<{ from_address: string }>(
    "SELECT from_address FROM messages WHERE thread_id = $1 ORDER BY id ASC LIMIT 1",
    [threadId],
  );

  const threadContent = [
    `Subject: ${thread.subject}`,
    firstMessage ? `From: ${firstMessage.from_address}` : null,
    thread.thread_summary ? `\nEmail content:\n${thread.thread_summary}` : null,
  ].filter(Boolean).join("\n");

  if (!threadContent.trim()) return;

  for (const rule of rules) {
    await evaluateSingleRule(
      rule,
      thread,
      threadContent,
      workspace,
      tokenRow,
      model,
      workspaceId,
    );
  }
}

async function evaluateSingleRule(
  rule: SheetRule,
  thread: Thread,
  threadContent: string,
  workspace: Workspace,
  tokenRow: OAuthToken,
  model: string,
  workspaceId: number,
): Promise<void> {
  try {
    // Step 1: Look up the match column metadata.
    const matchCol = await queryOne<SheetColumn>(
      "SELECT * FROM sheet_columns WHERE workspace_id = $1 AND column_letter = $2",
      [workspaceId, rule.match_column],
    );

    if (!matchCol) {
      await recordExecution({
        workspaceId,
        ruleId: rule.id,
        threadId: thread.id,
        matchValue: null,
        rowNumber: null,
        proposedUpdates: {},
        status: "failed",
        error: `Match column "${rule.match_column}" not found in sheet columns`,
      });
      return;
    }

    // Step 2: Read all current values in the match column from the sheet.
    // Pass them to the AI alongside the email so it can reason about which row
    // best matches the instruction (handles fuzzy names, email→name inference, etc.)
    const range = `${workspace.sheet_name}!${matchCol.column_letter}2:${matchCol.column_letter}`;
    const sheetData = await sheetsGetColumn(
      tokenRow.email,
      workspace.sheet_id!,
      range,
    );
    const candidates = sheetData
      .map((value, i) => ({ row: i + 2, value: value ?? "" }))
      .filter((c) => c.value.trim() !== "");

    const match = await findMatchingRow(threadContent, rule.match_instruction, candidates, model);

    if (!match) {
      await recordExecution({
        workspaceId,
        ruleId: rule.id,
        threadId: thread.id,
        matchValue: null,
        rowNumber: null,
        proposedUpdates: {},
        status: "failed",
        error: `No matching row found using instruction: "${rule.match_instruction}"`,
      });
      return;
    }

    const { rowNumber, matchedValue } = match;

    // Step 3: Resolve update values.
    const proposedUpdates = await resolveUpdates(threadContent, rule.updates, model);

    if (rule.auto_apply) {
      // Write to sheet immediately.
      try {
        await writeToSheet(
          tokenRow.email,
          workspace.sheet_id!,
          workspace.sheet_name,
          rowNumber,
          proposedUpdates,
          workspaceId,
        );
        await recordExecution({
          workspaceId,
          ruleId: rule.id,
          threadId: thread.id,
          matchValue: matchedValue,
          rowNumber,
          proposedUpdates,
          status: "applied",
          appliedAt: new Date().toISOString(),
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await recordExecution({
          workspaceId,
          ruleId: rule.id,
          threadId: thread.id,
          matchValue: matchedValue,
          rowNumber,
          proposedUpdates,
          status: "failed",
          error: `Sheet write failed: ${errorMsg}`,
        });
      }
    } else {
      // Queue for manual review.
      await recordExecution({
        workspaceId,
        ruleId: rule.id,
        threadId: thread.id,
        matchValue: matchedValue,
        rowNumber,
        proposedUpdates,
        status: "pending",
      });
    }
  } catch (err) {
    // Catch anything the rule evaluation throws so one rule failure doesn't
    // prevent other rules from running or break the email pipeline.
    let errorMsg = err instanceof Error ? err.message : String(err);
    if (err instanceof AppError && err.detail) {
      errorMsg = `${errorMsg}: ${err.detail}`;
    }
    console.error(`[sheet-rules] Rule ${rule.id} evaluation error:`, errorMsg);
    await recordExecution({
      workspaceId,
      ruleId: rule.id,
      threadId: thread.id,
      matchValue: null,
      rowNumber: null,
      proposedUpdates: {},
      status: "failed",
      error: errorMsg,
    }).catch((e) => console.error("[sheet-rules] Failed to record execution:", e));
  }
}

interface ExecutionRecord {
  workspaceId: number;
  ruleId: number;
  threadId: number | null;
  matchValue: string | null;
  rowNumber: number | null;
  proposedUpdates: Record<string, string>;
  status: SheetRuleExecution["status"];
  error?: string;
  appliedAt?: string;
}

async function recordExecution(rec: ExecutionRecord): Promise<void> {
  await execute(
    `INSERT INTO sheet_rule_executions
       (workspace_id, rule_id, thread_id, match_value, row_number, proposed_updates, status, error, applied_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      rec.workspaceId,
      rec.ruleId,
      rec.threadId,
      rec.matchValue,
      rec.rowNumber,
      JSON.stringify(rec.proposedUpdates),
      rec.status,
      rec.error ?? null,
      rec.appliedAt ?? null,
    ],
  );
}

/**
 * Apply a pending execution to the sheet and mark it as approved+applied.
 * Called from the review queue approve endpoint.
 */
export async function approveExecution(executionId: number): Promise<void> {
  const exec = await queryOne<SheetRuleExecution>(
    "SELECT * FROM sheet_rule_executions WHERE id = $1",
    [executionId],
  );
  if (!exec) throw new AppError(404, "Execution not found");
  if (exec.status !== "pending") {
    throw new AppError(422, `Execution is in status "${exec.status}", not pending`);
  }

  const rule = await queryOne<SheetRule>(
    "SELECT * FROM sheet_rules WHERE id = $1",
    [exec.rule_id],
  );
  if (!rule) throw new AppError(404, "Associated rule not found");

  const workspace = await queryOne<Workspace>(
    "SELECT * FROM workspaces WHERE id = $1",
    [exec.workspace_id],
  );
  if (!workspace?.sheet_id) throw new AppError(422, "No sheet configured for workspace");
  if (!workspace.gmail_address) throw new AppError(422, "No Gmail address configured for workspace");

  const tokenRow = await queryOne<OAuthToken>(
    "SELECT * FROM oauth_tokens WHERE email = $1",
    [workspace.gmail_address],
  );
  if (!tokenRow) throw new AppError(500, "No OAuth token for workspace");

  if (exec.row_number === null) {
    throw new AppError(422, "Execution has no row number — cannot write to sheet");
  }

  await writeToSheet(
    tokenRow.email,
    workspace.sheet_id,
    workspace.sheet_name,
    exec.row_number,
    exec.proposed_updates,
    exec.workspace_id,
  );

  await execute(
    "UPDATE sheet_rule_executions SET status = 'applied', applied_at = now() WHERE id = $1",
    [executionId],
  );
}

/**
 * Reject a pending execution without writing anything to the sheet.
 */
export async function rejectExecution(executionId: number): Promise<void> {
  const exec = await queryOne<SheetRuleExecution>(
    "SELECT * FROM sheet_rule_executions WHERE id = $1",
    [executionId],
  );
  if (!exec) throw new AppError(404, "Execution not found");
  if (exec.status !== "pending") {
    throw new AppError(422, `Execution is in status "${exec.status}", not pending`);
  }

  await execute(
    "UPDATE sheet_rule_executions SET status = 'rejected' WHERE id = $1",
    [executionId],
  );
}

/**
 * Retry a failed execution.
 * - If the execution has a row_number and proposed_updates already stored,
 *   re-apply them to the sheet directly (fast path — skips AI).
 * - Otherwise re-runs the full rule evaluation pipeline from scratch
 *   (AI extraction → row lookup → resolve updates → write/queue).
 */
export async function retryExecution(executionId: number): Promise<void> {
  const exec = await queryOne<SheetRuleExecution>(
    "SELECT * FROM sheet_rule_executions WHERE id = $1",
    [executionId],
  );
  if (!exec) throw new AppError(404, "Execution not found");
  if (exec.status !== "failed") {
    throw new AppError(422, `Execution is in status "${exec.status}", expected "failed"`);
  }

  const workspace = await queryOne<Workspace>(
    "SELECT * FROM workspaces WHERE id = $1",
    [exec.workspace_id],
  );
  if (!workspace?.sheet_id) throw new AppError(422, "No sheet configured");
  if (!workspace.gmail_address) throw new AppError(422, "No Gmail address configured for workspace");

  const tokenRow = await queryOne<OAuthToken>(
    "SELECT * FROM oauth_tokens WHERE email = $1",
    [workspace.gmail_address],
  );
  if (!tokenRow) throw new AppError(500, "No OAuth token for workspace");

  // Fast path: we already have a row number and proposed updates — just re-write.
  if (exec.row_number !== null && Object.keys(exec.proposed_updates).length > 0) {
    await writeToSheet(
      tokenRow.email,
      workspace.sheet_id,
      workspace.sheet_name,
      exec.row_number,
      exec.proposed_updates,
      exec.workspace_id,
    );

    await execute(
      "UPDATE sheet_rule_executions SET status = 'applied', applied_at = now(), error = null WHERE id = $1",
      [executionId],
    );
    return;
  }

  // Full re-run: failed before finding a row (e.g. AI extraction or row lookup failed).
  // Delete the old failed record first, then re-run the pipeline — the evaluation
  // will create a fresh record with the new outcome.
  const rule = await queryOne<SheetRule>(
    "SELECT * FROM sheet_rules WHERE id = $1",
    [exec.rule_id],
  );
  if (!rule) throw new AppError(404, "Associated rule not found");

  if (exec.thread_id === null) {
    throw new AppError(422, "Execution has no thread — cannot re-run evaluation");
  }

  const thread = await queryOne<Thread>(
    "SELECT * FROM threads WHERE id = $1",
    [exec.thread_id],
  );
  if (!thread) throw new AppError(404, "Thread not found");

  const model = await getModel(exec.workspace_id);
  const threadContent = thread.thread_summary ?? "";
  if (!threadContent.trim()) {
    throw new AppError(422, "Thread has no summary — cannot re-run evaluation");
  }

  // Remove the old failed record before creating a new one.
  await execute("DELETE FROM sheet_rule_executions WHERE id = $1", [executionId]);

  await evaluateSingleRule(rule, thread, threadContent, workspace, tokenRow, model, exec.workspace_id);
}
