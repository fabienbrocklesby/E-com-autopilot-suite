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
	was_auto_sent: boolean;
	was_edited: boolean;
	final_body: string | null;
	sent_at: string | null;
	ai_model_used: string | null;
	created_at: string;
	updated_at: string;
}

export const threadsApi = {
	list(params?: { status?: string; limit?: number; offset?: number; workspaceId?: number }) {
		const qs = new URLSearchParams();
		qs.set('workspace_id', String(params?.workspaceId ?? 1));
		if (params?.status) qs.set('status', params.status);
		if (params?.limit !== undefined) qs.set('limit', String(params.limit));
		if (params?.offset !== undefined) qs.set('offset', String(params.offset));
		return request<{ threads: ThreadListItem[]; limit: number; offset: number }>(
			`/threads?${qs.toString()}`
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

	updateDraftStatus(threadId: number, draftId: number, status: Draft['status'], body?: string) {
		return request<{ draft: Draft }>(`/threads/${threadId}/drafts/${draftId}`, {
			method: 'PATCH',
			body: JSON.stringify({ status, ...(body !== undefined ? { body } : {}) })
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
	list(workspaceId = 1) {
		return request<{ categories: Category[] }>(`/categories?workspace_id=${workspaceId}`);
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

// ─── Workspaces ───────────────────────────────────────────────────────────────

export interface Workspace {
	id: number;
	name: string;
	gmail_address: string | null;
	sheet_id: string | null;
	sheet_name: string;
	created_at: string;
	updated_at: string;
}

export interface WorkspacePayload {
	name: string;
	gmail_address?: string;
	sheet_id?: string;
	sheet_name?: string;
}

export const workspacesApi = {
	list() {
		return request<{ workspaces: Workspace[] }>('/workspaces');
	},

	get(id: number) {
		return request<{ workspace: Workspace }>(`/workspaces/${id}`);
	},

	create(payload: WorkspacePayload) {
		return request<{ workspace: Workspace }>('/workspaces', {
			method: 'POST',
			body: JSON.stringify(payload)
		});
	},

	update(id: number, payload: Partial<WorkspacePayload>) {
		return request<{ workspace: Workspace }>(`/workspaces/${id}`, {
			method: 'PATCH',
			body: JSON.stringify(payload)
		});
	},

	syncLabels(id: number) {
		return request<{ synced: number }>(`/workspaces/${id}/sync-labels`, { method: 'POST' });
	}
};

// ─── Sheets ───────────────────────────────────────────────────────────────────

export interface SheetColumn {
	id: number;
	workspace_id: number;
	column_letter: string;
	header_name: string;
	created_at: string;
	updated_at: string;
}

export interface SheetUpdate {
	id: number;
	workspace_id: number;
	thread_id: number | null;
	column_letter: string;
	match_column: string;
	match_value: string;
	new_value: string;
	applied: boolean;
	error: string | null;
	created_at: string;
}

export const sheetsApi = {
	getColumns(workspaceId = 1) {
		return request<{ columns: SheetColumn[] }>(`/sheets/columns?workspace_id=${workspaceId}`);
	},

	syncColumns(workspaceId = 1) {
		return request<{ columns: Array<{ column_letter: string; header_name: string }> }>(
			`/sheets/sync-columns?workspace_id=${workspaceId}`,
			{ method: 'POST' }
		);
	},

	getUpdates(workspaceId = 1, limit = 50, offset = 0) {
		return request<{ updates: SheetUpdate[]; limit: number; offset: number }>(
			`/sheets/updates?workspace_id=${workspaceId}&limit=${limit}&offset=${offset}`
		);
	}
};

// ─── Labels ───────────────────────────────────────────────────────────────────

export const labelsApi = {
	sync(workspaceId = 1) {
		return request<{ synced: number }>(`/labels/sync?workspace_id=${workspaceId}`, {
			method: 'POST'
		});
	}
};

// ─── Sheet Rules ──────────────────────────────────────────────────────────────

export interface RuleUpdateDefinition {
	column: string;
	mode: 'fixed' | 'ai';
	value?: string;
	instruction?: string;
}

export interface SheetRule {
	id: number;
	workspace_id: number;
	name: string;
	description: string;
	is_active: boolean;
	category_ids: number[] | null;
	match_instruction: string;
	match_column: string;
	updates: RuleUpdateDefinition[];
	auto_apply: boolean;
	created_at: string;
	updated_at: string;
}

export interface SheetRulePayload {
	name: string;
	description: string;
	is_active: boolean;
	category_ids: number[] | null;
	match_instruction: string;
	match_column: string;
	updates: RuleUpdateDefinition[];
	auto_apply: boolean;
}

export interface SheetRuleExecution {
	id: number;
	workspace_id: number;
	rule_id: number;
	rule_name: string;
	thread_id: number | null;
	thread_subject: string | null;
	row_number: number | null;
	match_value: string | null;
	proposed_updates: Record<string, string>;
	status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';
	applied_at: string | null;
	error: string | null;
	created_at: string;
}

export const sheetRulesApi = {
	list(workspaceId = 1) {
		return request<{ rules: SheetRule[] }>(`/sheet-rules?workspace_id=${workspaceId}`);
	},

	get(id: number) {
		return request<{ rule: SheetRule }>(`/sheet-rules/${id}`);
	},

	create(payload: SheetRulePayload, workspaceId = 1) {
		return request<{ rule: SheetRule }>(`/sheet-rules?workspace_id=${workspaceId}`, {
			method: 'POST',
			body: JSON.stringify(payload)
		});
	},

	update(id: number, payload: SheetRulePayload) {
		return request<{ rule: SheetRule }>(`/sheet-rules/${id}`, {
			method: 'PUT',
			body: JSON.stringify(payload)
		});
	},

	patch(id: number, payload: Partial<SheetRulePayload>) {
		return request<{ rule: SheetRule }>(`/sheet-rules/${id}`, {
			method: 'PATCH',
			body: JSON.stringify(payload)
		});
	},

	delete(id: number) {
		return request<{ deleted: boolean }>(`/sheet-rules/${id}`, { method: 'DELETE' });
	},

	listExecutions(workspaceId = 1, status?: string, limit = 50, offset = 0) {
		const qs = new URLSearchParams({ workspace_id: String(workspaceId), limit: String(limit), offset: String(offset) });
		if (status) qs.set('status', status);
		return request<{ executions: SheetRuleExecution[]; limit: number; offset: number }>(
			`/sheet-rules/executions?${qs.toString()}`
		);
	},

	approveExecution(id: number) {
		return request<{ execution: SheetRuleExecution }>(`/sheet-rules/executions/${id}/approve`, {
			method: 'POST'
		});
	},

	rejectExecution(id: number) {
		return request<{ execution: SheetRuleExecution }>(`/sheet-rules/executions/${id}/reject`, {
			method: 'POST'
		});
	},

	retryExecution(id: number) {
		return request<{ execution: SheetRuleExecution }>(`/sheet-rules/executions/${id}/retry`, {
			method: 'POST'
		});
	}
};
// ─── Playbooks ────────────────────────────────────────────────────────────────

export type PlaybookStep = Record<string, unknown> & { id: string; type: string };

export interface Playbook {
        id: number;
        workspace_id: number;
        category_id: number | null;
        category_name?: string | null;
        name: string;
        plain_language_description: string | null;
        steps: PlaybookStep[];
        version: number;
        is_active: boolean;
        created_at: string;
        updated_at: string;
}

export interface PlaybookRun {
        id: number;
        workspace_id: number;
        thread_id: number;
        playbook_id: number;
        playbook_version: number;
        current_step_id: string | null;
        status: 'running' | 'waiting_for_customer' | 'waiting_for_human' | 'complete' | 'failed' | 'escalated';
        context: Record<string, unknown>;
        created_at: string;
        updated_at: string;
        playbook_name?: string;
        step_reason?: string | null;
	step_capture_input?: boolean | null;
	step_input_prompt?: string | null;
}

export interface StepExecution {
	id: number;
	run_id: number;
	step_id: string;
	step_type: string;
	status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
	input: Record<string, unknown> | null;
	output: Record<string, unknown> | null;
	error: string | null;
	ai_calls: Array<{ model: string; prompt: string; response: string; tokens: number }> | null;
	created_at: string;   completed_at: string | null;
}

export interface DryRunTraceEntry {
	stepId: string;
	stepType: string;
	status: 'success' | 'skipped' | 'paused' | 'failed';
	summary: string;
	extractedVars?: Record<string, unknown>;
	messageSent?: string;
	condition?: { expression: string; result: boolean };
	aiCall?: { prompt: string; response: string };
}
export interface DryRunResult {
        playbookId: number;
        playbookName: string;
        finalStatus: string;
        context: Record<string, unknown>;
        trace: DryRunTraceEntry[];
}

export const playbooksApi = {
        list(workspaceId = 1) {
                return request<{ playbooks: Playbook[] }>(`/playbooks?workspace_id=${workspaceId}`);
        },

        get(id: number) {
                return request<{ playbook: Playbook }>(`/playbooks/${id}`);
        },

        create(payload: { name: string; category_id?: number | null; plain_language_description?: string; steps?: PlaybookStep[] }) {
                return request<{ playbook: Playbook }>('/playbooks', {
                        method: 'POST',
                        body: JSON.stringify(payload)
                });
        },

        update(id: number, payload: { name?: string; category_id?: number | null; plain_language_description?: string; steps?: PlaybookStep[]; is_active?: boolean }) {
                return request<{ playbook: Playbook }>(`/playbooks/${id}`, {
                        method: 'PUT',
                        body: JSON.stringify(payload)
                });
        },

        delete(id: number) {
                return request<{ ok: boolean }>(`/playbooks/${id}`, { method: 'DELETE' });
        },

        parse(payload: { description: string; workspace_id?: number }) {
                return request<{ steps: PlaybookStep[]; warnings: string[] }>('/playbooks/parse', {
                        method: 'POST',
                        body: JSON.stringify(payload)
                });
        },

        dryRun(id: number, emailContent: string, workspaceId = 1) {
                return request<DryRunResult>(`/playbooks/${id}/dry-run?workspace_id=${workspaceId}`, {
                        method: 'POST',
                        body: JSON.stringify({ email_content: emailContent })
                });
        },

        activate(id: number) {
                return request<{ playbook: Playbook }>(`/playbooks/${id}/activate`, { method: 'POST' });
        },

        deactivate(id: number) {
                return request<{ playbook: Playbook }>(`/playbooks/${id}/deactivate`, { method: 'POST' });
        },

        listRuns(params: { thread_id?: number; playbook_id?: number; workspace_id?: number; status?: string }) {
                const qs = new URLSearchParams();
                if (params.thread_id !== undefined) qs.set('thread_id', String(params.thread_id));
                if (params.playbook_id !== undefined) qs.set('playbook_id', String(params.playbook_id));
                if (params.workspace_id !== undefined) qs.set('workspace_id', String(params.workspace_id));
                if (params.status) qs.set('status', params.status);
                return request<{ runs: PlaybookRun[] }>(`/playbooks/runs?${qs.toString()}`);
        },

        getRun(runId: number) {
                return request<{ run: PlaybookRun; executions: StepExecution[] }>(`/playbooks/runs/${runId}`);
        },

        approveRun(runId: number, input?: string) {
                return request<{ run: PlaybookRun }>(`/playbooks/runs/${runId}/approve`, {
                        method: 'POST',
                        body: input !== undefined ? JSON.stringify({ input }) : undefined
                });
        },

        rejectRun(runId: number) {
                return request<{ run: PlaybookRun }>(`/playbooks/runs/${runId}/reject`, { method: 'POST' });
        }
};
