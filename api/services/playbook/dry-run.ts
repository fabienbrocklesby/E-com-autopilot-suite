/**
 * Dry-run executor — sandbox that simulates a playbook without side effects.
 * Calls AI for extract steps, but does NOT send emails or write to sheets.
 */
import { queryOne } from "../../db/client.ts";
import { chatCompletion } from "../ai.ts";
import type {
  Playbook,
  PlaybookStep,
  AskCustomerStep,
  BranchStep,
  EvaluateStep,
  SendReplyStep,
  EscalateStep,
  ManualApprovalStep,
  ExtractStep,
} from "./types.ts";

export interface DryRunTraceEntry {
  stepId: string;
  stepType: string;
  status: "success" | "skipped" | "paused" | "failed";
  summary: string;
  extractedVars?: Record<string, unknown>;
  messageSent?: string;
  condition?: { expression: string; result: boolean };
  aiCall?: { prompt: string; response: string };
}

export interface DryRunResult {
  playbookId: number;
  playbookName: string;
  finalStatus: "complete" | "waiting_for_customer" | "waiting_for_human" | "failed" | "escalated";
  context: Record<string, unknown>;
  trace: DryRunTraceEntry[];
}

function interpolate(template: string, context: Record<string, unknown>): string {
  let result = template;
  for (const [key, val] of Object.entries(context)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(val ?? ""));
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), String(val ?? ""));
  }
  return result;
}

function nextStep(steps: PlaybookStep[], currentId: string): string | null {
  const idx = steps.findIndex((s) => s.id === currentId);
  return idx >= 0 && idx < steps.length - 1 ? steps[idx + 1].id : null;
}

