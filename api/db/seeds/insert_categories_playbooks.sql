-- Insert categories and playbooks for Exclusive Motors workspace
-- Covers: Wrong item, General inquiry, Escalated complaint, Unrelated (catch-all)
-- Date: 2026-04-19

BEGIN;

-- ─── Categories ──────────────────────────────────────────────────────────────

INSERT INTO categories (workspace_id, name, description, instructions)
VALUES
  (1,
   'Wrong item / Incompatible product',
   'Customer received the wrong item, wrong size, or a part that does not fit their vehicle as advertised',
   'Acknowledge the mistake, gather order details, and route for human approval on refund or replacement.'),
  (1,
   'General inquiry',
   'Simple questions about the store, shipping origins, whether products are available, or general vehicle/part questions',
   'Answer clearly and helpfully from store knowledge. Keep it concise.'),
  (1,
   'Escalated complaint',
   'Customer who has emailed multiple times without response, is clearly frustrated, or is threatening further action',
   'Treat as urgent. Immediately flag for human review. Do not auto-reply.'),
  (1,
   'Unrelated',
   'Emails that do not clearly fit any other category. May or may not be related to our store.',
   'Attempt a helpful reply if possible. If unsure, defer to human review.');

-- ─── Playbooks ───────────────────────────────────────────────────────────────

-- 1. Wrong item / Incompatible product
INSERT INTO playbooks (
  workspace_id, category_id, name, plain_language_description,
  steps, version, is_active, reply_mode, confidence_threshold
)
SELECT
  1,
  c.id,
  'Wrong item',
  'Extract the customer name, what item they received, and what the issue is. Look up their row in the sheet by name. If we cannot find them or don''t know the issue, ask. Update their sheet status to "Wrong Item / Return". Send to me for manual approval — I need to decide whether to refund or send a replacement. Once approved, send the resolution to the customer and update the sheet.',
  '[
    {"id":"extract_1","type":"extract","variables":["customer_name","product_description","issue_description"]},
    {"id":"find_1","type":"find_sheet_row","match_attempts":[{"column":"Name","context_var":"customer_name"}]},
    {"id":"evaluate_1","type":"evaluate","goal":"Do we have the customer sheet row and a clear description of the wrong item issue?","required_context":["row_number","issue_description"],"if_satisfied_goto":"update_1","if_missing_goto":"ask_1","if_escalate_goto":"escalate_no_match"},
    {"id":"update_1","type":"update_sheet","row_var":"row_number","updates":[{"column":"Status","value_or_var":"Wrong Item / Return"}]},
    {"id":"approval_1","type":"manual_approval","reason":"Customer received wrong or incompatible item. Decide: full refund or replacement?","on_approve":"send_1","on_reject":"escalate_rejected","input_prompt":"Enter your resolution (e.g. full refund approved, replacement being sent 30/04)","capture_input":true,"input_context_key":"resolution_decision","reference_context":["customer_name","product_description","issue_description"]},
    {"id":"send_1","type":"send_reply","goal":"Apologise sincerely for the wrong or incompatible item and inform the customer of the resolution you have approved. Keep the tone professional and warm.","reference_context":["customer_name","product_description","resolution_decision"]},
    {"id":"complete_1","type":"complete"},
    {"id":"ask_1","type":"ask_customer","goal":"Ask for their name and the product they purchased so we can locate their order and resolve the issue","required_context":["customer_name","product_description"],"on_reply_goto":"extract_1"},
    {"id":"escalate_no_match","type":"escalate","reason":"Could not locate customer in the sheet to process wrong item return"},
    {"id":"escalate_rejected","type":"escalate","reason":"Human reviewer did not approve a resolution for the wrong item complaint"}
  ]'::jsonb,
  1, true, 'auto_reply', 0.75
FROM categories c
WHERE c.workspace_id = 1 AND c.name = 'Wrong item / Incompatible product';

