---
name: ai-driven-step
description: How to build AI-driven playbook steps where the AI decides contextually instead of following a template. Use for any step that involves conversation, judgment, or contextual decision-making.
---

# AI-Driven Step Skill

This is the pattern for making playbook steps smart instead of rigid. Use it when a step needs to read context, adapt to the customer, and decide dynamically.

## When to use this pattern

**Use AI-driven** for:
- Writing messages to customers (`ask_customer`, `send_reply`)
- Deciding whether we have enough info (`evaluate`)
- Classifying open-ended content (`ai_classify`)
- Any step where "it depends on what the customer said"

**Use deterministic** for:
- Reading or writing sheet cells
- Checking literal null/not-null conditions (`branch`)
- Setting timers
- Calling structured APIs with known inputs

The split is simple: if a reasonable answer requires reading context and making a judgment, it's AI-driven. If the input fully determines the output, it's deterministic.

## The anatomy of an AI-driven step

Every AI-driven step handler follows the same 5 phases:

```ts
async execute(step, ctx) {
  // 1. LOAD CONTEXT
  //    - ctx.context (the variable bag)
  //    - ctx.messages (thread history, usually last 5)
  //    - ctx.playbook (for workspace voice, style)
  //    - relevant execution history (did we already ask this?)

  // 2. DETERMINISTIC PRE-CHECK
  //    Before burning an AI call, check if you can decide without one.
  //    E.g. "do we already have all required_context variables?"
  //    If yes, short-circuit with the happy-path decision.

  // 3. BUILD THE PROMPT
  //    Include: goal, current state, recent messages, voice,
  //    explicit list of actions the AI can return, output schema.

  // 4. CALL AI
  //    Use chatCompletion with response_format: json_object.
  //    Validate the response structure before using it.

  // 5. APPLY THE DECISION
  //    Map AI response to StepDecision. Handle all possible actions.
  //    Record the ai_calls in the return value for observability.
}
```

## The prompt template

Every AI-driven step's prompt should have these sections, in this order:

```
SYSTEM:
You are [role]. You are helping [who] accomplish [what].

TASK:
[one sentence: what this specific step is doing]

VOICE:
[writing_style from category, or voice_hint from step]

WHAT WE KNOW (context bag):
{JSON of relevant context variables with values}

WHAT WE DON'T KNOW YET:
{list of required_context variables still null}

RECENT CONVERSATION (last 5 messages):
[formatted as "CUSTOMER: ..." / "US: ..."]

PREVIOUS ACTIONS ON THIS STEP:
[if this step has fired before on this run, list the messages we already sent]

YOUR DECISION:
Return JSON with one of these shapes:
- {"action": "X", ...} when [condition]
- {"action": "Y", ...} when [condition]
- {"action": "Z", ...} when [condition]

RULES:
- [specific rules for this step type]
- [do-nots]
- [voice considerations]

Return JSON only. No preamble, no explanation outside the JSON.
```

## Action patterns

Every AI-driven step has a small set of actions. Common ones:

### `ask` — send a message to the customer
```json
{"action": "ask", "message": "..."}
```
Handler: send the message via Gmail, return `pause('waiting_for_customer', resumeStepId)`.

### `skip` — we already have what we need
```json
{"action": "skip", "extracted": {"var1": "value"}, "reasoning": "..."}
```
Handler: merge `extracted` into context, advance to next step. Don't send anything.

### `escalate` — this needs a human
```json
{"action": "escalate", "reason": "..."}
```
Handler: return `fail` with reason; executor handles escalation.

### `draft` — produce a message for later use
```json
{"action": "draft", "message": "..."}
```
Handler: store in context or execution output; don't send yet. Used by `send_reply` with optional human review.

### `classify` — pick from a set
```json
{"action": "classify", "class": "refund_request", "confidence": 0.85, "reasoning": "..."}
```
Handler: store result in context, advance based on class.

### `route` — pick one of N paths (for evaluate)
```json
{"action": "route", "path": "satisfied" | "missing" | "escalate", "extracted": {...}, "reasoning": "..."}
```
Handler: advance to the step_id mapped to that path.

## Validation of AI responses

Never trust the AI response blindly. Every handler must validate:

```ts
const parsed = JSON.parse(aiResponse);

if (!parsed.action || typeof parsed.action !== 'string') {
  // Fallback to safe default — escalate
  return { decision: { kind: 'fail', error: 'AI response missing action' } };
}

if (!ALLOWED_ACTIONS.includes(parsed.action)) {
  return { decision: { kind: 'fail', error: `Unknown action: ${parsed.action}` } };
}

// Validate per-action shape
if (parsed.action === 'ask' && (!parsed.message || typeof parsed.message !== 'string')) {
  return { decision: { kind: 'fail', error: 'ask action missing message' } };
}
// ... etc
```

If validation fails, escalate rather than retrying — something's wrong with the prompt or the model is having a bad day.

## Observability

Every AI call must be recorded. The handler returns:

```ts
return {
  decision: ...,
  contextUpdates: {...},
  output: { action: parsed.action, reasoning: parsed.reasoning, ... },
  aiCalls: [{
    model: 'claude-sonnet-4-6',
    prompt_tokens: response.usage.input_tokens,
    response_tokens: response.usage.output_tokens,
    prompt: fullPromptText,  // for debugging
    response: aiResponse,     // raw string
    duration_ms: Date.now() - startTime,
  }],
};
```

The executor persists this into `playbook_step_executions.ai_calls`. The thread detail UI surfaces it for debugging.

## Anti-patterns

### Hardcoding messages

Bad:
```ts
const message = "Could you please provide your order number?";
```

Good: let the AI write the message, providing the goal and constraints.

