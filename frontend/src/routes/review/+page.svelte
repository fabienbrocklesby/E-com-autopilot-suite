<!--
  /review — Manual reply queue
  Shows threads needing human review with draft approval UI.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { threadsApi } from '$lib/api';
	import type { ThreadListItem, ThreadDetail, Draft } from '$lib/api';

	let reviewThreads = $state<ThreadListItem[]>([]);
	let expandedThread = $state<ThreadDetail | null>(null);
	let loading = $state(true);
	let detailLoading = $state(false);
	let error = $state<string | null>(null);
	let successMessage = $state<string | null>(null);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await threadsApi.list({ status: 'in_review' });
			reviewThreads = res.threads;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load review queue';
		} finally {
			loading = false;
		}
	}

	async function openThread(id: number) {
		detailLoading = true;
		try {
			const res = await threadsApi.get(id);
			expandedThread = res.thread;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load thread';
		} finally {
			detailLoading = false;
		}
	}

	async function handleDraftAction(
		threadId: number,
		draftId: number,
		status: Draft['status']
	) {
		try {
			await threadsApi.updateDraftStatus(threadId, draftId, status);
			successMessage = `Draft ${status}.`;
			setTimeout(() => { successMessage = null; }, 3000);

			// Refresh the expanded thread view.
			if (expandedThread?.id === threadId) {
				expandedThread = (await threadsApi.get(threadId)).thread;
			}
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to update draft';
		}
	}

	onMount(() => { load(); });
</script>

<svelte:head>
	<title>Review Queue — Email Dash</title>
</svelte:head>

<div class="page-header">
	<h1>Review Queue</h1>
	<span class="count">{reviewThreads.length} pending</span>
</div>

