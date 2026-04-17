<!--
  /threads/[id] - Thread detail page
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { fly, fade } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { threadsApi, playbooksApi } from "$lib/api";
  import type { ThreadDetail, Draft, PlaybookRun, StepExecution } from "$lib/api";
  import ManualActionBanner from "$lib/components/ManualActionBanner.svelte";
  import ManualReplyPanel from "$lib/components/ManualReplyPanel.svelte";
  import { Zap } from '@lucide/svelte';

  const prefersReducedMotion =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  const threadId = parseInt($page.params.id ?? "0");
  let thread = $state<ThreadDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let success = $state<string | null>(null);
  let categorising = $state(false);

  // Playbook run observability
  let runs = $state<PlaybookRun[]>([]);
  let expandedRunId = $state<number | null>(null);
  let runDetail = $state<{ run: PlaybookRun; executions: StepExecution[] } | null>(null);
  let runDetailLoading = $state(false);

  // Active run waiting for human action - drives the banner.
  let waitingRun = $derived(runs.find((r) => r.status === "waiting_for_human") ?? null);

  async function loadRunDetail(runId: number) {
    if (expandedRunId === runId) {
      expandedRunId = null;
      runDetail = null;
      return;
    }
    expandedRunId = runId;
    runDetailLoading = true;
    try {
      runDetail = await playbooksApi.getRun(runId);
    } catch {
      runDetail = null;
    } finally {
      runDetailLoading = false;
    }
  }

  function runStatusColor(status: string): string {
    const map: Record<string, string> = {
      running: "#6366f1",
      waiting_for_customer: "#f59e0b",
      waiting_for_human: "#f97316",
      complete: "#10b981",
      failed: "#ef4444",
      escalated: "#ef4444",
    };
    return map[status] ?? "#64748b";
  }

  function stepStatusColor(status: string): string {
    const map: Record<string, string> = { success: "#10b981", failed: "#ef4444", running: "#6366f1", skipped: "#64748b", pending: "#64748b" };
    return map[status] ?? "#64748b";
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const [threadRes, runsRes] = await Promise.all([
        threadsApi.get(threadId),
        playbooksApi.listRuns({ thread_id: threadId }),
      ]);
      thread = threadRes.thread;
      runs = runsRes.runs;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load thread";
    } finally {
      loading = false;
    }
  }

  async function handleCategorise() {
    categorising = true;
    error = null;
    try {
      const res = await threadsApi.categorise(threadId);
      success = `Categorised with confidence ${Math.round(res.confidence * 100)}%.${res.draftCreated ? " Draft created." : ""}`;
      setTimeout(() => {
        success = null;
      }, 5000);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Categorisation failed";
    } finally {
      categorising = false;
    }
  }

  async function handleDraftAction(draftId: number, status: Draft["status"]) {
    try {
      await threadsApi.updateDraftStatus(threadId, draftId, status);
      success = `Draft ${status}.`;
      setTimeout(() => {
        success = null;
      }, 3000);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to update draft";
    }
  }

  async function handleStatusUpdate(newStatus: string) {
    try {
      await threadsApi.updateStatus(threadId, newStatus);
      if (thread) thread = { ...thread, status: newStatus };
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to update status";
    }
  }

  onMount(() => {
    load();
  });
</script>

<svelte:head>
  <title>{thread?.subject ?? "Thread"} - Autopilot</title>
</svelte:head>

