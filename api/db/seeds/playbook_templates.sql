-- Seed: playbook templates for quick onboarding
-- Run after 017_playbook_templates.sql migration

INSERT INTO playbook_templates (slug, name, category, industry, description, plain_language, steps, voice_examples, required_sheet_columns) VALUES

-- ─── E-commerce ──────────────────────────────────────────────────────────────

('ecom-refund', 'Refund Request', 'refund', 'ecommerce',
 'Handles refund requests by extracting order details, looking up the order in the sheet, and routing based on order value.',
 'When a customer asks for a refund, extract their order number and reason. Look up the order in our sheet. If the order total is under $50, auto-approve and update the sheet. If over $50, send to manual approval. Then confirm the outcome to the customer.',
 '[
   {"id":"extract_1","type":"extract","variables":["order_number","refund_reason"]},
   {"id":"branch_has_order","type":"branch","condition":"context.order_number != null","if_true":"find_order","if_false":"ask_order"},
   {"id":"ask_order","type":"ask_customer","goal":"Ask the customer for their order number so we can process the refund.","on_reply_goto":"extract_1"},
   {"id":"find_order","type":"find_sheet_row","match_attempts":[{"column":"Order Number","value_var":"order_number"}],"store_to":"order_row"},
   {"id":"branch_found","type":"branch","condition":"context.order_row != null","if_true":"branch_value","if_false":"escalate_not_found"},
   {"id":"branch_value","type":"branch","condition":"parseFloat(context.order_row?.Total || ''0'') < 50","if_true":"auto_refund","if_false":"manual_refund"},
   {"id":"auto_refund","type":"update_sheet","row_var":"order_row","updates":[{"column":"Refund Status","value":"Approved"},{"column":"Refund Reason","value_var":"refund_reason"}]},
   {"id":"reply_approved","type":"send_reply","goal":"Let the customer know their refund has been approved and they''ll see it back on their card shortly."},
   {"id":"complete_1","type":"complete"},
   {"id":"manual_refund","type":"manual_approval","reason":"Refund over $50 needs manual review","draft_template":"refund_approval","on_approve":"update_approved","on_reject":"reply_denied"},
   {"id":"update_approved","type":"update_sheet","row_var":"order_row","updates":[{"column":"Refund Status","value":"Approved"},{"column":"Refund Reason","value_var":"refund_reason"}]},
   {"id":"reply_denied","type":"send_reply","goal":"Politely let the customer know their refund request was reviewed but unfortunately cannot be approved at this time. Suggest they contact us to discuss alternatives."},
   {"id":"complete_denied","type":"complete"},
   {"id":"escalate_not_found","type":"escalate","reason":"Order not found in sheet"}
 ]'::jsonb,
 'Hey! Your refund is sorted - you''ll see it back on your card in 3-5 business days.',
 ARRAY['Order Number', 'Total', 'Refund Status', 'Refund Reason']),

('ecom-tracking', 'Where Is My Order', 'tracking', 'ecommerce',
 'Handles order tracking enquiries by extracting the order number and sending a status update.',
 'When someone asks where their order is, extract the order number. If they didn''t provide one, ask for it. Look up the order and send a tracking update.',
 '[
   {"id":"extract_1","type":"extract","variables":["order_number"]},
   {"id":"branch_1","type":"branch","condition":"context.order_number != null","if_true":"find_order","if_false":"ask_1"},
   {"id":"ask_1","type":"ask_customer","goal":"Ask the customer for their order number so we can look up their tracking info.","on_reply_goto":"extract_1"},
   {"id":"find_order","type":"find_sheet_row","match_attempts":[{"column":"Order Number","value_var":"order_number"}],"store_to":"order_row"},
   {"id":"branch_found","type":"branch","condition":"context.order_row != null","if_true":"send_tracking","if_false":"escalate_1"},
   {"id":"send_tracking","type":"send_reply","goal":"Give the customer a tracking update based on their order details. Include any shipping status or tracking number we have."},
   {"id":"complete_1","type":"complete"},
   {"id":"escalate_1","type":"escalate","reason":"Order not found in sheet"}
 ]'::jsonb,
 'Hey! Your order has shipped and should be with you in the next few days. Let us know if it doesn''t show up by then.',
 ARRAY['Order Number', 'Tracking Number', 'Shipping Status']),

