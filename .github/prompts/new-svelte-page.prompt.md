---
agent: 'agent'
description: 'Scaffold a new SvelteKit 5 page with proper structure, API integration, runes'
tools: ['search/codebase', 'edit']
---

# New SvelteKit page

Route path: ${input:route:Route path, e.g. /playbooks or /playbooks/[id]}
What it shows: ${input:purpose:Brief description}

## Steps

1. **Read `.github/instructions/frontend.instructions.md`** for SvelteKit 5 conventions.

2. **Check existing similar pages** for layout/styling patterns (e.g. `categories/+page.svelte`, `threads/[id]/+page.svelte`).

3. **Create `frontend/src/routes${input:route}/+page.svelte`** with:
   - Script with runes for state, derived, effect
   - Loading/error/content rendering states
   - Onmount data fetch
   - Reload function

4. **If new API endpoints needed**:
   - Add them to `frontend/src/lib/api.ts`
   - Add corresponding backend routes in `api/routes/`
   - Update `api/main.ts` if a new route file is added

5. **Add navigation entry** in `+layout.svelte` if this is a top-level page.

6. **Match the existing dark-theme styling**:
   - Use CSS variables from `+layout.svelte`
   - Component-scoped `<style>` blocks
   - No new styling library

7. **Verify with playwright MCP** if available:
   - Page loads
   - Data fetch succeeds (or shows error properly)
   - Interactions work

8. **Update `TASK_LOG.md`** if this page is part of a phase deliverable.
