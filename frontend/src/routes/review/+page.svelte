<!--
  /review - Manual reply queue
  Shows threads needing human review with draft approval UI.
  Also surfaces playbook runs waiting for human approval (manual_approval steps).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { fly, fade } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { threadsApi, playbooksApi } from "$lib/api";
  import type { ThreadListItem, ThreadDetail, Draft, PlaybookRun } from "$lib/api";
  import { CheckCircle } from '@lucide/svelte';

  const prefersReducedMotion =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  let mounted = $state(false);

  let reviewThreads = $state<ThreadListItem[]>([]);
  let expandedThread = $state<ThreadDetail | null>(null);
  let loading = $state(true);
  let detailLoading = $state(false);
  let error = $state<string | null>(null);
  let successMessage = $state<string | null>(null);

  // Playbook runs waiting for human
  let pendingRuns = $state<PlaybookRun[]>([]);
  let runActioning = $state<number | null>(null);

  // Per-run capture_input text: runId → typed text
  let runInputs = $state<Record<number, string>>({});

  // Per-run editable reply body for pending_send approvals: runId → edited body
  let runBodies = $state<Record<number, string>>({});

  // Per-draft edit state: draftId → edited body
  let editingBodies = $state<Record<number, string>>({});

  // Group pending runs by reason
  let runsByReason = $derived(
    pendingRuns.reduce<Record<string, PlaybookRun[]>>((acc, run) => {
      const key = run.step_reason ?? "Approval required";
      (acc[key] ??= []).push(run);
      return acc;
    }, {})
  );

  async function load() {
    loading = true;
    error = null;
    try {
      const [threadsRes, runsRes] = await Promise.all([
        threadsApi.list({ status: "in_review" }),
        playbooksApi.listRuns({ status: "waiting_for_human" }),
      ]);
      reviewThreads = threadsRes.threads;
      pendingRuns = runsRes.runs;
      // Initialise editable bodies from AI-drafted pending sends
      for (const run of runsRes.runs) {
        if (run.step_pending_send && !(run.id in runBodies)) {
          runBodies[run.id] = run.step_pending_send;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load review queue";
    } finally {
      loading = false;
    }
  }

  async function openThread(id: number) {
    detailLoading = true;
    try {
      const res = await threadsApi.get(id);
      expandedThread = res.thread;
      for (const d of res.thread.drafts) {
        if (d.status === "pending") {
          editingBodies[d.id] = d.body;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load thread";
    } finally {
      detailLoading = false;
    }
  }

  async function handleDraftAction(
    threadId: number,
    draft: Draft,
    status: Draft["status"],
  ) {
    try {
      const editedBody =
        status === "approved" ? editingBodies[draft.id] : undefined;
      await threadsApi.updateDraftStatus(threadId, draft.id, status, editedBody);
      successMessage = `Draft ${status}.`;
      setTimeout(() => { successMessage = null; }, 3000);
      if (expandedThread?.id === threadId) {
        const res = await threadsApi.get(threadId);
        expandedThread = res.thread;
      }
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to update draft";
    }
  }

  async function approveRun(runId: number, captureInput: boolean) {
    runActioning = runId;
    error = null;
    try {
      const input = captureInput ? runInputs[runId] : undefined;
      // Pass edited reply body for pending_send approvals
      const body = runBodies[runId];
      await playbooksApi.approveRun(runId, input, body);
      successMessage = "Approved - playbook resumed.";
      setTimeout(() => { successMessage = null; }, 3000);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to approve";
    } finally {
      runActioning = null;
    }
  }

  async function rejectRun(runId: number) {
    runActioning = runId;
    error = null;
    try {
      await playbooksApi.rejectRun(runId);
      successMessage = "Rejected - run escalated.";
      setTimeout(() => { successMessage = null; }, 3000);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to reject";
    } finally {
      runActioning = null;
    }
  }

  onMount(async () => {
    await load();
    mounted = true;
  });
</script>

<svelte:head>
  <title>Review Queue - Email Dash</title>
</svelte:head>

<div class="page-header">
  <h1>Review Queue</h1>
  <span class="count">{reviewThreads.length} thread{reviewThreads.length !== 1 ? "s" : ""} · {pendingRuns.length} approval{pendingRuns.length !== 1 ? "s" : ""}</span>
</div>

{#if error}
  <div class="error-banner" transition:fade={{ duration: 150 }}>{error}</div>
{/if}

{#if successMessage}
  <div class="success-banner" transition:fade={{ duration: 150 }}>{successMessage}</div>
{/if}

{#if loading}
  <div class="loading">Loading review queue…</div>
{:else}

{#if pendingRuns.length > 0}
  <section class="approvals-section">
    <h2>Playbook approvals</h2>
    {#each Object.entries(runsByReason) as [reason, runs]}
      <div class="reason-group">
        <div class="reason-label">{reason}</div>
        {#each runs as run, i (run.id)}
          <div
            class="approval-card card"
            in:fly={{ y: prefersReducedMotion ? 0 : 6, duration: prefersReducedMotion ? 50 : 140, delay: mounted ? 0 : i * 30, easing: cubicOut }}
          >
            <div class="approval-info">
              <span class="approval-playbook">{run.playbook_name ?? `Playbook #${run.playbook_id}`}</span>
              <span class="approval-meta">Run #{run.id} · <a href="/threads/{run.thread_id}" class="thread-link">Thread #{run.thread_id}</a></span>
              <span class="approval-time">{new Date(run.updated_at).toLocaleString()}</span>
            </div>
            {#if run.step_pending_send}
              <div class="pending-send-area">
                <div class="pending-send-header">
                  <span class="pending-send-label">
                    {run.step_type === 'ask_customer' ? 'Message to customer (held for approval)' : 'Reply to send (held for approval)'}
                  </span>
                  {#if runBodies[run.id] !== run.step_pending_send}
                    <span class="edited-notice">edited</span>
                  {/if}
                </div>
                <textarea
                  class="pending-send-textarea"
                  rows={6}
                  value={runBodies[run.id] ?? run.step_pending_send}
                  oninput={(e) => { runBodies[run.id] = (e.target as HTMLTextAreaElement).value; }}
                ></textarea>
                {#if runBodies[run.id] !== run.step_pending_send}
                  <button
                    class="btn btn-ghost btn-sm"
                    onclick={() => { runBodies[run.id] = run.step_pending_send!; }}
                  >Reset to AI draft</button>
                {/if}
              </div>
            {/if}
            {#if run.step_capture_input}
              <div class="capture-input-area">
                <label class="capture-label" for="run-input-{run.id}">
                  {run.step_input_prompt ?? "Notes"}
                </label>
                <textarea
                  id="run-input-{run.id}"
                  class="capture-textarea"
                  rows={3}
                  placeholder={run.step_input_prompt ?? "Enter notes…"}
                  value={runInputs[run.id] ?? ""}
                  oninput={(e) => { runInputs[run.id] = (e.target as HTMLTextAreaElement).value; }}
                ></textarea>
              </div>
            {/if}
            <div class="approval-actions">
              <button
                class="btn btn-primary"
                onclick={() => approveRun(run.id, run.step_capture_input ?? false)}
                disabled={runActioning === run.id}
              >
                {runActioning === run.id ? "…" : "Approve"}
              </button>
              <button
                class="btn btn-ghost"
                onclick={() => rejectRun(run.id)}
                disabled={runActioning === run.id}
              >
                Reject
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/each}
  </section>
{/if}

{#if reviewThreads.length === 0 && pendingRuns.length === 0}
  <div class="empty">
    <div class="empty-icon"><CheckCircle size={40} strokeWidth={1.5} /></div>
    <p>No threads need review right now.</p>
  </div>
{:else if reviewThreads.length === 0}
  <div class="empty-small">No draft threads in queue.</div>
{:else}
  <div class="review-layout">
    <div class="thread-list">
      {#each reviewThreads as thread, i (thread.id)}
        <button
          class="thread-item"
          class:selected={expandedThread?.id === thread.id}
          onclick={() => openThread(thread.id)}
          in:fly={{ y: prefersReducedMotion ? 0 : 6, duration: prefersReducedMotion ? 50 : 140, delay: mounted ? 0 : i * 25, easing: cubicOut }}
        >
          <div class="thread-subject">{thread.subject || "(no subject)"}</div>
          <div class="thread-meta">
            {#if thread.category_name}
              <span class="category-badge">{thread.category_name}</span>
            {/if}
            {#if thread.draft_count > 0}
              <span class="draft-badge"
                >{thread.draft_count} draft{thread.draft_count !== 1
                  ? "s"
                  : ""}</span
              >
            {/if}
          </div>
        </button>
      {/each}
    </div>

    <div class="thread-detail">
      {#if detailLoading}
        <div class="loading">Loading thread…</div>
      {:else if expandedThread}
        <div class="detail-header">
          <h2>{expandedThread.subject || "(no subject)"}</h2>
          {#if expandedThread.category}
            <span class="category-badge">{expandedThread.category.name}</span>
          {/if}
        </div>

        <div class="messages-section">
          <h3>Messages</h3>
          {#each expandedThread.messages as message (message.id)}
            <div
              class="message"
              class:outbound={message.direction === "outbound"}
            >
              <div class="message-header">
                <span class="from">{message.from_address}</span>
                <span class="date"
                  >{new Date(message.received_at).toLocaleString()}</span
                >
                <span class="direction-badge">{message.direction}</span>
              </div>
              <div class="message-body">{message.body_plain}</div>
            </div>
          {/each}
        </div>

        {#if expandedThread.drafts.length > 0}
          <div class="drafts-section">
            <h3>Drafts</h3>
            {#each expandedThread.drafts as draft (draft.id)}
              <div class="draft card">
                <div class="draft-status-row">
                  <span class="draft-status draft-status-{draft.status}"
                    >{draft.status}</span
                  >
                  <span class="date"
                    >{new Date(draft.created_at).toLocaleString()}</span
                  >
                  {#if draft.was_edited}
                    <span class="edited-badge">edited</span>
                  {/if}
                </div>
                {#if draft.status === "pending"}
                  <textarea
                    class="draft-editor"
                    rows={10}
                    bind:value={editingBodies[draft.id]}
                  ></textarea>
                  {#if editingBodies[draft.id] !== draft.body}
                    <p class="edit-notice">
                      Body edited - changes will be sent on approval.
                    </p>
                  {/if}
                  <div class="draft-actions">
                    <button
                      class="btn btn-primary"
                      onclick={() =>
                        handleDraftAction(
                          expandedThread!.id,
                          draft,
                          "approved",
                        )}
                    >
                      Approve &amp; Send
                    </button>
                    <button
                      class="btn btn-ghost"
                      onclick={() => {
                        editingBodies[draft.id] = draft.body;
                      }}
                    >
                      Reset
                    </button>
                    <button
                      class="btn btn-danger"
                      onclick={() =>
                        handleDraftAction(
                          expandedThread!.id,
                          draft,
                          "rejected",
                        )}
                    >
                      Reject
                    </button>
                  </div>
                {:else}
                  <pre class="draft-body">{draft.final_body ?? draft.body}</pre>
                  {#if draft.sent_at}
                    <p class="sent-at">
                      Sent {new Date(draft.sent_at).toLocaleString()}
                    </p>
                  {/if}
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        <div class="select-prompt">Select a thread to review</div>
      {/if}
    </div>
  </div>
{/if}

{/if}

<style>
  .page-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 24px;
  }

  h1 {
    font-size: 22px;
    font-weight: 700;
  }

  .count {
    background: rgba(99 102 241 / 0.15);
    color: var(--color-primary);
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
  }

  .loading,
  .empty {
    color: var(--color-text-muted);
    padding: 40px;
    text-align: center;
  }

  .empty-small {
    color: var(--color-text-muted);
    font-size: 13px;
    padding: 12px 0 20px;
  }

  /* ─── Playbook approvals ─────────────────────────────────────────────────── */

  .approvals-section {
    margin-bottom: 28px;
  }

  .approvals-section h2 {
    font-size: 14px;
    font-weight: 700;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 12px;
  }

  .reason-group {
    margin-bottom: 16px;
  }

  .reason-label {
    font-size: 13px;
    font-weight: 600;
    color: #fb923c;
    margin-bottom: 8px;
    padding-left: 2px;
  }

  .approval-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 16px;
    margin-bottom: 6px;
  }

  .approval-info {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .approval-playbook {
    font-size: 13px;
    font-weight: 600;
  }

  .approval-meta {
    font-size: 12px;
    color: var(--color-text-muted);
  }

  .thread-link {
    color: var(--color-primary);
    text-decoration: none;
  }

  .approval-time {
    font-size: 11px;
    color: var(--color-text-muted);
  }

  .approval-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .capture-input-area {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .capture-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-muted);
  }

  .capture-textarea {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    font-size: 13px;
    font-family: inherit;
    background: var(--color-surface-raised);
    color: var(--color-text);
    resize: vertical;
    box-sizing: border-box;
  }

  .capture-textarea:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  /* ─── Pending send (reply approval) ─────────────────────────────────── */

  .pending-send-area {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .pending-send-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .pending-send-label {
    font-size: 12px;
    font-weight: 600;
    color: #818cf8;
  }

  .edited-notice {
    font-size: 11px;
    padding: 1px 6px;
    background: rgba(251 146 60 / 0.15);
    color: #fb923c;
    border-radius: 4px;
    font-weight: 600;
  }

  .pending-send-textarea {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid rgba(129 140 248 / 0.4);
    border-radius: var(--radius);
    font-size: 13px;
    font-family: inherit;
    background: var(--color-surface-raised);
    color: var(--color-text);
    resize: vertical;
    box-sizing: border-box;
    line-height: 1.5;
  }

  .pending-send-textarea:focus {
    outline: none;
    border-color: #818cf8;
  }

  .btn-sm {
    font-size: 12px;
    padding: 4px 10px;
    align-self: flex-start;
  }

  .empty-icon {
    font-size: 32px;
    margin-bottom: 12px;
    color: var(--color-success);
  }

  .success-banner {
    background: rgba(16 185 129 / 0.1);
    border: 1px solid rgba(16 185 129 / 0.3);
    border-radius: var(--radius);
    color: #6ee7b7;
    padding: 12px 16px;
    margin-bottom: 16px;
  }

  .review-layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 20px;
    align-items: start;
  }

  .thread-list {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .thread-item {
    width: 100%;
    text-align: left;
    padding: 14px 16px;
    background: var(--color-surface);
    border: none;
    border-bottom: 1px solid var(--color-border);
    cursor: pointer;
    transition: background 0.15s;
  }

  .thread-item:last-child {
    border-bottom: none;
  }

  .thread-item:hover {
    background: var(--color-surface-2);
  }

  .thread-item.selected {
    background: rgba(99 102 241 / 0.1);
    border-left: 3px solid var(--color-primary);
  }

  .thread-subject {
    font-weight: 500;
    font-size: 13px;
    margin-bottom: 6px;
  }

  .thread-meta {
    display: flex;
    gap: 6px;
  }

  .category-badge {
    background: rgba(99 102 241 / 0.15);
    color: var(--color-primary);
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
  }

  .draft-badge {
    background: rgba(245 158 11 / 0.15);
    color: var(--color-warning);
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
  }

  .edited-badge {
    background: rgba(59 130 246 / 0.15);
    color: var(--color-info);
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
  }

  .thread-detail {
    min-height: 400px;
  }

  .detail-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 24px;
  }

  h2 {
    font-size: 18px;
    font-weight: 700;
  }

  h3 {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 12px;
  }

  .messages-section {
    margin-bottom: 28px;
  }

  .message {
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 14px 16px;
    margin-bottom: 10px;
    background: var(--color-surface);
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

  .date,
  .sent-at {
    color: var(--color-text-muted);
  }

  .date {
    margin-left: auto;
  }

  .sent-at {
    font-size: 11px;
    margin-top: 6px;
  }

  .direction-badge {
    background: var(--color-surface-2);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .draft-status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }

  .draft-status {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .draft-status-pending {
    background: rgba(245 158 11 / 0.15);
    color: var(--color-warning);
  }
  .draft-status-approved {
    background: rgba(16 185 129 / 0.15);
    color: var(--color-success);
  }
  .draft-status-rejected {
    background: rgba(239 68 68 / 0.15);
    color: var(--color-danger);
  }
  .draft-status-sent {
    background: rgba(59 130 246 / 0.15);
    color: var(--color-info);
  }

  .draft-editor {
    width: 100%;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    padding: 12px;
    resize: vertical;
    margin-bottom: 8px;
  }

  .draft-editor:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .edit-notice {
    font-size: 12px;
    color: var(--color-info);
    margin-bottom: 8px;
  }

  .draft-body {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--color-text-muted);
    padding: 12px;
    background: var(--color-bg);
    border-radius: var(--radius);
    border: 1px solid var(--color-border);
    margin-bottom: 12px;
  }

  .draft-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 16px;
    margin-bottom: 12px;
  }

  .select-prompt {
    color: var(--color-text-muted);
    padding: 60px;
    text-align: center;
  }

  .btn-danger {
    background: rgba(239 68 68 / 0.1);
    border-color: rgba(239 68 68 / 0.3);
    color: var(--color-danger);
  }

  .btn-danger:hover {
    background: rgba(239 68 68 / 0.2);
  }

  :global(.error-banner) {
    background: rgba(239 68 68 / 0.1);
    border: 1px solid rgba(239 68 68 / 0.3);
    border-radius: var(--radius);
    color: var(--color-danger);
    padding: 12px 16px;
    margin-bottom: 16px;
  }

  @media (max-width: 767px) {
    .review-layout {
      grid-template-columns: 1fr;
    }

    .thread-detail,
    .select-prompt {
      min-width: 0;
      width: 100%;
    }

    .detail-header {
      flex-wrap: wrap;
      gap: 8px;
    }

    h2 {
      font-size: 15px;
    }

    .draft-actions {
      flex-direction: column;
    }

    .draft-actions .btn {
      width: 100%;
    }
  }
</style>
