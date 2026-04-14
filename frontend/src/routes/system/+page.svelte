<!--
  /system — Observability dashboard.
  Shows live stats: active runs, escalations, AI calls, ingestion failures, circuit breaker.
  Auto-refreshes every 30 seconds.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { systemApi } from '$lib/api';
  import type { SystemStats } from '$lib/api';
  import { workspaceStore } from '$lib/stores';

  let stats = $state<SystemStats | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let lastRefresh = $state<Date | null>(null);
  let resettingCB = $state(false);

  const workspaceId = $derived($workspaceStore);

  async function load() {
    try {
      stats = await systemApi.getStats(workspaceId);
      lastRefresh = new Date();
      error = null;
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  }

  async function resetCB() {
    resettingCB = true;
    try {
      await systemApi.resetCircuitBreaker();
      await load();
    } finally {
      resettingCB = false;
    }
  }

  let interval: ReturnType<typeof setInterval>;
  onMount(() => {
    load();
    interval = setInterval(load, 30_000);
  });
  onDestroy(() => clearInterval(interval));

  function fmt(n: number | undefined | null): string {
    if (n == null) return '—';
    return n.toLocaleString();
  }

  function fmtMs(ms: number | undefined | null): string {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  const STATUS_COLORS: Record<string, string> = {
    running: '#6366f1',
    waiting_for_customer: '#f59e0b',
    waiting_for_human: '#ec4899',
    retrying: '#8b5cf6',
  };
</script>

<svelte:head><title>System — Autopilot</title></svelte:head>

<div class="page">
  <div class="header">
    <h1>System</h1>
    <div class="header-right">
      {#if lastRefresh}
        <span class="refresh-info">Last refresh: {lastRefresh.toLocaleTimeString()} · Auto-refreshes every 30s</span>
      {/if}
      <button onclick={load} class="btn-secondary">Refresh now</button>
    </div>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {:else if loading && !stats}
    <div class="loading">Loading…</div>
  {:else if stats}
    <div class="grid">

      <!-- Active Runs -->
      <div class="card">
        <h2>Active Runs</h2>
        {#if Object.keys(stats.active_runs).length === 0}
          <p class="empty">No active runs</p>
        {:else}
          <div class="status-list">
            {#each Object.entries(stats.active_runs) as [status, count]}
              <div class="status-row">
                <span class="dot" style="background:{STATUS_COLORS[status] ?? '#94a3b8'}"></span>
                <span class="status-label">{status.replace(/_/g, ' ')}</span>
                <span class="count">{count}</span>
              </div>
            {/each}
          </div>
        {/if}
        <div class="stat-footer">
          Escalated (last 24h): <strong>{stats.escalated_last_24h}</strong>
        </div>
      </div>

      <!-- Step Timing -->
      <div class="card">
        <h2>Step Timing</h2>
        {#each [['1h', 'Last hour'], ['24h', 'Last 24h']] as [key, label]}
          {#if stats.step_timing[key]}
            <div class="timing-row">
              <span class="window-label">{label}</span>
              <span>avg <strong>{fmtMs(stats.step_timing[key].avg_ms)}</strong></span>
              <span>p95 <strong>{fmtMs(stats.step_timing[key].p95_ms)}</strong></span>
            </div>
          {/if}
        {/each}
        {#if Object.keys(stats.step_timing).length === 0}
          <p class="empty">No step data yet</p>
        {/if}
      </div>

      <!-- AI Calls -->
      <div class="card">
        <h2>AI Calls (last 24h)</h2>
        <div class="big-stat">{fmt(stats.ai_calls_24h.count)}</div>
        <div class="sub-stat">Total tokens: {fmt(stats.ai_calls_24h.total_tokens)}</div>
        <div class="cb-row">
          <span>Circuit breaker:</span>
          {#if stats.circuit_breaker.open}
            <span class="badge badge-red">OPEN</span>
            <button onclick={resetCB} disabled={resettingCB} class="btn-danger-sm">
              {resettingCB ? 'Resetting…' : 'Reset'}
            </button>
          {:else}
            <span class="badge badge-green">CLOSED</span>
          {/if}
          <span class="cb-failures">({stats.circuit_breaker.failureCount} recent failures)</span>
        </div>
      </div>

      <!-- Failed Ingestions -->
      <div class="card">
        <h2>Failed Ingestions</h2>
        <div class="big-stat">{stats.failed_ingestions.unresolved_count}</div>
        <div class="sub-stat">unresolved</div>
        {#if stats.failed_ingestions.recent.length > 0}
          <div class="ingestion-list">
            {#each stats.failed_ingestions.recent.slice(0, 5) as item}
              <div class="ingestion-row">
                <span class="msg-id" title={item.gmail_message_id}>{item.gmail_message_id.slice(0, 12)}…</span>
                <span class="attempt-count">attempt {item.attempt_count}</span>
              </div>
            {/each}
          </div>
          <a href="/system/failed-ingestions" class="view-all">View all →</a>
        {:else}
          <p class="empty">All ingestions healthy</p>
        {/if}
      </div>

      <!-- Rate Limit Buckets -->
      <div class="card card-wide">
        <h2>API Rate Limits</h2>
        {#if stats.rate_limit_buckets.length === 0}
          <p class="empty">No API calls recorded yet</p>
        {:else}
          <table class="rl-table">
            <thead>
              <tr><th>API</th><th>Tokens</th><th>Total calls</th><th>Last refilled</th></tr>
            </thead>
            <tbody>
              {#each stats.rate_limit_buckets as b}
                <tr>
                  <td>{b.api}</td>
                  <td>{b.tokens.toFixed(1)}</td>
                  <td>{fmt(b.calls_total)}</td>
                  <td>{new Date(b.last_refilled_at).toLocaleTimeString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

    </div>
  {/if}
</div>

<style>
  .page { padding: 2rem; max-width: 1200px; margin: 0 auto; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
  .header h1 { margin: 0; font-size: 1.5rem; }
  .header-right { display: flex; align-items: center; gap: 1rem; }
  .refresh-info { font-size: 0.8rem; color: #64748b; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1.25rem; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.25rem; }
  .card-wide { grid-column: span 2; }
  .card h2 { margin: 0 0 1rem; font-size: 0.95rem; font-weight: 600; color: #374151; text-transform: uppercase; letter-spacing: 0.05em; }
  .status-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .status-row { display: flex; align-items: center; gap: 0.5rem; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .status-label { flex: 1; font-size: 0.9rem; color: #374151; }
  .count { font-weight: 600; font-size: 1rem; }
  .stat-footer { margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid #f1f5f9; font-size: 0.85rem; color: #64748b; }
  .timing-row { display: flex; align-items: center; gap: 1rem; padding: 0.4rem 0; border-bottom: 1px solid #f1f5f9; font-size: 0.88rem; }
  .window-label { font-weight: 600; min-width: 60px; }
  .big-stat { font-size: 2.5rem; font-weight: 700; color: #1e293b; line-height: 1; }
  .sub-stat { font-size: 0.85rem; color: #64748b; margin-top: 0.25rem; margin-bottom: 1rem; }
  .cb-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem; font-size: 0.85rem; }
  .cb-failures { color: #94a3b8; }
  .badge { padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 700; }
  .badge-red { background: #fee2e2; color: #dc2626; }
  .badge-green { background: #d1fae5; color: #059669; }
  .btn-danger-sm { padding: 0.2rem 0.5rem; background: #dc2626; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.75rem; }
  .btn-danger-sm:hover { background: #b91c1c; }
  .btn-secondary { padding: 0.4rem 0.75rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
  .btn-secondary:hover { background: #f1f5f9; }
  .ingestion-list { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.75rem; }
  .ingestion-row { display: flex; gap: 0.75rem; font-size: 0.82rem; }
  .msg-id { font-family: monospace; color: #475569; }
  .attempt-count { color: #ef4444; }
  .view-all { font-size: 0.85rem; color: #6366f1; text-decoration: none; }
  .view-all:hover { text-decoration: underline; }
  .rl-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  .rl-table th { text-align: left; padding: 0.4rem 0.75rem; background: #f8fafc; font-weight: 600; color: #64748b; font-size: 0.8rem; }
  .rl-table td { padding: 0.5rem 0.75rem; border-top: 1px solid #f1f5f9; }
  .empty { color: #94a3b8; font-size: 0.9rem; margin: 0; }
  .loading { color: #94a3b8; }
  .error { background: #fee2e2; color: #dc2626; padding: 0.75rem; border-radius: 6px; }
</style>
