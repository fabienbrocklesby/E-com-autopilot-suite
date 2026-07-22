/**
 * Plain-language → structured steps parser.
 * Loads the design guide from docs/PLAYBOOK_DESIGN_GUIDE.md at runtime,
 * injects workspace-specific sheet columns, and calls the AI.
 *
 * Why load from disk: the design guide is editable without code changes.
 * In production, a deploy restarts the process which re-reads the file.
 * In development, the cache is bypassed so edits take effect immediately.
 */
import { query } from "../../db/client.ts";
import { chatCompletion, getModel } from "../ai.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import type { PlaybookStep } from "./types.ts";

const VALID_STEP_TYPES = [
  "extract",
  "find_sheet_row",
  "update_sheet",
  "ask_customer",
  "branch",
  "evaluate",
  "triage",
  "manual_approval",
  "send_reply",
  "complete",
  "escalate",
] as const;

// ─── Design guide loader ──────────────────────────────────────────────────────

// In dev, docs/ is mounted at /docs. Production images include docs under /app.
const DESIGN_GUIDE_PATH = (() => {
  try {
    Deno.statSync("/docs");
    return "/docs/PLAYBOOK_DESIGN_GUIDE.md";
  } catch {
    return join(Deno.cwd(), "docs", "PLAYBOOK_DESIGN_GUIDE.md");
  }
})();

let cachedGuide: string | null = null;
let lastLoadedAt = 0;
const CACHE_MS = Deno.env.get("DENO_ENV") === "development" ? 0 : 60_000;

async function loadDesignGuide(): Promise<string> {
  const now = Date.now();
  if (cachedGuide && now - lastLoadedAt < CACHE_MS) {
    return cachedGuide;
  }
  const content = await Deno.readTextFile(DESIGN_GUIDE_PATH);
  cachedGuide = content;
  lastLoadedAt = now;
  return content;
}

// ─── Workspace context builder ────────────────────────────────────────────────

interface SheetColumn {
  column_letter: string;
  header_name: string;
}

async function buildWorkspaceContext(workspaceId: number): Promise<string> {
  const columns = await query<SheetColumn>(
    `SELECT column_letter, header_name FROM sheet_columns
     WHERE workspace_id = $1 ORDER BY column_letter`,
    [workspaceId],
  );

  if (columns.length === 0) {
    return `No sheet columns configured for this workspace yet. Use realistic column names based on typical e-commerce sheets.`;
  }

  const columnList = columns
    .map((c) => `- "${c.header_name}" (column ${c.column_letter})`)
    .join("\n");

  return `This workspace's Google Sheet has these columns:\n\n${columnList}\n\nThe playbook you generate MUST only reference columns that exist in this list.\nMatch logic should only use context variables that can be extracted from typical customer emails AND have a corresponding column in this sheet.`;
}

export interface ParseResult {
  steps: PlaybookStep[];
  warnings: string[];
}

