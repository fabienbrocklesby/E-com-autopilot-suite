<!--
  Global error boundary - shown when a page throws an unhandled exception or
  a +layout/+page load function returns an error.
-->
<script lang="ts">
  import { page } from '$app/stores';
</script>

<svelte:head>
  <title>Error - Email Dash</title>
</svelte:head>

<div class="error-page">
  <div class="error-card">
    <div class="error-code">{$page.status}</div>
    <h1 class="error-title">
      {$page.status === 404 ? 'Page not found' : 'Something went wrong'}
    </h1>
    <p class="error-message">
      {$page.error?.message ?? 'An unexpected error occurred.'}
    </p>
    <div class="error-actions">
      <a href="/" class="btn btn-primary">Back to Threads</a>
      <button class="btn btn-ghost" onclick={() => window.history.back()}>Go back</button>
    </div>
  </div>
</div>

<style>
  .error-page {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
    padding: 40px;
  }

  .error-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 48px 56px;
    text-align: center;
    max-width: 480px;
    width: 100%;
  }

  .error-code {
    font-size: 64px;
    font-weight: 800;
    color: var(--color-primary);
    line-height: 1;
    margin-bottom: 12px;
    font-variant-numeric: tabular-nums;
  }

  .error-title {
    font-size: 22px;
    font-weight: 700;
    margin-bottom: 10px;
  }

  .error-message {
    color: var(--color-text-muted);
    margin-bottom: 28px;
    line-height: 1.5;
  }

  .error-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
  }
</style>
