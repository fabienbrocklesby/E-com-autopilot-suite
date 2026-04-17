/**
 * Seed script - inserts the tracking-request playbook for testing.
 * Run with: deno run --allow-env --allow-net api/scripts/seed_playbook.ts
 *
 * Prerequisites:
 *   - A "Tracking Request" (or similar) category must exist in workspace 1.
 *   - If it doesn't exist, the script creates one.
 */
import { query, queryOne, execute } from "../db/client.ts";

const WORKSPACE_ID = 1;
const CATEGORY_NAME = "Tracking Request";

async function seed() {
  // Ensure a tracking category exists
  let category = await queryOne<{ id: number }>(
    "SELECT id FROM categories WHERE workspace_id = $1 AND name = $2",
    [WORKSPACE_ID, CATEGORY_NAME],
  );

  if (!category) {
    category = await queryOne<{ id: number }>(
      `INSERT INTO categories (workspace_id, name, description, instructions, allow_auto_reply, confidence_threshold, writing_style)
       VALUES ($1, $2, $3, $4, true, 0.7, 'friendly and helpful')
       RETURNING id`,
      [
        WORKSPACE_ID,
        CATEGORY_NAME,
        "Customer asking about order tracking or delivery status",
        "Handle tracking requests by extracting the order number and providing a status update.",
      ],
    );
    console.log(`Created category "${CATEGORY_NAME}" with id ${category!.id}`);
  } else {
    console.log(`Category "${CATEGORY_NAME}" already exists with id ${category.id}`);
  }

  const categoryId = category!.id;

  // Check if a playbook already exists for this category
  const existing = await queryOne<{ id: number }>(
    "SELECT id FROM playbooks WHERE category_id = $1 AND is_active = true",
    [categoryId],
  );

  if (existing) {
    console.log(`Playbook already exists for category ${categoryId} (id ${existing.id}) - skipping`);
    Deno.exit(0);
  }

  const steps = [
    {
      id: "extract_1",
      type: "extract",
      variables: ["order_number"],
    },
    {
      id: "branch_1",
      type: "branch",
      condition: "context.order_number != null",
      if_true: "send_1",
      if_false: "ask_1",
    },
    {
      id: "ask_1",
      type: "ask_customer",
      message: "No worries, just need your order number to check that for you. What is it?",
      on_reply_goto: "extract_1",
    },
    {
      id: "send_1",
      type: "send_reply",
      message: "Sweet, your order has shipped and should be with you in the next few days. Let us know if it doesn't show up by then.",
    },
    {
      id: "complete_1",
      type: "complete",
    },
  ];

  const row = await queryOne<{ id: number }>(
    `INSERT INTO playbooks (workspace_id, category_id, name, plain_language_description, steps, version)
     VALUES ($1, $2, $3, $4, $5::jsonb, 1)
     RETURNING id`,
    [
      WORKSPACE_ID,
      categoryId,
      "Tracking Request",
      "When someone asks where their order is, extract the order number. If they didn't provide one, ask for it. Once we have it, send a tracking update.",
      JSON.stringify(steps),
    ],
  );

  console.log(`Created playbook "Tracking Request" with id ${row!.id} for category ${categoryId}`);
  console.log("Steps:", JSON.stringify(steps, null, 2));
  Deno.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  Deno.exit(1);
});
