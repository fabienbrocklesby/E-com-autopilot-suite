<!--
  /playbooks - Categories & Playbooks (merged view)
  Each category is a row. Its playbook status is shown inline.
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fly, fade } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { playbooksApi, categoriesApi } from "$lib/api";
  import { workspaceStore } from "$lib/stores";
  import type { Playbook, Category } from "$lib/api";
  import { ClipboardList, Trash2, CheckCircle, RefreshCw } from '@lucide/svelte';
  import { openSSE } from "$lib/sse";

  const prefersReducedMotion =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

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
  let mounted = $state(false);
  let graduationBanner = $state<string | null>(null);

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

  // Merge: each category gets its playbook.
  let rows = $derived.by<CategoryRow[]>(() => {
    return categories.map((cat) => {
      const playbook = playbooks.find((p) => p.category_id === cat.id) ?? null;
      return { category: cat, playbook };
    });
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

  async function deletePlaybook(pb: Playbook) {
    if (!confirm(`Delete playbook "${pb.name}"? This cannot be undone.`)) return;
    error = null;
    try {
      await playbooksApi.delete(pb.id);
      flash("Playbook deleted.");
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to delete";
    }
  }

  async function revertToDraft(pb: Playbook) {
    if (!confirm(`Revert "${pb.name}" to draft-only? This resets its approval streak to 0.`)) return;
    error = null;
    try {
      await playbooksApi.revertToDraft(pb.id);
      flash("Reverted to draft-only.");
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to revert";
    }
  }

  function flash(msg: string) {
    success = msg;
    setTimeout(() => { success = null; }, 3000);
  }

  // Deterministic color per category based on id
  const CAT_PALETTE = [
    "#f97316", "#3b82f6", "#a855f7", "#10b981",
    "#64748b", "#f59e0b", "#ec4899", "#22d3ee",
  ];

  function catColor(id: number): string {
    return CAT_PALETTE[(id - 1) % CAT_PALETTE.length];
  }

  onMount(() => {
    load();
    mounted = true;
  });

  $effect(() => {
    const wsId = currentWorkspaceId;
    const es = openSSE('workspace', { workspace_id: wsId });

    es.addEventListener('playbook_graduated', (e: Event) => {
      const { playbook } = JSON.parse((e as MessageEvent).data) as {
        playbook: { id: number; name: string };
      };
      graduationBanner = `"${playbook.name}" graduated to auto-send after a clean approval streak.`;
      setTimeout(() => { graduationBanner = null; }, 8000);
      load();
    });

    return () => es.close();
  });
</script>

<svelte:head>
  <title>Playbooks - Autopilot</title>
</svelte:head>

<div class="page-header">
  <h1>Playbooks</h1>
  <div class="header-actions">
    <a href="/categories" class="btn btn-ghost">Manage Categories</a>
  </div>
</div>

{#if error}
  <div class="error-banner">{error}</div>
{/if}
{#if success}
  <div class="success-banner" transition:fade={{ duration: 150 }}>{success}</div>
{/if}
{#if graduationBanner}
  <div class="graduation-banner" transition:fade={{ duration: 150 }}>
    <CheckCircle size={16} /> {graduationBanner}
  </div>
{/if}

{#if loading}
  <div class="skeleton-list">
    {#each Array.from({ length: 4 }) as _, i (i)}
      <div class="skeleton-row card" style="animation-delay: {i * 0.06}s">
        <div class="skeleton-col">
          <div class="skeleton skeleton-cat-name"></div>
          <div class="skeleton skeleton-cat-desc"></div>
          <div class="skeleton skeleton-cat-chips"></div>
        </div>
        <div class="skeleton skeleton-pb-col"></div>
      </div>
    {/each}
  </div>
{:else if categories.length === 0}
  <div class="empty-state">
    <div class="empty-icon"><ClipboardList size={40} strokeWidth={1.5} /></div>
    <p>No categories yet. Categories define email types. Playbooks automate how each type is handled.</p>
    <a href="/categories" class="btn btn-primary">Create First Category</a>
  </div>
{:else}
  <div class="category-list">
    {#each rows as row, i (row.category.id)}
      <div
        class="category-row card"
        in:fly={{
          y: prefersReducedMotion ? 0 : 6,
          duration: prefersReducedMotion ? 50 : 140,
          delay: mounted ? 0 : i * 30,
          easing: cubicOut,
        }}
      >
        <div class="cat-main">
          <div class="cat-info">
            <h2>
              <span class="cat-color-dot" style="background: {catColor(row.category.id)}"></span>
              {row.category.name}
            </h2>
            {#if row.category.description}
              <p class="cat-desc">{row.category.description}</p>
            {/if}
          </div>

          <div class="playbook-col">
            {#if row.playbook}
              <div class="pb-info">
                <a href="/playbooks/{row.playbook.id}" class="pb-name">{row.playbook.name}</a>
                <div class="pb-meta">
                  {row.playbook.steps.length} step{row.playbook.steps.length !== 1 ? "s" : ""}
                  · {row.playbook.reply_mode === 'auto_reply' ? 'Auto-reply' : 'Draft only'}
                  · min {Math.round((row.playbook.confidence_threshold ?? 0.8) * 100)}% confidence
                </div>
              </div>
              <div class="pb-actions">
                <span class="status-dot" class:active={row.playbook.is_active} class:inactive={!row.playbook.is_active}></span>
                {#if row.playbook.reply_mode === 'draft_only'}
                  <span class="streak-badge" title="Consecutive clean approvals before auto-send">
                    {row.playbook.approval_streak}/{row.playbook.auto_send_streak_target} clean approvals
                  </span>
                {:else}
                  <span class="streak-badge streak-badge-graduated">
                    <CheckCircle size={12} /> Auto-send
                  </span>
                  <button class="btn-action" onclick={() => revertToDraft(row.playbook!)}>
                    <RefreshCw size={12} /> Revert to draft
                  </button>
                {/if}
                <button class="btn-action" onclick={() => toggleActive(row.playbook!)}>
                  {row.playbook.is_active ? "Deactivate" : "Activate"}
                </button>
                <a href="/playbooks/{row.playbook.id}" class="btn-action">Edit</a>
                <button class="btn-action danger" onclick={() => deletePlaybook(row.playbook!)} title="Delete playbook">
                  <Trash2 size={13} />
                </button>
              </div>
            {:else}
              <div class="no-playbook">
                <span class="text-muted">No playbook</span>
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>

{/if}

<style>
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
  }

  h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }

  .header-actions {
    display: flex;
    gap: 8px;
  }

  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--color-text-muted);
  }
  .empty-icon { margin-bottom: 12px; color: var(--color-text-muted); }

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
    .playbook-col {
      min-width: unset;
      width: 100%;
      justify-content: flex-start;
      flex-wrap: wrap;
    }
    .no-playbook {
      justify-content: flex-start;
    }
    .skeleton-pb-col {
      width: 100%;
    }
  }

  .cat-info {
    flex: 1;
    min-width: 0;
  }

  h2 { font-size: 14px; font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }

  .cat-color-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    display: inline-block;
  }

  .cat-desc { font-size: 12.5px; color: var(--color-text-muted); margin-bottom: 8px; padding-left: 18px; }

  .playbook-col {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
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

  .streak-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .streak-badge-graduated {
    color: var(--color-success);
    font-weight: 600;
  }

  .graduation-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(16 185 129 / 0.1);
    border: 1px solid rgba(16 185 129 / 0.3);
    border-radius: var(--radius);
    color: var(--color-success);
    padding: 12px 16px;
    margin-bottom: 16px;
    font-size: 13px;
    font-weight: 500;
  }

  .btn-action {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    text-decoration: none;
    white-space: nowrap;
    transition: background 0.12s ease, color 0.12s ease, transform 0.1s ease;
  }
  .btn-action:hover { background: var(--color-surface-2); color: var(--color-text); }
  .btn-action:active { transform: scale(0.97); }
  .btn-action.danger { border-color: var(--color-danger); color: var(--color-danger); }
  .btn-action.danger:hover { background: rgba(239 68 68 / 0.1); }

  .no-playbook {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    width: 100%;
  }

  .text-muted { color: var(--color-text-muted); font-size: 13px; }

  .skeleton-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .skeleton-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    padding: 16px 20px;
  }
  .skeleton-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .skeleton-cat-name {
    height: 15px;
    width: 40%;
  }
  .skeleton-cat-desc {
    height: 12px;
    width: 65%;
    opacity: 0.7;
  }
  .skeleton-cat-chips {
    height: 10px;
    width: 30%;
    opacity: 0.5;
  }
  .skeleton-pb-col {
    height: 32px;
    width: 200px;
    flex-shrink: 0;
    opacity: 0.6;
    border-radius: var(--radius);
  }
</style>
