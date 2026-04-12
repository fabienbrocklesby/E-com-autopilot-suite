<!--
  /sheet-rules — Manage sheet rules
  Configure rules that match email threads to spreadsheet rows and apply updates.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { sheetRulesApi, sheetsApi, categoriesApi } from "$lib/api";
  import type { SheetRule, SheetRulePayload, SheetColumn, Category } from "$lib/api";

  let rules = $state<SheetRule[]>([]);
  let columns = $state<SheetColumn[]>([]);
  let categories = $state<Category[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let success = $state<string | null>(null);

  // Modal state
  let showForm = $state(false);
  let editingRule = $state<SheetRule | null>(null);
  let saving = $state(false);
  let validationErrors = $state<Record<string, string>>({});

  const emptyForm = (): SheetRulePayload => ({
    name: "",
    description: "",
    is_active: true,
    category_ids: null,
    match_instruction: "",
    match_column: "",
    updates: [],
    auto_apply: false,
  });

  let form = $state<SheetRulePayload>(emptyForm());
  let selectedCategoryIds = $state<number[]>([]);

  // ─── Match instruction warning ──────────────────────────────────────────
  // Warn if the instruction looks like an action/description rather than an extraction command
  const ACTION_WORDS = /\b(update|change|set|write|add|mark|modify|put|make|fill|insert|replace)\b/i;
  const EXTRACT_WORDS = /\b(extract|find|get|pull|parse|identify|locate|determine|return|what is|what's)\b/i;

  let matchInstructionWarning = $derived(
    form.match_instruction.length > 10 &&
    ACTION_WORDS.test(form.match_instruction) &&
    !EXTRACT_WORDS.test(form.match_instruction)
      ? "This looks like an action description, not an extraction instruction. The AI needs to know what value to pull out of the email (e.g. an order number or email address), not what to do with it."
      : null
  );

  // ─── Category helpers ────────────────────────────────────────────────────
  function syncCategoryIds() {
    form.category_ids = selectedCategoryIds.length > 0 ? [...selectedCategoryIds] : null;
  }

  function toggleCategoryId(id: number) {
    selectedCategoryIds = selectedCategoryIds.includes(id)
      ? selectedCategoryIds.filter((c) => c !== id)
      : [...selectedCategoryIds, id];
    syncCategoryIds();
  }

  // ─── Load ────────────────────────────────────────────────────────────────
  async function load() {
    loading = true;
    error = null;
    try {
      const [rulesRes, colsRes, catsRes] = await Promise.all([
        sheetRulesApi.list(),
        sheetsApi.getColumns(),
        categoriesApi.list(),
      ]);
      rules = rulesRes.rules;
      columns = colsRes.columns;
      categories = catsRes.categories;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load";
    } finally {
      loading = false;
    }
  }

  // ─── Form open/close ─────────────────────────────────────────────────────
  function openCreate() {
    editingRule = null;
    form = emptyForm();
    selectedCategoryIds = [];
    validationErrors = {};
    showForm = true;
  }

  function openEdit(rule: SheetRule) {
    editingRule = rule;
    form = {
      name: rule.name,
      description: rule.description,
      is_active: rule.is_active,
      category_ids: rule.category_ids,
      match_instruction: rule.match_instruction,
      match_column: rule.match_column,
      updates: rule.updates.map((u) => ({ ...u })),
      auto_apply: rule.auto_apply,
    };
    selectedCategoryIds = rule.category_ids ? [...rule.category_ids] : [];
    validationErrors = {};
    showForm = true;
  }

  function closeForm() {
    showForm = false;
    editingRule = null;
    form = emptyForm();
    selectedCategoryIds = [];
    validationErrors = {};
  }

  // ─── Validation ──────────────────────────────────────────────────────────
  function validate(): boolean {
    const errs: Record<string, string> = {};

    if (!form.name.trim()) errs.name = "Name is required.";

    if (!form.match_instruction.trim()) {
      errs.match_instruction = "Extraction instruction is required.";
    } else if (matchInstructionWarning) {
      errs.match_instruction = "Fix the extraction instruction before saving — see the warning above.";
    }

    if (!form.match_column) errs.match_column = "You must select a match column.";

    if (form.updates.length === 0) {
      errs.updates = "Add at least one column to update.";
    } else {
      if (form.updates.some((u) => !u.column)) errs.updates = "Every update row must have a column selected.";
      else if (form.updates.some((u) => u.mode === "fixed" && !u.value?.trim())) errs.updates = "Fixed value updates cannot be blank.";
      else if (form.updates.some((u) => u.mode === "ai" && !u.instruction?.trim())) errs.updates = "AI update instructions cannot be blank.";
    }

    validationErrors = errs;
    return Object.keys(errs).length === 0;
  }

  // ─── Save ────────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!validate()) return;
    saving = true;
    error = null;
    try {
      if (editingRule) {
        const res = await sheetRulesApi.update(editingRule.id, form);
        rules = rules.map((r) => (r.id === editingRule!.id ? res.rule : r));
        success = "Rule updated.";
      } else {
        const res = await sheetRulesApi.create(form);
        rules = [...rules, res.rule];
        success = "Rule created.";
      }
      closeForm();
      setTimeout(() => { success = null; }, 3000);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to save rule";
    } finally {
      saving = false;
    }
  }

  async function handleToggleActive(rule: SheetRule) {
    try {
      const res = await sheetRulesApi.patch(rule.id, { is_active: !rule.is_active });
      rules = rules.map((r) => (r.id === rule.id ? res.rule : r));
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to update rule";
    }
  }

  async function handleDelete(rule: SheetRule) {
    if (!confirm(`Delete rule "${rule.name}"? This cannot be undone.`)) return;
    try {
      await sheetRulesApi.delete(rule.id);
      rules = rules.filter((r) => r.id !== rule.id);
      success = "Rule deleted.";
      setTimeout(() => { success = null; }, 3000);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to delete rule";
    }
  }

  // ─── Updates editor ───────────────────────────────────────────────────────
  function addUpdate() {
    form.updates = [...form.updates, { column: "", mode: "fixed", value: "" }];
  }

  function removeUpdate(index: number) {
    form.updates = form.updates.filter((_, i) => i !== index);
  }

  function setUpdateMode(index: number, mode: "fixed" | "ai") {
    form.updates = form.updates.map((u, i) =>
      i === index
        ? { column: u.column, mode, value: mode === "fixed" ? "" : undefined, instruction: mode === "ai" ? "" : undefined }
        : u
    );
  }

  function setUpdateColumn(index: number, column: string) {
    form.updates = form.updates.map((u, i) => (i === index ? { ...u, column } : u));
  }

  function setUpdateValue(index: number, value: string) {
    form.updates = form.updates.map((u, i) => (i === index ? { ...u, value } : u));
  }

  function setUpdateInstruction(index: number, instruction: string) {
    form.updates = form.updates.map((u, i) => (i === index ? { ...u, instruction } : u));
  }

  function colLabel(letter: string) {
    const col = columns.find((c) => c.column_letter === letter);
    return col ? `${letter} — ${col.header_name}` : letter;
  }

  function categoryName(id: number) {
    return categories.find((c) => c.id === id)?.name ?? String(id);
  }

  onMount(() => { load(); });
</script>

<svelte:head>
  <title>Sheet Rules — Email Dash</title>
</svelte:head>

<div class="page-header">
  <h1>Sheet Rules</h1>
  <button class="btn btn-primary" onclick={openCreate}>+ New Rule</button>
</div>

{#if error}
  <div class="error-banner">{error}</div>
{/if}

{#if success}
  <div class="success-banner">{success}</div>
{/if}

{#if columns.length === 0 && !loading}
  <div class="info-banner">
    ⚠ No sheet columns synced yet. Go to <a href="/settings">Settings → Workspaces</a> and click "Sync Columns" so rules can reference your spreadsheet columns.
  </div>
{/if}

{#if loading}
  <div class="loading">Loading rules…</div>
{:else if rules.length === 0}
  <div class="empty">
    <p>No sheet rules yet. Create one to start auto-updating your spreadsheet.</p>
    <button class="btn btn-primary" style="margin-top: 16px" onclick={openCreate}>
      + Create First Rule
    </button>
  </div>
{:else}
  <div class="rules-grid">
    {#each rules as rule (rule.id)}
      <div class="card rule-card" class:inactive={!rule.is_active}>
        <div class="rule-header">
          <div class="rule-title-row">
            <h2>{rule.name}</h2>
            <span class="status-badge" class:active={rule.is_active}>
              {rule.is_active ? "Active" : "Inactive"}
            </span>
          </div>
          <div class="rule-actions">
            <button class="btn btn-ghost btn-sm" onclick={() => openEdit(rule)}>Edit</button>
            <button class="btn btn-ghost btn-sm" onclick={() => handleToggleActive(rule)}>
              {rule.is_active ? "Disable" : "Enable"}
            </button>
            <button class="btn btn-ghost btn-sm danger" onclick={() => handleDelete(rule)}>Delete</button>
          </div>
        </div>

        {#if rule.description}
          <p class="rule-description">{rule.description}</p>
        {/if}

        <div class="rule-meta">
          <div class="meta-item">
            <span class="meta-label">Match column</span>
            <span class="meta-value">{colLabel(rule.match_column)}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Auto-apply</span>
            <span class="meta-value" class:enabled={rule.auto_apply}>
              {rule.auto_apply ? "Yes" : "No — review required"}
            </span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Updates</span>
            <span class="meta-value">{rule.updates.length} column{rule.updates.length !== 1 ? "s" : ""}</span>
          </div>
        </div>

        {#if rule.category_ids && rule.category_ids.length > 0}
          <div class="category-chips">
            <span class="meta-label">Categories</span>
            <div class="chips">
              {#each rule.category_ids as cid}
                <span class="chip">{categoryName(cid)}</span>
              {/each}
            </div>
          </div>
        {:else}
          <p class="all-categories">Applies to all categories</p>
        {/if}

        <details class="match-details">
          <summary>Extraction instruction</summary>
          <pre class="match-body">{rule.match_instruction}</pre>
        </details>
      </div>
    {/each}
  </div>
{/if}

<!-- ─── Modal form ─────────────────────────────────────────────────────────── -->
{#if showForm}
  <div class="modal-overlay" role="dialog" aria-modal="true">
    <div class="modal card">
      <div class="modal-header">
        <h2>{editingRule ? "Edit Rule" : "New Rule"}</h2>
        <button class="close-btn" onclick={closeForm}>✕</button>
      </div>

      {#if error}
        <div class="error-banner">{error}</div>
      {/if}

      <div class="how-it-works">
        <strong>How rules work:</strong> When an email is categorised, the AI extracts a unique identifier from the email (using your extraction instruction), searches your spreadsheet for that value, then writes the configured updates to that row.
      </div>

      <form class="rule-form" onsubmit={(e) => { e.preventDefault(); handleSave(); }}>

        <!-- Name -->
        <div class="field">
          <label class="label" for="rule-name">Rule name *</label>
          <input
            id="rule-name"
            class="input"
            class:input-error={validationErrors.name}
            type="text"
            bind:value={form.name}
            placeholder="e.g. Update order status on refund request"
          />
          {#if validationErrors.name}
            <span class="field-error">{validationErrors.name}</span>
          {/if}
        </div>

        <!-- Description -->
        <div class="field">
          <label class="label" for="rule-desc">Description</label>
          <input
            id="rule-desc"
            class="input"
            type="text"
            bind:value={form.description}
            placeholder="Optional — briefly describe what this rule does"
          />
        </div>

        <!-- Match instruction -->
        <div class="field">
          <label class="label" for="rule-match-inst">
            Step 1 — What identifier should the AI extract from the email? *
          </label>
          <p class="field-hint">
            This tells the AI what unique value to pull from the email so it can find the correct row in your spreadsheet.<br />
            <strong class="example-good">✓ Good:</strong> "Extract the order number from the email — it usually appears as #12345 or 'order 12345'"<br />
            <strong class="example-good">✓ Good:</strong> "Extract the sender's email address"<br />
            <strong class="example-bad">✗ Wrong:</strong> "Update the status column to say refund requested" — that's an action, not an extraction
          </p>
          <textarea
            id="rule-match-inst"
            class="input textarea"
            class:input-error={validationErrors.match_instruction}
            bind:value={form.match_instruction}
            rows={3}
            placeholder="e.g. Extract the order number from the email. It usually looks like #12345 or 'order number 12345'."
          ></textarea>
          {#if matchInstructionWarning}
            <div class="field-warning">
              ⚠ {matchInstructionWarning}
            </div>
          {/if}
          {#if validationErrors.match_instruction}
            <span class="field-error">{validationErrors.match_instruction}</span>
          {/if}
        </div>

        <!-- Match column -->
        <div class="field">
          <label class="label" for="rule-match-col">
            Step 2 — Which spreadsheet column contains that identifier? *
          </label>
          <p class="field-hint">
            The extracted value will be searched in this column to find the matching row (e.g. if you extract an order number, pick the column that lists order numbers).
            {#if columns.length === 0}
              <strong class="example-bad"> No columns synced yet — go to Settings → Workspaces → Sync Columns first.</strong>
            {/if}
          </p>
          <select
            id="rule-match-col"
            class="input"
            class:input-error={validationErrors.match_column}
            bind:value={form.match_column}
          >
            <option value="">— Select column —</option>
            {#each columns as col}
              <option value={col.column_letter}>{col.column_letter} — {col.header_name}</option>
            {/each}
          </select>
          {#if validationErrors.match_column}
            <span class="field-error">{validationErrors.match_column}</span>
          {/if}
        </div>

        <!-- Updates -->
        <div class="field">
          <div class="updates-header">
            <div>
              <span class="label">Step 3 — What should be written to the matched row? *</span>
              <p class="field-hint" style="margin-top: 3px">
                Add one entry per column to update. <strong>Fixed</strong> = write an exact value every time. <strong>AI</strong> = the model reads the email and generates the value.
              </p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" onclick={addUpdate}>+ Add column</button>
          </div>

          {#if validationErrors.updates}
            <div class="field-error" style="margin-top: 4px">{validationErrors.updates}</div>
          {/if}

          {#if form.updates.length === 0}
            <div class="empty-updates">No column updates yet — add at least one above.</div>
          {/if}

          {#each form.updates as update, i (i)}
            <div class="update-row card">
              <div class="update-top">
                <select
                  class="input update-col-select"
                  class:input-error={!update.column}
                  value={update.column}
                  onchange={(e) => setUpdateColumn(i, (e.target as HTMLSelectElement).value)}
                >
                  <option value="">— Column to update —</option>
                  {#each columns as col}
                    <option value={col.column_letter}>{col.column_letter} — {col.header_name}</option>
                  {/each}
                </select>

                <div class="mode-toggle" title="Fixed: write a specific value. AI: model generates it from the email.">
                  <button
                    type="button"
                    class="mode-btn"
                    class:active={update.mode === "fixed"}
                    onclick={() => setUpdateMode(i, "fixed")}
                  >Fixed</button>
                  <button
                    type="button"
                    class="mode-btn"
                    class:active={update.mode === "ai"}
                    onclick={() => setUpdateMode(i, "ai")}
                  >AI</button>
                </div>

                <button
                  type="button"
                  class="btn btn-ghost btn-sm danger remove-btn"
                  onclick={() => removeUpdate(i)}
                  title="Remove this update"
                >✕</button>
              </div>

              {#if update.mode === "fixed"}
                <input
                  class="input"
                  class:input-error={!update.value?.trim()}
                  type="text"
                  placeholder="Exact text to write — e.g. Refund Requested"
                  value={update.value ?? ""}
                  oninput={(e) => setUpdateValue(i, (e.target as HTMLInputElement).value)}
                />
                <span class="update-mode-hint">This exact text will be written to the cell whenever the rule fires.</span>
              {:else}
                <textarea
                  class="input textarea"
                  class:input-error={!update.instruction?.trim()}
                  rows={2}
                  placeholder="e.g. Summarise the customer's issue in one sentence"
                  value={update.instruction ?? ""}
                  oninput={(e) => setUpdateInstruction(i, (e.target as HTMLTextAreaElement).value)}
                ></textarea>
                <span class="update-mode-hint">The AI will read the email and write a value based on this instruction.</span>
              {/if}
            </div>
          {/each}
        </div>

        <!-- Category filter -->
        <div class="field">
          <span class="label">Category filter</span>
          <p class="field-hint">Restrict this rule to specific categories. Leave all unchecked to run on every categorised email.</p>
          {#if categories.length === 0}
            <p class="field-hint"><strong>No categories yet</strong> — create some on the Categories page first.</p>
          {:else}
            <div class="checkbox-grid">
              {#each categories as cat}
                <label class="checkbox-item">
                  <input
                    type="checkbox"
                    checked={selectedCategoryIds.includes(cat.id)}
                    onchange={() => toggleCategoryId(cat.id)}
                  />
                  <span>{cat.name}</span>
                </label>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Toggles -->
        <div class="field-row">
          <label class="field field-half toggle-field">
            <div>
              <span class="label">Active</span>
              <p class="field-hint" style="margin-top: 2px">Inactive rules are skipped entirely.</p>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={form.is_active} />
              <span class="toggle-slider"></span>
            </label>
          </label>

          <label class="field field-half toggle-field">
            <div>
              <span class="label">Auto-apply</span>
              <p class="field-hint" style="margin-top: 2px">Write directly — no review step. Keep off while testing.</p>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={form.auto_apply} />
              <span class="toggle-slider"></span>
            </label>
          </label>
        </div>

        <div class="form-actions">
          <button type="button" class="btn btn-ghost" onclick={closeForm}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled={saving}>
            {saving ? "Saving…" : "Save Rule"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
  h1 { font-size: 22px; font-weight: 700; }
  .loading, .empty { color: var(--color-text-muted); padding: 40px; text-align: center; }

  .success-banner {
    background: rgba(16 185 129 / 0.1); border: 1px solid rgba(16 185 129 / 0.3);
    border-radius: var(--radius); color: #6ee7b7; padding: 12px 16px; margin-bottom: 16px;
  }

  .info-banner {
    background: rgba(245 158 11 / 0.1); border: 1px solid rgba(245 158 11 / 0.3);
    border-radius: var(--radius); color: var(--color-warning);
    padding: 12px 16px; margin-bottom: 20px; font-size: 13px;
  }
  .info-banner a { color: var(--color-warning); text-decoration: underline; }

  .rules-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 16px; }
  .rule-card { display: flex; flex-direction: column; gap: 12px; }
  .rule-card.inactive { opacity: 0.6; }
  .rule-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .rule-title-row { display: flex; align-items: center; gap: 8px; flex: 1; }
  h2 { font-size: 15px; font-weight: 700; }

  .status-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: rgba(100 116 139 / 0.15); color: var(--color-text-muted); }
  .status-badge.active { background: rgba(16 185 129 / 0.15); color: var(--color-success); }

  .rule-actions { display: flex; gap: 6px; flex-shrink: 0; }
  :global(.btn-sm.danger) { color: var(--color-danger) !important; }
  .rule-description { color: var(--color-text-muted); font-size: 13px; }
  .rule-meta { display: flex; gap: 20px; flex-wrap: wrap; }

  .meta-label { display: block; font-size: 11px; font-weight: 600; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3px; }
  .meta-value { font-size: 13px; font-weight: 500; }
  .meta-value.enabled { color: var(--color-success); }

  .category-chips { display: flex; flex-direction: column; gap: 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { background: rgba(99 102 241 / 0.15); color: var(--color-primary); padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .all-categories { font-size: 12px; color: var(--color-text-muted); }
  .match-details summary { cursor: pointer; font-size: 12px; color: var(--color-text-muted); user-select: none; }
  .match-body { margin-top: 8px; font-family: var(--font); font-size: 12px; white-space: pre-wrap; background: var(--color-surface-2); padding: 10px; border-radius: var(--radius); }

  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0 0 0 / 0.7); display: grid; place-items: center; padding: 20px; z-index: 100; overflow-y: auto; }
  .modal { width: 100%; max-width: 620px; max-height: 90vh; overflow-y: auto; }
  .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .close-btn { background: none; border: none; color: var(--color-text-muted); font-size: 16px; padding: 4px; cursor: pointer; }
  .close-btn:hover { color: var(--color-text); }

  .how-it-works {
    background: rgba(99 102 241 / 0.08); border: 1px solid rgba(99 102 241 / 0.2);
    border-radius: var(--radius); color: var(--color-text);
    font-size: 12px; line-height: 1.6; padding: 12px 14px; margin-bottom: 20px;
  }

  .rule-form { display: flex; flex-direction: column; gap: 18px; }
  .field { display: flex; flex-direction: column; gap: 5px; }
  .field-row { display: flex; gap: 14px; }
  .field-half { flex: 1; }
  .toggle-field { flex-direction: row !important; align-items: center; justify-content: space-between; }

  .label { font-size: 12px; font-weight: 600; color: var(--color-text-muted); }
  .field-hint { font-size: 12px; color: var(--color-text-muted); line-height: 1.6; }
  .field-error { font-size: 12px; color: var(--color-danger); font-weight: 500; }

  .example-good { color: var(--color-success); }
  .example-bad { color: var(--color-danger); }

  .field-warning {
    background: rgba(245 158 11 / 0.12); border: 1px solid rgba(245 158 11 / 0.35);
    border-radius: var(--radius); color: var(--color-warning);
    font-size: 12px; line-height: 1.5; padding: 10px 12px; margin-top: 4px;
  }

  .input {
    background: var(--color-surface-2); border: 1px solid var(--color-border);
    border-radius: var(--radius); color: var(--color-text);
    font-size: 13px; font-family: inherit; padding: 8px 10px;
    transition: border-color 0.15s; width: 100%;
  }
  .input:focus { outline: none; border-color: var(--color-primary); }
  .input.input-error { border-color: var(--color-danger); }
  .textarea { resize: vertical; }

  .updates-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }

  .empty-updates {
    font-size: 12px; color: var(--color-text-muted);
    border: 1px dashed var(--color-border); border-radius: var(--radius);
    padding: 16px; text-align: center; margin-top: 6px;
  }

  .update-row { display: flex; flex-direction: column; gap: 8px; padding: 12px !important; margin-top: 8px; }
  .update-top { display: flex; align-items: center; gap: 8px; }
  .update-col-select { flex: 1; }
  .update-mode-hint { font-size: 11px; color: var(--color-text-muted); }

  .mode-toggle { display: flex; border: 1px solid var(--color-border); border-radius: var(--radius); overflow: hidden; flex-shrink: 0; }
  .mode-btn { background: none; border: none; color: var(--color-text-muted); font-size: 12px; font-weight: 500; padding: 5px 12px; cursor: pointer; transition: background 0.15s; }
  .mode-btn.active { background: var(--color-primary); color: #fff; }
  .remove-btn { flex-shrink: 0; }

  .checkbox-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; margin-top: 6px; }
  .checkbox-item { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }

  .toggle { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider { position: absolute; inset: 0; background: var(--color-surface-2); border: 1px solid var(--color-border); border-radius: 22px; cursor: pointer; transition: background 0.2s; }
  .toggle-slider::before { content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 50%; transform: translateY(-50%); background: var(--color-text-muted); border-radius: 50%; transition: transform 0.2s, background 0.2s; }
  .toggle input:checked + .toggle-slider { background: rgba(99 102 241 / 0.3); border-color: var(--color-primary); }
  .toggle input:checked + .toggle-slider::before { transform: translate(18px, -50%); background: var(--color-primary); }

  .form-actions { display: flex; justify-content: flex-end; gap: 10px; padding-top: 8px; border-top: 1px solid var(--color-border); }
</style>
