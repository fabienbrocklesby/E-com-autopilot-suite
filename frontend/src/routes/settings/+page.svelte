<!--
  /settings — Global settings and OAuth connection status
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { settingsApi, authApi } from '$lib/api';

	interface SettingDef {
		key: string;
		label: string;
		description: string;
		type: 'text' | 'boolean' | 'number';
	}

	const SETTING_DEFS: SettingDef[] = [
		{
			key: 'auto_reply_enabled',
			label: 'Auto-reply enabled',
			description: 'When enabled, emails meeting confidence thresholds are auto-replied.',
			type: 'boolean'
		},
		{
			key: 'default_confidence_threshold',
			label: 'Default confidence threshold',
			description: 'Minimum AI confidence (0–1) required to auto-reply if category does not override.',
			type: 'number'
		},
		{
			key: 'openai_model',
			label: 'OpenAI model',
			description: 'Model used for categorisation and draft generation.',
			type: 'text'
		},
		{
			key: 'reply_signature',
			label: 'Reply signature',
			description: 'Appended to AI-generated drafts.',
			type: 'text'
		}
	];

	let settings = $state<Record<string, string>>({});
	let loadingSettings = $state(true);
	let savingKey = $state<string | null>(null);
	let settingsError = $state<string | null>(null);
	let success = $state<string | null>(null);

	let oauthStatus = $state<{ connected: boolean; email: string | null; expiry: string | null } | null>(null);
	let loadingOauth = $state(true);

	// OAuth feedback from redirect
	const oauthSuccess = $page.url.searchParams.get('oauth_success');
	const oauthError = $page.url.searchParams.get('oauth_error');

	async function loadSettings() {
		loadingSettings = true;
		settingsError = null;
		try {
			const res = await settingsApi.getAll();
			settings = res.settings;
		} catch (e) {
			settingsError = e instanceof Error ? e.message : 'Failed to load settings';
		} finally {
			loadingSettings = false;
		}
	}

	async function loadOauthStatus() {
		loadingOauth = true;
		try {
			oauthStatus = await authApi.status();
		} catch {
			oauthStatus = { connected: false, email: null, expiry: null };
		} finally {
			loadingOauth = false;
		}
	}

	async function saveSetting(key: string, value: string) {
		savingKey = key;
		settingsError = null;
		try {
			await settingsApi.set(key, value);
			settings[key] = value;
			success = `'${key}' saved.`;
			setTimeout(() => { success = null; }, 3000);
		} catch (e) {
			settingsError = e instanceof Error ? e.message : 'Failed to save setting';
		} finally {
			savingKey = null;
		}
	}

	function handleBooleanToggle(key: string, checked: boolean) {
		saveSetting(key, checked ? 'true' : 'false');
	}

	onMount(() => {
		loadSettings();
		loadOauthStatus();
	});
</script>

<svelte:head>
	<title>Settings — Email Dash</title>
</svelte:head>

<h1>Settings</h1>