('ecom-order-change', 'Order Change Request', 'order_change', 'ecommerce',
 'Handles requests to modify an existing order (size, colour, quantity) before shipping.',
 'When a customer wants to change their order, extract the order number and what they want changed. Look up the order. If it hasn''t shipped yet, flag it for manual action. If already shipped, let the customer know it''s too late and suggest a return instead.',
 '[
   {"id":"extract_1","type":"extract","variables":["order_number","change_requested"]},
   {"id":"branch_has_order","type":"branch","condition":"context.order_number != null","if_true":"find_order","if_false":"ask_order"},
   {"id":"ask_order","type":"ask_customer","goal":"Ask the customer for their order number and what they''d like to change.","on_reply_goto":"extract_1"},
   {"id":"find_order","type":"find_sheet_row","match_attempts":[{"column":"Order Number","value_var":"order_number"}],"store_to":"order_row"},
   {"id":"branch_found","type":"branch","condition":"context.order_row != null","if_true":"branch_shipped","if_false":"escalate_not_found"},
   {"id":"branch_shipped","type":"branch","condition":"context.order_row?.Status !== ''Shipped'' && context.order_row?.Status !== ''Delivered''","if_true":"manual_change","if_false":"reply_too_late"},
   {"id":"manual_change","type":"manual_approval","reason":"Customer wants to change their order","draft_template":"order_change","on_approve":"reply_changed","on_reject":"reply_cant_change"},
   {"id":"reply_changed","type":"send_reply","goal":"Confirm to the customer that their order change has been made."},
   {"id":"complete_changed","type":"complete"},
   {"id":"reply_cant_change","type":"send_reply","goal":"Let the customer know we unfortunately couldn''t make the change to their order and explain why."},
   {"id":"complete_cant","type":"complete"},
   {"id":"reply_too_late","type":"send_reply","goal":"Let the customer know their order has already shipped so we can''t change it. Suggest they can return it once received and place a new order."},
   {"id":"complete_late","type":"complete"},
   {"id":"escalate_not_found","type":"escalate","reason":"Order not found in sheet"}
 ]'::jsonb,
 NULL,
 ARRAY['Order Number', 'Status']),

('ecom-damaged-item', 'Damaged Item Report', 'damaged_item', 'ecommerce',
 'Handles reports of damaged or defective items with photo collection and refund/replacement routing.',
 'When a customer reports a damaged item, extract the order number and damage description. Ask for a photo if they didn''t include one. Look up the order and send to manual review with all the info so the team can decide on a refund or replacement.',
 '[
   {"id":"extract_1","type":"extract","variables":["order_number","damage_description"]},
   {"id":"branch_has_order","type":"branch","condition":"context.order_number != null","if_true":"find_order","if_false":"ask_details"},
   {"id":"ask_details","type":"ask_customer","goal":"Ask the customer for their order number and a description (or photo) of the damage.","on_reply_goto":"extract_1"},
   {"id":"find_order","type":"find_sheet_row","match_attempts":[{"column":"Order Number","value_var":"order_number"}],"store_to":"order_row"},
   {"id":"branch_found","type":"branch","condition":"context.order_row != null","if_true":"manual_review","if_false":"escalate_not_found"},
   {"id":"manual_review","type":"manual_approval","reason":"Damaged item reported - review needed for refund or replacement","draft_template":"damaged_item","on_approve":"reply_resolved","on_reject":"reply_denied"},
   {"id":"reply_resolved","type":"send_reply","goal":"Let the customer know we''re sorting out a replacement or refund for their damaged item."},
   {"id":"complete_1","type":"complete"},
   {"id":"reply_denied","type":"send_reply","goal":"Apologise but explain the damage claim couldn''t be verified. Suggest they reach out again with more details."},
   {"id":"complete_denied","type":"complete"},
   {"id":"escalate_not_found","type":"escalate","reason":"Order not found in sheet"}
 ]'::jsonb,
 NULL,
 ARRAY['Order Number']),

