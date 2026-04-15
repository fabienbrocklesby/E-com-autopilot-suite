<!--
  /playbooks — Categories & Playbooks (merged view)
  Each category is a row. Its playbook status is shown inline.
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { playbooksApi, categoriesApi } from "$lib/api";
  import { workspaceStore } from "$lib/stores";
  import type { Playbook, Category } from "$lib/api";

  interface CategoryRow {
    category: Category;
    playbook: Playbook | null;
  }

  let playbooks = $state<Playbook[]>([]);
  let categories = $state<Category[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let success = $state<string | null>(null);
  let currentWorkspaceId = $state(1);

  const unsubWs = workspaceStore.subscribe((id) => {
    currentWorkspaceId = id;
    load();
  });

  onDestroy(() => unsubWs());

  async function load() {
    loading = true;
    error = null;
    try {
      const [pbRes, catRes] = await Promise.all([
        playbooksApi.list(currentWorkspaceId),
        categoriesApi.list(currentWorkspaceId),
      ]);
      playbooks = pbRes.playbooks;
      categories = catRes.categories;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load";
    } finally {
      loading = false;
    }
  }

  // Merge: each category gets its active playbook (or latest)
  let rows = $derived.by<CategoryRow[]>(() => {
    return categories.map((cat) => {
      const active = playbooks.find((p) => p.category_id === cat.id && p.is_active);
      const latest = active ?? playbooks.find((p) => p.category_id === cat.id) ?? null;
      return { category: cat, playbook: latest };
    });
  });

  // Orphan playbooks (no category)
  let orphanPlaybooks = $derived.by<Playbook[]>(() => {
    return playbooks.filter((p) => p.category_id === null);
  });

  async function toggleActive(pb: Playbook) {
    error = null;
    try {
      if (pb.is_active) {
        await playbooksApi.deactivate(pb.id);
        flash("Playbook deactivated.");
      } else {
        await playbooksApi.activate(pb.id);
        flash("Playbook activated.");
      }
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to toggle";
    }
  }

  function flash(msg: string) {
    success = msg;
    setTimeout(() => { success = null; }, 3000);
  }

  onMount(load);
</script>

<svelte:head>
  <title>Playbooks — Autopilot</title>
</svelte:head>

<div class="page-header">
  <h1>Playbooks</h1>
  <div class="header-actions">
    <a href="/categories" class="btn btn-ghost">Manage Categories</a>
    <a href="/playbooks/new" class="btn btn-primary">+ New Playbook</a>
  </div>
</div>

{#if error}
  <div class="error-banner">{error}</div>
{/if}
{#if success}
  <div class="success-banner">{success}</div>
{/if}

{#if loading}
  <div class="loading">Loading…</div>
{:else if categories.length === 0}
  <div class="empty-state">
    <div class="empty-icon">📋</div>
    <p>No categories yet. Categories define email types. Playbooks automate how each type is handled.</p>
    <a href="/categories" class="btn btn-primary">Create First Category</a>
  </div>
{:else}
  <div class="category-list">
    {#each rows as row (row.category.id)}
      <div class="category-row card">
        <div class="cat-main">
          <div class="cat-info">
            <h2>{row.category.name}</h2>
            {#if row.category.description}
              <p class="cat-desc">{row.category.description}</p>
            {/if}
            <div class="cat-chips">
              <span class="chip" class:enabled={row.category.allow_auto_reply}>
                Auto-reply {row.category.allow_auto_reply ? "on" : "off"}
              </span>
              <span class="chip">
                Threshold {Math.round(row.category.confidence_threshold * 100)}%
              </span>
            </div>
          </div>

          <div class="playbook-col">
            {#if row.playbook}
              <div class="pb-info">
                <a href="/playbooks/{row.playbook.id}" class="pb-name">{row.playbook.name}</a>
                <div class="pb-meta">
                  v{row.playbook.version} · {row.playbook.steps.length} step{row.playbook.steps.length !== 1 ? "s" : ""}
                </div>
              </div>
              <div class="pb-actions">
                <span class="status-dot" class:active={row.playbook.is_active} class:inactive={!row.playbook.is_active}></span>
                <button class="btn-action" onclick={() => toggleActive(row.playbook!)}>
                  {row.playbook.is_active ? "Deactivate" : "Activate"}
                </button>
                <a href="/playbooks/{row.playbook.id}" class="btn-action">Edit</a>
              </div>
            {:else}
              <div class="no-playbook">
                <span class="text-muted">No playbook</span>
                <a href="/playbooks/new?category_id={row.category.id}" class="btn-action primary">+ Create</a>
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>

  {#if orphanPlaybooks.length > 0}
    <div class="orphan-section">
      <h3>Unlinked Playbooks</h3>
      <p class="text-muted">These playbooks aren't attached to a category.</p>
      <div class="orphan-list">
        {#each orphanPlaybooks as pb (pb.id)}
          <div class="orphan-row card">
            <a href="/playbooks/{pb.id}" class="pb-name">{pb.name}</a>
            <span class="pb-meta">v{pb.version} · {pb.steps.length} steps</span>
            <span class="status-dot" class:active={pb.is_active} class:inactive={!pb.is_active}></span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
{/if}

<style>
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
  }

  h1 { font-size: 22px; font-weight: 700; }

  .header-actions {
    display: flex;
    gap: 8px;
  }

  .loading {
    color: var(--color-text-muted);
    padding: 40px;
    text-align: center;
  }

  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--color-text-muted);
  }
  .empty-icon { font-size: 40px; margin-bottom: 12px; }

  .success-banner {
    background: rgba(16 185 129 / 0.1);
    border: 1px solid rgba(16 185 129 / 0.3);
    border-radius: var(--radius);
    color: #6ee7b7;
    padding: 12px 16px;
    margin-bottom: 16px;
  }

  .category-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .category-row {
    padding: 16px 20px;
  }

  .cat-main {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
  }

  @media (max-width: 700px) {
    .cat-main { flex-direction: column; }
  }

  .cat-info {
    flex: 1;
    min-width: 0;
  }

  h2 { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
  .cat-desc { font-size: 13px; color: var(--color-text-muted); margin-bottom: 8px; }

  .cat-chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .chip {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--color-surface-2);
    color: var(--color-text-muted);
    font-weight: 500;
  }
  .chip.enabled { background: rgba(16 185 129 / 0.12); color: var(--color-success); }

  .playbook-col {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 280px;
  }

  .pb-info { flex: 1; }
  .pb-name {
    font-weight: 600;
    font-size: 13px;
    color: var(--color-text);
  }
  .pb-name:hover { color: var(--color-primary); }
  .pb-meta { font-size: 11px; color: var(--color-text-muted); margin-top: 2px; }

  .pb-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-dot.active { background: var(--color-success); }
  .status-dot.inactive { background: var(--color-text-muted); }

  .btn-action {
    background: none;
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    text-decoration: none;
    white-space: nowrap;
  }
  .btn-action:hover { background: var(--color-surface-2); color: var(--color-text); }
  .btn-action.primary { border-color: var(--color-primary); color: var(--color-primary); }
  .btn-action.primary:hover { background: rgba(99 102 241 / 0.1); }

  .no-playbook {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .text-muted { color: var(--color-text-muted); font-size: 13px; }

  .orphan-section {
    margin-top: 32px;
  }
  .orphan-section h3 { font-size: 14px; font-weight: 700; margin-bottom: 4px; }

  .orphan-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
  }

  .orphan-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
  }
</style>