{#if oauthSuccess}
	<div class="success-banner">Google account connected successfully.</div>
{/if}
{#if oauthError}
	<div class="error-banner">OAuth error: {decodeURIComponent(oauthError)}</div>
{/if}
{#if settingsError}
	<div class="error-banner">{settingsError}</div>
{/if}
{#if success}
	<div class="success-banner">{success}</div>
{/if}

<!-- OAuth Section -->
<section class="card section">
	<h2>Google Account</h2>
	<p class="section-description">
		Connect your Google account to enable Gmail access and Sheets integration.
	</p>

	{#if loadingOauth}
		<div class="status-row loading-text">Checking connection…</div>
	{:else if oauthStatus?.connected}
		<div class="status-row connected">
			<span class="status-dot connected"></span>
			<span>Connected as <strong>{oauthStatus.email}</strong></span>
			{#if oauthStatus.expiry}
				<span class="expiry">Token expires: {new Date(oauthStatus.expiry).toLocaleString()}</span>
			{/if}
		</div>
		<a href={authApi.startOAuthUrl()} class="btn btn-ghost" style="margin-top: 12px">
			Reconnect
		</a>
	{:else}
		<div class="status-row disconnected">
			<span class="status-dot disconnected"></span>
			<span>Not connected</span>
		</div>
		<a href={authApi.startOAuthUrl()} class="btn btn-primary" style="margin-top: 12px">
			Connect Google Account
		</a>
	{/if}
</section>

<!-- General Settings -->
<section class="card section">
	<h2>General</h2>

	{#if loadingSettings}
		<div class="loading-text">Loading settings…</div>
	{:else}
		<div class="settings-list">
			{#each SETTING_DEFS as def (def.key)}
				<div class="setting-row">
					<div class="setting-info">
						<span class="setting-label">{def.label}</span>
						<span class="setting-description">{def.description}</span>
					</div>

					<div class="setting-control">
						{#if def.type === 'boolean'}
							<label class="toggle">
								<input
									type="checkbox"
									checked={settings[def.key] === 'true'}
									onchange={(e) => handleBooleanToggle(def.key, (e.target as HTMLInputElement).checked)}
									disabled={savingKey === def.key}
								/>
								<span class="toggle-slider"></span>
							</label>
						{:else}
							<div class="input-with-save">
								<input
									class="input"
									type={def.type === 'number' ? 'number' : 'text'}
									value={settings[def.key] ?? ''}
									min={def.type === 'number' ? 0 : undefined}
									max={def.type === 'number' ? 1 : undefined}
									step={def.type === 'number' ? 0.01 : undefined}
									oninput={(e) => { settings[def.key] = (e.target as HTMLInputElement).value; }}
								/>
								<button
									class="btn btn-primary btn-sm"
									onclick={() => saveSetting(def.key, settings[def.key] ?? '')}
									disabled={savingKey === def.key}
								>
									{savingKey === def.key ? '…' : 'Save'}
								</button>
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	h1 {
		font-size: 22px;
		font-weight: 700;
		margin-bottom: 24px;
	}

	h2 {
		font-size: 16px;
		font-weight: 700;
		margin-bottom: 6px;
	}

	.section {
		margin-bottom: 20px;
	}

	.section-description {
		color: var(--color-text-muted);
		font-size: 13px;
		margin-bottom: 16px;
	}

	.success-banner {
		background: rgba(16 185 129 / 0.1);
		border: 1px solid rgba(16 185 129 / 0.3);
		border-radius: var(--radius);
		color: #6ee7b7;
		padding: 12px 16px;
		margin-bottom: 16px;
	}

	.loading-text {
		color: var(--color-text-muted);
		font-size: 13px;
	}

	.status-row {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13px;
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.status-dot.connected    { background: var(--color-success); box-shadow: 0 0 0 2px rgba(16 185 129 / 0.2); }
	.status-dot.disconnected { background: var(--color-text-muted); }

	.expiry {
		color: var(--color-text-muted);
		font-size: 12px;
		margin-left: auto;
	}

	.settings-list {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.setting-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 0;
		border-bottom: 1px solid var(--color-border);
		gap: 20px;
	}

	.setting-row:last-child {
		border-bottom: none;
	}

	.setting-info {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.setting-label {
		font-size: 13px;
		font-weight: 500;
	}

	.setting-description {
		font-size: 12px;
		color: var(--color-text-muted);
	}

	.setting-control {
		flex-shrink: 0;
	}

	.input-with-save {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.input {
		background: var(--color-surface-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		color: var(--color-text);
		font-size: 13px;
		font-family: inherit;
		padding: 6px 10px;
		width: 200px;
	}

	.input:focus {
		outline: none;
		border-color: var(--color-primary);
	}

	/* Toggle */
	.toggle {
		position: relative;
		display: inline-block;
		width: 40px;
		height: 22px;
	}

	.toggle input {
		opacity: 0;
		width: 0;
		height: 0;
	}

	.toggle-slider {
		position: absolute;
		inset: 0;
		background: var(--color-surface-2);
		border: 1px solid var(--color-border);
		border-radius: 22px;
		cursor: pointer;
		transition: background 0.2s;
	}

	.toggle-slider::before {
		content: '';
		position: absolute;
		width: 16px;
		height: 16px;
		left: 3px;
		top: 50%;
		transform: translateY(-50%);
		background: var(--color-text-muted);
		border-radius: 50%;
		transition: transform 0.2s, background 0.2s;
	}

	.toggle input:checked + .toggle-slider {
		background: var(--color-primary);
		border-color: var(--color-primary);
	}

	.toggle input:checked + .toggle-slider::before {
		transform: translateX(18px) translateY(-50%);
		background: #fff;
	}

	.toggle input:disabled + .toggle-slider {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
