---
applyTo: "frontend/**"
---

# Frontend conventions (SvelteKit 5 with runes)

## Stack reminder

- SvelteKit 5 with **runes mode** (`$state`, `$derived`, `$effect`, `$props`)
- Vite for dev + build
- TypeScript everywhere
- API client in `src/lib/api.ts`
- Stores (legacy `writable`) in `src/lib/stores.ts`
- Bearer token in `localStorage` as `api_token`

## Runes — non-negotiable

Use runes. Do not write Svelte 4 syntax even if it would work.

```svelte
<script lang="ts">
  // State
  let count = $state(0);

  // Derived
  let doubled = $derived(count * 2);

  // Effects
  $effect(() => {
    console.log("count is now", count);
  });

  // Props
  let { initial = 0 }: { initial?: number } = $props();
</script>
```

Banned patterns:
- `let x = ...` for reactive state (use `$state`)
- `$: doubled = x * 2` (use `$derived`)
- `onMount(() => ...)` for reactive logic (use `$effect`)
- `export let prop` (use `$props`)

## Page structure

Every page lives in `src/routes/<path>/+page.svelte`. Pages do this in order:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$lib/api";
  import type { Thread } from "$lib/types";

  let threads = $state<Thread[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      threads = await api.threads.list();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load";
    } finally {
      loading = false;
    }
  }

  onMount(load);
</script>

{#if loading}
  <p>Loading…</p>
{:else if error}
  <p class="error">{error}</p>
{:else}
  <!-- content -->
{/if}
```

## API calls

Always go through `src/lib/api.ts`. If a route doesn't exist there yet, add it:

```ts
// In src/lib/api.ts
export const api = {
  threads: {
    list: () => fetchJson<Thread[]>("/threads"),
    get: (id: number) => fetchJson<Thread>(`/threads/${id}`),
    updateStatus: (id: number, status: string) =>
      fetchJson(`/threads/${id}/status`, { method: "PATCH", body: { status } }),
  },
  // ... etc
};
```

Never use `fetch()` directly in a component.

## Styling

Currently using inline `<style>` blocks per component with CSS variables defined in `+layout.svelte`. Don't introduce Tailwind, UnoCSS, or any other styling layer mid-project. Match existing patterns.

## State management

For now: local component state via runes for page-local stuff, `writable` stores in `src/lib/stores.ts` for cross-page state.

Don't refactor existing stores to runes. That's a separate project.

## Things to avoid

- No new top-level dependencies without checking they're truly needed
- No client-side routing libraries (SvelteKit handles it)
- No global event buses
- No setting up component libraries (we hand-roll components for now)
- No localStorage abuse — only `api_token` lives there
