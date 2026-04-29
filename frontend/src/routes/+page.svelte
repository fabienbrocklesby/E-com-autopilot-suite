<!--
  / - Inbox: unified thread dashboard with urgency grouping
  Groups: Needs attention → In progress → Other
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { goto } from "$app/navigation";
  import { threadsApi } from "$lib/api";
  import { threadsStore, workspaceStore } from "$lib/stores";
  import type { ThreadListItem } from "$lib/api";
  import { Inbox, RefreshCw } from '@lucide/svelte';
  import { openSSE } from "$lib/sse";

  // Detect reduced-motion preference once at init so stagger can respect it.
  // Svelte transitions are JS-driven, so CSS media queries alone can't suppress them.
  const prefersReducedMotion =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

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

  // After the first mount, stagger delay drops to 0 so re-fetches feel instant.
  let mounted = $state(false);

  const unsubWs = workspaceStore.subscribe((id) => {
    currentWorkspaceId = id;
    loadThreads();
  });

  onDestroy(() => unsubWs());

  function classifyThread(t: ThreadListItem): UrgencyGroup {
    if (t.has_pending_action) return "attention";
    if (t.latest_run_status === "waiting_for_human") return "attention";

    const runIsActive = t.latest_run_status != null &&
      ["running", "waiting_for_customer", "retrying"].includes(t.latest_run_status);
    if (runIsActive) return "progress";

    if (t.status === "in_review") return "attention";
    if (t.draft_count > 0 && t.status === "new") return "attention";

    if (t.status === "new" && t.category_id) return "progress";

    return "other";
  }

  let grouped = $derived.by<GroupedSection[]>(() => {
    const buckets: Record<UrgencyGroup, ThreadListItem[]> = { attention: [], progress: [], other: [] };
    for (const t of threads) {
      buckets[classifyThread(t)].push(t);
    }
    return [
      { key: "attention", label: "Needs your attention", threads: buckets.attention, defaultOpen: true },
      { key: "progress", label: "In progress", threads: buckets.progress, defaultOpen: true },
      { key: "other", label: "Other / Noise", threads: buckets.other, defaultOpen: false },
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

  function urgencyColor(key: UrgencyGroup): string {
    if (key === "attention") return "var(--color-danger)";
    if (key === "progress") return "var(--color-warning)";
    return "var(--color-text-3, var(--color-text-muted))";
  }

  function threadDotColor(t: ThreadListItem, groupKey: UrgencyGroup): string {
    if (t.latest_run_status === "waiting_for_human") return "var(--color-orange)";
    if (t.latest_run_status === "failed" || t.latest_run_status === "escalated") return "var(--color-danger)";
    if (t.latest_run_status === "running") return "var(--color-primary)";
    if (t.latest_run_status === "waiting_for_customer") return "var(--color-info)";
    if (groupKey === "attention") return "var(--color-danger)";
    if (groupKey === "progress") return "var(--color-warning)";
    return "var(--color-text-3, var(--color-text-muted))";
  }

  onMount(() => {
    loadThreads();
    mounted = true;
  });

  $effect(() => {
    const wsId = currentWorkspaceId;
    let connectionCount = 0;
    const es = openSSE('workspace', { workspace_id: wsId });

    es.addEventListener('open', () => {
      connectionCount++;
      if (connectionCount > 1) loadThreads();
    });

    es.addEventListener('thread_created', (e: Event) => {
      const { thread } = JSON.parse((e as MessageEvent).data) as { thread: ThreadListItem };
      if (!threads.find((t) => t.id === thread.id)) threads = [thread, ...threads];
    });

    es.addEventListener('thread_updated', (e: Event) => {
      const { thread } = JSON.parse((e as MessageEvent).data) as { thread: ThreadListItem };
      const exists = threads.some((t) => t.id === thread.id);
      threads = exists ? threads.map((t) => (t.id === thread.id ? thread : t)) : [thread, ...threads];
    });

    es.addEventListener('run_updated', (e: Event) => {
      const { threadId, run } = JSON.parse((e as MessageEvent).data) as {
        threadId: number;
        run: { id: number; status: string };
      };
      threads = threads.map((t) => {
        if (t.id !== threadId) return t;
        if (t.latest_run_id != null && t.latest_run_id !== run.id) return t;
        return {
          ...t,
          latest_run_id: run.id,
          latest_run_status: run.status,
          has_pending_action: run.status === 'waiting_for_human',
        };
      });
    });

    return () => es.close();
  });
</script>

<svelte:head>
  <title>Inbox - Autopilot</title>
</svelte:head>

<svelte:window on:keydown={handleKeydown} />

<div class="page-header">
  <div class="header-title">
    <h1>Inbox</h1>
    {#if !loading}
      {@const attentionThreads = grouped.find(g => g.key === "attention")?.threads.length ?? 0}
      {#if attentionThreads > 0}
        <span class="attention-subtitle">{attentionThreads} thread{attentionThreads !== 1 ? "s" : ""} need your attention</span>
      {/if}
    {/if}
  </div>
  <div class="header-actions">
    <button class="btn btn-ghost" onclick={loadThreads}><RefreshCw size={14} /> Refresh</button>
  </div>
</div>

{#if error}
  <div class="error-banner">{error}</div>
{/if}

{#if loading}
  <div class="skeleton-list" aria-busy="true" aria-label="Loading threads">
    {#each Array.from({ length: 6 }) as _, i}
      <div class="skeleton-row" style="animation-delay: {i * 0.06}s">
        <div class="skeleton-col">
          <div class="skeleton skeleton-subject"></div>
          <div class="skeleton skeleton-meta"></div>
        </div>
        <div class="skeleton skeleton-time"></div>
      </div>
    {/each}
  </div>
{:else if threads.length === 0}
  <div class="empty-state">
    <div class="empty-icon"><Inbox size={40} strokeWidth={1.5} /></div>
    <p>No threads yet. Connect Gmail in Settings to start.</p>
  </div>
{:else}
  {#each grouped as group (group.key)}
    {#if group.threads.length > 0}
      <section class="thread-group">
        <button class="group-header" onclick={() => toggleGroup(group.key)}>
          <span class="group-indicator" style="background: {urgencyColor(group.key)}"></span>
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
              {@const dotColor = threadDotColor(thread, group.key)}
              {@const isPulse = group.key === "attention"}
              <li
                in:fly={{
                  y: prefersReducedMotion ? 0 : 6,
                  duration: prefersReducedMotion ? 50 : 140,
                  delay: mounted ? 0 : i * 28,
                  easing: cubicOut,
                }}
              >
                <a
                  href="/threads/{thread.id}"
                  class="thread-row"
                  class:selected={selectedIdx === flatIdx}
                  class:unread={thread.status === "new"}
                >
                  <span class="thread-dot" class:pulse={isPulse} style="color: {dotColor}">
                    {#if isPulse}<span class="dot-ring"></span>{/if}
                    <span class="dot-fill"></span>
                  </span>
                  <div class="thread-main">
                    <div class="thread-top">
                      <span class="thread-subject">{thread.subject || "(no subject)"}</span>
                      {#if thread.latest_run_status === "waiting_for_human" || thread.has_pending_action}
                        <span class="action-badge">Action needed</span>
                      {/if}
                      {#if thread.latest_run_status === "failed"}
                        <span class="failed-badge">Failed</span>
                      {/if}
                      {#if thread.status === "in_review" && !thread.has_pending_action && thread.latest_run_status !== "failed"}
                        <span class="review-badge">Review</span>
                      {/if}
                      {#if thread.draft_count > 0 && thread.latest_run_status !== "waiting_for_human" && !thread.has_pending_action}
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
                      {:else}
                        <span class="thread-snippet">{thread.snippet}</span>
                      {/if}
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
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .header-title {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .attention-subtitle {
    font-size: 12px;
    color: var(--color-danger);
    font-weight: 500;
  }

  .loading,
  .empty-state {
    color: var(--color-text-muted);
    padding: 60px 20px;
    text-align: center;
  }

  .empty-icon {
    margin-bottom: 12px;
    color: var(--color-text-muted);
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
    background: var(--color-surface-2);
  }

  .group-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
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
	margin-top: 2vh;
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
    gap: 14px;
    padding: 13px 18px;
    color: var(--color-text);
    transition: background 0.1s;
    text-decoration: none;
  }

  /* Status dot */
  .thread-dot {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 10px;
    height: 10px;
    flex-shrink: 0;
    margin-top: 5px;
  }

  .dot-fill {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: currentColor;
    display: block;
  }

  .dot-ring {
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.25;
  }

  @keyframes dot-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.5; } }

  .thread-dot.pulse .dot-ring {
    animation: dot-pulse 2s infinite;
  }

  .thread-row:hover {
    background: var(--color-surface-2);
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
    font-size: 13.5px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .action-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 4px;
    background: var(--color-orange-dim);
    color: var(--color-orange);
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .failed-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 4px;
    background: var(--color-danger-dim);
    color: var(--color-danger);
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .review-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 4px;
    background: var(--color-warning-dim);
    color: var(--color-warning);
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .draft-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 4px;
    background: var(--color-primary-dim);
    color: var(--color-primary);
    letter-spacing: 0.03em;
    flex-shrink: 0;
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

  /* ------------------------------------------------------------------ */
  /* Loading skeleton                                                     */
  /* ------------------------------------------------------------------ */
  .skeleton-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .skeleton-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 13px 16px;
    border-bottom: 1px solid var(--color-border);
  }
  .skeleton-row:last-child {
    border-bottom: none;
  }

  .skeleton-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* .skeleton base is provided globally via +layout.svelte */
  .skeleton-subject {
    height: 14px;
    width: 55%;
  }
  .skeleton-meta {
    height: 11px;
    width: 35%;
    opacity: 0.6;
  }
  .skeleton-time {
    height: 11px;
    width: 48px;
    flex-shrink: 0;
    opacity: 0.5;
  }

  /* ------------------------------------------------------------------ */
  /* Mobile responsive                                                    */
  /* ------------------------------------------------------------------ */
  @media (max-width: 767px) {
    .page-header {
      margin-bottom: 16px;
    }

    h1 {
      font-size: 18px;
    }

    .thread-row {
      padding: 12px 14px;
      gap: 10px;
    }

    /* Stack time/badge below subject on very small screens */
    .thread-side {
      flex-direction: row;
      align-items: center;
      gap: 6px;
    }

    .thread-subject {
      font-size: 13px;
    }

    .group-header {
      padding: 6px 10px;
      font-size: 11px;
    }
  }
</style>
