/**
 * Svelte stores for global application state.
 */
import { writable, derived } from 'svelte/store';
import type { ThreadListItem, Category } from '$lib/api';

// ─── Threads ──────────────────────────────────────────────────────────────────

export interface ThreadsState {
	items: ThreadListItem[];
	loading: boolean;
	error: string | null;
	statusFilter: string | null;
	limit: number;
	offset: number;
}

export const threadsStore = writable<ThreadsState>({
	items: [],
	loading: false,
	error: null,
	statusFilter: null,
	limit: 50,
	offset: 0
});

// ─── Categories ───────────────────────────────────────────────────────────────

export const categoriesStore = writable<{
	items: Category[];
	loading: boolean;
	error: string | null;
}>({
	items: [],
	loading: false,
	error: null
});

// ─── Settings ─────────────────────────────────────────────────────────────────

export const settingsStore = writable<{
	values: Record<string, string>;
	loading: boolean;
	error: string | null;
}>({
	values: {},
	loading: false,
	error: null
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const authStore = writable<{
	connected: boolean;
	email: string | null;
	expiry: string | null;
	loading: boolean;
}>({
	connected: false,
	email: null,
	expiry: null,
	loading: false
});

// ─── Derived stores ───────────────────────────────────────────────────────────

/** Threads pending human review (status = 'in_review' or has a pending draft). */
export const reviewQueueStore = derived(threadsStore, ($threads) =>
	$threads.items.filter(
		(t) => t.status === 'in_review' || (t.draft_count > 0 && t.status !== 'replied')
	)
);
