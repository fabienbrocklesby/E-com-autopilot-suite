/**
 * Typed API client for the email-dash backend.
 * All fetch calls funnel through here for consistent error handling and base URL.
 */
import { PUBLIC_API_BASE_URL } from '$env/static/public';

const BASE_URL = PUBLIC_API_BASE_URL;

export interface ApiError {
	message: string;
	detail?: string;
	status: number;
}

export class ApiRequestError extends Error {
	constructor(public readonly error: ApiError) {
		super(error.message);
		this.name = 'ApiRequestError';
	}
}

async function request<T>(
	path: string,
	options: RequestInit = {}
): Promise<T> {
	const token = typeof localStorage !== 'undefined'
		? localStorage.getItem('api_token') ?? ''
		: '';

	const res = await fetch(`${BASE_URL}${path}`, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...options.headers
		}
	});

	const data = await res.json();

	if (!res.ok) {
		const err = (data as { error: ApiError }).error ?? {
			message: 'Unknown error',
			status: res.status
		};
		throw new ApiRequestError(err);
	}

	return data as T;
}

// ─── Threads ──────────────────────────────────────────────────────────────────

export interface ThreadListItem {
	id: number;
	gmail_thread_id: string;
	subject: string;
	snippet: string;
	category_id: number | null;
	category_name: string | null;
	status: string;
	auto_replied: boolean;
	draft_count: number;
	created_at: string;
	updated_at: string;
}

export interface ThreadDetail extends Omit<ThreadListItem, 'draft_count' | 'category_name'> {
	messages: Message[];
	drafts: Draft[];
	category: Category | null;
}

export interface Message {
	id: number;
	thread_id: number;
	gmail_message_id: string;
	from_address: string;
	body_plain: string;
	body_html: string;
	received_at: string;
	direction: 'inbound' | 'outbound';
}

export interface Draft {
	id: number;
	thread_id: number;
	body: string;
	status: 'pending' | 'approved' | 'rejected' | 'sent';
	created_at: string;
	updated_at: string;
}

export const threadsApi = {
	list(params?: { status?: string; limit?: number; offset?: number }) {
		const qs = new URLSearchParams();
		if (params?.status) qs.set('status', params.status);
		if (params?.limit !== undefined) qs.set('limit', String(params.limit));
		if (params?.offset !== undefined) qs.set('offset', String(params.offset));
		const query = qs.toString() ? `?${qs.toString()}` : '';
		return request<{ threads: ThreadListItem[]; limit: number; offset: number }>(
			`/threads${query}`
		);
	},

	get(id: number) {
		return request<{ thread: ThreadDetail }>(`/threads/${id}`);
	},

	updateStatus(id: number, status: string) {
		return request<{ thread: ThreadDetail }>(`/threads/${id}/status`, {
			method: 'PATCH',
			body: JSON.stringify({ status })
		});
	},

	categorise(id: number) {
		return request<{
			categoryId: number | null;
			confidence: number;
			reasoning: string;
			draftCreated: boolean;
		}>(`/threads/${id}/categorise`, { method: 'POST' });
	},

	updateDraftStatus(threadId: number, draftId: number, status: Draft['status']) {
		return request<{ draft: Draft }>(`/threads/${threadId}/drafts/${draftId}`, {
			method: 'PATCH',
			body: JSON.stringify({ status })
		});
	}
};

// ─── Categories ───────────────────────────────────────────────────────────────

export interface Category {
	id: number;
	name: string;
	description: string;
	instructions: string;
	allow_auto_reply: boolean;
	confidence_threshold: number;
	writing_style: string;
	created_at: string;
	updated_at: string;
}

export interface CategoryPayload {
	name: string;
	description: string;
	instructions: string;
	allow_auto_reply: boolean;
	confidence_threshold: number;
	writing_style: string;
}

export const categoriesApi = {
	list() {
		return request<{ categories: Category[] }>('/categories');
	},

	get(id: number) {
		return request<{ category: Category }>(`/categories/${id}`);
	},

	create(payload: CategoryPayload) {
		return request<{ category: Category }>('/categories', {
			method: 'POST',
			body: JSON.stringify(payload)
		});
	},

	update(id: number, payload: CategoryPayload) {
		return request<{ category: Category }>(`/categories/${id}`, {
			method: 'PUT',
			body: JSON.stringify(payload)
		});
	},

	delete(id: number) {
		return request<{ deleted: boolean }>(`/categories/${id}`, { method: 'DELETE' });
	}
};

// ─── Settings ─────────────────────────────────────────────────────────────────

export const settingsApi = {
	getAll() {
		return request<{ settings: Record<string, string> }>('/settings');
	},

	set(key: string, value: string) {
		return request<{ setting: { key: string; value: string } }>(`/settings/${key}`, {
			method: 'PUT',
			body: JSON.stringify({ value })
		});
	}
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
	status() {
		return request<{ connected: boolean; email: string | null; expiry: string | null }>(
			'/auth/status'
		);
	},

	/** Returns the OAuth start URL the user should be redirected to. */
	startOAuthUrl(): string {
		return `${BASE_URL}/auth/google/start`;
	}
};