export async function dryRunPlaybook(
  playbookId: number,
  emailContent: string,
  workspaceId: number,
): Promise<DryRunResult> {
  const playbook = await queryOne<Playbook>(
    "SELECT * FROM playbooks WHERE id = $1 AND workspace_id = $2",
    [playbookId, workspaceId],
  );
  if (!playbook) throw new Error(`Playbook ${playbookId} not found`);

  const steps: PlaybookStep[] =
    typeof playbook.steps === "string" ? JSON.parse(playbook.steps) : playbook.steps;

  const context: Record<string, unknown> = {};
  const trace: DryRunTraceEntry[] = [];
  const MAX_ITERATIONS = 50;
  let iterations = 0;
  let currentStepId: string | null = steps.length > 0 ? steps[0].id : null;
  let finalStatus: DryRunResult["finalStatus"] = "complete";

  while (currentStepId && iterations < MAX_ITERATIONS) {
    iterations++;
    const step = steps.find((s) => s.id === currentStepId);

    if (!step) {
      trace.push({
        stepId: currentStepId,
        stepType: "unknown",
        status: "failed",
        summary: `Step "${currentStepId}" not found in playbook`,
      });
      finalStatus = "failed";
      break;
    }

    switch (step.type) {
      case "extract": {
        const extractStep = step as ExtractStep;
        const prompt = `Extract the following variables from this email. Return JSON with the variable names as keys and null for missing values.\nVariables: ${extractStep.variables.join(", ")}\n\nEmail:\n${emailContent}`;
        let extracted: Record<string, unknown> = {};
        let aiResponse = "";
        try {
          aiResponse = await chatCompletion(
            [{ role: "user", content: prompt }],
            "gpt-4o",
            { type: "json_object" },
          );
          extracted = JSON.parse(aiResponse);
          Object.assign(context, extracted);
        } catch {
          extracted = {};
        }
        trace.push({
          stepId: step.id,
          stepType: step.type,
          status: "success",
          summary: `Extracted: ${extractStep.variables.join(", ")}`,
          extractedVars: extracted,
          aiCall: aiResponse ? { prompt, response: aiResponse } : undefined,
        });
        currentStepId = nextStep(steps, step.id);
        break;
      }

      case "branch": {
        const branchStep = step as BranchStep;
        const condition = branchStep.condition;
        let result = false;
        const nullCheck = condition.match(/^context\.(\w+)\s*(!=|==)\s*null$/);
        if (nullCheck) {
          const [, varName, op] = nullCheck;
          const val = context[varName];
          result = op === "!=" ? val != null : val == null;
        } else {
          const truthyCheck = condition.match(/^context\.(\w+)$/);
          if (truthyCheck) result = Boolean(context[truthyCheck[1]]);
        }
        trace.push({
          stepId: step.id,
          stepType: step.type,
          status: "success",
          summary: `Branch: "${condition}" → ${result ? branchStep.if_true : branchStep.if_false}`,
          condition: { expression: condition, result },
        });
        currentStepId = result ? branchStep.if_true : branchStep.if_false;
        break;
      }

      case "ask_customer": {
        const askStep = step as AskCustomerStep;
        const message = askStep.message
          ? interpolate(typeof askStep.message === "string" ? askStep.message : "", context)
          : `[AI would ask for: ${(askStep.required_context ?? []).join(", ")} — goal: ${askStep.goal ?? "gather info"}]`;
        trace.push({
          stepId: step.id,
          stepType: step.type,
          status: "paused",
          summary: askStep.goal
            ? `Would AI-write question to gather: ${(askStep.required_context ?? []).join(", ")}`
            : "Would send question and wait for customer reply",
          messageSent: message,
        });
        finalStatus = "waiting_for_customer";
        currentStepId = null;
        break;
      }

      case "evaluate": {
        const evalStep = step as EvaluateStep;
        const missing = (evalStep.required_context ?? []).filter((v) => context[v] == null);
        const routeTo = missing.length === 0 ? evalStep.if_satisfied_goto : evalStep.if_missing_goto;
        trace.push({
          stepId: step.id,
          stepType: step.type,
          status: "success",
          summary: missing.length === 0
            ? `evaluate: satisfied → ${evalStep.if_satisfied_goto}`
            : `evaluate: missing [${missing.join(", ")}] → ${evalStep.if_missing_goto}`,
        });
        currentStepId = routeTo;
        break;
      }

      case "send_reply": {
        const sendStep = step as SendReplyStep;
        let message: string;
        if (sendStep.goal) {
          const refs = (sendStep.reference_context ?? []).map((k) => `${k}=${context[k] ?? "?"}`);
          message = `[AI would draft reply — goal: "${sendStep.goal}"${refs.length > 0 ? `, referencing: ${refs.join(", ")}` : ""}]`;
        } else if (typeof sendStep.message === "string") {
          message = interpolate(sendStep.message, context);
        } else if (sendStep.message && "ai_generate_using_category_voice" in (sendStep.message as object)) {
          message = "[AI would generate reply using category voice and tone]";
        } else if (sendStep.message) {
          message = interpolate((sendStep.message as { from_template: string }).from_template, context);
        } else {
          message = "[No message or goal configured]";
        }
        trace.push({
          stepId: step.id,
          stepType: step.type,
          status: "success",
          summary: "Would send reply to customer",
          messageSent: message,
        });
        currentStepId = nextStep(steps, step.id);
        break;
      }

      case "manual_approval": {
        const approvalStep = step as ManualApprovalStep;
        const captureNote = approvalStep.capture_input
          ? ` (captures input: "${approvalStep.input_prompt ?? "notes"}" → ${approvalStep.input_context_key ?? "human_notes"})`
          : "";
        trace.push({
          stepId: step.id,
          stepType: step.type,
          status: "paused",
          summary: `Would pause for human approval: "${approvalStep.reason}"${captureNote}`,
        });
        finalStatus = "waiting_for_human";
        currentStepId = null;
        break;
      }

      case "find_sheet_row": {
        trace.push({
          stepId: step.id,
          stepType: step.type,
          status: "skipped",
          summary: "Would search sheet for matching row (not executed in dry-run; row_number set to 1 for simulation)",
        });
        context["row_number"] = 1;
        currentStepId = nextStep(steps, step.id);
        break;
      }

      case "update_sheet": {
        trace.push({
          stepId: step.id,
          stepType: step.type,
          status: "skipped",
          summary: "Would write column updates to sheet row (not executed in dry-run)",
        });
        currentStepId = nextStep(steps, step.id);
        break;
      }

      case "complete": {
        trace.push({ stepId: step.id, stepType: step.type, status: "success", summary: "Run complete" });
        finalStatus = "complete";
        currentStepId = null;
        break;
      }

      case "escalate": {
        const escalateStep = step as EscalateStep;
        trace.push({
          stepId: step.id,
          stepType: step.type,
          status: "failed",
          summary: `Escalated: ${escalateStep.reason}`,
        });
        finalStatus = "escalated";
        currentStepId = null;
        break;
      }

      default: {
        const unknownStep = step as { id?: string; type?: string };
        trace.push({ stepId: unknownStep.id ?? "?", stepType: unknownStep.type ?? "unknown", status: "skipped", summary: `Unknown step type` });
        currentStepId = nextStep(steps, unknownStep.id ?? "");
      }
    }
  }

  if (iterations >= MAX_ITERATIONS) {
    finalStatus = "failed";
    trace.push({ stepId: "safety", stepType: "safety", status: "failed", summary: "Hit max iterations safety limit" });
  }

  return {
    playbookId: playbook.id,
    playbookName: playbook.name,
    finalStatus,
    context,
    trace,
  };
}
