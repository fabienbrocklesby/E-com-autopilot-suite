<!--
  / — Inbox: unified thread dashboard with urgency grouping
  Groups: Needs attention → In progress → Other
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { threadsApi } from "$lib/api";
  import { threadsStore, workspaceStore } from "$lib/stores";
  import type { ThreadListItem } from "$lib/api";

  type UrgencyGroup = "attention" | "progress" | "other";
  interface GroupedSection {
    key: UrgencyGroup;
    label: string;
    threads: ThreadListItem[];
    defaultOpen: boolean;
  }

  let threads = $state<ThreadListItem[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let currentWorkspaceId = $state(1);
  let selectedIdx = $state(-1);
  let collapsedGroups = $state<Record<UrgencyGroup, boolean>>({ attention: false, progress: false, other: true });

  const unsubWs = workspaceStore.subscribe((id) => {
    currentWorkspaceId = id;
    loadThreads();
  });

  onDestroy(() => unsubWs());

  function classifyThread(t: ThreadListItem): UrgencyGroup {
    // Needs attention: pending human action, draft waiting for review, or new uncategorised
    if (t.has_pending_action) return "attention";
    if (t.status === "in_review") return "attention";
    if (t.draft_count > 0 && t.status === "new") return "attention";

    // In progress: has an active playbook run
    if (t.latest_run_status && ["running", "waiting_for_customer", "paused"].includes(t.latest_run_status)) return "progress";
    if (t.status === "new" && t.category_id) return "progress";

    return "other";
  }

  let grouped = $derived.by<GroupedSection[]>(() => {
    const buckets: Record<UrgencyGroup, ThreadListItem[]> = { attention: [], progress: [], other: [] };
    for (const t of threads) {
      buckets[classifyThread(t)].push(t);
    }
    return [
      { key: "attention", label: "Needs attention", threads: buckets.attention, defaultOpen: true },
      { key: "progress", label: "In progress", threads: buckets.progress, defaultOpen: true },
      { key: "other", label: "Other", threads: buckets.other, defaultOpen: false },
    ];
  });

  // Flat list for keyboard navigation
  let flatThreads = $derived.by<ThreadListItem[]>(() => {
    const result: ThreadListItem[] = [];
    for (const g of grouped) {
      if (!collapsedGroups[g.key]) result.push(...g.threads);
    }
    return result;
  });

  async function loadThreads() {
    loading = true;
    error = null;
    try {
      const res = await threadsApi.list({ workspaceId: currentWorkspaceId });
      threads = res.threads;
      threadsStore.update((s) => ({ ...s, items: res.threads }));
      selectedIdx = -1;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load threads";
    } finally {
      loading = false;
    }
  }

  function toggleGroup(key: UrgencyGroup) {
    collapsedGroups = { ...collapsedGroups, [key]: !collapsedGroups[key] };
    selectedIdx = -1;
  }

  function handleKeydown(event: KeyboardEvent) {
    const flat = flatThreads;
    if (!flat.length) return;

    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, flat.length - 1);
    } else if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
    } else if (event.key === "Enter" && selectedIdx >= 0) {
      event.preventDefault();
      goto(`/threads/${flat[selectedIdx].id}`);
    } else if (event.key === "Escape") {
      selectedIdx = -1;
    }
  }

  function relativeTime(dateStr: string): string {
    const d = new Date(dateStr);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  }

  function runProgressLabel(t: ThreadListItem): string {
    if (!t.latest_run_status) return "";
    if (t.latest_run_status === "waiting_for_human") return "Waiting for you";
    if (t.latest_run_status === "waiting_for_customer") return "Waiting for customer";
    if (t.latest_run_status === "running") {
      if (t.latest_run_completed_steps != null && t.latest_run_total_steps != null) {
        return `Step ${t.latest_run_completed_steps + 1}/${t.latest_run_total_steps}`;
      }
      return "Running";
    }
    if (t.latest_run_status === "completed") return "Completed";
    if (t.latest_run_status === "failed") return "Failed";
    return t.latest_run_status;
  }

  function urgencyIcon(key: UrgencyGroup): string {
    if (key === "attention") return "🔴";
    if (key === "progress") return "🟡";
    return "⚪";
  }

  onMount(() => {
    loadThreads();
  });
</script>

<svelte:head>
  <title>Inbox — Autopilot</title>
</svelte:head>

<svelte:window on:keydown={handleKeydown} />

<div class="page-header">
  <h1>Inbox</h1>
  <div class="header-actions">
    <span class="thread-count">{threads.length} thread{threads.length !== 1 ? "s" : ""}</span>
    <button class="btn btn-ghost" onclick={loadThreads}>↻ Refresh</button>
  </div>
</div>

