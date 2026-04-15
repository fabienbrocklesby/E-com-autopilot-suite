<script lang="ts">
	import { page } from '$app/stores';
        import { onMount, onDestroy } from 'svelte';
        import type { Snippet } from 'svelte';
        import { workspacesApi, type Workspace } from '$lib/api';
        import { workspaceStore } from '$lib/stores';
		import { Inbox, BookOpen, Settings } from '@lucide/svelte';

        let { children }: { children: Snippet } = $props();

        let workspaces = $state<Workspace[]>([]);
        let selectedId = $state(1);

        // Sync store → local state
        const unsubWs = workspaceStore.subscribe((id) => { selectedId = id; });

        onMount(async () => {
                try {
                        const res = await workspacesApi.list();
                        workspaces = res.workspaces;
                        if (!workspaces.find((w) => w.id === selectedId) && workspaces.length > 0) {
                                workspaceStore.set(workspaces[0].id);
                        }
                } catch {
                        // Non-critical; layout still functions without the list.
                }
        });

        onDestroy(() => unsubWs());

        function onWorkspaceChange(event: Event) {
                const id = parseInt((event.target as HTMLSelectElement).value, 10);
                if (Number.isFinite(id)) workspaceStore.set(id);
        }

        function isActive(href: string, pathname: string): boolean {
                if (href === '/') return pathname === '/' || pathname === '/inbox';
                return pathname.startsWith(href);
        }

        const navLinks = [
                { href: '/', label: 'Inbox', icon: Inbox },
                { href: '/playbooks', label: 'Playbooks', icon: BookOpen },
                { href: '/settings', label: 'Settings', icon: Settings },
        ];
</script>

<div class="app">
        <nav class="sidebar">
                <div class="brand">
                        <span class="brand-icon">✉</span>
                        <span class="brand-name">Autopilot</span>
                </div>

                {#if workspaces.length > 1}
                <div class="workspace-selector">
                        <label class="ws-label" for="workspace-select">Workspace</label>
                        <select
                                id="workspace-select"
                                class="ws-select"
                                value={selectedId}
                                onchange={onWorkspaceChange}
                        >
                                {#each workspaces as ws}
                                        <option value={ws.id}>{ws.name}</option>
                                {/each}
                        </select>
                </div>
                {/if}

		<ul class="nav-links">
			{#each navLinks as { href, label, icon: Icon }}
				<li>
					<a
						href={href}
						class="nav-link"
						class:active={isActive(href, $page.url.pathname)}
					>
						<span class="nav-icon"><Icon size={16} /></span>
						{label}
					</a>
				</li>
			{/each}
		</ul>

		<div class="sidebar-footer">
			<a href="/system" class="system-link" class:active={$page.url.pathname.startsWith('/system')}>System</a>
		</div>
	</nav>

	<main class="content">
		{@render children()}
	</main>
</div>

<style>
	:global(*, *::before, *::after) {
		box-sizing: border-box;
		margin: 0;
		padding: 0;
	}

	:global(:root) {
		--color-bg: #0f1117;
		--color-surface: #1a1d27;
		--color-surface-2: #22263a;
		--color-border: #2e3348;
		--color-text: #e2e8f0;
		--color-text-muted: #64748b;
		--color-primary: #6366f1;
		--color-primary-hover: #4f52d4;
		--color-success: #10b981;
		--color-warning: #f59e0b;
		--color-danger: #ef4444;
		--color-info: #3b82f6;
		--radius: 6px;
		--radius-lg: 10px;
		--shadow: 0 1px 3px rgba(0 0 0 / 0.4);
		--font: 'Inter', system-ui, -apple-system, sans-serif;
		--font-mono: 'JetBrains Mono', 'Fira Code', monospace;
	}

	:global(body) {
		background: var(--color-bg);
		color: var(--color-text);
		font-family: var(--font);
		font-size: 14px;
		line-height: 1.5;
		min-height: 100vh;
	}

	:global(a) {
		color: var(--color-primary);
		text-decoration: none;
	}

	:global(button) {
		cursor: pointer;
		font-family: inherit;
		font-size: inherit;
	}

	:global(.btn) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 14px;
		border: 1px solid transparent;
		border-radius: var(--radius);
		font-size: 13px;
		font-weight: 500;
		transition: background 0.15s, border-color 0.15s;
	}

	:global(.btn-primary) {
		background: var(--color-primary);
		color: #fff;
	}
	:global(.btn-primary:hover) {
		background: var(--color-primary-hover);
	}

	:global(.btn-ghost) {
		background: transparent;
		color: var(--color-text);
		border-color: var(--color-border);
	}
	:global(.btn-ghost:hover) {
		background: var(--color-surface-2);
	}

	:global(.btn-danger) {
		background: var(--color-danger);
		color: #fff;
	}

	:global(.badge) {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	:global(.badge-new)       { background: #1e3a5f; color: var(--color-info); }
	:global(.badge-in_review) { background: #3d2b00; color: var(--color-warning); }
	:global(.badge-replied)   { background: #0a3a2a; color: var(--color-success); }
	:global(.badge-ignored)   { background: #1f2335; color: var(--color-text-muted); }
	:global(.badge-closed)    { background: #1a1d27; color: var(--color-text-muted); }

	:global(.card) {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: 20px;
	}

	:global(.error-banner) {
		background: rgba(239 68 68 / 0.1);
		border: 1px solid rgba(239 68 68 / 0.3);
		border-radius: var(--radius);
		color: #fca5a5;
		padding: 12px 16px;
		margin-bottom: 16px;
	}

	.app {
		display: grid;
		grid-template-columns: 220px 1fr;
		min-height: 100vh;
	}

	.sidebar {
		background: var(--color-surface);
		border-right: 1px solid var(--color-border);
		display: flex;
		flex-direction: column;
		padding: 20px 0;
		position: sticky;
		top: 0;
		height: 100vh;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 20px 24px;
		border-bottom: 1px solid var(--color-border);
		margin-bottom: 12px;
	}

        .workspace-selector {
                padding: 0 16px 12px;
                border-bottom: 1px solid var(--color-border);
                margin-bottom: 8px;
        }

        .ws-label {
                display: block;
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: var(--color-text-muted);
                margin-bottom: 4px;
        }

        .ws-select {
                width: 100%;
                background: var(--color-surface-2);
                border: 1px solid var(--color-border);
                border-radius: var(--radius);
                color: var(--color-text);
                font-size: 13px;
                padding: 5px 8px;
        }

	.brand-icon {
		font-size: 20px;
	}

	.brand-name {
		font-size: 16px;
		font-weight: 700;
		letter-spacing: -0.02em;
	}

	.nav-links {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 0 10px;
	}

	.nav-link {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-radius: var(--radius);
		color: var(--color-text-muted);
		font-weight: 500;
		transition: color 0.15s, background 0.15s;
	}

	.nav-icon {
		font-size: 15px;
		width: 20px;
		text-align: center;
	}

	.nav-link:hover {
		color: var(--color-text);
		background: var(--color-surface-2);
	}

	.nav-link.active {
		background: rgba(99 102 241 / 0.15);
		color: var(--color-primary);
	}

	.sidebar-footer {
		margin-top: auto;
		padding: 12px 22px;
		border-top: 1px solid var(--color-border);
	}

	.system-link {
		display: block;
		font-size: 12px;
		color: var(--color-text-muted);
		padding: 4px 0;
		font-weight: 500;
		transition: color 0.15s;
	}

	.system-link:hover,
	.system-link.active {
		color: var(--color-text);
	}

	.content {
		padding: 28px 32px;
		overflow-y: auto;
	}
</style>