export async function parsePlaybook(
  description: string,
  workspaceId: number,
): Promise<ParseResult> {
  // Load the design guide from disk and inject workspace-specific context
  const guide = await loadDesignGuide();
  const workspaceContext = await buildWorkspaceContext(workspaceId);

  const categories = await query<{ id: number; name: string }>(
    "SELECT id, name FROM categories WHERE workspace_id = $1 ORDER BY name",
    [workspaceId],
  );

  const categoryContext = categories.length > 0
    ? `\nKnown categories in this workspace: ${categories.map((c) => c.name).join(", ")}.`
    : "";

  // Replace the placeholder section with actual workspace data
  const systemPrompt = guide.replace(
    "## Workspace context (injected at runtime)\n\nThis section is replaced at runtime with the actual workspace sheet columns and configuration. The parser injects this before sending to the AI. You will see the specific columns available for this workspace here when the prompt is assembled.",
    `## Workspace context\n\n${workspaceContext}${categoryContext}`,
  );

  const model = await getModel(workspaceId);
  const content = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Convert this to steps:\n\n${description}` },
    ],
    model,
    { type: "json_object" },
  );

  let parsed: { steps?: unknown[] };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("AI returned invalid JSON");
  }

  if (!Array.isArray(parsed.steps)) {
    throw new Error("AI response missing 'steps' array");
  }

  const warnings: string[] = [];
  const validatedSteps: PlaybookStep[] = [];

  for (const step of parsed.steps) {
    if (typeof step !== "object" || step === null) {
      warnings.push(`Skipped non-object step`);
      continue;
    }
    const s = step as Record<string, unknown>;
    if (!s.id || typeof s.id !== "string") {
      warnings.push(`Step missing 'id' field: ${JSON.stringify(s).slice(0, 80)}`);
      continue;
    }
    if (!s.type || !VALID_STEP_TYPES.includes(s.type as typeof VALID_STEP_TYPES[number])) {
      warnings.push(`Step "${s.id}" has unknown type: "${s.type}"`);
      continue;
    }
    validatedSteps.push(s as unknown as PlaybookStep);
  }

  // Reference validation
  const stepIds = new Set(validatedSteps.map((s) => s.id));
  for (const step of validatedSteps) {
    if (step.type === "ask_customer") {
      const s = step as { on_reply_goto?: string };
      if (s.on_reply_goto && !stepIds.has(s.on_reply_goto)) {
        warnings.push(`Step "${step.id}": on_reply_goto "${s.on_reply_goto}" not found`);
      }
    }
    if (step.type === "branch") {
      const s = step as { if_true?: string; if_false?: string };
      if (s.if_true && !stepIds.has(s.if_true)) {
        warnings.push(`Step "${step.id}": if_true "${s.if_true}" not found`);
      }
      if (s.if_false && !stepIds.has(s.if_false)) {
        warnings.push(`Step "${step.id}": if_false "${s.if_false}" not found`);
      }
    }
    if (step.type === "evaluate") {
      const s = step as {
        if_satisfied_goto?: string;
        if_missing_goto?: string;
        if_escalate_goto?: string;
      };
      if (s.if_satisfied_goto && !stepIds.has(s.if_satisfied_goto)) {
        warnings.push(`Step "${step.id}": if_satisfied_goto "${s.if_satisfied_goto}" not found`);
      }
      if (s.if_missing_goto && !stepIds.has(s.if_missing_goto)) {
        warnings.push(`Step "${step.id}": if_missing_goto "${s.if_missing_goto}" not found`);
      }
      if (s.if_escalate_goto && !stepIds.has(s.if_escalate_goto)) {
        warnings.push(`Step "${step.id}": if_escalate_goto "${s.if_escalate_goto}" not found`);
      }
    }
    if (step.type === "triage") {
      const s = step as {
        routes?: Array<{ label?: string; goto?: string }>;
        fallback_goto?: string;
      };
      if (!Array.isArray(s.routes) || s.routes.length === 0) {
        warnings.push(`Step "${step.id}": triage routes missing`);
      } else {
        for (const route of s.routes) {
          if (!route.goto || !stepIds.has(route.goto)) {
            warnings.push(
              `Step "${step.id}": triage route "${
                route.label ?? "?"
              }" goto "${route.goto}" not found`,
            );
          }
        }
      }
      if (!s.fallback_goto) {
        warnings.push(`Step "${step.id}": fallback_goto missing`);
      } else if (!stepIds.has(s.fallback_goto)) {
        warnings.push(`Step "${step.id}": fallback_goto "${s.fallback_goto}" not found`);
      }
    }
    if (step.type === "manual_approval") {
      const s = step as { on_approve?: string; on_reject?: string };
      if (s.on_approve && !stepIds.has(s.on_approve)) {
        warnings.push(`Step "${step.id}": on_approve "${s.on_approve}" not found`);
      }
      if (s.on_reject && !stepIds.has(s.on_reject)) {
        warnings.push(`Step "${step.id}": on_reject "${s.on_reject}" not found`);
      }
    }
  }

  return { steps: validatedSteps, warnings };
}

/**
 * Generate a single playbook step from a plain-language description.
 * Useful for inserting a new step into an existing playbook without regenerating everything.
 */
export async function parsePlaybookStep(
  description: string,
  previousSteps: PlaybookStep[],
  nextSteps: PlaybookStep[],
  playbookContext: string,
  workspaceId: number,
): Promise<PlaybookStep> {
  const guide = await loadDesignGuide();
  const workspaceContext = await buildWorkspaceContext(workspaceId);

  const contextLines: string[] = [];
  if (playbookContext) contextLines.push(`Playbook purpose: ${playbookContext}`);
  if (previousSteps.length > 0) {
    contextLines.push(
      `Previous steps: ${previousSteps.map((s) => `${s.id} (${s.type})`).join(", ")}`,
    );
  }
  if (nextSteps.length > 0) {
    contextLines.push(`Next steps: ${nextSteps.map((s) => `${s.id} (${s.type})`).join(", ")}`);
  }

  const systemPrompt = `${
    guide.replace(
      "## Workspace context (injected at runtime)\n\nThis section is replaced at runtime with the actual workspace sheet columns and configuration. The parser injects this before sending to the AI. You will see the specific columns available for this workspace here when the prompt is assembled.",
      `## Workspace context\n\n${workspaceContext}`,
    )
  }

## Task
Generate a SINGLE step object as JSON (not an array). The step must fit the existing playbook context.
${contextLines.join("\n")}

Respond with a single JSON object (no array wrapper) representing one playbook step.`;

  const model = await getModel(workspaceId);
  const content = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Generate a single step for: ${description}` },
    ],
    model,
    { type: "json_object" },
  );

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("AI returned invalid JSON for step");
  }

  if (!parsed.id || typeof parsed.id !== "string") {
    // Auto-generate an id from the description
    parsed.id = description.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30) + "_" +
      Date.now();
  }

  if (!parsed.type || !VALID_STEP_TYPES.includes(parsed.type as typeof VALID_STEP_TYPES[number])) {
    throw new Error(`AI returned unknown step type: "${parsed.type}"`);
  }

  return parsed as unknown as PlaybookStep;
}
