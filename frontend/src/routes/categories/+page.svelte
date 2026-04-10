<!--
  /categories — List and edit categories and their behaviour
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { categoriesApi } from "$lib/api";
  import type { Category, CategoryPayload } from "$lib/api";

  let categories = $state<Category[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let success = $state<string | null>(null);

  // Edit/create modal state
  let showForm = $state(false);
  let editingCategory = $state<Category | null>(null);
  let saving = $state(false);

  const emptyForm = (): CategoryPayload => ({
    name: "",
    description: "",
    instructions: "",
    allow_auto_reply: false,
    confidence_threshold: 0.8,
    writing_style: "",
  });

  let form = $state<CategoryPayload>(emptyForm());

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await categoriesApi.list();
      categories = res.categories;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load categories";
    } finally {
      loading = false;
    }
  }

  function openCreate() {
    editingCategory = null;
    form = emptyForm();
    showForm = true;
  }

  function openEdit(cat: Category) {
    editingCategory = cat;
    form = {
      name: cat.name,
      description: cat.description,
      instructions: cat.instructions,
      allow_auto_reply: cat.allow_auto_reply,
      confidence_threshold: cat.confidence_threshold,
      writing_style: cat.writing_style,
    };
    showForm = true;
  }

  function closeForm() {
    showForm = false;
    editingCategory = null;
    form = emptyForm();
  }

  async function handleSave() {
    saving = true;
    error = null;
    try {
      if (editingCategory) {
        const res = await categoriesApi.update(editingCategory.id, form);
        categories = categories.map((c) =>
          c.id === editingCategory!.id ? res.category : c,
        );
        success = "Category updated.";
      } else {
        const res = await categoriesApi.create(form);
        categories = [...categories, res.category];
        success = "Category created.";
      }
      closeForm();
      setTimeout(() => {
        success = null;
      }, 3000);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to save category";
    } finally {
      saving = false;
    }
  }

  async function handleDelete(cat: Category) {
    if (!confirm(`Delete category "${cat.name}"? This cannot be undone.`))
      return;
    try {
      await categoriesApi.delete(cat.id);
      categories = categories.filter((c) => c.id !== cat.id);
      success = "Category deleted.";
      setTimeout(() => {
        success = null;
      }, 3000);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to delete category";
    }
  }

  onMount(() => {
    load();
  });
</script>

<svelte:head>
  <title>Categories — Email Dash</title>
</svelte:head>

<div class="page-header">
  <h1>Categories</h1>
  <button class="btn btn-primary" onclick={openCreate}>+ New Category</button>
</div>

