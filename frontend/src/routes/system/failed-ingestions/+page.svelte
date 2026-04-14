<!--
  /system/failed-ingestions — Failed email ingestion admin.
  Lists unresolved DLQ entries with retry buttons.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { systemApi } from '$lib/api';
  import type { FailedIngestion } from '$lib/api';
  import { workspaceStore } from '$lib/stores';

  let ingestions = $state<FailedIngestion[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let showResolved = $state(false);
  let retrying = $state<Set<number>>(new Set());

  const workspaceId = $derived($workspaceStore);

  async function load() {
    loading = true;
    try {
      const result = await systemApi.getFailedIngestions(workspaceId, showResolved);
      ingestions = result.ingestions;
      error = null;
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  }

  async function retry(id: number) {
    retrying = new Set([...retrying, id]);
    try {
      await systemApi.retryIngestion(id);
      await load();
    } catch (err) {
      error = String(err);
    } finally {
      retrying = new Set([...retrying].filter((x) => x !== id));
    }
  }

  onMount(load);

  $effect(() => {
    workspaceId;
    showResolved;
    load();
  });
</script>

<svelte:head><title>Failed Ingestions — Autopilot</title></svelte:head>

<div class="page">
  <div class="header">
    <div>
      <a href="/system" class="back">← System</a>
      <h1>Failed Ingestions</h1>
    </div>
    <div class="controls">
      <label class="toggle">
        <input type="checkbox" bind:checked={showResolved} />
        Show resolved
      </label>
      <button onclick={load} class="btn-secondary">Refresh</button>
    </div>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {:else if loading}
    <div class="loading">Loading…</div>
  {:else if ingestions.length === 0}
    <div class="empty">No {showResolved ? '' : 'unresolved '}failed ingestions — all healthy.</div>
  {:else}
    <table class="table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Gmail Message</th>
          <th>Gmail Thread</th>
          <th>Error</th>
          <th>Attempts</th>
          <th>Last attempt</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each ingestions as item}
          <tr class:resolved={item.resolved}>
            <td>{item.id}</td>
            <td class="mono" title={item.gmail_message_id}>{item.gmail_message_id.slice(0, 16)}…</td>
            <td class="mono" title={item.gmail_thread_id}>{item.gmail_thread_id.slice(0, 16)}…</td>
            <td class="error-cell" title={item.error}>{item.error.slice(0, 60)}{item.error.length > 60 ? '…' : ''}</td>
            <td>{item.attempt_count}</td>
            <td>{new Date(item.last_attempt_at).toLocaleString()}</td>
            <td>
              {#if item.resolved}
                <span class="badge badge-green">resolved</span>
              {:else}
                <span class="badge badge-red">unresolved</span>
              {/if}
            </td>
            <td>
              {#if !item.resolved}
                <button
                  onclick={() => retry(item.id)}
                  disabled={retrying.has(item.id)}
                  class="btn-retry"
                >
                  {retrying.has(item.id) ? 'Retrying…' : 'Retry'}
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .page { padding: 2rem; max-width: 1200px; margin: 0 auto; }
  .header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1.5rem; }
  .header h1 { margin: 0.25rem 0 0; font-size: 1.4rem; }
  .back { font-size: 0.85rem; color: #6366f1; text-decoration: none; }
  .back:hover { text-decoration: underline; }
  .controls { display: flex; align-items: center; gap: 1rem; }
  .toggle { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; cursor: pointer; }
  .btn-secondary { padding: 0.4rem 0.75rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
  .table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  .table th { text-align: left; padding: 0.5rem 0.75rem; background: #f8fafc; font-weight: 600; color: #64748b; border-bottom: 2px solid #e2e8f0; }
  .table td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .table tr.resolved { opacity: 0.5; }
  .mono { font-family: monospace; font-size: 0.82rem; }
  .error-cell { color: #dc2626; max-width: 200px; word-break: break-word; }
  .badge { padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
  .badge-red { background: #fee2e2; color: #dc2626; }
  .badge-green { background: #d1fae5; color: #059669; }
  .btn-retry { padding: 0.25rem 0.6rem; background: #6366f1; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.82rem; }
  .btn-retry:hover { background: #4f46e5; }
  .btn-retry:disabled { background: #94a3b8; cursor: wait; }
  .empty { color: #94a3b8; padding: 2rem 0; }
  .loading { color: #94a3b8; }
  .error { background: #fee2e2; color: #dc2626; padding: 0.75rem; border-radius: 6px; margin-bottom: 1rem; }
</style>
