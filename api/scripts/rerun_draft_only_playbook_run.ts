/**
 * Safely rerun a waiting_for_human draft-only playbook run.
 *
 * This is intended for repairing bad pending drafts after a prompt/context fix.
 * It refuses to run unless the playbook is draft_only, so it cannot accidentally
 * send a customer email while regenerating.
 *
 * Usage:
 *   deno run --allow-net --allow-env --allow-read scripts/rerun_draft_only_playbook_run.ts --run-id=302
 *   deno run --allow-net --allow-env --allow-read scripts/rerun_draft_only_playbook_run.ts --run-id=302 --apply
 */
import { execute, queryOne } from "../db/client.ts";
import { advanceRun } from "../services/playbook/executor.ts";
import type { Playbook, PlaybookRun, PlaybookStep } from "../services/playbook/types.ts";

function requiredArg(name: string): string {
  const prefix = `--${name}=`;
  const arg = Deno.args.find((item) => item.startsWith(prefix));
  if (!arg) {
    throw new Error(`Missing required argument --${name}=...`);
  }
  return arg.slice(prefix.length);
}

function optionalArg(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = Deno.args.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

const runId = parseInt(requiredArg("run-id"));
if (isNaN(runId)) throw new Error("--run-id must be a number");

const apply = Deno.args.includes("--apply");

const run = await queryOne<PlaybookRun>(
  "SELECT * FROM playbook_runs WHERE id = $1",
  [runId],
);
if (!run) throw new Error(`Run ${runId} not found`);
if (run.status !== "waiting_for_human") {
  throw new Error(`Run ${runId} is ${run.status}, not waiting_for_human`);
}

const playbook = await queryOne<Playbook>(
  "SELECT * FROM playbooks WHERE id = $1",
  [run.playbook_id],
);
if (!playbook) throw new Error(`Playbook ${run.playbook_id} not found`);
if (playbook.reply_mode !== "draft_only") {
  throw new Error(
    `Refusing to rerun playbook ${playbook.id}: reply_mode is ${playbook.reply_mode}, not draft_only`,
  );
}

const steps: PlaybookStep[] = typeof playbook.steps === "string"
  ? JSON.parse(playbook.steps)
  : playbook.steps;
const resetTo = optionalArg("reset-to") ?? steps[0]?.id ?? null;
if (!resetTo) throw new Error(`Playbook ${playbook.id} has no steps`);
if (!steps.some((step) => step.id === resetTo)) {
  throw new Error(`Step ${resetTo} does not exist in playbook ${playbook.id}`);
}

console.log(
  `Run ${runId} will be reset to ${resetTo} and advanced under draft_only playbook "${playbook.name}".`,
);

if (!apply) {
  console.log("Dry run only. Re-run with --apply to regenerate the pending draft.");
  Deno.exit(0);
}

await execute(
  "UPDATE playbook_runs SET status = 'running', current_step_id = $1 WHERE id = $2",
  [resetTo, runId],
);

const result = await advanceRun(runId);
console.log(JSON.stringify(result, null, 2));