{#if error}
	<div class="error-banner">{error}</div>
{/if}

{#if successMessage}
	<div class="success-banner">{successMessage}</div>
{/if}

{#if loading}
	<div class="loading">Loading review queue…</div>
{:else if reviewThreads.length === 0}
	<div class="empty">
		<div class="empty-icon">✓</div>
		<p>No threads need review right now.</p>
	</div>
{:else}
	<div class="review-layout">
		<div class="thread-list">
			{#each reviewThreads as thread (thread.id)}
				<button
					class="thread-item"
					class:selected={expandedThread?.id === thread.id}
					onclick={() => openThread(thread.id)}
				>
					<div class="thread-subject">{thread.subject || '(no subject)'}</div>
					<div class="thread-meta">
						{#if thread.category_name}
							<span class="category-badge">{thread.category_name}</span>
						{/if}
						{#if thread.draft_count > 0}
							<span class="draft-badge">{thread.draft_count} draft{thread.draft_count !== 1 ? 's' : ''}</span>
						{/if}
					</div>
				</button>
			{/each}
		</div>

		<div class="thread-detail">
			{#if detailLoading}
				<div class="loading">Loading thread…</div>
			{:else if expandedThread}
				<div class="detail-header">
					<h2>{expandedThread.subject || '(no subject)'}</h2>
					{#if expandedThread.category}
						<span class="category-badge">{expandedThread.category.name}</span>
					{/if}
				</div>

				<div class="messages-section">
					<h3>Messages</h3>
					{#each expandedThread.messages as message (message.id)}
						<div class="message" class:outbound={message.direction === 'outbound'}>
							<div class="message-header">
								<span class="from">{message.from_address}</span>
								<span class="date">{new Date(message.received_at).toLocaleString()}</span>
								<span class="direction-badge">{message.direction}</span>
							</div>
							<div class="message-body">{message.body_plain}</div>
						</div>
					{/each}
				</div>

				{#if expandedThread.drafts.length > 0}
					<div class="drafts-section">
						<h3>Drafts</h3>
						{#each expandedThread.drafts as draft (draft.id)}
							<div class="draft card">
								<div class="draft-status-row">
									<span class="draft-status draft-status-{draft.status}">{draft.status}</span>
									<span class="date">{new Date(draft.created_at).toLocaleString()}</span>
								</div>
								<pre class="draft-body">{draft.body}</pre>
								{#if draft.status === 'pending'}
									<div class="draft-actions">
										<button
											class="btn btn-primary"
											onclick={() => handleDraftAction(expandedThread!.id, draft.id, 'approved')}
										>
											Approve
										</button>
										<button
											class="btn btn-ghost"
											onclick={() => handleDraftAction(expandedThread!.id, draft.id, 'rejected')}
										>
											Reject
										</button>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			{:else}
				<div class="select-prompt">Select a thread to review</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.page-header {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 24px;
	}

	h1 {
		font-size: 22px;
		font-weight: 700;
	}

	.count {
		background: rgba(99 102 241 / 0.15);
		color: var(--color-primary);
		padding: 3px 10px;
		border-radius: 999px;
		font-size: 12px;
		font-weight: 600;
	}

	.loading,
	.empty {
		color: var(--color-text-muted);
		padding: 40px;
		text-align: center;
	}

	.empty-icon {
		font-size: 32px;
		margin-bottom: 12px;
		color: var(--color-success);
	}

	.success-banner {
		background: rgba(16 185 129 / 0.1);
		border: 1px solid rgba(16 185 129 / 0.3);
		border-radius: var(--radius);
		color: #6ee7b7;
		padding: 12px 16px;
		margin-bottom: 16px;
	}

	.review-layout {
		display: grid;
		grid-template-columns: 320px 1fr;
		gap: 20px;
		align-items: start;
	}

	.thread-list {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
	}

	.thread-item {
		width: 100%;
		text-align: left;
		padding: 14px 16px;
		background: var(--color-surface);
		border: none;
		border-bottom: 1px solid var(--color-border);
		cursor: pointer;
		transition: background 0.15s;
	}

	.thread-item:last-child {
		border-bottom: none;
	}

	.thread-item:hover {
		background: var(--color-surface-2);
	}

	.thread-item.selected {
		background: rgba(99 102 241 / 0.1);
		border-left: 3px solid var(--color-primary);
	}

	.thread-subject {
		font-weight: 500;
		font-size: 13px;
		margin-bottom: 6px;
	}

	.thread-meta {
		display: flex;
		gap: 6px;
	}

	.category-badge {
		background: rgba(99 102 241 / 0.15);
		color: var(--color-primary);
		padding: 2px 7px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 500;
	}

	.draft-badge {
		background: rgba(245 158 11 / 0.15);
		color: var(--color-warning);
		padding: 2px 7px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 500;
	}

	.thread-detail {
		min-height: 400px;
	}

	.detail-header {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 24px;
	}

	h2 {
		font-size: 18px;
		font-weight: 700;
	}

	h3 {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 12px;
	}

	.messages-section {
		margin-bottom: 28px;
	}

	.message {
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		padding: 14px 16px;
		margin-bottom: 10px;
		background: var(--color-surface);
	}

	.message.outbound {
		border-color: rgba(99 102 241 / 0.3);
		background: rgba(99 102 241 / 0.05);
	}

	.message-header {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 10px;
		font-size: 12px;
	}

	.from {
		font-weight: 600;
	}

	.date {
		color: var(--color-text-muted);
		margin-left: auto;
	}

	.direction-badge {
		background: var(--color-surface-2);
		padding: 1px 6px;
		border-radius: 4px;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.message-body {
		font-size: 13px;
		line-height: 1.6;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.draft {
		margin-bottom: 16px;
	}

	.draft-status-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 12px;
	}

	.draft-status {
		padding: 2px 8px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
	}

	.draft-status-pending  { background: rgba(245 158 11 / 0.15); color: var(--color-warning); }
	.draft-status-approved { background: rgba(16 185 129 / 0.15); color: var(--color-success); }
	.draft-status-rejected { background: rgba(239 68 68 / 0.15); color: var(--color-danger); }
	.draft-status-sent     { background: rgba(99 102 241 / 0.15); color: var(--color-primary); }

	.draft-body {
		font-family: var(--font);
		font-size: 13px;
		line-height: 1.7;
		white-space: pre-wrap;
		word-break: break-word;
		background: var(--color-surface-2);
		padding: 14px;
		border-radius: var(--radius);
		margin-bottom: 14px;
	}

	.draft-actions {
		display: flex;
		gap: 10px;
	}

	.select-prompt {
		color: var(--color-text-muted);
		text-align: center;
		padding: 80px 20px;
	}
</style>
