<!--
  /sheet-updates — Review sheet rule executions
  Shows pending and historical rule execution records with approve/reject/retry actions.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { sheetRulesApi } from "$lib/api";
  import type { SheetRuleExecution } from "$lib/api";

  type StatusFilter = "pending" | "approved" | "applied" | "rejected" | "failed" | "all";

  const TABS: { value: StatusFilter; label: string }[] = [
    { value: "pending", label: "Pending" },
    { value: "applied", label: "Applied" },
    { value: "rejected", label: "Rejected" },
    { value: "failed", label: "Failed" },
    { value: "all", label: "All" },
  ];

  let activeTab = $state<StatusFilter>("pending");
  let executions = $state<SheetRuleExecution[]>([]);
  let selected = $state<SheetRuleExecution | null>(null);
  let loading = $state(true);
  let actionLoading = $state(false);
  let error = $state<string | null>(null);
  let success = $state<string | null>(null);

  async function load(tab: StatusFilter = activeTab) {
    loading = true;
    error = null;
    try {
      const res = await sheetRulesApi.listExecutions(
        1,
        tab === "all" ? undefined : tab
      );
      executions = res.executions;
      // Keep selection in sync
      if (selected) {
        selected = executions.find((e) => e.id === selected!.id) ?? null;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load executions";
    } finally {
      loading = false;
    }
  }

  async function switchTab(tab: StatusFilter) {
    activeTab = tab;
    selected = null;
    await load(tab);
  }

  async function approve(execution: SheetRuleExecution) {
    actionLoading = true;
    error = null;
    try {
      const res = await sheetRulesApi.approveExecution(execution.id);
      success = "Execution approved and applied.";
      setTimeout(() => { success = null; }, 3000);
      await load();
      selected = executions.find((e) => e.id === res.execution.id) ?? null;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to approve";
    } finally {
      actionLoading = false;
    }
  }

  async function reject(execution: SheetRuleExecution) {
    actionLoading = true;
    error = null;
    try {
      const res = await sheetRulesApi.rejectExecution(execution.id);
      success = "Execution rejected.";
      setTimeout(() => { success = null; }, 3000);
      await load();
      selected = executions.find((e) => e.id === res.execution.id) ?? null;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to reject";
    } finally {
      actionLoading = false;
    }
  }

  async function retry(execution: SheetRuleExecution) {
    actionLoading = true;
    error = null;
    try {
      await sheetRulesApi.retryExecution(execution.id);
      success = "Execution queued for retry.";
      setTimeout(() => { success = null; }, 3000);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to retry";
    } finally {
      actionLoading = false;
    }
  }

  function statusClass(status: SheetRuleExecution["status"]) {
    if (status === "applied") return "success";
    if (status === "pending") return "warning";
    if (status === "failed") return "danger";
    if (status === "rejected") return "muted";
    return "info";
  }

  onMount(() => { load(); });
</script>

<svelte:head>
  <title>Sheet Updates — Email Dash</title>
</svelte:head>

<div class="page-header">
  <h1>Sheet Updates</h1>
  <span class="count">{executions.length} record{executions.length !== 1 ? "s" : ""}</span>
</div>

{#if error}
  <div class="error-banner">{error}</div>
{/if}

{#if success}
  <div class="success-banner">{success}</div>
{/if}

<div class="tabs">
  {#each TABS as tab}
    <button
      class="tab-btn"
      class:active={activeTab === tab.value}
      onclick={() => switchTab(tab.value)}
    >{tab.label}</button>
  {/each}
</div>

{#if loading}
  <div class="loading">Loading…</div>
{:else if executions.length === 0}
  <div class="empty">
    <p>No {activeTab === "all" ? "" : activeTab + " "}executions found.</p>
  </div>
{:else}
  <div class="review-layout">
    <!-- Left: execution list -->
    <div class="exec-list">
      {#each executions as exec (exec.id)}
        <button
          class="exec-item"
          class:selected={selected?.id === exec.id}
          onclick={() => { selected = exec; }}
        >
          <div class="exec-subject">{exec.thread_subject ?? "(no subject)"}</div>
          <div class="exec-meta">
            <span class="rule-name">{exec.rule_name}</span>
            <span class="exec-status exec-status-{statusClass(exec.status)}">{exec.status}</span>
          </div>
          <div class="exec-time">{new Date(exec.created_at).toLocaleString()}</div>
        </button>
      {/each}
    </div>

    <!-- Right: detail panel -->
    <div class="exec-detail">
      {#if selected}
        <div class="detail-header">
          <h2>{selected.thread_subject ?? "(no subject)"}</h2>
          <span class="exec-status exec-status-{statusClass(selected.status)} large">{selected.status}</span>
        </div>

        <div class="detail-meta">
          <div class="dm-item">
            <span class="dm-label">Rule</span>
            <span class="dm-value">{selected.rule_name}</span>
          </div>
          {#if selected.match_value}
            <div class="dm-item">
              <span class="dm-label">Matched value</span>
              <span class="dm-value mono">{selected.match_value}</span>
            </div>
          {/if}
          {#if selected.row_number}
            <div class="dm-item">
              <span class="dm-label">Row</span>
              <span class="dm-value mono">{selected.row_number}</span>
            </div>
          {/if}
          <div class="dm-item">
            <span class="dm-label">Created</span>
            <span class="dm-value">{new Date(selected.created_at).toLocaleString()}</span>
          </div>
          {#if selected.applied_at}
            <div class="dm-item">
              <span class="dm-label">Applied at</span>
              <span class="dm-value">{new Date(selected.applied_at).toLocaleString()}</span>
            </div>
          {/if}
        </div>

        {#if selected.proposed_updates && Object.keys(selected.proposed_updates).length > 0}
          <div class="updates-section">
            <h3>Proposed updates</h3>
            <table class="updates-table">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {#each Object.entries(selected.proposed_updates) as [col, val]}
                  <tr>
                    <td class="mono">{col}</td>
                    <td>{val}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}

        {#if selected.error}
          <div class="error-box">
            <span class="error-label">Error</span>
            <pre class="error-text">{selected.error}</pre>
          </div>
        {/if}

        {#if selected.status === "pending"}
          <div class="action-row">
            <button
              class="btn btn-primary"
              disabled={actionLoading}
              onclick={() => approve(selected!)}
            >
              {actionLoading ? "Processing…" : "Approve & Apply"}
            </button>
            <button
              class="btn btn-danger"
              disabled={actionLoading}
              onclick={() => reject(selected!)}
            >
              {actionLoading ? "Processing…" : "Reject"}
            </button>
          </div>
        {:else if selected.status === "failed"}
          <div class="action-row">
            <button
              class="btn btn-ghost"
              disabled={actionLoading}
              onclick={() => retry(selected!)}
            >
              {actionLoading ? "Processing…" : "Retry"}
            </button>
          </div>
        {/if}
      {:else}
        <div class="select-prompt">Select an execution to view details</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .page-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
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

  .success-banner {
    background: rgba(16 185 129 / 0.1);
    border: 1px solid rgba(16 185 129 / 0.3);
    border-radius: var(--radius);
    color: #6ee7b7;
    padding: 12px 16px;
    margin-bottom: 16px;
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 20px;
    border-bottom: 1px solid var(--color-border);
  }

  .tab-btn {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    padding: 8px 16px;
    margin-bottom: -1px;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab-btn:hover {
    color: var(--color-text);
  }

  .tab-btn.active {
    border-bottom-color: var(--color-primary);
    color: var(--color-text);
  }

  /* Layout */
  .review-layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 20px;
    align-items: start;
  }

  /* Execution list */
  .exec-list {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .exec-item {
    width: 100%;
    text-align: left;
    padding: 12px 14px;
    background: var(--color-surface);
    border: none;
    border-bottom: 1px solid var(--color-border);
    cursor: pointer;
    transition: background 0.15s;
  }

  .exec-item:last-child {
    border-bottom: none;
  }

  .exec-item:hover {
    background: var(--color-surface-2);
  }

  .exec-item.selected {
    background: rgba(99 102 241 / 0.1);
    border-left: 3px solid var(--color-primary);
  }

  .exec-subject {
    font-weight: 500;
    font-size: 13px;
    margin-bottom: 5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .exec-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 3px;
  }

  .rule-name {
    font-size: 11px;
    color: var(--color-text-muted);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .exec-time {
    font-size: 11px;
    color: var(--color-text-muted);
  }

  /* Status badges */
  .exec-status {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }

  .exec-status.large {
    font-size: 12px;
    padding: 3px 10px;
  }

  .exec-status-success {
    background: rgba(16 185 129 / 0.15);
    color: var(--color-success);
  }

  .exec-status-warning {
    background: rgba(245 158 11 / 0.15);
    color: var(--color-warning);
  }

  .exec-status-danger {
    background: rgba(239 68 68 / 0.15);
    color: var(--color-danger);
  }

  .exec-status-muted {
    background: rgba(100 116 139 / 0.15);
    color: var(--color-text-muted);
  }

  .exec-status-info {
    background: rgba(59 130 246 / 0.15);
    color: var(--color-info);
  }

  /* Detail */
  .exec-detail {
    min-height: 400px;
  }

  .select-prompt {
    padding: 60px 40px;
    text-align: center;
    color: var(--color-text-muted);
    font-size: 13px;
  }

  .detail-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 20px;
  }

  h2 {
    font-size: 18px;
    font-weight: 700;
    flex: 1;
  }

  .detail-meta {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
    padding: 16px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  .dm-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .dm-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .dm-value {
    font-size: 13px;
    font-weight: 500;
  }

  .dm-value.mono {
    font-family: var(--font-mono);
    font-size: 12px;
  }

  /* Updates table */
  .updates-section {
    margin-bottom: 20px;
  }

  h3 {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 10px;
  }

  .updates-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .updates-table th,
  .updates-table td {
    padding: 8px 12px;
    text-align: left;
    border-bottom: 1px solid var(--color-border);
  }

  .updates-table th {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: var(--color-surface);
  }

  .updates-table td.mono {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--color-primary);
  }

  /* Error box */
  .error-box {
    background: rgba(239 68 68 / 0.1);
    border: 1px solid rgba(239 68 68 / 0.3);
    border-radius: var(--radius);
    padding: 14px 16px;
    margin-bottom: 20px;
  }

  .error-label {
    display: block;
    font-size: 11px;
    font-weight: 700;
    color: var(--color-danger);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }

  .error-text {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--color-text);
    white-space: pre-wrap;
  }

  /* Actions */
  .action-row {
    display: flex;
    gap: 10px;
    margin-top: 20px;
    padding-top: 20px;
    border-top: 1px solid var(--color-border);
  }

  .btn-danger {
    background: rgba(239 68 68 / 0.15);
    border: 1px solid rgba(239 68 68 / 0.4);
    color: var(--color-danger);
    border-radius: var(--radius);
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-danger:hover:not(:disabled) {
    background: rgba(239 68 68 / 0.25);
  }

  .btn-danger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
