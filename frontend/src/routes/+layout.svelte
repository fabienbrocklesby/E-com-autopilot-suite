<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import type { Snippet } from 'svelte';
	import { onNavigate } from '$app/navigation';
	import { workspacesApi, type Workspace } from '$lib/api';
	import { workspaceStore, attentionCountStore } from '$lib/stores';
	import { Inbox, BookOpen, Settings, Plane, Menu, X } from '@lucide/svelte';

	let { children }: { children: Snippet } = $props();

	let workspaces = $state<Workspace[]>([]);
	let selectedId = $state(1);
	let attentionCount = $state(0);
	// Sidebar open state: starts closed on mobile, open on desktop
	let sidebarOpen = $state(false);
	let isMobile = $state(false);

	// Sync stores → local state
	const unsubWs = workspaceStore.subscribe((id) => { selectedId = id; });
	const unsubAttention = attentionCountStore.subscribe((n) => { attentionCount = n; });

	let currentWorkspace = $derived(workspaces.find((w) => w.id === selectedId) ?? null);

	function checkMobile() {
		const mobile = window.innerWidth < 768;
		isMobile = mobile;
		// On desktop, sidebar defaults open; on mobile, closed
		if (!mobile && !sidebarOpen) sidebarOpen = true;
		if (mobile) sidebarOpen = false;
	}

	onMount(async () => {
		localStorage.removeItem('api_token');
		checkMobile();
		window.addEventListener('resize', checkMobile);
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

	onDestroy(() => {
		unsubWs();
		unsubAttention();
		if (typeof window !== 'undefined') {
			window.removeEventListener('resize', checkMobile);
		}
	});

	function onWorkspaceChange(event: Event) {
		const id = parseInt((event.target as HTMLSelectElement).value, 10);
		if (Number.isFinite(id)) workspaceStore.set(id);
	}

	function isActive(href: string, pathname: string): boolean {
		if (href === '/') return pathname === '/' || pathname === '/inbox';
		return pathname.startsWith(href);
	}

	function closeSidebarIfMobile() {
		if (isMobile) sidebarOpen = false;
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

{#if !($page.url.pathname as string).startsWith('/login')}
<div class="app" class:sidebar-open={sidebarOpen}>
	<!-- Mobile top bar (hidden on desktop) -->
	<header class="mobile-topbar">
		<button class="menu-btn" onclick={() => sidebarOpen = !sidebarOpen} aria-label="Toggle menu">
			{#if sidebarOpen}
				<X size={20} />
			{:else}
				<Menu size={20} />
			{/if}
		</button>
		<span class="mobile-brand">
			<span class="brand-icon"><Plane size={16} /></span>
			Autopilot
		</span>
		{#if attentionCount > 0}
			<span class="mobile-badge">{attentionCount}</span>
		{/if}
	</header>

	<!-- Backdrop (mobile only, closes sidebar when tapped) -->
	{#if sidebarOpen && isMobile}
		<div class="sidebar-backdrop" onclick={() => sidebarOpen = false} aria-hidden="true"></div>
	{/if}

	<nav class="sidebar" class:open={sidebarOpen}>
		<div class="brand">
			<div class="brand-top">
				<span class="brand-icon"><Plane size={18} /></span>
				<span class="brand-name">Autopilot</span>
			</div>
			{#if currentWorkspace?.gmail_address}
				<div class="brand-email">
					<span class="email-dot"></span>
					{currentWorkspace.gmail_address}
				</div>
			{/if}
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
						onclick={closeSidebarIfMobile}
					>
						<span class="nav-icon"><Icon size={16} /></span>
						{label}
						{#if href === '/' && attentionCount > 0}
							<span class="nav-badge">{attentionCount}</span>
						{/if}
					</a>
				</li>
			{/each}
		</ul>

		<div class="sidebar-footer">
			<a href="/system" class="system-link" class:active={$page.url.pathname.startsWith('/system')} onclick={closeSidebarIfMobile}>System ↗</a>
		</div>
	</nav>

	<main class="content">
		{@render children()}
	</main>
</div>
{:else}
	{@render children()}
{/if}

<style>
	:global(*, *::before, *::after) {
		box-sizing: border-box;
		margin: 0;
		padding: 0;
	}

	:global(:root) {
		--color-bg: #0d0f18;
		--color-surface: #141720;
		--color-surface-2: #1c2030;
		--color-surface-3: #242840;
		--color-border: #272b3e;
		--color-border-2: #303550;
		--color-text: #e4e8f5;
		--color-text-muted: #8892ae;
		--color-text-3: #5a6480;
		--color-primary: #6366f1;
		--color-primary-dim: rgba(99, 102, 241, 0.15);
		--color-primary-hover: #5254cc;
		--color-success: #10b981;
		--color-success-dim: rgba(16, 185, 129, 0.12);
		--color-warning: #f59e0b;
		--color-warning-dim: rgba(245, 158, 11, 0.12);
		--color-danger: #ef4444;
		--color-danger-dim: rgba(239, 68, 68, 0.12);
		--color-info: #3b82f6;
		--color-info-dim: rgba(59, 130, 246, 0.12);
		--color-orange: #f97316;
		--color-orange-dim: rgba(249, 115, 22, 0.12);
		--radius: 7px;
		--radius-lg: 11px;
		--shadow: 0 1px 3px rgba(0 0 0 / 0.4);
		--shadow-sm: 0 1px 3px rgba(0 0 0 / 0.3), 0 1px 2px rgba(0 0 0 / 0.2);
		--shadow-md: 0 4px 8px rgba(0 0 0 / 0.35), 0 2px 4px rgba(0 0 0 / 0.2);
		--shadow-lg: 0 12px 28px rgba(0 0 0 / 0.45), 0 4px 8px rgba(0 0 0 / 0.3);
		--font: 'DM Sans', system-ui, -apple-system, sans-serif;
		--font-mono: 'DM Mono', monospace;
		--control-height: 38px;
		--control-padding-x: 12px;
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

	/* Global control baseline to keep forms visually consistent across pages */
	:global(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"])),
	:global(textarea),
	:global(select) {
		background: var(--color-surface-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		color: var(--color-text);
		font-size: 13px;
		font-family: var(--font);
		padding: 8px var(--control-padding-x);
		transition: border-color 0.15s ease, box-shadow 0.15s ease, outline-color 0.15s ease, background 0.15s ease;
	}

	:global(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"])),
	:global(select) {
		height: var(--control-height);
		box-sizing: border-box;
	}

	:global(textarea) {
		min-height: var(--control-height);
		line-height: 1.5;
	}

	:global(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):focus),
	:global(select:focus),
	:global(textarea:focus) {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 2px rgba(99 102 241 / 0.16);
	}

	:global(input[type="number"]) {
		appearance: textfield;
	}

	:global(input[type="number"]::-webkit-outer-spin-button),
	:global(input[type="number"]::-webkit-inner-spin-button) {
		margin: 0;
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

	:global(.badge-new)       { background: var(--color-info-dim); color: var(--color-info); }
	:global(.badge-in_review) { background: var(--color-warning-dim); color: var(--color-warning); }
	:global(.badge-replied)   { background: var(--color-success-dim); color: var(--color-success); }
	:global(.badge-ignored)   { background: var(--color-surface-2); color: var(--color-text-muted); }
	:global(.badge-closed)    { background: var(--color-surface-2); color: var(--color-text-muted); }

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
		grid-template-columns: 208px 1fr;
		grid-template-rows: 1fr;
		min-height: 100vh;
	}

	/* Mobile topbar - hidden on desktop */
	.mobile-topbar {
		display: none;
	}

	.sidebar-backdrop {
		display: none;
	}

	.sidebar {
		background: var(--color-surface);
		border-right: 1px solid var(--color-border);
		display: flex;
		flex-direction: column;
		position: sticky;
		top: 0;
		height: 100vh;
	}

	.brand {
		padding: 20px 20px 18px;
		border-bottom: 1px solid var(--color-border);
		margin-bottom: 10px;
	}

	.brand-top {
		display: flex;
		align-items: center;
		gap: 9px;
	}

	.brand-icon {
		color: var(--color-primary);
		margin-top: 2px;
		flex-shrink: 0;
	}

	.brand-name {
		font-size: 15px;
		font-weight: 700;
		letter-spacing: -0.02em;
	}

	.brand-email {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 8px;
		font-size: 11px;
		color: var(--color-text-3, var(--color-text-muted));
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.email-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-success);
		flex-shrink: 0;
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
		gap: 9px;
		padding: 8px 12px;
		border-radius: var(--radius);
		color: var(--color-text-muted);
		font-size: 13.5px;
		font-weight: 400;
		transition: color 0.12s, background 0.12s, border-color 0.12s;
		border-left: 2px solid transparent;
	}

	.nav-icon {
		width: 16px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.nav-link:hover {
		color: var(--color-text);
		background: var(--color-surface-2);
	}

	.nav-link.active {
		background: var(--color-primary-dim, rgba(99 102 241 / 0.12));
		color: var(--color-primary);
		border-left-color: var(--color-primary);
		font-weight: 600;
	}

	.nav-badge {
		margin-left: auto;
		background: var(--color-danger);
		color: #fff;
		font-size: 10px;
		font-weight: 700;
		padding: 1px 6px;
		border-radius: 999px;
		line-height: 1.4;
	}

	.sidebar-footer {
		margin-top: auto;
		padding: 14px 20px;
		border-top: 1px solid var(--color-border);
	}

	.system-link {
		display: block;
		font-size: 11.5px;
		color: var(--color-text-3, var(--color-text-muted));
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
		min-width: 0; /* prevent grid blowout */
	}

	/* ------------------------------------------------------------------ */
	/* Mobile responsive layout                                             */
	/* ------------------------------------------------------------------ */
	@media (max-width: 767px) {
		.app {
			grid-template-columns: 1fr;
			grid-template-rows: auto 1fr;
		}

		/* Top bar visible on mobile */
		.mobile-topbar {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 0 16px;
			height: 52px;
			background: var(--color-surface);
			border-bottom: 1px solid var(--color-border);
			position: sticky;
			top: 0;
			z-index: 100;
			grid-column: 1;
		}

		.menu-btn {
			background: none;
			border: none;
			color: var(--color-text);
			padding: 6px;
			border-radius: var(--radius);
			display: flex;
			align-items: center;
			justify-content: center;
			cursor: pointer;
			flex-shrink: 0;
		}
		.menu-btn:hover {
			background: var(--color-surface-2);
		}

		.mobile-brand {
			display: flex;
			align-items: center;
			gap: 7px;
			font-size: 15px;
			font-weight: 700;
			letter-spacing: -0.02em;
			color: var(--color-text);
		}

		.mobile-badge {
			margin-left: auto;
			background: var(--color-danger);
			color: #fff;
			font-size: 11px;
			font-weight: 700;
			padding: 2px 7px;
			border-radius: 999px;
		}

		/* Sidebar as overlay on mobile */
		.sidebar {
			position: fixed;
			top: 52px;
			left: 0;
			bottom: 0;
			width: 240px;
			z-index: 200;
			transform: translateX(-100%);
			transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
			height: auto;
		}

		.sidebar.open {
			transform: translateX(0);
		}

		/* Backdrop - shown when sidebar is open on mobile */
		.sidebar-backdrop {
			display: block;
			position: fixed;
			inset: 52px 0 0 0;
			background: rgba(0 0 0 / 0.5);
			z-index: 150;
			backdrop-filter: blur(2px);
		}

		.content {
			padding: 16px;
			grid-column: 1;
			min-width: 0;
			overflow-x: hidden;
		}
	}

	/* Medium screens - slightly tighter sidebar */
	@media (min-width: 768px) and (max-width: 1024px) {
		.app {
			grid-template-columns: 180px 1fr;
		}
		.content {
			padding: 20px 24px;
		}
	}

	/* Desktop: hide mobile-only elements */
	@media (min-width: 768px) {
		.mobile-topbar {
			display: none !important;
		}
		.sidebar-backdrop {
			display: none !important;
		}
	}

	/* ------------------------------------------------------------------ */
	/* Loading skeleton                                                       */
	/* ------------------------------------------------------------------ */
	:global(.skeleton) {
		background: linear-gradient(
			90deg,
			var(--color-surface-2) 25%,
			var(--color-surface-3) 50%,
			var(--color-surface-2) 75%
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
			background: var(--color-surface-3);
		}
	}
</style>
