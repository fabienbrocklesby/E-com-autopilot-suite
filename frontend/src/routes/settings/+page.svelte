<!--
  /settings - Global settings, OAuth connection status, and workspace management
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { page } from "$app/stores";
  import {
    settingsApi,
    authApi,
    workspacesApi,
    sheetsApi,
    labelsApi,
  } from "$lib/api";
  import type { Workspace } from "$lib/api";

  interface SettingDef {
    key: string;
    label: string;
    description: string;
    hint?: string;
    type: "text" | "boolean" | "number";
  }

  const SETTING_DEFS: SettingDef[] = [
    {
      key: "openai_model",
      label: "OpenAI model",
      description: "Model used for categorisation and draft generation.",
      hint: "e.g. gpt-4o (recommended, best quality), gpt-4o-mini (faster / cheaper), gpt-4-turbo (older)",
      type: "text",
    },
  ];

  let settings = $state<Record<string, string>>({});
  let loadingSettings = $state(true);
  let savingKey = $state<string | null>(null);
  let settingsError = $state<string | null>(null);
  let success = $state<string | null>(null);
  let openaiModels = $state<string[]>([]);

  let senderName = $state("");
  let savingSenderName = $state(false);

  let oauthStatus = $state<{
    connected: boolean;
    email: string | null;
    expiry: string | null;
  } | null>(null);
  let loadingOauth = $state(true);

  // Workspace state
  let workspaces = $state<Workspace[]>([]);
  let loadingWorkspaces = $state(true);
  let editingWorkspace = $state<Workspace | null>(null);
  let workspaceForm = $state({
    name: "",
    gmail_address: "",
    sheet_id: "",
    sheet_name: "Sheet1",
    store_name: "",
    store_description: "",
    store_url: "",
  });
  let savingWorkspace = $state(false);
  let workspaceSuccess = $state<string | null>(null);
  let workspaceError = $state<string | null>(null);
  let syncingLabels = $state(false);
  let syncingColumns = $state(false);

  // OAuth feedback from redirect
  const oauthSuccess = $page.url.searchParams.get("oauth_success");
  const oauthError = $page.url.searchParams.get("oauth_error");

  async function loadSettings() {
    loadingSettings = true;
    settingsError = null;
    try {
      const res = await settingsApi.getAll();
      settings = res.settings;
      senderName = res.settings["sender_name"] ?? "";
    } catch (e) {
      settingsError =
        e instanceof Error ? e.message : "Failed to load settings";
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

  async function loadWorkspaces() {
    loadingWorkspaces = true;
    try {
      const res = await workspacesApi.list();
      workspaces = res.workspaces;
    } catch {
      // Silently fail workspace load - not critical
    } finally {
      loadingWorkspaces = false;
    }
  }

  async function saveSenderName() {
    savingSenderName = true;
    settingsError = null;
    try {
      await settingsApi.set("sender_name", senderName);
      settings["sender_name"] = senderName;
      success = "Signature saved.";
      setTimeout(() => {
        success = null;
      }, 3000);
    } catch (e) {
      settingsError = e instanceof Error ? e.message : "Failed to save signature";
    } finally {
      savingSenderName = false;
    }
  }

  async function saveSetting(key: string, value: string) {
    savingKey = key;
    settingsError = null;
    try {
      await settingsApi.set(key, value);
      settings[key] = value;
      success = `'${key}' saved.`;
      setTimeout(() => {
        success = null;
      }, 3000);
    } catch (e) {
      settingsError = e instanceof Error ? e.message : "Failed to save setting";
    } finally {
      savingKey = null;
    }
  }

  function handleBooleanToggle(key: string, checked: boolean) {
    saveSetting(key, checked ? "true" : "false");
  }

  function startEditWorkspace(ws: Workspace) {
    editingWorkspace = ws;
    workspaceForm = {
      name: ws.name,
      gmail_address: ws.gmail_address ?? "",
      sheet_id: ws.sheet_id ?? "",
      sheet_name: ws.sheet_name,
      store_name: ws.store_name ?? "",
      store_description: ws.store_description ?? "",
      store_url: ws.store_url ?? "",
    };
  }

  function cancelEditWorkspace() {
    editingWorkspace = null;
  }

  async function saveWorkspace() {
    if (!editingWorkspace) return;
    savingWorkspace = true;
    workspaceError = null;
    try {
      await workspacesApi.update(editingWorkspace.id, {
        name: workspaceForm.name,
        gmail_address: workspaceForm.gmail_address || undefined,
        sheet_id: workspaceForm.sheet_id || undefined,
        sheet_name: workspaceForm.sheet_name || "Sheet1",
        store_name: workspaceForm.store_name || undefined,
        store_description: workspaceForm.store_description || undefined,
        store_url: workspaceForm.store_url || undefined,
      });
      workspaceSuccess = "Workspace saved.";
      setTimeout(() => {
        workspaceSuccess = null;
      }, 3000);
      editingWorkspace = null;
      await loadWorkspaces();
    } catch (e) {
      workspaceError =
        e instanceof Error ? e.message : "Failed to save workspace";
    } finally {
      savingWorkspace = false;
    }
  }

  async function syncLabels(ws: Workspace) {
    syncingLabels = true;
    workspaceError = null;
    try {
      const res = await workspacesApi.syncLabels(ws.id);
      workspaceSuccess = `Synced ${res.synced} Gmail labels.`;
      setTimeout(() => {
        workspaceSuccess = null;
      }, 4000);
    } catch (e) {
      workspaceError = e instanceof Error ? e.message : "Failed to sync labels";
    } finally {
      syncingLabels = false;
    }
  }

  async function syncColumns(ws: Workspace) {
    syncingColumns = true;
    workspaceError = null;
    try {
      const res = await sheetsApi.syncColumns(ws.id);
      workspaceSuccess = `Synced ${res.columns.length} sheet columns.`;
      setTimeout(() => {
        workspaceSuccess = null;
      }, 4000);
    } catch (e) {
      workspaceError =
        e instanceof Error ? e.message : "Failed to sync sheet columns";
    } finally {
      syncingColumns = false;
    }
  }

  async function loadOpenAIModels() {
    try {
      const res = await settingsApi.getOpenAIModels();
      openaiModels = res.models;
    } catch {
      openaiModels = [];
    }
  }

  onMount(() => {
    loadSettings();
    loadOauthStatus();
    loadWorkspaces();
    loadOpenAIModels();
  });
</script>

<svelte:head>
  <title>Settings - Autopilot</title>
</svelte:head>

<div class="page-header">
  <h1>Settings</h1>
</div>

{#if oauthSuccess}
  <div class="success-banner" transition:fade={{ duration: 150 }}>Google account connected successfully.</div>
{/if}
{#if oauthError}
  <div class="error-banner" transition:fade={{ duration: 150 }}>OAuth error: {decodeURIComponent(oauthError)}</div>
{/if}
{#if settingsError}
  <div class="error-banner" transition:fade={{ duration: 150 }}>{settingsError}</div>
{/if}
{#if success}
  <div class="success-banner" transition:fade={{ duration: 150 }}>{success}</div>
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
        <span class="expiry"
          >Token expires: {new Date(oauthStatus.expiry).toLocaleString()}</span
        >
      {/if}
    </div>
    <a
      href={authApi.startOAuthUrl()}
      class="btn btn-ghost"
      style="margin-top: 12px"
    >
      Reconnect
    </a>
  {:else}
    <div class="status-row disconnected">
      <span class="status-dot disconnected"></span>
      <span>Not connected</span>
    </div>
    <a
      href={authApi.startOAuthUrl()}
      class="btn btn-primary"
      style="margin-top: 12px"
    >
      Connect Google Account
    </a>
  {/if}
</section>

<!-- Workspace Section -->
<section class="card section">
  <h2>Workspaces</h2>
  <p class="section-description">
    Configure Gmail address and Google Sheet per workspace.
  </p>

  {#if workspaceSuccess}
    <div class="success-banner ws-banner" transition:fade={{ duration: 150 }}>{workspaceSuccess}</div>
  {/if}
  {#if workspaceError}
    <div class="error-banner ws-banner" transition:fade={{ duration: 150 }}>{workspaceError}</div>
  {/if}

  {#if loadingWorkspaces}
    <div class="loading-text">Loading workspaces…</div>
  {:else}
    {#each workspaces as ws (ws.id)}
      <div class="workspace-card">

        <!-- Header: name + actions -->
        <div class="wc-header">
          {#if editingWorkspace?.id === ws.id}
            <input id="ws-name" class="input wc-name-input" bind:value={workspaceForm.name} />
          {:else}
            <span class="wc-name">{ws.name}</span>
          {/if}
          <div class="wc-actions">
            {#if editingWorkspace?.id === ws.id}
              <button class="btn btn-primary btn-sm" onclick={saveWorkspace} disabled={savingWorkspace}>
                {savingWorkspace ? "Saving…" : "Save"}
              </button>
              <button class="btn btn-ghost btn-sm" onclick={cancelEditWorkspace}>Cancel</button>
            {:else}
              <button class="btn btn-ghost btn-sm" onclick={() => startEditWorkspace(ws)}>Edit</button>
              {#if ws.gmail_address}
                <button class="btn btn-ghost btn-sm" onclick={() => syncLabels(ws)} disabled={syncingLabels}>
                  {syncingLabels ? "…" : "Sync Labels"}
                </button>
              {/if}
              {#if ws.sheet_id}
                <button class="btn btn-ghost btn-sm" onclick={() => syncColumns(ws)} disabled={syncingColumns}>
                  {syncingColumns ? "…" : "Sync Columns"}
                </button>
              {/if}
            {/if}
          </div>
        </div>

        <!-- Gmail -->
        <div class="wc-section">
          <span class="wc-label">Gmail</span>
          {#if editingWorkspace?.id === ws.id}
            <input id="ws-gmail" class="input" type="email" bind:value={workspaceForm.gmail_address} placeholder="you@gmail.com" />
          {:else}
            <span class="wc-value">{ws.gmail_address ?? "—"}</span>
          {/if}
        </div>

        <!-- Store Profile -->
        <div class="wc-section">
          <span class="wc-label">Store Profile</span>
          {#if editingWorkspace?.id === ws.id}
            <div class="field">
              <label class="field-label" for="ws-store-name">Store name</label>
              <input id="ws-store-name" class="input" bind:value={workspaceForm.store_name} placeholder="e.g. Acme Widgets" />
            </div>
            <div class="field">
              <label class="field-label" for="ws-store-description">About your store</label>
              <textarea id="ws-store-description" class="input textarea" bind:value={workspaceForm.store_description} placeholder="Describe what your store sells, your niche, tone, and anything the AI should know when writing replies." rows={4}></textarea>
            </div>
            <div class="field">
              <label class="field-label" for="ws-store-url">Store URL</label>
              <input id="ws-store-url" class="input" type="url" bind:value={workspaceForm.store_url} placeholder="https://yourstore.com" />
            </div>
          {:else if ws.store_name || ws.store_description || ws.store_url}
            <div class="wc-store-preview">
              {#if ws.store_name}<span class="wc-store-name">{ws.store_name}</span>{/if}
              {#if ws.store_description}<span class="wc-store-desc">{ws.store_description}</span>{/if}
              {#if ws.store_url}<a href={ws.store_url} class="wc-store-url" target="_blank" rel="noopener noreferrer">{ws.store_url}</a>{/if}
            </div>
          {:else}
            <span class="wc-empty">Not set — click Edit to add store context for the AI.</span>
          {/if}
        </div>

        <!-- Google Sheet — collapsible -->
        <details class="wc-integration" open={editingWorkspace?.id === ws.id ? true : undefined}>
          <summary class="wc-integration-summary">
            <span class="wc-label">Google Sheet</span>
            <span class="wc-integration-preview">
              {#if ws.sheet_id}
                {ws.sheet_name} · <code>{ws.sheet_id.slice(0, 16)}…</code>
              {:else}
                <span class="wc-empty">Not connected</span>
              {/if}
            </span>
          </summary>
          <div class="wc-integration-body">
            {#if editingWorkspace?.id === ws.id}
              <div class="field">
                <label class="field-label" for="ws-sheet-id">Sheet ID</label>
                <input id="ws-sheet-id" class="input" bind:value={workspaceForm.sheet_id} placeholder="e.g. 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms" />
                <p class="field-hint">Find this in your Google Sheets URL: <code>docs.google.com/spreadsheets/d/<strong>[THIS PART]</strong>/edit</code></p>
              </div>
              <div class="field">
                <label class="field-label" for="ws-sheet-name">Sheet name</label>
                <input id="ws-sheet-name" class="input" bind:value={workspaceForm.sheet_name} placeholder="Sheet1" />
                <p class="field-hint">Must match the tab name exactly. Default is <code>Sheet1</code>.</p>
              </div>
            {:else}
              <div class="wc-detail-row">
                <span class="wc-detail-label">Sheet ID</span>
                <code class="wc-detail-value">{ws.sheet_id ?? "—"}</code>
              </div>
              <div class="wc-detail-row">
                <span class="wc-detail-label">Tab name</span>
                <span class="wc-detail-value">{ws.sheet_name}</span>
              </div>
            {/if}
          </div>
        </details>

      </div>
    {/each}
  {/if}
</section>

<!-- Email Signature -->
<section class="card section">
  <h2>Email Signature</h2>
  <p class="section-description">
    The AI signs every outbound email with this name. Leave blank to omit a sign-off.
  </p>

  {#if loadingSettings}
    <div class="loading-text">Loading…</div>
  {:else}
    <div class="signature-editor">
      <div class="signature-input-row">
        <input
          class="input signature-input"
          type="text"
          placeholder="e.g. Sarah from Support"
          bind:value={senderName}
        />
        <button
          class="btn btn-primary btn-sm"
          onclick={saveSenderName}
          disabled={savingSenderName}
        >
          {savingSenderName ? "Saving…" : "Save"}
        </button>
      </div>

      <div class="signature-preview">
        <span class="signature-preview-label">Preview</span>
        <div class="signature-preview-body">
          <span class="signature-preview-line">…your reply text here…</span>
          {#if senderName.trim()}
            <span class="signature-preview-line">
              Best regards,<br />{senderName.trim()}
            </span>
          {:else}
            <span class="signature-preview-line signature-preview-empty">No sign-off (name is blank)</span>
          {/if}
        </div>
      </div>
    </div>
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
            {#if def.hint}
              <span class="setting-hint">{def.hint}</span>
            {/if}
          </div>

          <div class="setting-control">
            {#if def.type === "boolean"}
              <label class="toggle">
                <input
                  type="checkbox"
                  checked={settings[def.key] === "true"}
                  onchange={(e) =>
                    handleBooleanToggle(
                      def.key,
                      (e.target as HTMLInputElement).checked,
                    )}
                  disabled={savingKey === def.key}
                />
                <span class="toggle-slider"></span>
              </label>
            {:else if def.key === 'openai_model' && openaiModels.length > 0}
              <div class="input-with-save">
                <select
                  class="input"
                  bind:value={settings[def.key]}
                  onchange={() => saveSetting(def.key, settings[def.key])}
                  disabled={savingKey === def.key}
                >
                  {#each openaiModels as model (model)}
                    <option value={model}>{model}</option>
                  {/each}
                </select>
                {#if savingKey === def.key}
                  <span class="saving-indicator">…</span>
                {/if}
              </div>
            {:else}
              <div class="input-with-save">
                <input
                  class="input"
                  type={def.type === "number" ? "number" : "text"}
                  value={settings[def.key] ?? ""}
                  min={def.type === "number" ? 0 : undefined}
                  max={def.type === "number" ? 1 : undefined}
                  step={def.type === "number" ? 0.01 : undefined}
                  oninput={(e) => {
                    settings[def.key] = (e.target as HTMLInputElement).value;
                  }}
                />
                <button
                  class="btn btn-primary btn-sm"
                  onclick={() => saveSetting(def.key, settings[def.key] ?? "")}
                  disabled={savingKey === def.key}
                >
                  {savingKey === def.key ? "…" : "Save"}
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
  .page-header {
    margin-bottom: 24px;
  }

  h1 {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  h2 {
    font-size: 13.5px;
    font-weight: 700;
    margin-bottom: 6px;
  }

  .section {
    margin-bottom: 16px;
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

  .ws-banner {
    margin-top: 12px;
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

  .status-dot.connected {
    background: var(--color-success);
    box-shadow: 0 0 0 2px rgba(16 185 129 / 0.2);
  }
  .status-dot.disconnected {
    background: var(--color-text-muted);
  }

  .expiry {
    color: var(--color-text-muted);
    font-size: 12px;
    margin-left: auto;
  }

  /* Workspace cards */
  .workspace-card {
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    margin-bottom: 12px;
    overflow: hidden;
  }

  .workspace-card:last-child {
    margin-bottom: 0;
  }

  .wc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    background: var(--color-surface-2);
    border-bottom: 1px solid var(--color-border);
  }

  .wc-name {
    font-size: 13px;
    font-weight: 600;
  }

  .wc-name-input {
    width: 200px;
  }

  .wc-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  .wc-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border);
  }

  .wc-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }

  .wc-value {
    font-size: 13px;
    color: var(--color-text);
  }

  .wc-empty {
    font-size: 12px;
    color: var(--color-text-muted);
    font-style: italic;
  }

  .wc-store-preview {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .wc-store-name {
    font-size: 13px;
    font-weight: 600;
  }

  .wc-store-desc {
    font-size: 12px;
    color: var(--color-text-muted);
    line-height: 1.5;
  }

  .wc-store-url {
    font-size: 12px;
    color: var(--color-accent, #60a5fa);
    text-decoration: none;
  }

  .wc-store-url:hover {
    text-decoration: underline;
  }

  .wc-integration {
    border-bottom: none;
  }

  .wc-integration-summary {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 16px;
    cursor: pointer;
    list-style: none;
    user-select: none;
  }

  .wc-integration-summary::-webkit-details-marker {
    display: none;
  }

  .wc-integration-summary::before {
    content: "▶";
    font-size: 9px;
    color: var(--color-text-muted);
    order: -1;
    transition: transform 0.15s;
    flex-shrink: 0;
  }

  details[open] .wc-integration-summary::before {
    transform: rotate(90deg);
  }

  .wc-integration-preview {
    font-size: 12px;
    color: var(--color-text-muted);
    flex: 1;
  }

  .wc-integration-body {
    padding: 0 16px 14px 32px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .wc-detail-row {
    display: flex;
    gap: 12px;
    align-items: baseline;
  }

  .wc-detail-label {
    font-size: 11px;
    color: var(--color-text-muted);
    min-width: 64px;
    flex-shrink: 0;
  }

  .wc-detail-value {
    font-size: 12px;
    color: var(--color-text);
    word-break: break-all;
  }

  .wc-section .input,
  .wc-integration-body .input {
    width: 100%;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .field-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text);
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

  .setting-hint {
    font-size: 12px;
    color: var(--color-text-muted);
    font-style: italic;
  }

  .field-hint {
    font-size: 12px;
    color: var(--color-text-muted);
    line-height: 1.5;
    margin-top: 1px;
  }

  code {
    font-family: monospace;
    background: var(--color-surface-2);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
  }

  .signature-editor {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .signature-input-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .signature-input {
    width: 260px;
  }

  .signature-preview {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .signature-preview-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }

  .signature-preview-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 13px;
    line-height: 1.5;
  }

  .signature-preview-line {
    color: var(--color-text);
  }

  .signature-preview-empty {
    color: var(--color-text-muted);
    font-style: italic;
  }

  .setting-control {
    flex-shrink: 0;
  }

  .input-with-save {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .saving-indicator {
    color: var(--color-text-muted);
    font-size: 13px;
  }

  .input {
    width: 200px;
  }

  .input.textarea {
    width: 100%;
    resize: vertical;
    min-height: 80px;
    font-family: inherit;
    line-height: 1.5;
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
    content: "";
    position: absolute;
    width: 16px;
    height: 16px;
    left: 3px;
    top: 50%;
    transform: translateY(-50%);
    background: var(--color-text-muted);
    border-radius: 50%;
    transition:
      transform 0.2s,
      background 0.2s;
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

  :global(.error-banner) {
    background: rgba(239 68 68 / 0.1);
    border: 1px solid rgba(239 68 68 / 0.3);
    border-radius: var(--radius);
    color: var(--color-danger);
    padding: 12px 16px;
    margin-bottom: 16px;
  }

  /* ------------------------------------------------------------------ */
  /* Mobile responsive                                                    */
  /* ------------------------------------------------------------------ */
  @media (max-width: 767px) {
    .setting-row {
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
    }

    .setting-control {
      width: 100%;
      flex-shrink: unset;
    }

    .input-with-save {
      width: 100%;
    }

    .input {
      width: 100%;
      flex: 1;
    }

    .signature-input-row {
      flex-wrap: wrap;
    }

    .signature-input {
      width: 100%;
    }

    .workspace-row {
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
    }

    .workspace-actions {
      width: 100%;
    }

    .field-row {
      flex-direction: column;
      align-items: flex-start;
    }

    .field-label {
      min-width: unset;
    }

    .field-row input,
    .field-row select {
      width: 100%;
    }
  }
</style>
