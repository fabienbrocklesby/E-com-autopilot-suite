/**
 * Sheet rules → playbook migration script.
 *
 * For each active sheet_rules row, generates a playbook with:
 *   1. extract - pull the match value from the email
 *   2. find_sheet_row - locate the row in the sheet
 *   3. branch - if row found → update_sheet, else → ask_customer or escalate
 *   4. update_sheet - write the configured columns
 *   5. complete
 *
 * After creating the playbook:
 *   - Links it to the same category_ids the rule applied to (first category only for v1).
 *   - Marks the original sheet rule as is_active = false.
 *
 * Run with:
 *   deno run --allow-env --allow-net api/scripts/migrate_sheet_rules_to_playbooks.ts
 *
 * This is idempotent: rules that already have is_active = false are skipped,
 * and the script checks for an existing playbook with the same name before creating.
 */
import { query, queryOne, execute } from "../db/client.ts";
import type { SheetRule } from "../types/index.ts";

const WORKSPACE_ID = 1;
const DRY_RUN = Deno.args.includes("--dry-run");

if (DRY_RUN) {
  console.log("[migrate] DRY RUN - no writes will be made\n");
}

async function migrate() {
  const rules = await query<SheetRule>(
    `SELECT * FROM sheet_rules WHERE is_active = true AND workspace_id = $1 ORDER BY id ASC`,
    [WORKSPACE_ID],
  );

  if (rules.length === 0) {
    console.log("[migrate] No active sheet rules to migrate.");
    Deno.exit(0);
  }

  console.log(`[migrate] Found ${rules.length} active sheet rule(s) to migrate.\n`);

  for (const rule of rules) {
    console.log(`[migrate] Processing rule #${rule.id}: "${rule.name}"`);

    const playbookName = `[migrated] ${rule.name}`;

    // Check if already migrated
    const existing = await queryOne<{ id: number }>(
      "SELECT id FROM playbooks WHERE workspace_id = $1 AND name = $2",
      [WORKSPACE_ID, playbookName],
    );
    if (existing) {
      console.log(`  → Already migrated (playbook #${existing.id}), skipping.\n`);
      continue;
    }

    // Determine the category to attach (first one if multiple)
    const categoryIds: number[] = Array.isArray(rule.category_ids)
      ? rule.category_ids
      : rule.category_ids
      ? [rule.category_ids as unknown as number]
      : [];
    const primaryCategoryId = categoryIds[0] ?? null;

    // Build the variable name from the match instruction (slugified)
    const matchVar = rule.match_instruction
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || "match_value";

    // Build update steps
    const updates = (rule.updates as Array<{ column: string; mode: string; value?: string; instruction?: string }>).map(
      (upd) => ({
        column: upd.column,
        // For "fixed" mode use the literal value; for "ai" mode, use a placeholder the client can tune.
        value_or_var: upd.mode === "fixed" ? (upd.value ?? "") : `{ai_value_for_${upd.column.toLowerCase().replace(/[^a-z0-9]/g, "_")}}`,
      }),
    );

    const steps = [
      {
        id: "extract_1",
        type: "extract",
        variables: [matchVar],
      },
      {
        id: "branch_1",
        type: "branch",
        condition: `context.${matchVar} != null`,
        if_true: "find_1",
        if_false: "escalate_no_value",
      },
      {
        id: "escalate_no_value",
        type: "escalate",
        reason: `Could not extract match value ("${rule.match_instruction}") from email`,
      },
      {
        id: "find_1",
        type: "find_sheet_row",
        match_attempts: [{ column: rule.match_column, context_var: matchVar }],
      },
      {
        id: "branch_2",
        type: "branch",
        condition: "context.row_number != null",
        if_true: "update_1",
        if_false: "escalate_no_row",
      },
      {
        id: "escalate_no_row",
        type: "escalate",
        reason: `Could not find matching row in sheet for column "${rule.match_column}"`,
      },
      {
        id: "update_1",
        type: "update_sheet",
        row_var: "row_number",
        updates,
      },
      {
        id: "complete_1",
        type: "complete",
      },
    ];

    const description = `Migrated from sheet rule "${rule.name}". `
      + `Finds a row by matching "${rule.match_instruction}" against column "${rule.match_column}", `
      + `then updates: ${updates.map((u) => u.column).join(", ")}.`;

    if (DRY_RUN) {
      console.log(`  → Would create playbook "${playbookName}" for category_id=${primaryCategoryId}`);
      console.log(`  → Steps: ${steps.map((s) => s.id).join(" → ")}`);
      console.log(`  → Would deactivate rule #${rule.id}\n`);
      continue;
    }

    const playbook = await queryOne<{ id: number }>(
      `INSERT INTO playbooks (workspace_id, category_id, name, plain_language_description, steps, version, is_active)
       VALUES ($1, $2, $3, $4, $5::jsonb, 1, false)
       RETURNING id`,
      [WORKSPACE_ID, primaryCategoryId, playbookName, description, JSON.stringify(steps)],
    );

    console.log(`  → Created playbook #${playbook!.id} "${playbookName}" (inactive - review and activate manually)`);

    await execute(
      "UPDATE sheet_rules SET is_active = false WHERE id = $1",
      [rule.id],
    );

    console.log(`  → Deactivated sheet rule #${rule.id}\n`);
  }

  console.log("[migrate] Done.");
  Deno.exit(0);
}

migrate().catch((err) => {
  console.error("[migrate] Fatal error:", err);
  Deno.exit(1);
});
