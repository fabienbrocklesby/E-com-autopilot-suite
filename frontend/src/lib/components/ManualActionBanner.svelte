<!--
  ManualActionBanner - rendered on /threads/[id] when a playbook run is waiting_for_human.
  Handles two distinct waiting states:
    1. manual_approval step - shows reason, optional reference context, optional input field
    2. ask_customer / send_reply with require_approval - shows the AI-drafted message for review/edit before sending
  Props:
    run        - a PlaybookRun in waiting_for_human status (from playbooksApi.listRuns)
    onComplete - called after approve or reject so the parent can reload state
-->
<script lang="ts">
  import { playbooksApi } from "$lib/api";
  import type { PlaybookRun } from "$lib/api";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { untrack } from "svelte";
  import { Bell, Mail, ExternalLink, AlertTriangle } from '@lucide/svelte';

  const prefersReducedMotion =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  let {
    run,
    onComplete,
    sheetRowUrl = null,
  }: {
    run: PlaybookRun;
    onComplete: () => void;
    sheetRowUrl?: string | null;
  } = $props();

  let humanInput = $state("");
  let draftBody = $state(untrack(() => run.step_pending_send ?? ""));
  let submitting = $state(false);
  let regenerating = $state(false);
  let error = $state<string | null>(null);

  // True when this pause is for an ask_customer or send_reply step with require_approval.
  // The pending message is stored in step_pending_send and needs human review before sending.
  let isPendingSend = $derived(
    typeof run.step_pending_send === "string" && run.step_pending_send.length > 0,
  );

  let reason = $derived(run.step_reason ?? "Action required");
  let captureInput = $derived(!isPendingSend && run.step_capture_input === true);
  let inputPrompt = $derived(run.step_input_prompt ?? "What did you do?");

  // $derived.by() is used here because we map over an array and need the full
  // context bag - a plain $derived expression would be harder to read.
  // Ref: Svelte 5 docs - "derived" / "Using $derived.by"
  let referenceItems = $derived.by(() => {
    const keys = run.step_reference_context ?? [];
    return keys.map((key) => ({
      key,
      value: String(run.context?.[key] ?? "(not set)"),
    }));
  });

  let canApprove = $derived(
    !submitting &&
    !regenerating &&
    (isPendingSend
      ? draftBody.trim().length > 0
      : !captureInput || humanInput.trim().length > 0),
  );

  let messagesSinceDraft = $derived.by(() => {
    const raw = run.context?._messages_since_draft;
    return Array.isArray(raw) ? (raw as Array<{ message_id: number | null; received_at: string }>) : [];
  });

  async function regenerateDraft() {
    regenerating = true;
    error = null;
    try {
      const res = await playbooksApi.regenerateDraft(run.id);
      draftBody = res.body;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to regenerate draft";
    } finally {
      regenerating = false;
    }
  }

  function formatKey(key: string): string {
    return key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }

  async function approve() {
    submitting = true;
    error = null;
    try {
      if (isPendingSend) {
        await playbooksApi.approveRun(run.id, undefined, draftBody.trim());
      } else {
        await playbooksApi.approveRun(run.id, captureInput ? humanInput : undefined);
      }
      humanInput = "";
      onComplete();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to approve";
    } finally {
      submitting = false;
    }
  }

  async function reject() {
    if (!confirm("Reject this action and escalate the run?")) return;
    submitting = true;
    error = null;
    try {
      await playbooksApi.rejectRun(run.id);
      onComplete();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to reject";
    } finally {
      submitting = false;
    }
  }
</script>

<div
  class="banner"
  class:banner-draft={isPendingSend}
  role="alert"
  aria-live="polite"
  in:fly={{ y: prefersReducedMotion ? 0 : -8, duration: prefersReducedMotion ? 50 : 180, easing: cubicOut }}
