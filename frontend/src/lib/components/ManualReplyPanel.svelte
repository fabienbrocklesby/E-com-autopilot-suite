<!--
  ManualReplyPanel — rendered on /threads/[id] to allow the operator to send
  a manual reply to the customer at any time, bypassing the playbook draft flow.

  Props:
    threadId    — the DB thread id (integer)
    workspaceId — defaults to 1 (current single-workspace setup)
    onSent      — called after a successful send so the parent can reload state

  On submit:
    - Calls threadsApi.sendManualReply()
    - On success: clears the textarea, calls onSent()
    - On error: shows inline error, does not clear textarea

  Run state handling (performed server-side, not surfaced here):
    - waiting_for_customer  → run is resumed automatically (server handles it)
    - waiting_for_human     → run stays paused; banner still visible
    - all other statuses    → send only, no run change
-->
<script lang="ts">
  import { threadsApi } from "$lib/api";

  let {
    threadId,
    workspaceId = 1,
    onSent,
  }: {
    threadId: number;
    workspaceId?: number;
    onSent: () => void;
  } = $props();

  let replyBody = $state("");
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let successMsg = $state<string | null>(null);

  // Character counter — Svelte 5 $derived reacts to replyBody automatically.
  // Confirmed syntax from Svelte MCP docs and context7 snapshots example.
  let charCount = $derived(replyBody.length);
  let overLimit = $derived(charCount > 10_000);
  let canSend = $derived(!submitting && replyBody.trim().length > 0 && !overLimit);

  async function send() {
    if (!canSend) return;
    submitting = true;
    error = null;
    successMsg = null;
    try {
      await threadsApi.sendManualReply(threadId, replyBody.trim(), workspaceId);
      replyBody = "";
      successMsg = "Reply sent.";
      // Clear success message after 3 s so it doesn't linger.
      setTimeout(() => {
        successMsg = null;
      }, 3000);
      onSent();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to send reply";
    } finally {
      submitting = false;
    }
  }

  /** Allow Cmd/Ctrl+Enter to submit, matching common email client UX. */
  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="panel card" aria-label="Send manual reply">
  <div class="panel-header">
    <span class="panel-icon" aria-hidden="true">✍️</span>
    <h3 class="panel-title">Send manual reply</h3>
  </div>

  <textarea
    bind:value={replyBody}
    onkeydown={handleKeydown}
    placeholder="Write your reply to the customer…"
    rows="5"
    disabled={submitting}
    aria-label="Manual reply text"
    aria-describedby="char-counter"
    class:textarea-error={overLimit}
  ></textarea>

  <div class="panel-footer">
    <span
      id="char-counter"
      class="char-count"
      class:over-limit={overLimit}
      aria-live="polite"
      aria-label="{charCount} of 10,000 characters"
    >
      {charCount}/10,000
    </span>
    <button
      class="btn-send"
      onclick={send}
      disabled={!canSend}
      aria-label="Send reply"
    >
      {submitting ? "Sending…" : "Send reply"}
    </button>
  </div>

  {#if overLimit}
    <p class="error" role="alert">Reply must not exceed 10,000 characters.</p>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if successMsg}
    <p class="success" role="status">{successMsg}</p>
  {/if}
</div>

<style>
  .panel {
    padding: 1.25rem 1.5rem;
    margin-top: 1.5rem;
  }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.875rem;
  }

  .panel-icon {
    font-size: 1.125rem;
    line-height: 1;
  }

  .panel-title {
    font-size: 0.95rem;
    font-weight: 700;
    margin: 0;
    color: var(--color-text, #e2e8f0);
  }

  textarea {
    width: 100%;
    padding: 0.5rem 0.625rem;
    background: var(--color-bg, #0f1117);
    color: var(--color-text, #e2e8f0);
    border: 1px solid var(--color-border, #2e3348);
    border-radius: calc(var(--radius, 8px) - 2px);
    font-family: var(--font, inherit);
    font-size: 0.9rem;
    resize: vertical;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }

  textarea:focus {
    outline: 2px solid var(--color-primary, #6366f1);
    outline-offset: -1px;
  }

  textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  textarea.textarea-error {
    border-color: var(--color-danger, #ef4444);
  }

  .panel-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.625rem;
    gap: 0.75rem;
  }

  .char-count {
    font-size: 0.8rem;
    color: var(--color-text-muted, #64748b);
    flex-shrink: 0;
    user-select: none;
  }

  .char-count.over-limit {
    color: var(--color-danger, #ef4444);
    font-weight: 600;
  }

  .btn-send {
    background: var(--color-primary, #6366f1);
    color: #fff;
    padding: 0.5rem 1.25rem;
    border-radius: calc(var(--radius, 8px) - 2px);
    border: none;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9rem;
    transition: opacity 0.15s;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .btn-send:hover:not(:disabled) {
    opacity: 0.88;
  }

  .btn-send:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .error {
    color: var(--color-danger, #ef4444);
    font-size: 0.875rem;
    margin: 0.5rem 0 0;
  }

  .success {
    color: var(--color-success, #10b981);
    font-size: 0.875rem;
    margin: 0.5rem 0 0;
  }
</style>
