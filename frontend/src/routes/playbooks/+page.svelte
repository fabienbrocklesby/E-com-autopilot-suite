<!--
  /playbooks — Playbook list
  Table of all playbooks for the workspace. Create, edit, activate/deactivate, delete.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { playbooksApi, categoriesApi } from "$lib/api";
  import type { Playbook, Category } from "$lib/api";

  let playbooks = $state<Playbook[]>([]);
  let categories = $state<Category[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let success = $state<string | null>(null);
  let creating = $state(false);

  async function load() {
    loading = true;
    error = null;
    try {
      const [pbRes, catRes] = await Promise.all([
        playbooksApi.list(),
        categoriesApi.list(),
      ]);
      playbooks = pbRes.playbooks;
      categories = catRes.categories;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load playbooks";
    } finally {
      loading = false;
    }
  }

  async function createNew() {
    creating = true;
    error = null;
    try {
      const res = await playbooksApi.create({ name: "New Playbook" });
      goto(`/playbooks/${res.playbook.id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to create playbook";
      creating = false;
    }
  }

  async function duplicate(pb: Playbook) {
    error = null;
    try {
      const res = await playbooksApi.create({
        name: `${pb.name} (copy)`,
        category_id: pb.category_id,
        plain_language_description: pb.plain_language_description ?? undefined,
        steps: pb.steps,
      });
      flash(`Duplicated as "${res.playbook.name}"`);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to duplicate";
    }
  }

  async function toggleActive(pb: Playbook) {
    error = null;
    try {
      if (pb.is_active) {
        await playbooksApi.deactivate(pb.id);
        flash("Playbook deactivated.");
      } else {
        await playbooksApi.activate(pb.id);
        flash("Playbook activated.");
      }
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to toggle active state";
    }
  }

  async function deletePlaybook(pb: Playbook) {
    if (!confirm(`Delete "${pb.name}"? This cannot be undone.`)) return;
    error = null;
    try {
      await playbooksApi.delete(pb.id);
      flash(`Deleted "${pb.name}".`);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to delete";
    }
  }

  function flash(msg: string) {
    success = msg;
    setTimeout(() => { success = null; }, 3000);
  }

  function categoryName(id: number | null) {
    if (id === null) return "—";
    return categories.find((c) => c.id === id)?.name ?? "Unknown";
  }

  onMount(load);
</script>

<svelte:head>
  <title>Playbooks — Email Dash</title>
</svelte:head>

<div class="page-header">
  <h1>Playbooks</h1>
  <button class="btn btn-primary" onclick={createNew} disabled={creating}>
    {creating ? "Creating…" : "+ New Playbook"}
  </button>
</div>

{#if error}
  <div class="error-banner">{error}</div>
{/if}
{#if success}
  <div class="success-banner">{success}</div>
{/if}

{#if loading}
  <div class="loading">Loading playbooks…</div>
{:else if playbooks.length === 0}
  <div class="empty">
    <p>No playbooks yet. Create one to automate your email handling.</p>
    <button class="btn btn-primary" onclick={createNew} disabled={creating}>
      {creating ? "Creating…" : "+ New Playbook"}
    </button>
  </div>
{:else}
  <div class="table-wrap card">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Category</th>
          <th>Version</th>
          <th>Steps</th>
          <th>Active</th>
          <th>Last edited</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each playbooks as pb (pb.id)}
          <tr>
            <td>
              <a href="/playbooks/{pb.id}" class="name-link">{pb.name}</a>
            </td>
            <td class="text-muted">{categoryName(pb.category_id)}</td>
            <td class="text-muted">v{pb.version}</td>
            <td class="text-muted">{pb.steps.length}</td>
            <td>
              <span class="badge" class:active={pb.is_active} class:inactive={!pb.is_active}>
                {pb.is_active ? "Active" : "Inactive"}
              </span>
            </td>
            <td class="text-muted">{new Date(pb.updated_at).toLocaleDateString()}</td>
            <td class="actions">
              <a href="/playbooks/{pb.id}" class="btn-action">Edit</a>
              <button class="btn-action" onclick={() => duplicate(pb)}>Duplicate</button>
              <button class="btn-action" onclick={() => toggleActive(pb)}>
                {pb.is_active ? "Deactivate" : "Activate"}
              </button>
              <button class="btn-action danger" onclick={() => deletePlaybook(pb)}>Delete</button>
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
    margin-bottom: 24px;
  }

  h1 {
    font-size: 22px;
    font-weight: 700;
  }

  .loading {
    color: var(--color-text-muted);
    padding: 40px;
    text-align: center;
  }

  .empty {
    text-align: center;
    padding: 60px 20px;
    color: var(--color-text-muted);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  .table-wrap {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  th {
    text-align: left;
    padding: 10px 14px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    border-bottom: 1px solid var(--color-border);
  }

  td {
    padding: 12px 14px;
    border-bottom: 1px solid var(--color-border);
    vertical-align: middle;
  }

  tr:last-child td {
    border-bottom: none;
  }

  .text-muted {
    color: var(--color-text-muted);
  }

  .name-link {
    color: var(--color-text);
    text-decoration: none;
    font-weight: 600;
  }

  .name-link:hover {
    color: var(--color-primary);
  }

  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .badge.active {
    background: rgba(16 185 129 / 0.15);
    color: var(--color-success);
  }

  .badge.inactive {
    background: rgba(100 116 139 / 0.15);
    color: var(--color-text-muted);
  }

  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: nowrap;
  }

  .btn-action {
    background: none;
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    text-decoration: none;
    display: inline-block;
    line-height: 1.4;
    white-space: nowrap;
  }

  .btn-action:hover {
    background: var(--color-surface-2);
    color: var(--color-text);
  }

  .btn-action.danger:hover {
    background: rgba(239 68 68 / 0.15);
    border-color: rgba(239 68 68 / 0.4);
    color: var(--color-danger);
  }

  .success-banner {
    background: rgba(16 185 129 / 0.1);
    border: 1px solid rgba(16 185 129 / 0.3);
    border-radius: var(--radius);
    color: #6ee7b7;
    padding: 12px 16px;
    margin-bottom: 16px;
  }
</style>
