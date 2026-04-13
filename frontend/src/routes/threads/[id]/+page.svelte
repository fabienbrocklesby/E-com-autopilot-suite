<!--
  /threads/[id] — Thread detail page
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { threadsApi, playbooksApi } from "$lib/api";
  import type { ThreadDetail, Draft, PlaybookRun, StepExecution } from "$lib/api";

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
  <title>{thread?.subject ?? "Thread"} — Email Dash</title>
</svelte:head>

<div class="page-header">
  <button class="back-btn" onclick={() => goto("/")}>← Back</button>
  <div class="header-actions">
    <button
      class="btn btn-ghost"
      onclick={handleCategorise}
      disabled={categorising}
    >
      {categorising ? "Categorising…" : "⚡ Categorise"}
    </button>
  </div>
</div>

{#if error}
  <div class="error-banner">{error}</div>
{/if}

{#if success}
  <div class="success-banner">{success}</div>
{/if}

{#if loading}
  <div class="loading">Loading thread…</div>
{:else if thread}
  <div class="thread-container">
    <div class="thread-info card">
      <h1>{thread.subject || "(no subject)"}</h1>
      <div class="thread-meta">
        <span class="badge badge-{thread.status}">{thread.status}</span>
        {#if thread.category}
          <span class="category-tag">{thread.category.name}</span>
        {:else}
          <span class="text-muted">Uncategorised</span>
        {/if}
        {#if thread.auto_replied}
          <span class="auto-reply-badge">Auto-replied</span>
        {/if}
      </div>

      <div class="status-changer">
        <span class="label">Change status:</span>
        {#each ["new", "in_review", "replied", "ignored", "closed"] as s}
          <button
            class="status-btn"
            class:active={thread.status === s}
            onclick={() => handleStatusUpdate(s)}
          >
            {s}
          </button>
        {/each}
      </div>
    </div>

    <section class="messages-section">
      <h2>Messages ({thread.messages.length})</h2>
      {#each thread.messages as message (message.id)}
        <div
          class="message card"
          class:outbound={message.direction === "outbound"}
        >
          <div class="message-header">
            <span class="from">{message.from_address}</span>
            <span class="direction">{message.direction}</span>
            <span class="date"
              >{new Date(message.received_at).toLocaleString()}</span
            >
          </div>
          <div class="message-body">{message.body_plain}</div>
        </div>
      {/each}
    </section>

    {#if thread.drafts.length > 0}
      <section class="drafts-section">
        <h2>Drafts ({thread.drafts.length})</h2>
        {#each thread.drafts as draft (draft.id)}
          <div class="draft card">
            <div class="draft-header">
              <span class="draft-status draft-{draft.status}"
                >{draft.status}</span
              >
              <span class="date"
                >{new Date(draft.created_at).toLocaleString()}</span
              >
            </div>
            <pre class="draft-body">{draft.body}</pre>
            {#if draft.status === "pending"}
              <div class="draft-actions">
                <button
                  class="btn btn-primary"
                  onclick={() => handleDraftAction(draft.id, "approved")}
                >
                  Approve
                </button>
                <button
                  class="btn btn-ghost"
                  onclick={() => handleDraftAction(draft.id, "rejected")}
                >
                  Reject
                </button>
              </div>
            {/if}
          </div>
        {/each}
      </section>
    {/if}

    {#if runs.length > 0}
      <section class="runs-section">
        <h2>Playbook Runs ({runs.length})</h2>
        {#each runs as run (run.id)}
          <div class="run-card card">
            <div class="run-header" onclick={() => loadRunDetail(run.id)} role="button" tabindex="0" onkeydown={(e) => e.key === "Enter" && loadRunDetail(run.id)}>
              <div class="run-info">
                <span class="run-name">{run.playbook_name ?? `Playbook #${run.playbook_id}`}</span>
                <span class="run-meta">v{run.playbook_version} · run #{run.id}</span>
              </div>
              <div class="run-right">
                <span class="run-status-dot" style="background: {runStatusColor(run.status)}"></span>
                <span class="run-status">{run.status.replace(/_/g, " ")}</span>
                {#if run.current_step_id}
                  <span class="run-step">at: {run.current_step_id}</span>
                {/if}
                <span class="run-toggle">{expandedRunId === run.id ? "▲" : "▼"}</span>
              </div>
            </div>

            {#if expandedRunId === run.id}
              <div class="run-detail">
                {#if runDetailLoading}
                  <div class="run-loading">Loading run detail…</div>
                {:else if runDetail}
                  <!-- Context bag -->
                  {#if Object.keys(runDetail.run.context ?? {}).length > 0}
                    <div class="detail-section">
                      <h4>Context bag</h4>
                      <table class="ctx-table">
                        <tbody>
                        {#each Object.entries(runDetail.run.context) as [k, v]}
                          <tr><td class="ctx-key">{k}</td><td class="ctx-val">{String(v)}</td></tr>
                        {/each}
                        </tbody>
                      </table>
                    </div>
                  {/if}

                  <!-- Step execution log -->
                  <div class="detail-section">
                    <h4>Execution log ({runDetail.executions.length} step{runDetail.executions.length !== 1 ? "s" : ""})</h4>
                    {#if runDetail.executions.length === 0}
                      <p class="text-muted">No executions recorded yet.</p>
                    {:else}
                      <div class="exec-list">
                        {#each runDetail.executions as exec (exec.id)}
                          <div class="exec-entry">
                            <div class="exec-header">
                              <span class="exec-dot" style="background: {stepStatusColor(exec.status)}"></span>
                              <span class="exec-type">{exec.step_type}</span>
                              <code class="exec-step-id">{exec.step_id}</code>
                              <span class="exec-status">{exec.status}</span>
                              <span class="exec-time">{new Date(exec.created_at).toLocaleTimeString()}</span>
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
                            {#if exec.ai_calls && exec.ai_calls.length > 0}
                              <details class="exec-details">
                                <summary>AI calls ({exec.ai_calls.length})</summary>
                                {#each exec.ai_calls as call, ci}
                                  <div class="ai-call">
                                    <div class="ai-call-model">{call.model} · {call.tokens ?? "?"} tokens</div>
                                    <details class="ai-call-detail">
                                      <summary>Prompt</summary>
                                      <pre class="exec-json">{call.prompt}</pre>
                                    </details>
                                    <details class="ai-call-detail">
                                      <summary>Response</summary>
                                      <pre class="exec-json">{call.response}</pre>
                                    </details>
                                  </div>
                                {/each}
                              </details>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </section>
    {/if}
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
  }

  .back-btn {
    background: none;
    border: none;
    color: var(--color-text-muted);
    font-size: 13px;
    cursor: pointer;
    padding: 6px 0;
  }

  .back-btn:hover {
    color: var(--color-text);
  }

  .loading {
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

  .thread-container {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .thread-info h1 {
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 12px;
  }

  .thread-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
  }

  .category-tag {
    background: rgba(99 102 241 / 0.15);
    color: var(--color-primary);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
  }

  .auto-reply-badge {
    background: rgba(16 185 129 / 0.15);
    color: var(--color-success);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
  }

  .text-muted {
    color: var(--color-text-muted);
    font-size: 13px;
  }

  .status-changer {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .label {
    font-size: 12px;
    color: var(--color-text-muted);
  }

  .status-btn {
    padding: 4px 12px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: transparent;
    color: var(--color-text-muted);
    font-size: 12px;
    cursor: pointer;
    text-transform: capitalize;
  }

  .status-btn:hover {
    background: var(--color-surface-2);
    color: var(--color-text);
  }
  .status-btn.active {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: #fff;
  }

  h2 {
    font-size: 15px;
    font-weight: 700;
    margin-bottom: 12px;
  }

  .message {
    margin-bottom: 12px;
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

  .from {
    font-weight: 600;
  }

  .direction {
    background: var(--color-surface-2);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    text-transform: uppercase;
  }

  .date {
    color: var(--color-text-muted);
    margin-left: auto;
  }

  .message-body {
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

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

  .draft-pending {
    background: rgba(245 158 11 / 0.15);
    color: var(--color-warning);
  }
  .draft-approved {
    background: rgba(16 185 129 / 0.15);
    color: var(--color-success);
  }
  .draft-rejected {
    background: rgba(239 68 68 / 0.15);
    color: var(--color-danger);
  }
  .draft-sent {
    background: rgba(99 102 241 / 0.15);
    color: var(--color-primary);
  }

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

  .draft-actions {
    display: flex;
    gap: 10px;
  }

  /* ─── Playbook runs ──────────────────────────────────────────────────────── */

  .runs-section h2 { font-size: 15px; font-weight: 700; margin-bottom: 12px; }

  .run-card { margin-bottom: 10px; overflow: hidden; }

  .run-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    cursor: pointer;
    user-select: none;
  }

  .run-header:hover { background: var(--color-surface-2); }

  .run-info { display: flex; flex-direction: column; gap: 2px; }
  .run-name { font-size: 13px; font-weight: 600; }
  .run-meta { font-size: 11px; color: var(--color-text-muted); }

  .run-right { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .run-status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .run-status { font-weight: 600; text-transform: capitalize; }
  .run-step { color: var(--color-text-muted); font-family: monospace; font-size: 11px; }
  .run-toggle { color: var(--color-text-muted); font-size: 10px; }

  .run-detail { border-top: 1px solid var(--color-border); padding: 16px; }
  .run-loading { color: var(--color-text-muted); font-size: 13px; }

  .detail-section { margin-bottom: 16px; }
  .detail-section h4 { font-size: 12px; font-weight: 700; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }

  .ctx-table { border-collapse: collapse; font-size: 12px; width: 100%; }
  .ctx-key { color: var(--color-text-muted); padding: 3px 12px 3px 0; font-family: monospace; white-space: nowrap; }
  .ctx-val { color: var(--color-text); padding: 3px 0; word-break: break-all; }

  .exec-list { display: flex; flex-direction: column; gap: 6px; }

  .exec-entry {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 12px;
  }

  .exec-header { display: flex; align-items: center; gap: 8px; }
  .exec-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .exec-type { font-weight: 600; }
  .exec-step-id { color: var(--color-text-muted); font-size: 11px; }
  .exec-status { color: var(--color-text-muted); margin-left: auto; text-transform: capitalize; }
  .exec-time { color: var(--color-text-muted); font-size: 11px; }

  .exec-error { color: var(--color-danger); margin-top: 6px; font-family: monospace; font-size: 11px; }

  .exec-details { margin-top: 6px; }
  .exec-details summary { color: var(--color-text-muted); cursor: pointer; font-size: 11px; }
  .exec-json { margin-top: 4px; background: var(--color-bg); padding: 8px; border-radius: 4px; font-size: 11px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }

  .ai-call { margin-top: 8px; padding: 8px; background: var(--color-bg); border-radius: 4px; }
  .ai-call-model { font-weight: 600; font-size: 11px; color: var(--color-text-muted); margin-bottom: 4px; }
  .ai-call-detail summary { color: var(--color-text-muted); cursor: pointer; font-size: 11px; margin-top: 4px; }
</style>