### Asking the AI to "just do the right thing"

Bad:
```
Write a helpful reply to the customer.
```

Good: explicit goal, voice, context, what to reference, what to avoid.

### Not checking for repeat behaviour

Bad: AI-driven step with no awareness of what already happened. Fires the same question three times.

Good: include previous actions/messages in the prompt. Tell the AI to not repeat itself.

### No deterministic short-circuit

Bad: call the AI even when the answer is obvious from context.

Good: check for the happy path first. Only call AI when there's a real decision to make.

### Unbounded variability

Bad: every call produces a completely different message, breaking voice consistency.

Good: include previous messages in the prompt as voice examples. Use temperature 0.3-0.5 for step handlers, not 0.7+.

### No fallback for AI failure

Bad: AI call fails → step fails → run fails forever.

Good: on AI unavailable, return a retriable fail. The retry worker picks it up when the AI is back.

## Example: minimal ask_customer handler

```ts
import { StepHandler } from '../types.ts';
import { chatCompletion } from '../../ai.ts';
import { sendReply } from '../../gmail.ts';

export const askCustomerHandler: StepHandler = {
  type: 'ask_customer',

  validate(config) {
    if (!config.goal || typeof config.goal !== 'string') {
      throw new Error('ask_customer requires goal');
    }
    if (!Array.isArray(config.required_context)) {
      throw new Error('ask_customer requires required_context array');
    }
    if (!config.on_reply_goto) {
      throw new Error('ask_customer requires on_reply_goto');
    }
    return config;
  },

  async execute(step, ctx) {
    const { goal, required_context, on_reply_goto } = step.config;

    // PHASE 2: deterministic pre-check
    const missing = required_context.filter(v => ctx.context[v] == null);
    if (missing.length === 0) {
      return {
        decision: { kind: 'advance', nextStepId: on_reply_goto },
        contextUpdates: {},
        output: { action: 'skipped', reason: 'all required context present' },
      };
    }

    // PHASE 1 continues: load more context
    const previousMessages = await getPreviousOutboundOnRun(ctx.runId);
    const recentThread = ctx.messages.slice(-5);
    const voice = ctx.playbook.voice_hint ?? ctx.category.writing_style;

    // PHASE 3: build prompt
    const system = `You write the next message to a customer in an email thread.

TASK: ${goal}

VOICE: ${voice}

WHAT WE KNOW:
${JSON.stringify(ctx.context, null, 2)}

WHAT WE DON'T KNOW:
${missing.join(', ')}

RECENT CONVERSATION:
${recentThread.map(m => `${m.direction === 'inbound' ? 'CUSTOMER' : 'US'}: ${m.body_plain}`).join('\n\n')}

PREVIOUS MESSAGES WE ALREADY SENT (do not repeat):
${previousMessages.map(m => `- ${m}`).join('\n') || 'none'}

YOUR DECISION:
- {"action": "skip", "extracted": {...}} if the customer already told us what we need
- {"action": "escalate", "reason": "..."} if stuck, frustrated, or circular
- {"action": "ask", "message": "..."} otherwise

RULES:
- Don't repeat questions
- Reference what the customer just said
- Brief, one short paragraph
- Match the voice

Return JSON only.`;

    // PHASE 4: call AI
    const startTime = Date.now();
    const response = await chatCompletion({
      workspaceId: ctx.workspaceId,
      system,
      user: 'Decide and respond.',
      responseFormat: 'json_object',
      temperature: 0.4,
    });

    // Validate
    let parsed;
    try {
      parsed = JSON.parse(response.content);
    } catch {
      return {
        decision: { kind: 'fail', error: 'AI response not valid JSON' },
        aiCalls: [recordCall(system, response, startTime)],
      };
    }

    // PHASE 5: apply decision
    if (parsed.action === 'skip') {
      return {
        decision: { kind: 'advance', nextStepId: on_reply_goto },
        contextUpdates: parsed.extracted ?? {},
        output: { action: 'skipped', reasoning: parsed.reasoning },
        aiCalls: [recordCall(system, response, startTime)],
      };
    }

    if (parsed.action === 'escalate') {
      return {
        decision: { kind: 'fail', error: `AI escalated: ${parsed.reason}` },
        output: { action: 'escalated', reason: parsed.reason },
        aiCalls: [recordCall(system, response, startTime)],
      };
    }

    if (parsed.action === 'ask' && parsed.message) {
      await sendReply(ctx.workspaceId, ctx.thread, parsed.message);
      return {
        decision: { kind: 'pause', reason: 'waiting_for_customer', resumeStepId: step.id },
        output: { action: 'asked', message: parsed.message },
        aiCalls: [recordCall(system, response, startTime)],
      };
    }

    return {
      decision: { kind: 'fail', error: `Invalid action: ${parsed.action}` },
      aiCalls: [recordCall(system, response, startTime)],
    };
  },
};

function recordCall(prompt: string, response: any, startTime: number) {
  return {
    model: response.model,
    prompt_tokens: response.usage?.input_tokens,
    response_tokens: response.usage?.output_tokens,
    duration_ms: Date.now() - startTime,
    prompt,
    response: response.content,
  };
}
```

## Testing AI-driven steps

AI-driven = non-deterministic. Can't unit test with fixed assertions.

Approach:
1. **Unit test the deterministic parts** (validation, pre-checks, decision mapping)
2. **Integration test with recorded AI responses** — mock `chatCompletion` to return fixed JSON, verify the handler maps it correctly
3. **End-to-end test with real AI** — send real test emails, assert on behaviour at the run level (did the run complete? did it escalate? did it ask the right number of times?)

The Phase 7 testing harness is the proper tool for end-to-end. Use it.
