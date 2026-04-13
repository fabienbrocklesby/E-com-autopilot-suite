---
name: playbook-step
description: How to add a new playbook step type to the engine. Use when extending the playbook system with new step capabilities like extract, branch, send_reply, update_sheet, etc.
---

# Playbook Step Skill

This skill teaches Copilot how to add a new step type to the playbook engine cleanly.

## What a step is

A step is a unit of work the playbook engine executes against a thread. Each step:
- Has a unique ID within its playbook
- Has a type (e.g. `extract`, `branch`, `send_reply`)
- Has type-specific config
- Reads from and writes to the run's context bag
- Returns a decision: advance to next step, pause, complete, fail

## Step interface

```ts
// api/services/playbook/types.ts

export type StepDecision =
  | { kind: 'advance'; nextStepId: string }
  | { kind: 'pause'; reason: 'waiting_for_customer' | 'waiting_for_human'; resumeStepId?: string }
  | { kind: 'complete' }
  | { kind: 'fail'; error: string };

export interface StepContext {
  workspaceId: number;
  threadId: number;
  runId: number;
  thread: Thread;
  messages: Message[];
  context: Record<string, unknown>; // mutable bag
  playbook: Playbook;
}

export interface StepHandler<TConfig = unknown, TOutput = unknown> {
  type: string;
  validate(config: unknown): TConfig;
  execute(step: PlaybookStep & { config: TConfig }, ctx: StepContext): Promise<{
    decision: StepDecision;
    contextUpdates?: Record<string, unknown>;
    output?: TOutput;
    aiCalls?: AiCallRecord[];
  }>;
}
```

## Adding a new step type

### 1. Define the config schema in `types.ts`

Add a discriminated union variant:

```ts
export type PlaybookStep =
  | ExtractStep
  | BranchStep
  | SendReplyStep
  // ... add yours here
  | YourNewStep;

export interface YourNewStep {
  id: string;
  type: 'your_new_step';
  config: {
    // type-specific fields
  };
  // optional: explicit nextStepId, otherwise the engine uses the next step in the array
  nextStepId?: string;
}
```

### 2. Create the handler in `handlers/your_new_step.ts`

```ts
import { StepHandler, YourNewStep } from '../types.ts';

export const yourNewStepHandler: StepHandler<YourNewStep['config']> = {
  type: 'your_new_step',

  validate(config) {
    // throw if invalid
    if (!config || typeof config !== 'object') {
      throw new Error('your_new_step config must be an object');
    }
    // ... field-by-field validation
    return config as YourNewStep['config'];
  },

  async execute(step, ctx) {
    // Do the work
    // - Read from ctx.context
    // - Make AI calls via chatCompletion if needed
    // - Make external API calls if needed
    // - Determine the decision

    return {
      decision: { kind: 'advance', nextStepId: step.nextStepId ?? defaultNext(ctx, step) },
      contextUpdates: { /* keys to merge into context */ },
      output: { /* arbitrary, stored in execution log */ },
      aiCalls: [/* records of AI calls made, for observability */],
    };
  },
};
```

### 3. Register in `registry.ts`

```ts
import { yourNewStepHandler } from './handlers/your_new_step.ts';

export const handlers: Record<string, StepHandler> = {
  extract: extractHandler,
  branch: branchHandler,
  // ...
  your_new_step: yourNewStepHandler, // add this
};
```

### 4. Update the parser prompt

In `api/services/playbook/parser.ts`, the system prompt lists available step types. Add your new type with:
- A one-line description of when to use it
- Example config
- Example plain-language phrase that should map to it

### 5. Add the step editor component

In `frontend/src/lib/components/playbook-steps/your_new_step.svelte`:

```svelte
<script lang="ts">
  let { config = $bindable() }: { config: YourNewStepConfig } = $props();
</script>

<div class="step-editor">
  <label>
    Field 1
    <input bind:value={config.field1} />
  </label>
  <!-- ... -->
</div>
```

Register it in `frontend/src/lib/components/playbook-steps/index.ts`:

```ts
export const stepEditors = {
  extract: ExtractEditor,
  branch: BranchEditor,
  // ...
  your_new_step: YourNewStepEditor,
};
```

### 6. Document in PLAYBOOK_ENGINE.md

Add a row to the step type table with name, purpose, config schema, decision behaviour.

### 7. Test

- Insert a test playbook using the new step via SQL
- Run a thread through it
- Use Postgres MCP to verify `playbook_step_executions` has the right records
- Open the playbook editor in the UI, verify the step renders and edits correctly

## Decision patterns

### Advance to specific next step
```ts
{ kind: 'advance', nextStepId: 'send_1' }
```

### Advance to whatever comes next in the playbook array
```ts
{ kind: 'advance', nextStepId: nextSequentialStepId(playbook, step.id) }
```
(Helper exists in `executor.ts`.)

### Pause for customer reply
```ts
{ kind: 'pause', reason: 'waiting_for_customer', resumeStepId: 'extract_1' }
```
When the next inbound email arrives, the engine resumes from `resumeStepId`.

### Pause for human approval
```ts
{ kind: 'pause', reason: 'waiting_for_human', resumeStepId: 'send_1' }
```
The thread shows up in the review queue. When approved, engine resumes.

### Complete the run
```ts
{ kind: 'complete' }
```

### Fail (unrecoverable)
```ts
{ kind: 'fail', error: 'Could not find sheet column X' }
```
Thread is escalated to manual review.

## Common pitfalls

- **Don't make AI calls inside `validate()`** — validation must be sync and pure
- **Don't write to the database directly from a handler** unless it's the actual side effect of the step (e.g. `update_sheet` writes to Sheets, but execution-log writes are handled by the executor)
- **Always return `aiCalls`** when you call the AI, for observability
- **Variable names in `contextUpdates`** should match what other steps will reference. Keep a consistent vocabulary per workspace (the parser prompt should enforce this)
- **Don't catch errors silently** — throw or return `fail`, let the executor handle persistence
