<!--
  /playbooks/new — Create a new playbook from scratch or from a template.
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { playbooksApi, playbookTemplatesApi, categoriesApi } from "$lib/api";
  import { workspaceStore } from "$lib/stores";
  import type { PlaybookTemplate, Category } from "$lib/api";

  let templates = $state<PlaybookTemplate[]>([]);
  let categories = $state<Category[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let creating = $state(false);
  let currentWorkspaceId = $state(1);

  // Filters
  let searchQuery = $state("");
  let filterCategory = $state("");
  let filterIndustry = $state("");

  // Template preview
  let selectedTemplate = $state<PlaybookTemplate | null>(null);

  // Create-from-template form
  let showCreateForm = $state(false);
  let createCategoryId = $state<number | null>(null);
  let createName = $state("");

  const unsubWs = workspaceStore.subscribe((id) => {
    currentWorkspaceId = id;
    load();
  });

  onDestroy(() => unsubWs());

  async function load() {
    loading = true;
    error = null;
    try {
      const [tplRes, catRes] = await Promise.all([
        playbookTemplatesApi.list(),
        categoriesApi.list(currentWorkspaceId),
      ]);
      templates = tplRes.templates;
      categories = catRes.categories;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load templates";
    } finally {
      loading = false;
    }
  }

  // Derived: unique categories and industries from templates
  let templateCategories = $derived(
    [...new Set(templates.map((t) => t.category))].sort()
  );
  let templateIndustries = $derived(
    [...new Set(templates.map((t) => t.industry).filter(Boolean))].sort()
  );

  // Derived: filtered templates
  let filteredTemplates = $derived(() => {
    let result = templates;
    if (filterCategory) {
      result = result.filter((t) => t.category === filterCategory);
    }
    if (filterIndustry) {
      result = result.filter((t) => t.industry === filterIndustry);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q)
      );
    }
    return result;
  });

  // Derived: group filtered templates by category
  let groupedTemplates = $derived(() => {
    const filtered = filteredTemplates();
    const groups: Record<string, PlaybookTemplate[]> = {};
    for (const t of filtered) {
      if (!groups[t.category]) groups[t.category] = [];
      groups[t.category].push(t);
    }
    return groups;
  });

  function selectTemplate(template: PlaybookTemplate) {
    selectedTemplate = template;
    showCreateForm = false;
  }

  function startCreate(template: PlaybookTemplate) {
    selectedTemplate = template;
    createName = template.name;
    createCategoryId = categories.length > 0 ? categories[0].id : null;
    showCreateForm = true;
  }

  async function createFromTemplate() {
    if (!selectedTemplate || !createCategoryId) return;
    creating = true;
    error = null;
    try {
      const res = await playbookTemplatesApi.createFrom(
        {
          template_slug: selectedTemplate.slug,
          category_id: createCategoryId,
          customizations: createName !== selectedTemplate.name ? { name: createName } : undefined,
        },
        currentWorkspaceId
      );
      goto(`/playbooks/${res.playbook.id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to create playbook";
      creating = false;
    }
  }

  async function createFromScratch() {
    creating = true;
    error = null;
    try {
      const res = await playbooksApi.create({ name: "New Playbook" });
      goto(`/playbooks/${res.playbook.id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to create playbook";
      creating = false;
    }
  }

  function formatCategory(cat: string) {
    return cat
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function stepSummary(template: PlaybookTemplate): string {
    const steps =
      typeof template.steps === "string"
        ? JSON.parse(template.steps)
        : template.steps;
    const types: Record<string, number> = {};
    for (const s of steps) {
      types[s.type] = (types[s.type] || 0) + 1;
    }
    return Object.entries(types)
      .map(([t, n]) => `${n} ${t}`)
      .join(", ");
  }
</script>

<svelte:head>
  <title>New Playbook</title>
</svelte:head>

<div class="page">
  <header class="page-header">
    <div class="header-left">
      <a href="/playbooks" class="back-link">← Back to Playbooks</a>
      <h1>New Playbook</h1>
    </div>
    <button class="btn btn-secondary" onclick={createFromScratch} disabled={creating}>
      {creating ? "Creating…" : "Start from Scratch"}
    </button>
  </header>

  {#if error}
    <div class="alert alert-error">{error}</div>
  {/if}

  {#if loading}
    <div class="loading">Loading templates…</div>
  {:else}
    <div class="layout">
      <!-- Left: template browser -->
      <div class="browser">
        <div class="filters">
          <input
            type="text"
            placeholder="Search templates…"
            bind:value={searchQuery}
            class="search-input"
          />
          <select bind:value={filterCategory}>
            <option value="">All categories</option>
            {#each templateCategories as cat}
              <option value={cat}>{formatCategory(cat)}</option>
            {/each}
          </select>
          {#if templateIndustries.length > 1}
            <select bind:value={filterIndustry}>
              <option value="">All industries</option>
              {#each templateIndustries as ind}
                <option value={ind}>{ind}</option>
              {/each}
            </select>
          {/if}
        </div>

        {#each Object.entries(groupedTemplates()) as [category, tpls]}
          <div class="template-group">
            <h3 class="group-title">{formatCategory(category)}</h3>
            <div class="template-cards">
              {#each tpls as tpl (tpl.slug)}
                <button
                  class="template-card"
                  class:selected={selectedTemplate?.slug === tpl.slug}
                  onclick={() => selectTemplate(tpl)}
                >
                  <div class="card-header">
                    <span class="card-name">{tpl.name}</span>
                    {#if tpl.is_official}
                      <span class="badge official">Official</span>
                    {/if}
                  </div>
                  <p class="card-desc">{tpl.description}</p>
                  <div class="card-meta">
                    <span class="meta-item">{(typeof tpl.steps === 'string' ? JSON.parse(tpl.steps) : tpl.steps).length} steps</span>
                    {#if tpl.industry}
                      <span class="meta-item">{tpl.industry}</span>
                    {/if}
                  </div>
                </button>
              {/each}
            </div>
          </div>
        {:else}
          <p class="no-results">No templates match your search.</p>
        {/each}
      </div>

      <!-- Right: template detail / create form -->
      <div class="detail-panel">
        {#if selectedTemplate}
          <div class="detail-card card">
            <h2>{selectedTemplate.name}</h2>
            <p class="detail-desc">{selectedTemplate.description}</p>

            <div class="detail-section">
              <h4>Plain language description</h4>
              <p class="plain-language">{selectedTemplate.plain_language}</p>
            </div>

            <div class="detail-section">
              <h4>Steps ({(typeof selectedTemplate.steps === 'string' ? JSON.parse(selectedTemplate.steps) : selectedTemplate.steps).length})</h4>
              <div class="steps-list">
                {#each (typeof selectedTemplate.steps === 'string' ? JSON.parse(selectedTemplate.steps) : selectedTemplate.steps) as step, i}
                  <div class="step-item">
                    <span class="step-num">{i + 1}</span>
                    <span class="step-type">{step.type}</span>
                    <span class="step-id">{step.id}</span>
                  </div>
                {/each}
              </div>
            </div>

            {#if selectedTemplate.required_sheet_columns?.length}
              <div class="detail-section">
                <h4>Required sheet columns</h4>
                <div class="columns-list">
                  {#each selectedTemplate.required_sheet_columns as col}
                    <span class="column-tag">{col}</span>
                  {/each}
                </div>
              </div>
            {/if}

            {#if selectedTemplate.voice_examples}
              <div class="detail-section">
                <h4>Voice example</h4>
                <p class="voice-example">"{selectedTemplate.voice_examples}"</p>
              </div>
            {/if}

            {#if !showCreateForm}
              <button class="btn btn-primary use-btn" onclick={() => startCreate(selectedTemplate!)}>
                Use this template
              </button>
            {:else}
              <div class="create-form">
                <h4>Set up your playbook</h4>
                <label class="form-label">
                  Name
                  <input type="text" bind:value={createName} class="form-input" />
                </label>
                <label class="form-label">
                  Category
                  <select bind:value={createCategoryId} class="form-input">
                    {#each categories as cat}
                      <option value={cat.id}>{cat.name}</option>
                    {/each}
                  </select>
                </label>
                {#if categories.length === 0}
                  <p class="text-muted">No categories found. Create one first in the Categories page.</p>
                {/if}
                <div class="form-actions">
                  <button
                    class="btn btn-primary"
                    onclick={createFromTemplate}
                    disabled={creating || !createCategoryId}
                  >
                    {creating ? "Creating…" : "Create Playbook"}
                  </button>
                  <button class="btn btn-secondary" onclick={() => { showCreateForm = false; }}>
                    Cancel
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {:else}
          <div class="detail-empty card">
            <p>Select a template to preview it, or start from scratch.</p>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .page { max-width: 1400px; margin: 0 auto; padding: 2rem; }
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1.5rem;
  }
  .header-left { display: flex; flex-direction: column; gap: 0.25rem; }
  .back-link { color: var(--text-muted, #6b7280); text-decoration: none; font-size: 0.875rem; }
  .back-link:hover { color: var(--text, #111); }
  h1 { font-size: 1.5rem; margin: 0; }

  .alert-error {
    background: #fef2f2; color: #b91c1c; padding: 0.75rem 1rem;
    border-radius: 8px; margin-bottom: 1rem; border: 1px solid #fecaca;
  }
  .loading { text-align: center; padding: 3rem; color: var(--text-muted, #6b7280); }

  .layout { display: grid; grid-template-columns: 1fr 420px; gap: 1.5rem; align-items: start; }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }

  .filters { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .search-input {
    flex: 1; min-width: 200px; padding: 0.5rem 0.75rem;
    border: 1px solid var(--border, #e5e7eb); border-radius: 6px; font-size: 0.875rem;
  }
  .filters select {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border, #e5e7eb); border-radius: 6px; font-size: 0.875rem;
  }

  .template-group { margin-bottom: 1.5rem; }
  .group-title {
    font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-muted, #6b7280); margin: 0 0 0.5rem; padding-left: 0.25rem;
  }
  .template-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.75rem; }

  .template-card {
    text-align: left; cursor: pointer; padding: 1rem; border-radius: 8px;
    border: 1px solid var(--border, #e5e7eb); background: var(--card, #fff);
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .template-card:hover { border-color: var(--primary, #2563eb); }
  .template-card.selected {
    border-color: var(--primary, #2563eb);
    box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
  }
  .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.375rem; }
  .card-name { font-weight: 600; font-size: 0.9375rem; }
  .badge.official {
    font-size: 0.6875rem; padding: 0.125rem 0.5rem; border-radius: 999px;
    background: #dbeafe; color: #1d4ed8;
  }
  .card-desc { font-size: 0.8125rem; color: var(--text-muted, #6b7280); margin: 0 0 0.5rem; line-height: 1.4; }
  .card-meta { display: flex; gap: 0.75rem; font-size: 0.75rem; color: var(--text-muted, #9ca3af); }

  .no-results { text-align: center; padding: 2rem; color: var(--text-muted, #6b7280); }

  /* Detail panel */
  .detail-panel { position: sticky; top: 1rem; }
  .detail-card, .detail-empty { padding: 1.5rem; }
  .card {
    border: 1px solid var(--border, #e5e7eb); border-radius: 8px;
    background: var(--card, #fff);
  }
  .detail-empty { text-align: center; color: var(--text-muted, #6b7280); }
  .detail-card h2 { margin: 0 0 0.5rem; font-size: 1.25rem; }
  .detail-desc { color: var(--text-muted, #6b7280); margin: 0 0 1rem; font-size: 0.9375rem; line-height: 1.5; }

  .detail-section { margin-bottom: 1rem; }
  .detail-section h4 { font-size: 0.8125rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted, #6b7280); margin: 0 0 0.375rem; }
  .plain-language { font-size: 0.875rem; line-height: 1.5; margin: 0; background: #f9fafb; padding: 0.75rem; border-radius: 6px; }

  .steps-list { display: flex; flex-direction: column; gap: 0.25rem; }
  .step-item {
    display: flex; align-items: center; gap: 0.5rem;
    font-size: 0.8125rem; padding: 0.25rem 0;
  }
  .step-num {
    width: 1.5rem; height: 1.5rem; border-radius: 50%; display: flex;
    align-items: center; justify-content: center; font-size: 0.6875rem;
    background: #f3f4f6; color: var(--text-muted, #6b7280); flex-shrink: 0;
  }
  .step-type { font-weight: 500; }
  .step-id { color: var(--text-muted, #9ca3af); font-size: 0.75rem; }

  .columns-list { display: flex; flex-wrap: wrap; gap: 0.375rem; }
  .column-tag {
    font-size: 0.75rem; padding: 0.25rem 0.625rem; border-radius: 999px;
    background: #fef3c7; color: #92400e;
  }

  .voice-example { font-style: italic; font-size: 0.875rem; color: var(--text-muted, #6b7280); margin: 0; }

  .use-btn { width: 100%; margin-top: 1rem; }

  .create-form { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border, #e5e7eb); }
  .create-form h4 { margin: 0 0 0.75rem; }
  .form-label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.75rem; }
  .form-input { display: block; width: 100%; margin-top: 0.25rem; padding: 0.5rem 0.75rem; border: 1px solid var(--border, #e5e7eb); border-radius: 6px; font-size: 0.875rem; }
  .form-actions { display: flex; gap: 0.5rem; margin-top: 1rem; }

  /* Shared button styles */
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.875rem;
    font-weight: 500; cursor: pointer; border: none; transition: background 0.15s;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--primary, #2563eb); color: #fff; }
  .btn-primary:hover:not(:disabled) { background: #1d4ed8; }
  .btn-secondary { background: var(--card, #fff); color: var(--text, #111); border: 1px solid var(--border, #e5e7eb); }
  .btn-secondary:hover:not(:disabled) { background: #f9fafb; }
  .text-muted { color: var(--text-muted, #6b7280); font-size: 0.8125rem; }
</style>
