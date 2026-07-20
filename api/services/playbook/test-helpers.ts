/**
 * Shared fixture builders for playbook reliability-layer integration tests.
 * These run against a real Postgres database - there is no mocking layer in
 * this codebase, and every test using these fixtures needs DATABASE_URL set.
 * workspace_id cascade-deletes everything else via existing FK ON DELETE CASCADE,
 * so cleanupFixture only has to delete the workspace row.
 */
import { execute, queryOne } from "../../db/client.ts";
import type { PlaybookStep, RunStatus } from "./types.ts";

let counter = 0;
function uniqueSuffix(): string {
  counter++;
  return `${Date.now()}_${counter}`;
}

export interface TestFixture {
  workspaceId: number;
  categoryId: number;
  threadId: number;
  playbookId: number;
}

export interface TestFixtureOptions {
  /** Set false to simulate a workspace with no connected Gmail account. */
  withOAuthToken?: boolean;
}

export async function createTestFixture(
  steps: PlaybookStep[],
  options: TestFixtureOptions = {},
): Promise<TestFixture> {
  const withOAuthToken = options.withOAuthToken ?? true;
  const suffix = uniqueSuffix();

  const workspace = await queryOne<{ id: number }>(
    "INSERT INTO workspaces (name) VALUES ($1) RETURNING id",
    [`test-workspace-${suffix}`],
  );
  const workspaceId = workspace!.id;

  const category = await queryOne<{ id: number }>(
    `INSERT INTO categories (workspace_id, name, description, instructions)
     VALUES ($1, $2, '', '') RETURNING id`,
    [workspaceId, `test-category-${suffix}`],
  );
  const categoryId = category!.id;

  const playbook = await queryOne<{ id: number }>(
    `INSERT INTO playbooks (workspace_id, category_id, name, steps, version, is_active, reply_mode)
     VALUES ($1, $2, $3, $4::jsonb, 1, true, 'draft_only') RETURNING id`,
    [workspaceId, categoryId, `test-playbook-${suffix}`, JSON.stringify(steps)],
  );
  const playbookId = playbook!.id;

  const thread = await queryOne<{ id: number }>(
    `INSERT INTO threads (workspace_id, gmail_thread_id, subject, category_id)
     VALUES ($1, $2, 'Test thread', $3) RETURNING id`,
    [workspaceId, `test-thread-${suffix}`, categoryId],
  );
  const threadId = thread!.id;

  if (withOAuthToken) {
    // access_token/refresh_token plaintext columns were dropped in migration 007
    // (encrypted-only now, see google-auth.ts). advanceRun's setup only reads
    // `email` off this row before dispatching to a handler - it never decrypts
    // the token unless a handler actually calls the Gmail/Sheets API - so
    // leaving the encrypted columns NULL is fine for tests that don't send mail.
    await execute(
      `INSERT INTO oauth_tokens (workspace_id, email, expiry)
       VALUES ($1, $2, NOW() + interval '1 hour')`,
      [workspaceId, `store-${suffix}@example.com`],
    );
  }

  return { workspaceId, categoryId, threadId, playbookId };
}

export async function createTestRun(
  fixture: TestFixture,
  steps: PlaybookStep[],
  currentStepId: string | null,
  status: RunStatus,
  context: Record<string, unknown> = {},
): Promise<number> {
  const run = await queryOne<{ id: number }>(
    `INSERT INTO playbook_runs
       (workspace_id, thread_id, playbook_id, playbook_version, steps_snapshot, current_step_id, status, context)
     VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6, $7::jsonb)
     RETURNING id`,
    [
      fixture.workspaceId,
      fixture.threadId,
      fixture.playbookId,
      JSON.stringify(steps),
      currentStepId,
      status,
      JSON.stringify(context),
    ],
  );
  return run!.id;
}

export async function cleanupFixture(workspaceId: number): Promise<void> {
  await execute("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
}