{#if error}
  <div class="error-banner">{error}</div>
{/if}

{#if success}
  <div class="success-banner">{success}</div>
{/if}

{#if loading}
  <div class="loading">Loading categories…</div>
{:else if categories.length === 0}
  <div class="empty">
    <p>No categories yet. Create one to start categorising emails.</p>
    <button
      class="btn btn-primary"
      style="margin-top: 16px"
      onclick={openCreate}
    >
      + Create First Category
    </button>
  </div>
{:else}
  <div class="categories-grid">
    {#each categories as cat (cat.id)}
      <div class="card category-card">
        <div class="cat-header">
          <h2>{cat.name}</h2>
          <div class="cat-actions">
            <button class="btn btn-ghost btn-sm" onclick={() => openEdit(cat)}
              >Edit</button
            >
            <button
              class="btn btn-ghost btn-sm danger"
              onclick={() => handleDelete(cat)}>Delete</button
            >
          </div>
        </div>

        {#if cat.description}
          <p class="cat-description">{cat.description}</p>
        {/if}

        <div class="cat-meta">
          <div class="meta-item">
            <span class="meta-label">Auto-reply</span>
            <span class="meta-value" class:enabled={cat.allow_auto_reply}>
              {cat.allow_auto_reply ? "Enabled" : "Disabled"}
            </span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Confidence threshold</span>
            <span class="meta-value"
              >{Math.round(cat.confidence_threshold * 100)}%</span
            >
          </div>
        </div>

        {#if cat.instructions}
          <details class="instructions-details">
            <summary>Instructions</summary>
            <pre class="instructions-body">{cat.instructions}</pre>
          </details>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<!-- Modal form -->
{#if showForm}
  <div class="modal-overlay" role="dialog" aria-modal="true">
    <div class="modal card">
      <div class="modal-header">
        <h2>{editingCategory ? "Edit Category" : "New Category"}</h2>
        <button class="close-btn" onclick={closeForm}>✕</button>
      </div>

      {#if error}
        <div class="error-banner">{error}</div>
      {/if}

      <form
        class="category-form"
        onsubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
      >
        <label class="field">
          <span class="label">Name *</span>
          <input class="input" type="text" bind:value={form.name} required />
        </label>

        <label class="field">
          <span class="label">Description</span>
          <input class="input" type="text" bind:value={form.description} />
        </label>

        <label class="field">
          <span class="label">Instructions (for AI)</span>
          <textarea
            class="input textarea"
            bind:value={form.instructions}
            rows={5}
          ></textarea>
        </label>

        <label class="field">
          <span class="label">Writing style</span>
          <input
            class="input"
            type="text"
            bind:value={form.writing_style}
            placeholder="e.g. Professional and concise"
          />
        </label>

        <div class="field-row">
          <label class="field field-half">
            <span class="label">Confidence threshold</span>
            <input
              class="input"
              type="number"
              min="0"
              max="1"
              step="0.01"
              bind:value={form.confidence_threshold}
            />
          </label>

          <label class="field field-half toggle-field">
            <span class="label">Allow auto-reply</span>
            <label class="toggle">
              <input type="checkbox" bind:checked={form.allow_auto_reply} />
              <span class="toggle-slider"></span>
            </label>
          </label>
        </div>

        <div class="form-actions">
          <button type="button" class="btn btn-ghost" onclick={closeForm}
            >Cancel</button
          >
          <button type="submit" class="btn btn-primary" disabled={saving}>
            {saving ? "Saving…" : "Save Category"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
  }

  h1 {
    font-size: 22px;
    font-weight: 700;
  }

  .loading,
  .empty {
    color: var(--color-text-muted);
    padding: 40px;
    text-align: center;
  }

  .success-banner {
    background: rgba(16 185 129 / 0.1);
    border: 1px solid rgba(16 185 129 / 0.3);
    border-radius: var(--radius);
    color: #6ee7b7;
    padding: 12px 16px;
    margin-bottom: 16px;
  }

  .categories-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: 16px;
  }

  .category-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .cat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h2 {
    font-size: 15px;
    font-weight: 700;
  }

  .cat-actions {
    display: flex;
    gap: 6px;
  }

  :global(.btn-sm.danger) {
    color: var(--color-danger) !important;
  }

  .cat-description {
    color: var(--color-text-muted);
    font-size: 13px;
  }

  .cat-meta {
    display: flex;
    gap: 20px;
  }

  .meta-label {
    display: block;
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 3px;
  }

  .meta-value {
    font-size: 13px;
    font-weight: 500;
  }

  .meta-value.enabled {
    color: var(--color-success);
  }

  .instructions-details summary {
    cursor: pointer;
    font-size: 12px;
    color: var(--color-text-muted);
    user-select: none;
  }

  .instructions-body {
    margin-top: 8px;
    font-family: var(--font);
    font-size: 12px;
    white-space: pre-wrap;
    background: var(--color-surface-2);
    padding: 10px;
    border-radius: var(--radius);
  }

  /* Modal */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0 0 0 / 0.7);
    display: grid;
    place-items: center;
    padding: 20px;
    z-index: 100;
  }

  .modal {
    width: 100%;
    max-width: 560px;
    max-height: 90vh;
    overflow-y: auto;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--color-text-muted);
    font-size: 16px;
    padding: 4px;
  }

  .close-btn:hover {
    color: var(--color-text);
  }

  .category-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .field-row {
    display: flex;
    gap: 14px;
  }

  .field-half {
    flex: 1;
  }

  .toggle-field {
    justify-content: space-between;
  }

  .label {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-muted);
  }

  .input {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    color: var(--color-text);
    font-size: 13px;
    font-family: inherit;
    padding: 8px 10px;
    transition: border-color 0.15s;
    width: 100%;
  }

  .input:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .textarea {
    resize: vertical;
  }

  /* Toggle switch */
  .toggle {
    position: relative;
    display: inline-block;
    width: 40px;
    height: 22px;
  }

  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-slider {
    position: absolute;
    inset: 0;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: 22px;
    cursor: pointer;
    transition: background 0.2s;
  }

  .toggle-slider::before {
    content: "";
    position: absolute;
    width: 16px;
    height: 16px;
    left: 3px;
    top: 50%;
    transform: translateY(-50%);
    background: var(--color-text-muted);
    border-radius: 50%;
    transition:
      transform 0.2s,
      background 0.2s;
  }

  .toggle input:checked + .toggle-slider {
    background: var(--color-primary);
    border-color: var(--color-primary);
  }

  .toggle input:checked + .toggle-slider::before {
    transform: translateX(18px) translateY(-50%);
    background: #fff;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 6px;
  }
</style>
