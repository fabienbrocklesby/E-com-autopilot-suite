<script lang="ts">
	import { enhance } from '$app/forms';
	import { Plane } from '@lucide/svelte';

	let { data, form }: { data: { returnTo: string }; form: { error?: string } | null } = $props();

	let loading = $state(false);
	let passwordInput = $state('');
</script>

<div class="gate">
	<div class="card">
		<div class="brand">
			<span class="brand-icon"><Plane size={20} /></span>
			<span class="brand-name">Autopilot</span>
		</div>

		<h1 class="title">Dashboard access</h1>
		<p class="subtitle">Enter the dashboard password to continue.</p>

		<form
			method="POST"
			action="?/default&returnTo={encodeURIComponent(data.returnTo)}"
			use:enhance={() => {
				loading = true;
				return async ({ update }) => {
					loading = false;
					await update();
				};
			}}
		>
			<input type="hidden" name="returnTo" value={data.returnTo} />

			<div class="field">
				<label for="password" class="label">Password</label>
				<input
					id="password"
					name="password"
					type="password"
					class="input"
					class:input-error={!!form?.error}
					bind:value={passwordInput}
					placeholder="••••••••••••"
					autocomplete="current-password"
					required
				/>
				{#if form?.error}
					<p class="error-msg">{form.error}</p>
				{/if}
			</div>

			<button type="submit" class="btn" disabled={loading || !passwordInput}>
				{loading ? 'Checking…' : 'Unlock'}
			</button>
		</form>
	</div>
</div>

<style>
	:global(*, *::before, *::after) {
		box-sizing: border-box;
		margin: 0;
		padding: 0;
	}

	:global(body) {
		background: #0d0f18;
		color: #e4e8f5;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		min-height: 100dvh;
	}

	.gate {
		min-height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
	}

	.card {
		width: 100%;
		max-width: 360px;
		background: #141720;
		border: 1px solid #272b3e;
		border-radius: 12px;
		padding: 2rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: #6366f1;
		font-weight: 600;
		font-size: 0.9375rem;
	}

	.brand-icon {
		display: flex;
		align-items: center;
	}

	.brand-name {
		letter-spacing: -0.01em;
	}

	.title {
		font-size: 1.25rem;
		font-weight: 600;
		color: #e4e8f5;
		letter-spacing: -0.02em;
	}

	.subtitle {
		font-size: 0.875rem;
		color: #8892ae;
		margin-top: -0.5rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: #8892ae;
	}

	.input {
		width: 100%;
		padding: 0.625rem 0.75rem;
		background: #1c2030;
		border: 1px solid #272b3e;
		border-radius: 6px;
		color: #e4e8f5;
		font-size: 0.9375rem;
		outline: none;
		transition: border-color 0.15s;
	}

	.input:focus {
		border-color: #6366f1;
	}

	.input-error {
		border-color: #ef4444;
	}

	.error-msg {
		font-size: 0.8125rem;
		color: #ef4444;
	}

	.btn {
		width: 100%;
		padding: 0.625rem 1rem;
		background: #6366f1;
		color: #fff;
		border: none;
		border-radius: 6px;
		font-size: 0.9375rem;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.15s, opacity 0.15s;
	}

	.btn:hover:not(:disabled) {
		background: #5254cc;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
