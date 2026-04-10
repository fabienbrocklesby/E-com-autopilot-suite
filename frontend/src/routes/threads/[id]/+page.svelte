<!--
  /threads/[id] — Thread detail page
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { threadsApi } from "$lib/api";
  import type { ThreadDetail, Draft } from "$lib/api";

  const threadId = parseInt($page.params.id);
  let thread = $state<ThreadDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let success = $state<string | null>(null);
  let categorising = $state(false);

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await threadsApi.get(threadId);
      thread = res.thread;
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
</style>