>
  <div class="banner-header">
    <span class="banner-icon" aria-hidden="true">
      {#if isPendingSend}<Mail size={18} />{:else}<Bell size={18} />{/if}
    </span>
    <h2 class="banner-title">{isPendingSend ? "Review draft reply" : "Action required"}</h2>
  </div>

  {#if isPendingSend}
    <p class="banner-reason">Edit the AI-drafted reply if needed, then send.</p>
    {#if messagesSinceDraft.length > 0}
      <div class="stale-draft-notice">
        <AlertTriangle size={14} />
        <span>Customer replied since this draft was written.</span>
        <button class="regen-btn" onclick={regenerateDraft} disabled={regenerating || submitting}>
          {regenerating ? "Regenerating…" : "Regenerate draft"}
        </button>
      </div>
    {/if}
    {#if sheetRowUrl}
      <a href={sheetRowUrl} target="_blank" rel="noopener noreferrer" class="sheet-link">
        <ExternalLink size={13} />
        Open sheet row
      </a>
    {/if}
    <label class="input-label" for="draft-body">Draft message</label>
    <textarea
      id="draft-body"
      bind:value={draftBody}
      rows="6"
      disabled={submitting}
    ></textarea>
  {:else}
    <p class="banner-reason">{reason}</p>

    {#if sheetRowUrl}
      <a href={sheetRowUrl} target="_blank" rel="noopener noreferrer" class="sheet-link">
        <ExternalLink size={13} />
        Open sheet row
      </a>
    {/if}

    {#if referenceItems.length > 0}
      <dl class="reference-list">
        {#each referenceItems as item (item.key)}
          <div class="reference-row">
            <dt>{formatKey(item.key)}</dt>
            <dd>{item.value}</dd>
          </div>
        {/each}
      </dl>
    {/if}

    {#if captureInput}
      <label class="input-label" for="human-input">
        {inputPrompt}
      </label>
      <textarea
        id="human-input"
        bind:value={humanInput}
        placeholder={inputPrompt}
        rows="3"
        disabled={submitting}
      ></textarea>
    {/if}
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <div class="banner-actions">
    <button
      class="btn-approve"
      onclick={approve}
      disabled={!canApprove}
      aria-label={isPendingSend ? "Send the reviewed reply to the customer" : "Mark action as done and continue the playbook run"}
    >
      {submitting ? "Working…" : isPendingSend ? "Send reply" : "Done, continue"}
    </button>
    <button
      class="btn-skip"
      onclick={reject}
      disabled={submitting}
      aria-label="Reject this action and escalate"
    >
      Skip / escalate
    </button>
  </div>
</div>

<style>
  .banner {
    background: var(--color-orange-dim, rgba(249 115 22 / 0.08));
    border: 1px solid var(--color-orange, #f97316);
    border-left-width: 4px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.5rem;
    border-radius: var(--radius, 8px);
    color: var(--color-text, #e2e8f0);
    box-shadow: var(--shadow-sm, 0 1px 3px rgba(0 0 0 / 0.3));
  }

  .banner-draft {
    background: rgba(99 102 241 / 0.07);
    border-color: var(--color-primary, #6366f1);
  }

  .banner-draft .banner-title {
    color: var(--color-primary, #6366f1);
  }

  .banner-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .banner-icon {
    font-size: 1.25rem;
    line-height: 1;
  }

  .banner-title {
    font-size: 1rem;
    font-weight: 700;
    margin: 0;
    color: var(--color-orange, #f97316);
  }

  .banner-reason {
    margin: 0 0 1rem;
    line-height: 1.5;
    font-size: 0.95rem;
  }

  .stale-draft-notice {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.875rem;
    background: rgba(245 158 11 / 0.1);
    border: 1px solid rgba(245 158 11 / 0.35);
    border-radius: calc(var(--radius, 8px) - 2px);
    color: var(--color-warning, #f59e0b);
    font-size: 0.8125rem;
    flex-wrap: wrap;
  }

  .stale-draft-notice span {
    flex: 1;
    min-width: 10rem;
  }

  .regen-btn {
    background: transparent;
    border: 1px solid rgba(245 158 11 / 0.5);
    color: var(--color-warning, #f59e0b);
    padding: 0.3rem 0.75rem;
    border-radius: calc(var(--radius, 8px) - 2px);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .regen-btn:hover:not(:disabled) {
    background: rgba(245 158 11 / 0.15);
  }

  .regen-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .reference-list {
    background: var(--color-surface-2, #22263a);
    border: 1px solid var(--color-border, #2e3348);
    border-radius: calc(var(--radius, 8px) - 2px);
    padding: 0.625rem 0.875rem;
    margin: 0 0 1rem;
    font-size: 0.875rem;
  }

  .reference-row {
    display: flex;
    gap: 1rem;
    padding: 0.2rem 0;
  }

  .reference-row dt {
    font-weight: 600;
    min-width: 8rem;
    color: var(--color-text-muted, #64748b);
    flex-shrink: 0;
  }

  .reference-row dd {
    margin: 0;
    flex: 1;
    word-break: break-word;
  }

  .input-label {
    display: block;
    font-size: 0.875rem;
    font-weight: 600;
    margin-bottom: 0.375rem;
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
    margin-bottom: 1rem;
    resize: vertical;
    box-sizing: border-box;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  textarea:focus {
    outline: none;
    border-color: var(--color-primary, #6366f1);
    box-shadow: 0 0 0 3px rgba(99 102 241 / 0.2);
  }

  textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error {
    color: var(--color-danger, #ef4444);
    font-size: 0.875rem;
    margin: 0 0 0.875rem;
  }

  .banner-actions {
    display: flex;
    gap: 0.625rem;
  }

  .btn-approve {
    background: var(--color-success, #10b981);
    color: #fff;
    padding: 0.5rem 1.25rem;
    border-radius: calc(var(--radius, 8px) - 2px);
    border: none;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9rem;
    transition: opacity 0.15s ease, transform 0.1s ease;
  }

  .btn-approve:hover:not(:disabled) {
    opacity: 0.88;
  }

  .btn-approve:not(:disabled):active {
    transform: scale(0.97);
  }

  .btn-approve:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .btn-skip {
    background: transparent;
    color: var(--color-text-muted, #64748b);
    padding: 0.5rem 1.25rem;
    border-radius: calc(var(--radius, 8px) - 2px);
    border: 1px solid var(--color-border, #2e3348);
    cursor: pointer;
    font-weight: 500;
    font-size: 0.9rem;
    transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
  }

  .btn-skip:hover:not(:disabled) {
    background: var(--color-surface-2, #22263a);
    color: var(--color-text, #e2e8f0);
  }

  .btn-skip:not(:disabled):active {
    transform: scale(0.97);
  }

  .btn-skip:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .sheet-link {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-primary, #6366f1);
    text-decoration: none;
    padding: 0.3rem 0.75rem;
    border: 1px solid rgba(99 102 241 / 0.35);
    border-radius: calc(var(--radius, 8px) - 2px);
    background: rgba(99 102 241 / 0.08);
    margin-bottom: 0.875rem;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .sheet-link:hover {
    background: rgba(99 102 241 / 0.16);
    border-color: rgba(99 102 241 / 0.55);
  }
</style>