('ecom-cancellation', 'Order Cancellation', 'cancellation', 'ecommerce',
 'Handles cancellation requests, checking if the order can still be cancelled before shipping.',
 'When a customer wants to cancel their order, extract the order number. Look it up. If it hasn''t shipped, cancel and confirm. If it has shipped, let them know it''s too late and offer return instructions.',
 '[
   {"id":"extract_1","type":"extract","variables":["order_number","cancellation_reason"]},
   {"id":"branch_has_order","type":"branch","condition":"context.order_number != null","if_true":"find_order","if_false":"ask_order"},
   {"id":"ask_order","type":"ask_customer","goal":"Ask the customer for their order number.","on_reply_goto":"extract_1"},
   {"id":"find_order","type":"find_sheet_row","match_attempts":[{"column":"Order Number","value_var":"order_number"}],"store_to":"order_row"},
   {"id":"branch_found","type":"branch","condition":"context.order_row != null","if_true":"branch_shipped","if_false":"escalate_not_found"},
   {"id":"branch_shipped","type":"branch","condition":"context.order_row?.Status !== ''Shipped'' && context.order_row?.Status !== ''Delivered''","if_true":"cancel_order","if_false":"reply_too_late"},
   {"id":"cancel_order","type":"update_sheet","row_var":"order_row","updates":[{"column":"Status","value":"Cancelled"},{"column":"Cancel Reason","value_var":"cancellation_reason"}]},
   {"id":"reply_cancelled","type":"send_reply","goal":"Confirm the order has been cancelled and let the customer know about refund timing."},
   {"id":"complete_1","type":"complete"},
   {"id":"reply_too_late","type":"send_reply","goal":"Let the customer know their order has already shipped so it can''t be cancelled. Provide return instructions instead."},
   {"id":"complete_late","type":"complete"},
   {"id":"escalate_not_found","type":"escalate","reason":"Order not found in sheet"}
 ]'::jsonb,
 NULL,
 ARRAY['Order Number', 'Status', 'Cancel Reason']),

('ecom-address-change', 'Address Change', 'address_change', 'ecommerce',
 'Handles address change requests for unshipped orders.',
 'When a customer wants to update their shipping address, extract the order number and new address. Look up the order. If it hasn''t shipped, update the address. If it has, let them know.',
 '[
   {"id":"extract_1","type":"extract","variables":["order_number","new_address"]},
   {"id":"branch_has_info","type":"branch","condition":"context.order_number != null && context.new_address != null","if_true":"find_order","if_false":"ask_info"},
   {"id":"ask_info","type":"ask_customer","goal":"Ask the customer for their order number and the new shipping address.","on_reply_goto":"extract_1"},
   {"id":"find_order","type":"find_sheet_row","match_attempts":[{"column":"Order Number","value_var":"order_number"}],"store_to":"order_row"},
   {"id":"branch_found","type":"branch","condition":"context.order_row != null","if_true":"branch_shipped","if_false":"escalate_not_found"},
   {"id":"branch_shipped","type":"branch","condition":"context.order_row?.Status !== ''Shipped'' && context.order_row?.Status !== ''Delivered''","if_true":"update_address","if_false":"reply_too_late"},
   {"id":"update_address","type":"update_sheet","row_var":"order_row","updates":[{"column":"Shipping Address","value_var":"new_address"}]},
   {"id":"reply_updated","type":"send_reply","goal":"Confirm that the shipping address has been updated on their order."},
   {"id":"complete_1","type":"complete"},
   {"id":"reply_too_late","type":"send_reply","goal":"Let the customer know their order has already shipped to the original address. Suggest they contact the courier for redirection."},
   {"id":"complete_late","type":"complete"},
   {"id":"escalate_not_found","type":"escalate","reason":"Order not found in sheet"}
 ]'::jsonb,
 NULL,
 ARRAY['Order Number', 'Status', 'Shipping Address']),

('ecom-return', 'Return Request', 'return', 'ecommerce',
 'Walks the customer through initiating a return and logs it in the sheet.',
 'When a customer wants to return an item, get the order number and reason. Look it up and confirm eligibility. If eligible, mark the return in the sheet and send return instructions.',
 '[
   {"id":"extract_1","type":"extract","variables":["order_number","return_reason"]},
   {"id":"branch_has_order","type":"branch","condition":"context.order_number != null","if_true":"find_order","if_false":"ask_order"},
   {"id":"ask_order","type":"ask_customer","goal":"Ask the customer for their order number and why they want to return.","on_reply_goto":"extract_1"},
   {"id":"find_order","type":"find_sheet_row","match_attempts":[{"column":"Order Number","value_var":"order_number"}],"store_to":"order_row"},
   {"id":"branch_found","type":"branch","condition":"context.order_row != null","if_true":"update_return","if_false":"escalate_not_found"},
   {"id":"update_return","type":"update_sheet","row_var":"order_row","updates":[{"column":"Return Status","value":"Initiated"},{"column":"Return Reason","value_var":"return_reason"}]},
   {"id":"reply_instructions","type":"send_reply","goal":"Confirm the return has been logged and provide return instructions (pack the item, include the order number, send to our returns address)."},
   {"id":"complete_1","type":"complete"},
   {"id":"escalate_not_found","type":"escalate","reason":"Order not found in sheet"}
 ]'::jsonb,
 NULL,
 ARRAY['Order Number', 'Return Status', 'Return Reason']),

