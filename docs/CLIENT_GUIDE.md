# Client Guide

How to use the Email Automation Dashboard.

---

## How to write a playbook

A playbook is a sequence of instructions that tells the system how to handle a specific type of email - step by step - before it needs your attention.

### Starting point

1. Go to **Playbooks** in the sidebar.
2. Click **New Playbook**.
3. Give it a name and link it to a category (e.g. "Refund Requests").

### Writing the description

In the **Description** box, write what you want the system to do in plain English. Think of this as instructions to a new staff member:

> When someone asks for a refund, look up their order in the spreadsheet using their order number, name, or email. If you can't find their order, ask them for their order number. Once you've got it, mark the status column as "Refund Requested" and send it to me for approval. Once I approve, reply to the customer to confirm.

Then click **Generate Steps**. The AI turns your description into structured steps you can review and tune.

### Understanding the generated steps

Each step card shows the step type and its key config:

| Step type | What it does |
|---|---|
| `extract` | Reads the email and pulls out named values (order number, customer name, etc.) |
| `find_sheet_row` | Searches your spreadsheet for the row that matches the customer |
| `update_sheet` | Writes values to columns on the found row |
| `ask_customer` | Sends a question to the customer and waits for their reply |
| `branch` | Routes the flow based on whether a value was found |
| `manual_approval` | Pauses and sends the thread to your review queue |
| `send_reply` | Sends a reply to the customer and continues |
| `complete` | Marks the run as finished |
| `escalate` | Flags the thread for your attention and stops |

### Editing individual steps

Click the pencil icon on any step card to edit it. You don't need to re-write the whole description - edits to specific steps survive a re-parse (matched by step ID).

### Using variables in messages

You can insert extracted values into reply messages and sheet updates using `{{variable_name}}`:

```
Hi {{customer_name}}, your order {{order_number}} has been received.
```

Variables available after an `extract` step, such as `order_number`, `customer_name`, `refund_reason`.

### Testing before going live (dry-run)

Before activating a playbook, test it with an example email:

1. Click **Dry Run** (bottom of the editor).
2. Paste an example email into the text area.
3. Click **Simulate**.
4. The trace shows every step: what it did, what was extracted, what message it would have sent.

Sheet writes and email sends are **not** executed in dry-run mode - it's purely a simulation.

### Activating

Once you're happy with the steps:
1. Click **Save & Activate**, or
2. Click **Save**, then toggle **Active** on the playbook list.

New threads in that category will now run the playbook instead of going to manual review.

---

## How to interpret the thread timeline

Open any thread to see its full history.

The **Playbook Runs** panel shows:
- Which playbook ran (name + version)
- Current status (running, waiting for customer, waiting for you, complete, failed)
- The current step the run is positioned at
- The context bag - all variables collected so far (e.g. `order_number: "12345"`)
- The full step execution log - each step with its status, timing, output, and any AI calls

**Status colours:**
- Blue dot = running
- Amber dot = waiting for customer reply
- Purple dot = waiting for your approval
- Green dot = complete
- Red dot = failed / escalated

---

## How to handle stuck threads

A thread is "stuck" when its playbook run has a status of `failed` or `escalated` and no further action will happen automatically.

**To unstick:**
1. Open the thread.
2. Check the step execution log for the error message.
3. Common causes:
   - `find_sheet_row: No match found` → the customer's order number isn't in the sheet, or they gave the wrong one. Reply manually, update the sheet if needed, then re-categorise the thread to start a new playbook run.
   - `update_sheet: No sheet configured` → the workspace sheet ID hasn't been set. Go to **Settings** and configure the spreadsheet.
   - `extract: Failed to parse AI response` → temporary AI error. The thread is still in review - you can manually categorise or reply.

For `waiting_for_human` runs (manual approval queue), see the **Review Queue**.

---

## How to add a new category and playbook

1. Go to **Categories** → **Add Category**.
2. Fill in: name, description (what kinds of emails fit this category), instructions (optional - used by the AI when drafting legacy replies).
3. Save the category.
4. Go to **Playbooks** → **New Playbook**.
5. Select the new category.
6. Write the description, generate steps, dry-run, then activate.

---

## How to test before going live (rollout)

For a new playbook on a live category, use this process:

1. Create the playbook and test with dry-run.
2. Activate the playbook - it will now handle new threads in that category.
3. Monitor the **Review Queue** and thread list for 24 hours.
4. Check for failed runs in the thread detail playbook panel.
5. If something's wrong, deactivate the playbook (the category falls back to the manual draft flow).
6. Fix the steps and re-activate.

---

## Review queue

Go to **Review Queue** to see two sections:

**Threads needing draft review:** Threads where the AI created a draft but didn't auto-send (confidence below threshold, or auto-reply disabled). Review the draft, edit if needed, then Approve (sends) or Reject (discards).

**Playbook approvals:** Threads where a playbook hit a `manual_approval` step and is waiting for you. The reason will explain what's being asked. Click **Approve** to continue the playbook, **Reject** to route it to the reject path (usually escalate).
