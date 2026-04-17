<script lang="ts">
	import { page } from '$app/stores';
        import { onMount, onDestroy } from 'svelte';
        import type { Snippet } from 'svelte';
        import { onNavigate } from '$app/navigation';
        import { workspacesApi, type Workspace } from '$lib/api';
        import { workspaceStore } from '$lib/stores';
		import { Inbox, BookOpen, Settings, Plane } from '@lucide/svelte';

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

		// Use the View Transitions API for snappy route changes.
		// onNavigate must be called at component initialisation (not inside onMount).
		// Ref: https://svelte.dev/docs/kit/faq#how-do-i-use-the-view-transitions-api
		onNavigate((navigation) => {
			if (!document.startViewTransition) return;
			return new Promise((resolve) => {
				document.startViewTransition(async () => {
					resolve();
					await navigation.complete;
				});
			});
		});
</script>

<div class="app">
        <nav class="sidebar">
                <div class="brand">
                        <span class="brand-icon"><Plane size={20} /></span>
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
		--color-text-muted: #94a3b8;
		--color-primary: #6366f1;
		--color-primary-hover: #4f52d4;
		--color-success: #10b981;
		--color-warning: #f59e0b;
		--color-danger: #ef4444;
		--color-info: #3b82f6;
		--radius: 6px;
		--radius-lg: 10px;
		--shadow: 0 1px 3px rgba(0 0 0 / 0.4);
		--shadow-sm: 0 1px 3px rgba(0 0 0 / 0.3), 0 1px 2px rgba(0 0 0 / 0.2);
		--shadow-md: 0 4px 8px rgba(0 0 0 / 0.35), 0 2px 4px rgba(0 0 0 / 0.2);
		--shadow-lg: 0 12px 28px rgba(0 0 0 / 0.45), 0 4px 8px rgba(0 0 0 / 0.3);
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

	/* Tighter heading tracking for a more polished feel */
	:global(h1, h2, h3) {
		letter-spacing: -0.015em;
		line-height: 1.25;
	}
	:global(h4, h5, h6) {
		letter-spacing: -0.01em;
		line-height: 1.3;
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
		transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
	}

	:global(.btn:not(:disabled):active) {
		transform: scale(0.97);
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

	/* Global input/textarea/select transition for focus polish */
	:global(input:not([type="checkbox"]):not([type="radio"])),
	:global(textarea),
	:global(select) {
		transition: border-color 0.15s ease, box-shadow 0.15s ease, outline-color 0.15s ease;
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
		box-shadow: var(--shadow-sm);
		transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
	}

	/* Cards that act as clickable items get a subtle hover lift */
	:global(.card:hover) {
		transform: translateY(-1px);
		box-shadow: var(--shadow-md);
	}
	/* Opt out of hover lift for static containers (modals, forms, etc.) */
	:global(.modal .card:hover),
	:global(.card.no-hover:hover),
	:global(.editor-layout .card:hover) {
		transform: none;
		box-shadow: var(--shadow-sm);
	}

	:global(.error-banner) {
		background: rgba(239 68 68 / 0.1);
		border: 1px solid rgba(239 68 68 / 0.3);
		border-radius: var(--radius);
		color: #fca5a5;
		padding: 12px 16px;
		margin-bottom: 16px;
		animation: banner-enter 0.2s ease;
	}

	/* ------------------------------------------------------------------ */
	/* Modal transitions (CSS-driven for cross-browser)                    */
	/* ------------------------------------------------------------------ */
	:global(.modal-overlay) {
		animation: overlay-fade-in 0.15s ease;
	}
	:global(.modal-overlay > .modal),
	:global(.modal-overlay > .card) {
		animation: modal-slide-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}

	/* ------------------------------------------------------------------ */
	/* Success / info banner entry                                         */
	/* ------------------------------------------------------------------ */
	:global(.success-banner) {
		animation: banner-enter 0.2s ease;
	}
	:global(.info-banner) {
		animation: banner-enter 0.2s ease;
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
		margin-top: 5px;
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
		transition: color 0.15s, background 0.15s, border-color 0.15s, padding-left 0.15s;
		border-left: 3px solid transparent;
	}

	.nav-icon {
		font-size: 15px;
		width: 20px;
		text-align: center;
		margin-top: 5px;
	}

	.nav-link:hover {
		color: var(--color-text);
		background: var(--color-surface-2);
	}

	.nav-link.active {
		background: rgba(99 102 241 / 0.15);
		color: var(--color-primary);
		border-left-color: var(--color-primary);
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

	/* ------------------------------------------------------------------ */
	/* Loading skeleton                                                       */
	/* ------------------------------------------------------------------ */
	:global(.skeleton) {
		background: linear-gradient(
			90deg,
			var(--color-surface) 25%,
			var(--color-surface-2) 50%,
			var(--color-surface) 75%
		);
		background-size: 200% 100%;
		animation: shimmer 1.5s ease infinite;
		border-radius: var(--radius);
	}

	/* ------------------------------------------------------------------ */
	/* Status-flash utilities (apply via class, driven by Svelte $state)   */
	/* ------------------------------------------------------------------ */
	:global(.flash-success) {
		animation: flash-success 600ms ease forwards;
	}
	:global(.pulse-error) {
		animation: pulse-error 700ms ease forwards;
	}

	/* ------------------------------------------------------------------ */
	/* Keyframes (global - not scoped so they work across components)      */
	/* ------------------------------------------------------------------ */
	:global {
		@keyframes shimmer {
			from { background-position: -200% 0; }
			to   { background-position:  200% 0; }
		}

		@keyframes flash-success {
			0%   { box-shadow: 0 0 0 0   rgba(16 185 129 / 0.6); }
			40%  { box-shadow: 0 0 0 4px rgba(16 185 129 / 0.35); }
			100% { box-shadow: 0 0 0 0   rgba(16 185 129 / 0); }
		}

		@keyframes pulse-error {
			0%   { border-color: var(--color-danger); box-shadow: 0 0 0 0   rgba(239 68 68 / 0.5); }
			40%  { box-shadow: 0 0 0 4px rgba(239 68 68 / 0.3); }
			100% { border-color: var(--color-border); box-shadow: none; }
		}

		@keyframes vt-out {
			to { opacity: 0; transform: translateY(4px); }
		}

		@keyframes vt-in {
			from { opacity: 0; transform: translateY(-4px); }
		}

		@keyframes overlay-fade-in {
			from { opacity: 0; }
		}

		@keyframes modal-slide-in {
			from { opacity: 0; transform: translateY(-12px) scale(0.97); }
		}

		@keyframes banner-enter {
			from { opacity: 0; transform: translateY(-6px); }
		}
	}

	/* ------------------------------------------------------------------ */
	/* View Transitions (Chrome/Edge/Safari 18+, graceful fallback)        */
	/* Short cross-fade: feels like a refresh, not a cinematic transition. */
	/* ------------------------------------------------------------------ */
	:global(::view-transition-old(root)) {
		animation: vt-out 120ms ease;
	}
	:global(::view-transition-new(root)) {
		animation: vt-in 120ms ease;
	}

	/* ------------------------------------------------------------------ */
	/* Reduced motion - override ALL animations and transitions             */
	/* Svelte JS-transition y values are nullified by setting duration      */
	/* very low; opacity-only is still allowed (mild fade only).           */
	/* ------------------------------------------------------------------ */
	@media (prefers-reduced-motion: reduce) {
		:global(*, *::before, *::after) {
			animation-duration: 50ms !important;
			transition-duration: 50ms !important;
		}
		:global(::view-transition-old(root)),
		:global(::view-transition-new(root)) {
			animation: none !important;
		}
		:global(.skeleton) {
			animation: none;
			background: var(--color-surface-2);
		}
	}
</style>