<div class="page-header">
  <button class="back-btn" onclick={() => goto("/")}>← Back to Inbox</button>
  <div class="header-actions">
    <div class="status-pills">
      {#each ["new", "in_review", "replied", "ignored", "closed"] as s}
        <button
          class="status-btn"
          class:active={thread?.status === s}
          onclick={() => handleStatusUpdate(s)}
        >
          {s.replace("_", " ")}
        </button>
      {/each}
    </div>
    <button
      class="btn btn-ghost"
      onclick={handleCategorise}
      disabled={categorising}
    >
      {#if categorising}
        Categorising…
      {:else}
        <Zap size={14} /> Categorise
      {/if}
    </button>
  </div>
</div>

{#if error}
  <div class="error-banner" transition:fade={{ duration: 150 }}>{error}</div>
{/if}

{#if success}
  <div class="success-banner" transition:fade={{ duration: 150 }}>{success}</div>
{/if}

{#if waitingRun}
  <ManualActionBanner run={waitingRun} onComplete={load} />
{/if}

{#if loading}
  <div class="thread-skeleton">
    <div class="skeleton-header card">
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-badges"></div>
    </div>
    <div class="skeleton-messages">
      {#each Array.from({ length: 3 }) as _, i}
        <div class="skeleton-msg card" style="animation-delay: {i * 0.08}s">
          <div class="skeleton skeleton-msg-header"></div>
          <div class="skeleton skeleton-msg-body"></div>
          <div class="skeleton skeleton-msg-body-sm"></div>
        </div>
      {/each}
    </div>
  </div>
{:else if thread}
  <div class="thread-layout">
    <!-- LEFT: Conversation -->
    <div class="conversation-col">
      <div class="thread-subject-bar card">
        <h1>{thread.subject || "(no subject)"}</h1>
        <div class="thread-badges">
          <span class="badge badge-{thread.status}">{thread.status.replace("_", " ")}</span>
          {#if thread.category}
            <span class="category-tag">{thread.category.name}</span>
          {:else}
            <span class="text-muted">Uncategorised</span>
          {/if}
          {#if thread.auto_replied}
            <span class="auto-reply-badge">Auto-replied</span>
          {/if}
        </div>
      </div>

      <div class="messages-list">
        {#each thread.messages as message, i (message.id)}
          <div
            class="message card"
            class:outbound={message.direction === "outbound"}
            in:fly={{
              y: prefersReducedMotion ? 0 : 8,
              duration: prefersReducedMotion ? 50 : 150,
              delay: i * 35,
              easing: cubicOut,
            }}
          >
            <div class="message-header">
              <span class="from">{message.from_address}</span>
              <span class="direction-badge">{message.direction}</span>
              <span class="date">{new Date(message.received_at).toLocaleString()}</span>
            </div>
            <div class="message-body">{message.body_plain}</div>
          </div>
        {/each}
      </div>

      {#if thread.drafts.length > 0}
        <div class="drafts-section">
          <h3>Drafts ({thread.drafts.length})</h3>
          {#each thread.drafts as draft (draft.id)}
            <div class="draft card">
              <div class="draft-header">
                <span class="draft-status draft-{draft.status}">{draft.status}</span>
                <span class="date">{new Date(draft.created_at).toLocaleString()}</span>
              </div>
              <pre class="draft-body">{draft.body}</pre>
              {#if draft.status === "pending"}
                <div class="draft-actions">
                  <button class="btn btn-primary" onclick={() => handleDraftAction(draft.id, "approved")}>Approve & Send</button>
                  <button class="btn btn-ghost" onclick={() => handleDraftAction(draft.id, "rejected")}>Reject</button>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <ManualReplyPanel {threadId} onSent={load} />
    </div>

    <!-- RIGHT: Playbook & Context -->
    <div class="context-col">
      {#if runs.length > 0}
        <div class="sidebar-section">
          <h3>Playbook Runs</h3>
          {#each runs as run (run.id)}
            <div class="run-card card" class:run-expanded={expandedRunId === run.id}>
              <button class="run-header" onclick={() => loadRunDetail(run.id)}>
                <div class="run-title">
                  <span class="run-status-dot" style="background: {runStatusColor(run.status)}"></span>
                  <span class="run-name">{run.playbook_name ?? `Playbook #${run.playbook_id}`}</span>
                </div>
                <div class="run-sub">
                  <span class="run-status-text">{run.status.replace(/_/g, " ")}</span>
                  {#if run.current_step_id}
                    <span class="run-current-step">· {run.current_step_id}</span>
                  {/if}
                </div>
              </button>

              {#if expandedRunId === run.id}
                <div class="run-detail">
                  {#if runDetailLoading}
                    <div class="run-loading">Loading…</div>
                  {:else if runDetail}
                    {#if Object.keys(runDetail.run.context ?? {}).length > 0}
                      <div class="ctx-section">
                        <h4>Context</h4>
                        <dl class="ctx-grid">
                          {#each Object.entries(runDetail.run.context) as [k, v]}
                            <dt>{k}</dt>
                            <dd>{String(v)}</dd>
                          {/each}
                        </dl>
                      </div>
                    {/if}

                    <div class="exec-section">
                      <h4>Steps ({runDetail.executions.length})</h4>
                      {#each runDetail.executions as exec (exec.id)}
                        <div class="exec-entry">
                          <div class="exec-header">
                            <span class="exec-dot" style="background: {stepStatusColor(exec.status)}"></span>
                            <span class="exec-type">{exec.step_type}</span>
                            <code class="exec-step-id">{exec.step_id}</code>
                            <span class="exec-status">{exec.status}</span>
                          </div>
                          {#if exec.error}
                            <div class="exec-error">{exec.error}</div>
                          {/if}
                          {#if exec.output && Object.keys(exec.output).length > 0}
                            <details class="exec-details">
                              <summary>Output</summary>
                              <pre class="exec-json">{JSON.stringify(exec.output, null, 2)}</pre>
                            </details>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <div class="sidebar-section">
          <h3>Playbook</h3>
          <p class="text-muted">No playbook runs yet.</p>
        </div>
      {/if}
    </div>
  </div>
{:else}
  <div class="error-banner">Thread not found.</div>
{/if}

<style>
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
    gap: 12px;
    flex-wrap: wrap;
  }

  .back-btn {
    background: none;
    border: none;
    color: var(--color-text-muted);
    font-size: 13px;
    cursor: pointer;
    padding: 6px 0;
    transition: color 0.15s ease, transform 0.1s ease;
  }
  .back-btn:hover { color: var(--color-text); }
  .back-btn:active { transform: scale(0.97); }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .status-pills {
    display: flex;
    gap: 4px;
  }

  .status-btn {
    padding: 4px 10px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: transparent;
    color: var(--color-text-muted);
    font-size: 11px;
    cursor: pointer;
    text-transform: capitalize;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
  }
  .status-btn:hover { background: var(--color-surface-2); color: var(--color-text); }
  .status-btn:active { transform: scale(0.97); }
  .status-btn.active { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }

  .loading { color: var(--color-text-muted); padding: 40px; text-align: center; }

  .success-banner {
    background: rgba(16 185 129 / 0.1);
    border: 1px solid rgba(16 185 129 / 0.3);
    border-radius: var(--radius);
    color: #6ee7b7;
    padding: 12px 16px;
    margin-bottom: 16px;
    animation: flash-success 600ms ease forwards;
  }

  /* ─── Two-column layout ─── */
  .thread-layout {
    display: grid;
    grid-template-columns: 1fr 340px;
    gap: 20px;
    align-items: start;
  }

  @media (max-width: 900px) {
    .thread-layout {
      grid-template-columns: 1fr;
    }
  }

  /* ─── Left: Conversation ─── */
  .conversation-col {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .thread-subject-bar h1 {
    font-size: 18px;
    font-weight: 700;
    margin-bottom: 8px;
  }

  .thread-badges {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .category-tag {
    background: rgba(99 102 241 / 0.15);
    color: var(--color-primary);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
  }

  .auto-reply-badge {
    background: rgba(16 185 129 / 0.15);
    color: var(--color-success);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
  }

  .text-muted { color: var(--color-text-muted); font-size: 13px; }

  .messages-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .message.outbound {
    border-color: rgba(99 102 241 / 0.3);
    background: rgba(99 102 241 / 0.05);
  }

  .message-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    font-size: 12px;
  }

  .from { font-weight: 600; }

  .direction-badge {
    background: var(--color-surface-2);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    text-transform: uppercase;
  }

  .date { color: var(--color-text-muted); margin-left: auto; }

  .message-body {
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ─── Drafts ─── */
  .drafts-section h3 { font-size: 14px; font-weight: 700; margin-bottom: 10px; }

  .draft-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }

  .draft-status {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .draft-pending { background: rgba(245 158 11 / 0.15); color: var(--color-warning); }
  .draft-approved { background: rgba(16 185 129 / 0.15); color: var(--color-success); }
  .draft-rejected { background: rgba(239 68 68 / 0.15); color: var(--color-danger); }
  .draft-sent { background: rgba(99 102 241 / 0.15); color: var(--color-primary); }

  .draft-body {
    font-family: var(--font);
    font-size: 13px;
    line-height: 1.7;
    white-space: pre-wrap;
    background: var(--color-surface-2);
    padding: 14px;
    border-radius: var(--radius);
    margin-bottom: 14px;
  }

  .draft-actions { display: flex; gap: 10px; }

  /* ─── Right: Context sidebar ─── */
  .context-col {
    position: sticky;
    top: 28px;
  }

  .sidebar-section h3 {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    margin-bottom: 10px;
  }

  .run-card { margin-bottom: 8px; overflow: hidden; }
  .run-card.run-expanded { border-color: var(--color-primary); }

  .run-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 10px 14px;
    background: transparent;
    border: none;
    color: var(--color-text);
    cursor: pointer;
    text-align: left;
    transition: background 0.12s ease;
  }
  .run-header:hover { background: var(--color-surface-2); }

  .run-title {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .run-status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .run-name { font-size: 13px; font-weight: 600; }

  .run-sub {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--color-text-muted);
    padding-left: 14px;
  }

  .run-status-text { text-transform: capitalize; }
  .run-current-step { font-family: monospace; font-size: 10px; }

  .run-detail { border-top: 1px solid var(--color-border); padding: 12px; }
  .run-loading { color: var(--color-text-muted); font-size: 12px; }

  .ctx-section, .exec-section { margin-bottom: 12px; }
  .ctx-section h4, .exec-section h4 {
    font-size: 11px;
    font-weight: 700;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }

  .ctx-grid { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-size: 12px; }
  .ctx-grid dt { color: var(--color-text-muted); font-family: monospace; }
  .ctx-grid dd { color: var(--color-text); word-break: break-all; margin: 0; }

  .exec-entry {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 11px;
    margin-bottom: 4px;
  }

  .exec-header { display: flex; align-items: center; gap: 6px; }
  .exec-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .exec-type { font-weight: 600; }
  .exec-step-id { color: var(--color-text-muted); font-size: 10px; }
  .exec-status { color: var(--color-text-muted); margin-left: auto; text-transform: capitalize; }

  .exec-error { color: var(--color-danger); margin-top: 4px; font-family: monospace; font-size: 10px; }

  .exec-details { margin-top: 4px; }
  .exec-details summary { color: var(--color-text-muted); cursor: pointer; font-size: 10px; }
  .exec-json { margin-top: 4px; background: var(--color-bg); padding: 6px; border-radius: 4px; font-size: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }

  /* ------------------------------------------------------------------ */
  /* Thread loading skeleton                                              */
  /* ------------------------------------------------------------------ */
  .thread-skeleton {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .skeleton-header {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .skeleton-title {
    height: 22px;
    width: 60%;
  }
  .skeleton-badges {
    height: 14px;
    width: 30%;
    opacity: 0.6;
  }
  .skeleton-messages {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .skeleton-msg {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .skeleton-msg-header {
    height: 12px;
    width: 45%;
    opacity: 0.7;
  }
  .skeleton-msg-body {
    height: 12px;
    width: 90%;
  }
  .skeleton-msg-body-sm {
    height: 12px;
    width: 70%;
    opacity: 0.5;
  }
</style>