-- 2. General inquiry
INSERT INTO playbooks (
  workspace_id, category_id, name, plain_language_description,
  steps, version, is_active, reply_mode, confidence_threshold
)
SELECT
  1,
  c.id,
  'General inquiry',
  'Extract the customer name and their question. Evaluate if we can answer it using our store and product knowledge. If yes, send a clear and helpful reply. If we cannot confidently answer, escalate to me for a manual response.',
  '[
    {"id":"extract_1","type":"extract","variables":["customer_name","issue_description"]},
    {"id":"evaluate_1","type":"evaluate","goal":"Can we confidently answer this customer''s question using our store knowledge, product catalogue, or general automotive knowledge?","required_context":["issue_description"],"if_satisfied_goto":"send_1","if_missing_goto":"escalate_1","if_escalate_goto":"escalate_1"},
    {"id":"send_1","type":"send_reply","goal":"Answer the customer''s question clearly and helpfully. If it is about shipping origin, confirm we are a NZ-based business. If about a specific part, give what relevant info we can.","reference_context":["customer_name","issue_description"]},
    {"id":"complete_1","type":"complete"},
    {"id":"escalate_1","type":"escalate","reason":"Could not confidently answer the customer''s general inquiry from available store information"}
  ]'::jsonb,
  1, true, 'auto_reply', 0.75
FROM categories c
WHERE c.workspace_id = 1 AND c.name = 'General inquiry';

-- 3. Escalated complaint
INSERT INTO playbooks (
  workspace_id, category_id, name, plain_language_description,
  steps, version, is_active, reply_mode, confidence_threshold
)
SELECT
  1,
  c.id,
  'Escalated complaint',
  'Extract the customer name and what they have been waiting for or complaining about. Immediately send to me for manual review — do not auto-reply. I will write a personal response. Once I provide my response, send it to the customer.',
  '[
    {"id":"extract_1","type":"extract","variables":["customer_name","issue_description"]},
    {"id":"approval_1","type":"manual_approval","reason":"URGENT: Customer has been ignored or is very frustrated. Write a personalised response to send them directly.","on_approve":"send_1","on_reject":"escalate_1","input_prompt":"Write your personal response to this customer (will be sent as-is with light formatting)","capture_input":true,"input_context_key":"human_response","reference_context":["customer_name","issue_description"]},
    {"id":"send_1","type":"send_reply","goal":"Send the response written by the team member. Use their provided text as the core of the reply. Keep it personal and do not add unnecessary fluff.","reference_context":["customer_name","issue_description","human_response"]},
    {"id":"complete_1","type":"complete"},
    {"id":"escalate_1","type":"escalate","reason":"Escalated complaint could not be resolved via manual approval — needs further attention"}
  ]'::jsonb,
  1, true, 'draft_only', 0.70
FROM categories c
WHERE c.workspace_id = 1 AND c.name = 'Escalated complaint';

-- 4. Unrelated (catch-all)
INSERT INTO playbooks (
  workspace_id, category_id, name, plain_language_description,
  steps, version, is_active, reply_mode, confidence_threshold
)
SELECT
  1,
  c.id,
  'Unrelated catch-all',
  'Extract the customer name and what they are asking about. Evaluate whether we can give a genuinely helpful response. If yes, draft a reply but require my approval before sending. If we cannot figure out how to respond at all, escalate to me for manual handling.',
  '[
    {"id":"extract_1","type":"extract","variables":["customer_name","issue_description"]},
    {"id":"evaluate_1","type":"evaluate","goal":"Can we provide a meaningful and helpful response to this email, even if it is not directly about our products or services?","required_context":["issue_description"],"if_satisfied_goto":"send_1","if_missing_goto":"escalate_1","if_escalate_goto":"escalate_1"},
    {"id":"send_1","type":"send_reply","goal":"Respond helpfully and professionally. If the email is entirely unrelated to our business, acknowledge it politely and let them know how to best reach us.","require_approval":true,"reference_context":["customer_name","issue_description"]},
    {"id":"complete_1","type":"complete"},
    {"id":"escalate_1","type":"escalate","reason":"Could not determine a helpful response to this unrelated or unclear email — needs human review"}
  ]'::jsonb,
  1, true, 'draft_only', 0.60
FROM categories c
WHERE c.workspace_id = 1 AND c.name = 'Unrelated';

COMMIT;
