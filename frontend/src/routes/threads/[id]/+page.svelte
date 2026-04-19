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
  import type { ThreadDetail, Draft, Message, PlaybookRun, StepExecution } from "$lib/api";
  import ManualActionBanner from "$lib/components/ManualActionBanner.svelte";
  import ManualReplyPanel from "$lib/components/ManualReplyPanel.svelte";
  import { Zap, PlusCircle, TableProperties, Pencil, MessageCircleQuestion, Scale, GitBranch, Hand, Send, CheckCircle, AlertTriangle } from '@lucide/svelte';
  import { openSSE } from "$lib/sse";

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
  let runDetails = $state<Record<number, { run: PlaybookRun; executions: StepExecution[] }>>({});

  // Active run waiting for human action - drives the banner.
  let waitingRun = $derived(runs.find((r) => r.status === "waiting_for_human") ?? null);

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

  const execStepMeta: Record<string, { icon: typeof PlusCircle; label: string; color: string }> = {
    extract:         { icon: PlusCircle,           label: "Extract",         color: "#6366f1" },
    find_sheet_row:  { icon: TableProperties,      label: "Find Sheet Row",  color: "#0ea5e9" },
    update_sheet:    { icon: Pencil,                label: "Update Sheet",    color: "#0ea5e9" },
    ask_customer:    { icon: MessageCircleQuestion, label: "Ask Customer",    color: "#f59e0b" },
    evaluate:        { icon: Scale,                 label: "Evaluate",        color: "#8b5cf6" },
    branch:          { icon: GitBranch,             label: "Branch",          color: "#a78bfa" },
    manual_approval: { icon: Hand,                  label: "Manual Approval", color: "#f97316" },
    send_reply:      { icon: Send,                  label: "Send Reply",      color: "#10b981" },
    complete:        { icon: CheckCircle,           label: "Complete",        color: "#10b981" },
    escalate:        { icon: AlertTriangle,         label: "Escalate",        color: "#ef4444" },
  };

  const defaultExecMeta = { icon: PlusCircle, label: "Step", color: "#64748b" };

  function execMeta(type: string) {
    return execStepMeta[type] ?? defaultExecMeta;
  }

  function execSummary(stepType: string, output: Record<string, unknown> | null): string {
    if (!output) return "";
    switch (stepType) {
      case "find_sheet_row": {
        if (output.found) return `Found row ${output.row_number} · ${output.column} = "${output.matched_value}"`;
        return "No matching row found";
      }
      case "update_sheet": {
        const written = output.written as Record<string, unknown> | undefined;
        if (!written) return "";
        const pairs = Object.entries(written).map(([col, val]) => `${col} → ${String(val)}`).join(", ");
        return `Updated: ${pairs}`;
      }
      case "ask_customer": {
        if (output.action === "skipped") return "Skipped — all required context already present";
        const msg = (output.pending_send ?? output.message_sent) as string | undefined;
        if (msg) return `"${msg.slice(0, 80)}${msg.length > 80 ? "…" : ""}"`;
        return "";
      }
      case "evaluate": {
        const action = output.action as string | undefined;
        if (action === "satisfied") return `Satisfied${output.skipped_ai ? " (deterministic)" : ""}`;
        if (action === "missing") {
          const missing = (output.missing as string[] | undefined)?.join(", ");
          return `Missing: ${missing ?? "unknown"}`;
        }
        if (action === "escalate") return `Escalated: ${(output.reasoning as string | undefined) ?? ""}`;
        return String(action ?? "");
      }
      case "send_reply": {
        const msg = output.message_sent as string | undefined;
        if (msg) return `"${msg.slice(0, 80)}${msg.length > 80 ? "…" : ""}"`;
        return "";
      }
      case "manual_approval": {
        const reason = output.reason as string | undefined;
        return reason ? `Reason: "${reason}"` : "";
      }
      case "extract":
        return "";
      case "complete":
        return "Run completed successfully";
      case "escalate":
        return (output.reason as string | undefined) ?? "";
      default:
        return "";
    }
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
      const detailResults = await Promise.all(
        runsRes.runs.map((r) => playbooksApi.getRun(r.id).catch(() => null))
      );
      runDetails = Object.fromEntries(
        detailResults.flatMap((d) => (d ? [[d.run.id, d]] : []))
      );
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

  const ACTIVE_RUN_STATUSES = ["running", "waiting_for_customer", "waiting_for_human", "retrying"];

  let activeRuns = $derived(runs.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status)));

  let pendingStatus = $state<string | null>(null);

  function requestStatusUpdate(newStatus: string) {
    if (thread?.status === newStatus) return;
    if (activeRuns.length > 0) {
      pendingStatus = newStatus;
    } else {
      applyStatusUpdate(newStatus);
    }
  }

  async function applyStatusUpdate(newStatus: string) {
    pendingStatus = null;
    try {
      await threadsApi.updateStatus(threadId, newStatus);
      if (thread) thread = { ...thread, status: newStatus };
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to update status";
    }
  }

  async function confirmStatusUpdate() {
    if (!pendingStatus) return;
    const targetStatus = pendingStatus;
    pendingStatus = null;
    try {
      await Promise.all(activeRuns.map((r) => playbooksApi.cancelRun(r.id)));
      await threadsApi.updateStatus(threadId, targetStatus);
      if (thread) thread = { ...thread, status: targetStatus };
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to cancel runs and update status";
    }
  }

  onMount(() => {
    load();
  });

  $effect(() => {
    // Thread-scoped SSE stream for live step-by-step playbook progress.
    let connectionCount = 0;
    const es = openSSE(`thread/${threadId}`, { workspace_id: 1 });

    es.addEventListener('open', () => {
      connectionCount++;
      if (connectionCount > 1) load();
    });

    es.addEventListener('thread_updated', (e: Event) => {
      const { thread: updated } = JSON.parse((e as MessageEvent).data) as { thread: Record<string, unknown> };
      if (thread) thread = { ...thread, ...updated } as ThreadDetail;
    });

    es.addEventListener('message_created', (e: Event) => {
      const { message } = JSON.parse((e as MessageEvent).data) as { message: Message };
      if (thread && !thread.messages.find((m) => m.id === message.id)) {
        thread = { ...thread, messages: [...thread.messages, message] };
      }
    });

    es.addEventListener('run_updated', async (e: Event) => {
      const { run } = JSON.parse((e as MessageEvent).data) as { run: PlaybookRun & { playbook_name?: string } };
      const idx = runs.findIndex((r) => r.id === run.id);
      if (idx >= 0) {
        runs = runs.map((r, i) => (i === idx ? { ...r, ...run } : r));
        if (runDetails[run.id]) {
          runDetails = { ...runDetails, [run.id]: { ...runDetails[run.id], run } };
        }
      } else {
        runs = [...runs, run];
        try {
          const detail = await playbooksApi.getRun(run.id);
          runDetails = { ...runDetails, [run.id]: detail };
        } catch { /* ignore */ }
      }
    });

    es.addEventListener('step_execution_created', (e: Event) => {
      const { runId, execution } = JSON.parse((e as MessageEvent).data) as { runId: number; execution: StepExecution };
      if (runDetails[runId] && !runDetails[runId].executions.find((ex) => ex.id === execution.id)) {
        runDetails = {
          ...runDetails,
          [runId]: { ...runDetails[runId], executions: [...runDetails[runId].executions, execution] },
        };
      }
    });

    es.addEventListener('step_execution_updated', (e: Event) => {
      const { runId, execution } = JSON.parse((e as MessageEvent).data) as { runId: number; execution: StepExecution };
      if (runDetails[runId]) {
        runDetails = {
          ...runDetails,
          [runId]: {
            ...runDetails[runId],
            executions: runDetails[runId].executions.map((ex) =>
              ex.id === execution.id ? { ...ex, ...execution } : ex,
            ),
          },
        };
      }
    });

    return () => es.close();
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
          onclick={() => requestStatusUpdate(s)}
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

{#if pendingStatus}
  <div class="confirm-banner" transition:fade={{ duration: 150 }}>
    <div class="confirm-text">
      This thread has {activeRuns.length} active playbook {activeRuns.length === 1 ? "run" : "runs"}. Changing status to <strong>{pendingStatus.replace("_", " ")}</strong> will cancel {activeRuns.length === 1 ? "it" : "them"}.
    </div>
    <div class="confirm-actions">
      <button class="btn btn-danger btn-sm" onclick={confirmStatusUpdate}>Cancel {activeRuns.length === 1 ? "run" : "runs"} and continue</button>
      <button class="btn btn-ghost btn-sm" onclick={() => pendingStatus = null}>Keep running</button>
    </div>
  </div>
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
            class="bubble-wrapper"
            class:outbound={message.direction === "outbound"}
            in:fly={{
              y: prefersReducedMotion ? 0 : 8,
              duration: prefersReducedMotion ? 50 : 150,
              delay: i * 35,
              easing: cubicOut,
            }}
          >
            <div class="bubble">
              <div class="bubble-meta">
                <span class="bubble-from">{message.from_address}</span>
                <span class="bubble-date">{new Date(message.received_at).toLocaleString()}</span>
              </div>
              <div class="bubble-body">{message.body_plain}</div>
            </div>
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
            <div class="run-card card">
              <div class="run-header">
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
              </div>

              <div class="run-detail">
                {#if runDetails[run.id]}
                  {@const detail = runDetails[run.id]}
                  {#if Object.keys(detail.run.context ?? {}).length > 0}
                    <div class="ctx-section">
                      <h4>Context</h4>
                      <dl class="ctx-grid">
                        {#each Object.entries(detail.run.context) as [k, v]}
                          <dt>{k}</dt>
                          <dd>{String(v)}</dd>
                        {/each}
                      </dl>
                    </div>
                  {/if}

                  <div class="exec-section">
                    <h4>Steps ({detail.executions.length})</h4>
                    {#each detail.executions as exec (exec.id)}
                      <div class="exec-entry">
                        <div class="exec-header">
                          <span class="exec-dot" style="background: {stepStatusColor(exec.status)}"></span>
                          <span class="exec-icon" style="color: {execMeta(exec.step_type).color}">
                            {#if execMeta(exec.step_type).icon}
                              {@const ExecIcon = execMeta(exec.step_type).icon}
                              <ExecIcon size={13} />
                            {/if}
                          </span>
                          <span class="exec-type">{execMeta(exec.step_type).label}</span>
                          <code class="exec-step-id">{exec.step_id}</code>
                          <span class="exec-status">{exec.status}</span>
                        </div>
                        {#if execSummary(exec.step_type, exec.output)}
                          <div class="exec-summary">{execSummary(exec.step_type, exec.output)}</div>
                        {/if}
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
                {:else}
                  <div class="run-loading">Loading…</div>
                {/if}
              </div>
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

  .confirm-banner {
    background: rgba(245 158 11 / 0.08);
    border: 1px solid rgba(245 158 11 / 0.35);
    border-radius: var(--radius);
    padding: 12px 16px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }

  .confirm-text {
    font-size: 13px;
    color: var(--color-text);
    line-height: 1.5;
  }

  .confirm-text strong {
    color: var(--color-warning, #f59e0b);
    text-transform: capitalize;
  }

  .confirm-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .btn-danger {
    background: rgba(239 68 68 / 0.15);
    border-color: rgba(239 68 68 / 0.4);
    color: var(--color-danger, #ef4444);
  }

  .btn-danger:hover {
    background: rgba(239 68 68 / 0.25);
    border-color: rgba(239 68 68 / 0.6);
  }

  .btn-sm {
    padding: 4px 12px;
    font-size: 12px;
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
    gap: 14px;
  }

  /* Chat bubble wrapper — inbound left, outbound right */
  .bubble-wrapper {
    display: flex;
    flex-direction: row;
    align-items: flex-end;
  }

  .bubble-wrapper.outbound {
    flex-direction: row-reverse;
  }

  .bubble {
    max-width: 72%;
    padding: 12px 16px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: 16px 16px 16px 4px;
  }

  .bubble-wrapper.outbound .bubble {
    background: rgba(99, 102, 241, 0.12);
    border-color: rgba(99, 102, 241, 0.25);
    border-radius: 16px 16px 4px 16px;
  }

  .bubble-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 11px;
  }

  .bubble-from {
    font-weight: 600;
    color: var(--color-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }

  .bubble-wrapper.outbound .bubble-from {
    color: var(--color-primary);
  }

  .bubble-date {
    color: var(--color-text-3, var(--color-text-muted));
    font-size: 10.5px;
    white-space: nowrap;
  }

  .bubble-body {
    font-size: 13.5px;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--color-text);
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
    height: calc(100vh - 56px);
    display: flex;
    flex-direction: column;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }

  .sidebar-section {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: 16px;
    scrollbar-width: thin;
    scrollbar-color: var(--color-border) transparent;
  }

  .sidebar-section h3 {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    margin-bottom: 10px;
  }

  .run-card { margin-bottom: 8px; overflow: hidden; border-color: var(--color-primary); }

  .run-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 14px;
    color: var(--color-text);
  }

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
  .exec-icon { display: flex; align-items: center; flex-shrink: 0; }
  .exec-type { font-weight: 600; }
  .exec-step-id { color: var(--color-text-muted); font-size: 10px; }
  .exec-status { color: var(--color-text-muted); margin-left: auto; text-transform: capitalize; }
  .exec-summary { color: var(--color-text-muted); font-size: 11px; margin-top: 3px; padding-left: 18px; word-break: break-word; }

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

  /* ------------------------------------------------------------------ */
  /* Mobile responsive                                                    */
  /* ------------------------------------------------------------------ */
  @media (max-width: 767px) {
    .page-header {
      margin-bottom: 14px;
    }

    .thread-layout {
      grid-template-columns: 1fr;
      gap: 16px;
    }

    /* On mobile the context sidebar isn't sticky - just stacks below */
    .context-col {
      position: static;
      height: auto;
      max-height: 500px;
    }

    .bubble {
      max-width: 88%;
    }

    .header-actions {
      gap: 8px;
    }

    .status-pills {
      flex-wrap: wrap;
    }
  }
</style>