('ecom-exchange', 'Exchange Request', 'exchange', 'ecommerce',
 'Handles product exchange requests by confirming what the customer wants instead.',
 'When a customer wants to exchange an item, get their order number, what they currently have, and what they want instead. Look up the order and send it to manual review so the team can process the swap.',
 '[
   {"id":"extract_1","type":"extract","variables":["order_number","current_item","desired_item"]},
   {"id":"branch_has_info","type":"branch","condition":"context.order_number != null && context.desired_item != null","if_true":"find_order","if_false":"ask_info"},
   {"id":"ask_info","type":"ask_customer","goal":"Ask the customer for their order number, which item they want to exchange, and what they''d like instead.","on_reply_goto":"extract_1"},
   {"id":"find_order","type":"find_sheet_row","match_attempts":[{"column":"Order Number","value_var":"order_number"}],"store_to":"order_row"},
   {"id":"branch_found","type":"branch","condition":"context.order_row != null","if_true":"manual_review","if_false":"escalate_not_found"},
   {"id":"manual_review","type":"manual_approval","reason":"Exchange request needs manual processing","draft_template":"exchange","on_approve":"reply_confirmed","on_reject":"reply_denied"},
   {"id":"reply_confirmed","type":"send_reply","goal":"Confirm the exchange is being processed and let the customer know next steps (return original item, new item will ship once received)."},
   {"id":"complete_1","type":"complete"},
   {"id":"reply_denied","type":"send_reply","goal":"Let the customer know the exchange can''t be processed and explain the reason."},
   {"id":"complete_denied","type":"complete"},
   {"id":"escalate_not_found","type":"escalate","reason":"Order not found in sheet"}
 ]'::jsonb,
 NULL,
 ARRAY['Order Number']),

-- ─── Customer Service ────────────────────────────────────────────────────────

('cs-faq', 'FAQ Auto-Reply', 'faq', 'ecommerce',
 'Answers common questions using AI with the brand voice. No sheet lookups needed.',
 'When someone asks a common question (shipping times, returns policy, opening hours, etc), use AI to draft a helpful reply based on our brand knowledge. Send it automatically.',
 '[
   {"id":"extract_1","type":"extract","variables":["question_topic"]},
   {"id":"send_answer","type":"send_reply","goal":"Answer the customer''s question helpfully and accurately based on our brand knowledge. Keep it concise and friendly."},
   {"id":"complete_1","type":"complete"}
 ]'::jsonb,
 'We ship within 1-2 business days and delivery takes 3-5 days within NZ. Hope that helps!',
 NULL),

('cs-feedback', 'Customer Feedback', 'feedback', 'ecommerce',
 'Acknowledges customer feedback and logs it for the team.',
 'When a customer sends feedback about their experience, acknowledge it warmly and let them know we appreciate it. Send to manual review so the team can see it.',
 '[
   {"id":"extract_1","type":"extract","variables":["feedback_type","feedback_summary"]},
   {"id":"manual_review","type":"manual_approval","reason":"Customer feedback received - review and respond","draft_template":"feedback_response","on_approve":"reply_thanks","on_reject":"reply_thanks"},
   {"id":"reply_thanks","type":"send_reply","goal":"Thank the customer sincerely for their feedback. If it was positive, express genuine appreciation. If constructive, acknowledge it and let them know we take it on board."},
   {"id":"complete_1","type":"complete"}
 ]'::jsonb,
 'Really appreciate you taking the time to let us know. We''ll pass this on to the team!',
 NULL),

