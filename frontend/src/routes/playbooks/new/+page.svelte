<!--
  /playbooks/new - Creates a new blank playbook and redirects to its editor.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { playbooksApi } from "$lib/api";

  let error = $state<string | null>(null);
  let creating = $state(true);

  onMount(async () => {
    try {
      const params = new URLSearchParams($page.url.search);
      const categoryId = params.get("category_id");
      if (!categoryId) {
        throw new Error("category_id is required to create a playbook");
      }
      const res = await playbooksApi.create({
        name: "New Playbook",
        category_id: parseInt(categoryId, 10),
      });
      goto(`/playbooks/${res.playbook.id}`, { replaceState: true });
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to create playbook";
      creating = false;
    }
  });
</script>

<svelte:head>
  <title>New Playbook</title>
</svelte:head>

<div class="page">
  {#if error}
    <div class="error-banner">{error}</div>
    <a href="/playbooks" class="btn btn-ghost">Back to Playbooks</a>
  {:else}
    <p class="creating">Creating playbook...</p>
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 4rem 2rem;
    gap: 1rem;
  }
  .creating {
    color: var(--color-text-muted);
    font-size: 0.875rem;
  }
</style>