{#if error}
  <div class="error-banner">{error}</div>
{/if}

{#if loading}
  <div class="loading">Loading threads…</div>
{:else if threads.length === 0}
  <div class="empty-state">
    <div class="empty-icon">📭</div>
    <p>No threads yet. Connect Gmail in Settings to start.</p>
  </div>
{:else}
  {#each grouped as group (group.key)}
    {#if group.threads.length > 0}
      <section class="thread-group">
        <button class="group-header" onclick={() => toggleGroup(group.key)}>
          <span class="group-indicator">{urgencyIcon(group.key)}</span>
          <span class="group-label">{group.label}</span>
          <span class="group-count">{group.threads.length}</span>
          <span class="group-chevron" class:collapsed={collapsedGroups[group.key]}>▾</span>
        </button>

        {#if !collapsedGroups[group.key]}
          <ul class="thread-list">
            {#each group.threads as thread, i (thread.id)}
              {@const flatIdx = (() => {
                let offset = 0;
                for (const g of grouped) {
                  if (g.key === group.key) return offset + i;
                  if (!collapsedGroups[g.key]) offset += g.threads.length;
                }
                return -1;
              })()}
              <li>
                <a
                  href="/threads/{thread.id}"
                  class="thread-row"
                  class:selected={selectedIdx === flatIdx}
                  class:unread={thread.status === "new"}
                >
                  <div class="thread-main">
                    <div class="thread-top">
                      <span class="thread-subject">{thread.subject || "(no subject)"}</span>
                      {#if thread.has_pending_action}
                        <span class="action-badge" title="Action required">Action required</span>
                      {/if}
                      {#if thread.draft_count > 0}
                        <span class="draft-badge" title="Draft ready">Draft</span>
                      {/if}
                    </div>
                    <div class="thread-meta">
                      {#if thread.category_name}
                        <span class="category-tag">{thread.category_name}</span>
                      {/if}
                      {#if thread.latest_run_playbook_name}
                        <span class="run-info">
                          {thread.latest_run_playbook_name}
                          {#if runProgressLabel(thread)}
                            <span class="run-step">· {runProgressLabel(thread)}</span>
                          {/if}
                        </span>
                      {/if}
                      <span class="thread-snippet">{thread.snippet}</span>
                    </div>
                  </div>
                  <div class="thread-side">
                    <span class="thread-time">{relativeTime(thread.created_at)}</span>
                    <span class="badge badge-{thread.status}">{thread.status.replace("_", " ")}</span>
                  </div>
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/each}
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

  .header-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .thread-count {
    font-size: 13px;
    color: var(--color-text-muted);
  }

  .loading,
  .empty-state {
    color: var(--color-text-muted);
    padding: 60px 20px;
    text-align: center;
  }

  .empty-icon {
    font-size: 40px;
    margin-bottom: 12px;
  }

  .thread-group {
    margin-bottom: 8px;
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    color: var(--color-text-muted);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
    border-radius: var(--radius);
    transition: background 0.15s;
  }

  .group-header:hover {
    background: var(--color-surface);
  }

  .group-count {
    background: var(--color-surface-2);
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
  }

  .group-chevron {
    margin-left: auto;
    transition: transform 0.15s;
    font-size: 13px;
  }

  .group-chevron.collapsed {
    transform: rotate(-90deg);
  }

  .thread-list {
    list-style: none;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .thread-list li + li {
    border-top: 1px solid var(--color-border);
  }

  .thread-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 16px;
    color: var(--color-text);
    transition: background 0.1s;
    text-decoration: none;
  }

  .thread-row:hover {
    background: var(--color-surface);
  }

  .thread-row.selected {
    background: rgba(99 102 241 / 0.1);
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
    border-radius: 2px;
  }

  .thread-row.unread .thread-subject {
    font-weight: 600;
  }

  .thread-main {
    flex: 1;
    min-width: 0;
  }

  .thread-top {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .thread-subject {
    font-size: 14px;
    font-weight: 500;
  }

  .action-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(245 158 11 / 0.2);
    color: var(--color-warning);
  }

  .draft-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(99 102 241 / 0.15);
    color: var(--color-primary);
  }

  .thread-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    font-size: 12px;
    color: var(--color-text-muted);
    overflow: hidden;
  }

  .category-tag {
    flex-shrink: 0;
    background: rgba(99 102 241 / 0.12);
    color: var(--color-primary);
    padding: 1px 7px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
  }

  .run-info {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--color-text-muted);
  }

  .run-step {
    color: var(--color-text-muted);
    opacity: 0.7;
  }

  .thread-snippet {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .thread-side {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
  }

  .thread-time {
    font-size: 11px;
    color: var(--color-text-muted);
    white-space: nowrap;
  }
</style>