('cs-complaint', 'Complaint Handling', 'complaint', 'ecommerce',
 'Routes complaints to manual review with full context for human resolution.',
 'When a customer complains, extract the key details of what went wrong. Always escalate complaints to manual review - the AI drafts a response acknowledging the issue, but a human approves before sending.',
 '[
   {"id":"extract_1","type":"extract","variables":["complaint_topic","order_number"]},
   {"id":"branch_has_order","type":"branch","condition":"context.order_number != null","if_true":"find_order","if_false":"manual_review"},
   {"id":"find_order","type":"find_sheet_row","match_attempts":[{"column":"Order Number","value_var":"order_number"}],"store_to":"order_row"},
   {"id":"manual_review","type":"manual_approval","reason":"Customer complaint needs human review","draft_template":"complaint_response","on_approve":"send_response","on_reject":"send_response"},
   {"id":"send_response","type":"send_reply","goal":"Acknowledge the customer''s complaint empathetically. Apologise for the experience and explain what steps we''re taking to resolve it."},
   {"id":"complete_1","type":"complete"}
 ]'::jsonb,
 'Really sorry to hear about this experience. That''s not the standard we hold ourselves to. Let me look into this and get back to you.',
 ARRAY['Order Number']),

('cs-compliment', 'Compliment / Positive Review', 'compliment', 'ecommerce',
 'Warmly acknowledges positive messages and auto-replies.',
 'When a customer says something nice, thank them warmly. These can be auto-sent - no manual review needed.',
 '[
   {"id":"extract_1","type":"extract","variables":["compliment_topic"]},
   {"id":"send_thanks","type":"send_reply","goal":"Thank the customer genuinely for their kind words. Be warm and personal, not corporate."},
   {"id":"complete_1","type":"complete"}
 ]'::jsonb,
 'That''s made our day! So glad you''re loving it. Thanks for letting us know.',
 NULL),

-- ─── Operations ──────────────────────────────────────────────────────────────

('ops-supplier-query', 'Supplier Query', 'supplier_query', 'ecommerce',
 'Handles incoming emails from suppliers, extracts key info, and sends for review.',
 'When a supplier emails with a question or update, extract what they''re asking about and any reference numbers. Send to manual review so the ops team can handle it.',
 '[
   {"id":"extract_1","type":"extract","variables":["supplier_name","query_topic","reference_number"]},
   {"id":"manual_review","type":"manual_approval","reason":"Supplier query needs ops team review","draft_template":"supplier_response","on_approve":"send_reply_1","on_reject":"send_reply_1"},
   {"id":"send_reply_1","type":"send_reply","goal":"Respond to the supplier professionally. Acknowledge their query and provide any relevant information."},
   {"id":"complete_1","type":"complete"}
 ]'::jsonb,
 NULL,
 NULL),

('ops-b2b-enquiry', 'B2B / Wholesale Enquiry', 'b2b_enquiry', 'ecommerce',
 'Captures wholesale or partnership enquiries and routes them to the team.',
 'When someone enquires about wholesale, partnerships, or bulk orders, extract their business details and what they''re interested in. Send to manual review.',
 '[
   {"id":"extract_1","type":"extract","variables":["business_name","contact_name","enquiry_type","volume_interest"]},
   {"id":"manual_review","type":"manual_approval","reason":"B2B enquiry - needs team review","draft_template":"b2b_response","on_approve":"send_reply_1","on_reject":"send_reply_1"},
   {"id":"send_reply_1","type":"send_reply","goal":"Thank them for their interest in working with us. Let them know someone from the team will be in touch shortly with more details."},
   {"id":"complete_1","type":"complete"}
 ]'::jsonb,
 NULL,
 NULL),

('ops-press-enquiry', 'Press / Media Enquiry', 'press_enquiry', 'ecommerce',
 'Routes press and media requests to manual review for the founder or marketing team.',
 'When a journalist or media outlet reaches out, extract their name, outlet, and what they''re asking about. Always send to manual review.',
 '[
   {"id":"extract_1","type":"extract","variables":["journalist_name","media_outlet","topic"]},
   {"id":"manual_review","type":"manual_approval","reason":"Press enquiry - needs founder or marketing review","draft_template":"press_response","on_approve":"send_reply_1","on_reject":"send_reply_1"},
   {"id":"send_reply_1","type":"send_reply","goal":"Thank them for reaching out. Let them know the right person will get back to them shortly."},
   {"id":"complete_1","type":"complete"}
 ]'::jsonb,
 NULL,
 NULL)

ON CONFLICT (slug) DO NOTHING;
