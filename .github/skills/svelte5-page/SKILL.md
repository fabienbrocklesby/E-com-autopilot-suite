---
name: svelte5-page
description: How to build a SvelteKit 5 page using runes. Use when creating new pages or components in the frontend. Covers state, derived, effects, props, API integration, and styling.
---

# SvelteKit 5 Page Skill

## Runes — quick reference

```svelte
<script lang="ts">
  // State (replaces `let x = ...` for reactive vars)
  let count = $state(0);

  // Derived (replaces `$: doubled = count * 2`)
  let doubled = $derived(count * 2);
  
  // Multi-line derived
  let summary = $derived.by(() => {
    if (count === 0) return "Nothing yet";
    return `${count} things, doubled is ${count * 2}`;
  });

  // Effect (replaces onMount + manual reactive subscriptions)
  $effect(() => {
    console.log("count changed:", count);
    return () => {
      // cleanup
    };
  });

  // Props (replaces `export let prop`)
  let { initial = 0, label }: { initial?: number; label: string } = $props();

  // Bindable prop (parent can two-way bind)
  let { value = $bindable(0) }: { value?: number } = $props();
</script>
```

## Standard data-fetching page

```svelte
<!-- src/routes/examples/+page.svelte -->
<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$lib/api";
  import type { Example } from "$lib/types";

  let examples = $state<Example[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let count = $derived(examples.length);

  async function load() {
    loading = true;
    error = null;
    try {
      examples = await api.examples.list();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load";
    } finally {
      loading = false;
    }
  }

  onMount(load);
</script>

<svelte:head>
  <title>Examples</title>
</svelte:head>

<div class="page">
  <header>
    <h1>Examples</h1>
    <p>{count} total</p>
    <button onclick={load} disabled={loading}>Refresh</button>
  </header>

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if error}
    <p class="error">{error}</p>
    <button onclick={load}>Retry</button>
  {:else if examples.length === 0}
    <p class="muted">No examples yet</p>
  {:else}
    <ul class="list">
      {#each examples as example (example.id)}
        <li>
          <a href="/examples/{example.id}">{example.name}</a>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .page {
    padding: 1.5rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }
  .muted {
    color: var(--text-muted);
  }
  .error {
    color: var(--error);
  }
  .list {
    list-style: none;
    padding: 0;
  }
  .list li {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
  }
</style>
```

## Detail page with dynamic param

```svelte
<!-- src/routes/examples/[id]/+page.svelte -->
<script lang="ts">
  import { page } from "$app/state"; // Svelte 5 — NOT $app/stores
  import { onMount } from "svelte";
  import { api } from "$lib/api";

  let id = $derived(parseInt(page.params.id));
  let example = $state<Example | null>(null);
  let loading = $state(true);

  async function load() {
    loading = true;
    try {
      example = await api.examples.get(id);
    } finally {
      loading = false;
    }
  }

  // Re-load when id changes
  $effect(() => {
    if (!isNaN(id)) load();
  });
</script>

{#if loading}
  <p>Loading…</p>
{:else if !example}
  <p>Not found</p>
{:else}
  <h1>{example.name}</h1>
  <!-- ... -->
{/if}
```

## Component with bindable input

```svelte
<!-- src/lib/components/EditableField.svelte -->
<script lang="ts">
  let {
    value = $bindable(""),
    label,
    placeholder = ""
  }: { value?: string; label: string; placeholder?: string } = $props();
</script>

<label>
  <span>{label}</span>
  <input bind:value {placeholder} />
</label>
```

Used:
```svelte
<script>
  let name = $state("");
</script>
<EditableField bind:value={name} label="Name" />
```

## API integration

Always go through `src/lib/api.ts`. Add new endpoints there:

```ts
// src/lib/api.ts
const BASE = "http://localhost:8000"; // or import.meta.env

async function fetchJson<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const token = localStorage.getItem("api_token") ?? "";
  const res = await fetch(`${BASE}${path}`, {
    method: opts?.method ?? "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  examples: {
    list: () => fetchJson<Example[]>("/examples"),
    get: (id: number) => fetchJson<Example>(`/examples/${id}`),
    create: (data: Partial<Example>) => fetchJson<Example>("/examples", { method: "POST", body: data }),
    update: (id: number, data: Partial<Example>) => fetchJson<Example>(`/examples/${id}`, { method: "PUT", body: data }),
    delete: (id: number) => fetchJson<void>(`/examples/${id}`, { method: "DELETE" }),
  },
  // ... other resources
};
```

## Styling

- Component-scoped `<style>` blocks
- CSS variables defined in `src/routes/+layout.svelte`
- Common variables: `--bg`, `--bg-elevated`, `--text`, `--text-muted`, `--border`, `--accent`, `--error`, `--success`
- No external styling library

## Stores (legacy, for cross-page state)

We still use `writable` from `svelte/store` for things that need to persist across pages. Don't refactor these to runes:

```ts
// src/lib/stores.ts
import { writable } from "svelte/store";

export const apiToken = writable<string | null>(null);
```

In components:

```svelte
<script>
  import { apiToken } from "$lib/stores";
</script>

{#if $apiToken}
  Logged in
{/if}
```

## Banned

- `let x = ...` for reactive state — use `$state`
- `$: derived = x * 2` — use `$derived`
- `onMount(() => { /* reactive logic */ })` — use `$effect`
- `export let prop` — use `$props`
- `$app/stores` — use `$app/state` in Svelte 5
- Direct `fetch()` in components — use `api`
- New top-level dependencies without justification
- Tailwind/UnoCSS/styled-components — match existing patterns
