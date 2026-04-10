<!--
  / — Main threads dashboard
  Lists all threads with status filter, category, and reply state.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { threadsApi } from "$lib/api";
  import { threadsStore } from "$lib/stores";
  import type { ThreadListItem } from "$lib/api";

  const STATUSES = ["all", "new", "in_review", "replied", "ignored", "closed"];
  let selectedStatus = $state<string>("all");
  let threads = $state<ThreadListItem[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function loadThreads(status?: string) {
    loading = true;
    error = null;
    try {
      const res = await threadsApi.list(
        status && status !== "all" ? { status } : undefined,
      );
      threads = res.threads;
      threadsStore.update((s) => ({ ...s, items: res.threads }));
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load threads";
    } finally {
      loading = false;
    }
  }

  async function handleStatusChange(status: string) {
    selectedStatus = status;
    await loadThreads(status === "all" ? undefined : status);
  }

  async function updateThreadStatus(thread: ThreadListItem, newStatus: string) {
    try {
      await threadsApi.updateStatus(thread.id, newStatus);
      threads = threads.map((t) =>
        t.id === thread.id ? { ...t, status: newStatus } : t,
      );
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to update status";
    }
  }

  onMount(() => {
    loadThreads();
  });
</script>

<svelte:head>
  <title>Threads — Email Dash</title>
</svelte:head>

<div class="page-header">
  <h1>Threads</h1>
  <button
    class="btn btn-ghost"
    onclick={() =>
      loadThreads(selectedStatus === "all" ? undefined : selectedStatus)}
  >
    ↻ Refresh
  </button>
</div>

<div class="filters">
  {#each STATUSES as status}
    <button
      class="filter-btn"
      class:active={selectedStatus === status}
      onclick={() => handleStatusChange(status)}
    >
      {status}
    </button>
  {/each}
</div>

{#if error}
  <div class="error-banner">{error}</div>
{/if}

{#if loading}
  <div class="loading">Loading threads…</div>
{:else if threads.length === 0}
  <div class="empty">No threads found.</div>
{:else}
  <div class="threads-table-wrapper">
    <table class="threads-table">
      <thead>
        <tr>
          <th>Subject</th>
          <th>Category</th>
          <th>Status</th>
          <th>Auto-replied</th>
          <th>Drafts</th>
          <th>Received</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each threads as thread (thread.id)}
          <tr>
            <td class="subject-cell">
              <a href="/threads/{thread.id}"
                >{thread.subject || "(no subject)"}</a
              >
              <div class="snippet">{thread.snippet}</div>
            </td>
            <td>
              {#if thread.category_name}
                <span class="category-tag">{thread.category_name}</span>
              {:else}
                <span class="text-muted">—</span>
              {/if}
            </td>
            <td>
              <span class="badge badge-{thread.status}">{thread.status}</span>
            </td>
            <td class="center">
              {thread.auto_replied ? "✓" : "—"}
            </td>
            <td class="center">
              {thread.draft_count > 0
                ? `${thread.draft_count} draft${thread.draft_count !== 1 ? "s" : ""}`
                : "—"}
            </td>
            <td class="date-cell">
              {new Date(thread.created_at).toLocaleDateString()}
            </td>
            <td>
              <div class="row-actions">
                <a class="btn btn-ghost btn-sm" href="/threads/{thread.id}"
                  >View</a
                >
                {#if thread.status !== "in_review"}
                  <button
                    class="btn btn-ghost btn-sm"
                    onclick={() => updateThreadStatus(thread, "in_review")}
                  >
                    Review
                  </button>
                {/if}
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  h1 {
    font-size: 22px;
    font-weight: 700;
  }

  .filters {
    display: flex;
    gap: 6px;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }

  .filter-btn {
    padding: 5px 14px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: transparent;
    color: var(--color-text-muted);
    font-size: 12px;
    font-weight: 500;
    text-transform: capitalize;
    transition: all 0.15s;
  }

  .filter-btn:hover,
  .filter-btn.active {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: #fff;
  }

  .loading,
  .empty {
    color: var(--color-text-muted);
    padding: 40px;
    text-align: center;
  }

  .threads-table-wrapper {
    overflow-x: auto;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }

  .threads-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .threads-table thead {
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }

  .threads-table th {
    padding: 10px 16px;
    text-align: left;
    font-weight: 600;
    color: var(--color-text-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .threads-table td {
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border);
    vertical-align: top;
  }

  .threads-table tbody tr:last-child td {
    border-bottom: none;
  }

  .threads-table tbody tr:hover {
    background: var(--color-surface);
  }

  .subject-cell a {
    font-weight: 500;
    color: var(--color-text);
  }

  .subject-cell a:hover {
    color: var(--color-primary);
  }

  .snippet {
    color: var(--color-text-muted);
    font-size: 12px;
    margin-top: 2px;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .category-tag {
    background: rgba(99 102 241 / 0.15);
    color: var(--color-primary);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
  }

  .text-muted {
    color: var(--color-text-muted);
  }

  .center {
    text-align: center;
  }

  .date-cell {
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .row-actions {
    display: flex;
    gap: 6px;
  }

  :global(.btn-sm) {
    padding: 3px 10px !important;
    font-size: 12px !important;
  }
</style>
