/**
 * Extract handler - uses AI to pull named variables from the thread messages.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep, ExtractStep } from "../types.ts";
import { chatCompletion, getModel } from "../../ai.ts";

export const extractHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const extractStep = step as ExtractStep;
    const variables = extractStep.variables;

    // Build the thread transcript from messages
    const transcript = ctx.messages
      .map((m) => `[${m.direction}] ${m.from_address}: ${m.body_plain}`)
      .join("\n---\n");

    const model = await getModel(ctx.workspaceId);

    const prompt = `You are extracting specific pieces of information from an email thread.

Extract the following variables from the thread: ${variables.join(", ")}

Thread transcript:
${transcript}

Respond with a JSON object where keys are the variable names and values are the extracted values.
If a variable cannot be found in the thread, set its value to null.

Example response for variables ["order_number", "customer_name"]:
{"order_number": "12345", "customer_name": "John Smith"}`;

    const response = await chatCompletion(
      [{ role: "user", content: prompt }],
      model,
      { type: "json_object" },
    );

    const aiCalls = [{ model, prompt, response, tokens: undefined }];

    let extracted: Record<string, unknown>;
    try {
      extracted = JSON.parse(response);
    } catch {
      return {
        decision: { action: "fail", error: "Failed to parse AI extraction response" },
        aiCalls,
      };
    }

    // Only keep the variables we asked for
    const contextUpdates: Record<string, unknown> = {};
    for (const v of variables) {
      if (v in extracted) {
        contextUpdates[v] = extracted[v];
      }
    }

    return {
      decision: { action: "advance" },
      output: extracted,
      contextUpdates,
      aiCalls,
    };
  },
};
