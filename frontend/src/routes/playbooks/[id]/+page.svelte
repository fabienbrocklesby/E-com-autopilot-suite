<!--
  /playbooks/[id] - Playbook editor
  Plain-language input → AI parse → step cards → per-step edit modals → save/activate.
  Also includes dry-run: paste an example email and see the execution trace.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { fly, fade } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { playbooksApi, categoriesApi } from "$lib/api";
  import type { Playbook, PlaybookStep, Category, DryRunResult } from "$lib/api";
  import { PlusCircle, TableProperties, Pencil, MessageCircleQuestion, GitBranch, Hand, Send, CheckCircle, AlertTriangle, ChevronUp, ChevronDown, X, Scale } from '@lucide/svelte';

  const playbookId = parseInt($page.params.id ?? "0");

  const prefersReducedMotion =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  let playbook = $state<Playbook | null>(null);
  let categories = $state<Category[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let parsing = $state(false);
  let error = $state<string | null>(null);
  let success = $state<string | null>(null);
  let parseWarnings = $state<string[]>([]);

  // Form state
  let name = $state("");
  let categoryId = $state<number | null>(null);
  let description = $state("");
  let steps = $state<PlaybookStep[]>([]);
  let customerSilenceHours = $state(168);
  let writingStyle = $state("");
  let replyMode = $state<'auto_reply' | 'draft_only'>('draft_only');
  let confidenceThreshold = $state(0.8);

  // Per-step edit modal
  let editingStep = $state<PlaybookStep | null>(null);
  let editingIndex = $state(-1);
  let editDraft = $state<Record<string, unknown>>({});

  // Add step inline input
  let showAddStep = $state(false);
  let addStepDesc = $state("");
  let addStepAtIndex = $state(-1); // -1 = append at end
  let addingStep = $state(false);

  // Dry-run modal
  let showDryRun = $state(false);
  let dryRunEmail = $state("");
  let dryRunning = $state(false);
  let dryRunResult = $state<DryRunResult | null>(null);
  let dryRunError = $state<string | null>(null);

  // Step type icons & labels
  const stepMeta: Record<string, { icon: typeof PlusCircle; label: string; color: string }> = {
    extract:         { icon: PlusCircle,           label: "Extract",         color: "#6366f1" },
    find_sheet_row:  { icon: TableProperties,      label: "Find Sheet Row",  color: "#0ea5e9" },
    update_sheet:    { icon: Pencil,                label: "Update Sheet",    color: "#0ea5e9" },
    ask_customer:    { icon: MessageCircleQuestion, label: "Ask Customer",    color: "#f59e0b" },
    evaluate:        { icon: Scale,                 label: "Evaluate",        color: "#8b5cf6" },
    branch:          { icon: GitBranch,             label: "Branch",          color: "#a78bfa" },
    manual_approval: { icon: Hand,                  label: "Manual Approval", color: "#f97316" },
    send_reply:      { icon: Send,                  label: "Send Reply",      color: "#10b981" },
    complete:        { icon: CheckCircle,           label: "Complete",        color: "#10b981" },
    escalate:        { icon: AlertTriangle,         label: "Escalate",        color: "#ef4444" },
  };

  const defaultMeta = { icon: PlusCircle, label: "Unknown", color: "#64748b" };

  function meta(type: string) {
    return stepMeta[type] ?? defaultMeta;
  }

  function stepSummary(step: PlaybookStep): string {
    switch (step.type) {
      case "extract": return `Extract: ${(step.variables as string[] | undefined)?.join(", ") ?? "–"}`;
      case "find_sheet_row": return `Search sheet by ${((step.match_attempts as {column:string}[] | undefined)?.[0]?.column) ?? "…"}`;
      case "update_sheet": return `Update ${((step.updates as {column:string}[] | undefined)?.length ?? 0)} column(s) in row`;
      case "ask_customer": {
        const text = (step.goal as string | undefined) ?? (step.message as string | undefined) ?? "–";
        return `Ask: "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`;
      }
      case "evaluate": {
        const goal = (step.goal as string | undefined) ?? "–";
        return `Evaluate: ${goal.slice(0, 70)}${goal.length > 70 ? "…" : ""}`;
      }
      case "branch": return `If ${step.condition} → ${step.if_true} / ${step.if_false}`;
      case "manual_approval": return `Hold for approval: "${(step.reason as string | undefined)?.slice(0, 50) ?? "–"}"`;
      case "send_reply": {
        const goal = step.goal as string | undefined;
        if (goal) return `Reply (AI): "${goal.slice(0, 60)}${goal.length > 60 ? "…" : ""}"`;
        const msg = step.message;
        if (typeof msg === "string") return `Reply: "${msg.slice(0, 60)}"`;
        if (typeof msg === "object" && msg !== null && "ai_generate_using_category_voice" in (msg as object)) return "Reply: [AI generated]";
        return `Reply: [template]`;
      }
      case "complete": return "End run successfully";
      case "escalate": return `Escalate: "${(step.reason as string | undefined)?.slice(0, 60) ?? "–"}"`;
      default: return step.type;
    }
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const [pbRes, catRes] = await Promise.all([
        playbooksApi.get(playbookId),
        categoriesApi.list(),
      ]);
      playbook = pbRes.playbook;
      categories = catRes.categories;
      name = playbook.name;
      categoryId = playbook.category_id;
      description = playbook.plain_language_description ?? "";
      customerSilenceHours = playbook.customer_silence_hours ?? 168;
      writingStyle = playbook.writing_style ?? "";
      replyMode = playbook.reply_mode ?? 'draft_only';
      confidenceThreshold = playbook.confidence_threshold ?? 0.8;
      steps = Array.isArray(playbook.steps)
        ? playbook.steps
        : typeof playbook.steps === "string"
          ? JSON.parse(playbook.steps)
          : [];
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load playbook";
    } finally {
      loading = false;
    }
  }

  async function generateSteps() {
    if (!description.trim()) {
      error = "Write a description first.";
      return;
    }
    parsing = true;
    error = null;
    parseWarnings = [];
    try {
      const res = await playbooksApi.parse({ description: description.trim() });
      // Merge: preserve manually-edited steps where IDs match
      const existingById = new Map(steps.map((s) => [s.id, s]));
      steps = res.steps.map((s) => existingById.get(s.id) ?? s);
      parseWarnings = res.warnings;
    } catch (e) {
      error = e instanceof Error ? e.message : "Parse failed";
    } finally {
      parsing = false;
    }
  }

  async function save(andActivate = false) {
    saving = true;
    error = null;
    try {
      await playbooksApi.update(playbookId, {
        name: name.trim(),
        category_id: categoryId,
        plain_language_description: description,
        steps,
        is_active: andActivate ? true : playbook?.is_active,
        customer_silence_hours: customerSilenceHours,
        writing_style: writingStyle,
        reply_mode: replyMode,
        confidence_threshold: confidenceThreshold,
      });
      if (andActivate) {
        await playbooksApi.activate(playbookId);
      }
      flash(andActivate ? "Saved and activated." : "Saved.");
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Save failed";
    } finally {
      saving = false;
    }
  }

  function flash(msg: string) {
    success = msg;
    setTimeout(() => { success = null; }, 3000);
  }

  // ─── Step editing ────────────────────────────────────────────────────────────

  function openEdit(step: PlaybookStep, index: number) {
    editingStep = step;
    editingIndex = index;
    editDraft = { ...step };
  }

  function closeEdit() {
    editingStep = null;
    editingIndex = -1;
    editDraft = {};
  }

  function saveEdit() {
    if (editingIndex < 0) return;
    steps = steps.map((s, i) => i === editingIndex ? (editDraft as PlaybookStep) : s);
    closeEdit();
  }

  function deleteStep(index: number) {
    steps = steps.filter((_, i) => i !== index);
  }

  function moveStep(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    steps = next;
  }

  async function addStep() {
    if (!addStepDesc.trim()) return;
    addingStep = true;
    try {
      const prevSteps = addStepAtIndex === -1 ? steps : steps.slice(0, addStepAtIndex);
      const nextSteps = addStepAtIndex === -1 ? [] : steps.slice(addStepAtIndex);
      const res = await playbooksApi.parseStep({
        description: addStepDesc.trim(),
        previous_steps: prevSteps,
        next_steps: nextSteps,
        playbook_context: description,
      });
      const insertAt = addStepAtIndex === -1 ? steps.length : addStepAtIndex;
      const arr = [...steps];
      arr.splice(insertAt, 0, res.step);
      steps = arr;
      addStepDesc = "";
      showAddStep = false;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to generate step";
    } finally {
      addingStep = false;
    }
  }

  // ─── Dry run ─────────────────────────────────────────────────────────────────

  async function runDryRun() {
    if (!dryRunEmail.trim()) {
      dryRunError = "Paste an example email first.";
      return;
    }
    dryRunning = true;
    dryRunError = null;
    dryRunResult = null;
    try {
      dryRunResult = await playbooksApi.dryRun(playbookId, dryRunEmail.trim());
    } catch (e) {
      dryRunError = e instanceof Error ? e.message : "Dry run failed";
    } finally {
      dryRunning = false;
    }
  }

  // ─── Edit draft helpers ──────────────────────────────────────────────────────

  function draftStr(key: string): string {
    return (editDraft[key] as string | undefined) ?? "";
  }

  function setDraft(key: string, value: unknown) {
    editDraft = { ...editDraft, [key]: value };
  }

  function draftVariables(): string {
    return ((editDraft.variables as string[] | undefined) ?? []).join(", ");
  }

  function setDraftVariables(val: string) {
    setDraft("variables", val.split(",").map((v) => v.trim()).filter(Boolean));
  }

  function draftMatchAttempts(): string {
    const ma = (editDraft.match_attempts as Array<{column:string;context_var:string}> | undefined) ?? [];
    return ma.map((m) => `${m.column}:${m.context_var}`).join("\n");
  }

  function setDraftMatchAttempts(val: string) {
    const attempts = val.split("\n").map((line) => {
      const [col, cv] = line.split(":").map((s) => s.trim());
      return { column: col ?? "", context_var: cv ?? "" };
    }).filter((m) => m.column && m.context_var);
    setDraft("match_attempts", attempts);
  }

  function draftUpdates(): string {
    const upd = (editDraft.updates as Array<{column:string;value_or_var:string}> | undefined) ?? [];
    return upd.map((u) => `${u.column}:${u.value_or_var}`).join("\n");
  }

  function setDraftUpdates(val: string) {
    const updates = val.split("\n").map((line) => {
      const [col, ...rest] = line.split(":").map((s) => s.trim());
      return { column: col ?? "", value_or_var: rest.join(":") || "" };
    }).filter((u) => u.column);
    setDraft("updates", updates);
  }

  function draftSendMessage(): string {
    const msg = editDraft.message;
    if (typeof msg === "string") return msg;
    if (msg && typeof msg === "object" && "ai_generate_using_category_voice" in (msg as object)) return "__ai__";
    if (msg && typeof msg === "object" && "from_template" in (msg as object)) return (msg as { from_template: string }).from_template;
    return "";
  }

  function setDraftSendMessage(val: string) {
    if (val === "__ai__") {
      setDraft("message", { ai_generate_using_category_voice: true });
    } else {
      setDraft("message", val);
    }
  }

  onMount(load);
</script>

<svelte:head>
  <title>{playbook?.name ?? "Playbook"} - Email Dash</title>
</svelte:head>

<div class="page-header">
  <button class="back-btn" onclick={() => goto("/playbooks")}>← Playbooks</button>
  <div class="header-right">
    {#if playbook}
      <span class="version-badge">v{playbook.version}</span>
      <span class="status-badge" class:active={playbook.is_active}>
        {playbook.is_active ? "Active" : "Inactive"}
      </span>
    {/if}
    <button class="btn btn-ghost" onclick={() => { showDryRun = true; dryRunResult = null; dryRunError = null; }}>
      Test with example email
    </button>
  </div>
</div>

{#if error}
  <div class="error-banner" transition:fade={{ duration: 150 }}>{error}</div>
{/if}
{#if success}
  <div class="success-banner" transition:fade={{ duration: 150 }}>{success}</div>
{/if}

{#if loading}
  <div class="loading">Loading…</div>
{:else if playbook}
  <div class="editor-layout">

    <!-- ── Top bar: name + category + reply settings ──────────────────────────── -->
    <div class="top-bar card">
      <div class="field">
        <label>Name</label>
        <input type="text" bind:value={name} placeholder="Playbook name" />
      </div>
      <div class="field">
        <label>Category</label>
        <select bind:value={categoryId}>
          <option value={null}>- No category -</option>
          {#each categories as cat (cat.id)}
            <option value={cat.id}>{cat.name}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <label title="Escalate the run if the customer hasn't replied after this many hours">Customer silence timeout (hours)</label>
        <input type="number" bind:value={customerSilenceHours} min="0" step="1" style="width:100px" />
      </div>
      <div class="field">
        <label title="How the AI should write emails - e.g. 'Professional and concise. Use the customer's first name.'">Writing style</label>
        <input type="text" bind:value={writingStyle} placeholder="e.g. Professional and concise. Use the customer's first name." style="min-width:220px" />
      </div>
      <div class="field">
        <label title="draft_only: always queue for review. auto_reply: send automatically if step allows.">Reply mode</label>
        <select bind:value={replyMode}>
          <option value="draft_only">Draft only (always queue for review)</option>
          <option value="auto_reply">Auto-reply (send immediately)</option>
        </select>
      </div>
      <div class="field">
        <label title="Minimum AI confidence (0–1) required to start this playbook automatically. Below threshold: thread goes to review.">Min confidence</label>
        <input type="number" bind:value={confidenceThreshold} min="0" max="1" step="0.05" style="width:80px" />
      </div>
    </div>

    <!-- ── Main two-column layout ─────────────────────────────────────────────── -->
    <div class="main-cols">

      <!-- Left: description + generate -->
      <div class="col-left card">
        <div class="col-header">
          <h2>Plain-language description</h2>
          <span class="hint">Write how you'd explain this to a new employee.</span>
        </div>
        <textarea
          bind:value={description}
          placeholder="When someone asks for a refund, find their order in the sheet using their order number or email. If you can't find it, ask them for the order number. Mark the sheet status as Refund Requested and send it to me for approval. Once I approve, reply to confirm."
          rows={12}
        ></textarea>
        <button class="btn btn-primary generate-btn" onclick={generateSteps} disabled={parsing}>
          {parsing ? "Generating…" : "Generate Steps"}
        </button>
        {#if parseWarnings.length > 0}
          <div class="warnings">
            {#each parseWarnings as w}
              <div class="warning-item"><AlertTriangle size={14} /> {w}</div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Right: step pipeline -->
      <div class="col-right card">
        <div class="col-header">
          <h2>Steps</h2>
          <span class="hint">{steps.length} step{steps.length !== 1 ? "s" : ""}</span>
        </div>

        {#if steps.length === 0}
          <div class="steps-empty">
            Write a description and click "Generate Steps" to create the pipeline.
          </div>
        {:else}
          <div class="step-list">
            {#each steps as step, i (step.id)}
              <div
                class="step-card"
                in:fly={{ y: prefersReducedMotion ? 0 : 6, duration: prefersReducedMotion ? 50 : 140, delay: i * 25, easing: cubicOut }}
              >
                <div class="step-icon" style="background: {meta(step.type).color}20; color: {meta(step.type).color}">
                  {#if meta(step.type).icon}
                    {@const StepIcon = meta(step.type).icon}
                    <StepIcon size={16} />
                  {/if}
                </div>
                <div class="step-body">
                  <div class="step-type">{meta(step.type).label}</div>
                  <div class="step-id">id: {step.id}</div>
                  <div class="step-summary">{stepSummary(step)}</div>
                </div>
                <div class="step-actions">
                  <button class="step-btn" onclick={() => moveStep(i, -1)} disabled={i === 0} title="Move up"><ChevronUp size={14} /></button>
                  <button class="step-btn" onclick={() => moveStep(i, 1)} disabled={i === steps.length - 1} title="Move down"><ChevronDown size={14} /></button>
                  <button class="step-btn" onclick={() => openEdit(step, i)} title="Edit"><Pencil size={14} /></button>
                  <button class="step-btn danger" onclick={() => deleteStep(i)} title="Delete"><X size={14} /></button>
                </div>
              </div>
              <!-- Insert step below this one -->
              <div class="insert-step-row">
                <button class="insert-btn" title="Insert step here" onclick={() => { addStepAtIndex = i + 1; showAddStep = true; addStepDesc = ''; }}>
                  + insert step
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <!-- Add step to end -->
        <div class="add-step-area">
          {#if showAddStep}
            <div class="add-step-form">
              <input
                type="text"
                bind:value={addStepDesc}
                placeholder="Describe what this step should do…"
                onkeydown={(e) => { if (e.key === 'Enter') addStep(); if (e.key === 'Escape') { showAddStep = false; } }}
                autofocus
              />
              <button class="btn btn-primary btn-sm" onclick={addStep} disabled={addingStep}>
                {addingStep ? 'Generating…' : 'Add'}
              </button>
              <button class="btn btn-ghost btn-sm" onclick={() => { showAddStep = false; addStepDesc = ''; }}>Cancel</button>
            </div>
          {:else}
            <button class="btn btn-ghost" onclick={() => { addStepAtIndex = -1; showAddStep = true; addStepDesc = ''; }}>
              + Add step
            </button>
          {/if}
        </div>
      </div>
    </div>

    <!-- ── Bottom: save buttons ───────────────────────────────────────────────── -->
    <div class="bottom-bar">
      <button class="btn btn-ghost" onclick={() => goto("/playbooks")}>Cancel</button>
      <div class="save-group">
        <button class="btn btn-secondary" onclick={() => save(false)} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button class="btn btn-primary" onclick={() => save(true)} disabled={saving}>
          {saving ? "Saving…" : "Save & Activate"}
        </button>
      </div>
    </div>

  </div>
{/if}

<!-- ─── Step edit modal ──────────────────────────────────────────────────────── -->
{#if editingStep}
  <div class="modal-overlay" onclick={closeEdit}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <span>Edit step: <strong>{meta(editingStep.type).label}</strong></span>
        <button class="modal-close" onclick={closeEdit}><X size={16} /></button>
      </div>

      <div class="modal-body">
        <!-- Common: id field -->
        <div class="field">
          <label>Step ID</label>
          <input type="text" value={draftStr("id")} oninput={(e) => setDraft("id", (e.target as HTMLInputElement).value)} />
        </div>

        <!-- extract -->
        {#if editingStep.type === "extract"}
          <div class="field">
            <label>Variables to extract <span class="hint">(comma-separated)</span></label>
            <input type="text" value={draftVariables()} oninput={(e) => setDraftVariables((e.target as HTMLInputElement).value)} placeholder="order_number, customer_email" />
          </div>

        <!-- find_sheet_row -->
        {:else if editingStep.type === "find_sheet_row"}
          <div class="field">
            <label>Match attempts <span class="hint">(one per line: column_name:context_var)</span></label>
            <textarea rows={4} value={draftMatchAttempts()} oninput={(e) => setDraftMatchAttempts((e.target as HTMLTextAreaElement).value)} placeholder={"Order Number:order_number\nEmail:customer_email"}></textarea>
          </div>

        <!-- update_sheet -->
        {:else if editingStep.type === "update_sheet"}
          <div class="field">
            <label>Row variable</label>
            <input type="text" value={draftStr("row_var")} oninput={(e) => setDraft("row_var", (e.target as HTMLInputElement).value)} placeholder="row_number" />
          </div>
          <div class="field">
            <label>Updates <span class="hint">(one per line: Column Name:value_or_{'{var}'})</span></label>
            <textarea rows={4} value={draftUpdates()} oninput={(e) => setDraftUpdates((e.target as HTMLTextAreaElement).value)} placeholder={"Status:Refund Requested\nReason:{refund_reason}"}></textarea>
          </div>

        <!-- ask_customer -->
        {:else if editingStep.type === "ask_customer"}
          <div class="field">
            <label>Goal <span class="hint">What information are you trying to get? AI drafts the question.</span></label>
            <input type="text" value={draftStr("goal")} oninput={(e) => setDraft("goal", (e.target as HTMLInputElement).value)} placeholder="Ask the customer for their order number" />
          </div>
          <div class="field">
            <label>Required context <span class="hint">(comma-separated; step is skipped when all are already known)</span></label>
            <input type="text" value={((editDraft.required_context as string[] | undefined) ?? []).join(", ")} oninput={(e) => setDraft("required_context", (e.target as HTMLInputElement).value.split(",").map((v) => v.trim()).filter(Boolean))} placeholder="order_number, customer_email" />
          </div>
          <div class="field">
            <label>On reply - go to step ID</label>
            <input type="text" value={draftStr("on_reply_goto")} oninput={(e) => setDraft("on_reply_goto", (e.target as HTMLInputElement).value)} placeholder="extract_1" />
          </div>
          <div class="field">
            <label>Voice hint <span class="hint">(override playbook writing style for this step)</span></label>
            <input type="text" value={draftStr("voice_hint")} oninput={(e) => setDraft("voice_hint", (e.target as HTMLInputElement).value)} placeholder="Empathetic and brief" />
          </div>
          <label class="field toggle-field">
            <span class="label">Require human approval before sending</span>
            <label class="toggle">
              <input type="checkbox" checked={!!editDraft.require_approval} onchange={(e) => setDraft("require_approval", (e.target as HTMLInputElement).checked)} />
              <span class="toggle-slider"></span>
            </label>
          </label>

        <!-- evaluate -->
        {:else if editingStep.type === "evaluate"}
          <div class="field">
            <label>Goal <span class="hint">What decision is this step making?</span></label>
            <input type="text" value={draftStr("goal")} oninput={(e) => setDraft("goal", (e.target as HTMLInputElement).value)} placeholder="Do we have the order number to proceed?" />
          </div>
          <div class="field">
            <label>Required context <span class="hint">(comma-separated; all must be non-null to be satisfied)</span></label>
            <input type="text" value={((editDraft.required_context as string[] | undefined) ?? []).join(", ")} oninput={(e) => setDraft("required_context", (e.target as HTMLInputElement).value.split(",").map((v) => v.trim()).filter(Boolean))} placeholder="order_number, customer_email" />
          </div>
          <div class="field">
            <label>If satisfied - go to step ID</label>
            <input type="text" value={draftStr("if_satisfied_goto")} oninput={(e) => setDraft("if_satisfied_goto", (e.target as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label>If missing - go to step ID</label>
            <input type="text" value={draftStr("if_missing_goto")} oninput={(e) => setDraft("if_missing_goto", (e.target as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label>If escalate - go to step ID</label>
            <input type="text" value={draftStr("if_escalate_goto")} oninput={(e) => setDraft("if_escalate_goto", (e.target as HTMLInputElement).value)} />
          </div>

        <!-- branch -->
        {:else if editingStep.type === "branch"}
          <div class="field">
            <label>Condition <span class="hint">e.g. context.order_number != null</span></label>
            <input type="text" value={draftStr("condition")} oninput={(e) => setDraft("condition", (e.target as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label>If true - go to step ID</label>
            <input type="text" value={draftStr("if_true")} oninput={(e) => setDraft("if_true", (e.target as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label>If false - go to step ID</label>
            <input type="text" value={draftStr("if_false")} oninput={(e) => setDraft("if_false", (e.target as HTMLInputElement).value)} />
          </div>

        <!-- manual_approval -->
        {:else if editingStep.type === "manual_approval"}
          <div class="field">
            <label>Reason</label>
            <input type="text" value={draftStr("reason")} oninput={(e) => setDraft("reason", (e.target as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label>Draft template <span class="hint">(optional)</span></label>
            <textarea rows={4} value={draftStr("draft_template")} oninput={(e) => setDraft("draft_template", (e.target as HTMLTextAreaElement).value)}></textarea>
          </div>
          <div class="field">
            <label>On approve - go to step ID</label>
            <input type="text" value={draftStr("on_approve")} oninput={(e) => setDraft("on_approve", (e.target as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label>On reject - go to step ID</label>
            <input type="text" value={draftStr("on_reject")} oninput={(e) => setDraft("on_reject", (e.target as HTMLInputElement).value)} />
          </div>

        <!-- send_reply -->
        {:else if editingStep.type === "send_reply"}
          <div class="field">
            <label>Goal <span class="hint">What should this reply achieve? AI drafts the message from this.</span></label>
            <input type="text" value={draftStr("goal")} oninput={(e) => setDraft("goal", (e.target as HTMLInputElement).value)} placeholder="Confirm the refund has been processed for the approved amount" />
          </div>
          <div class="field">
            <label>Voice hint <span class="hint">(override playbook writing style for this step)</span></label>
            <input type="text" value={draftStr("voice_hint")} oninput={(e) => setDraft("voice_hint", (e.target as HTMLInputElement).value)} placeholder="Empathetic and brief" />
          </div>
          <label class="field toggle-field">
            <span class="label">Require human approval before sending</span>
            <label class="toggle">
              <input type="checkbox" checked={!!editDraft.require_approval} onchange={(e) => setDraft("require_approval", (e.target as HTMLInputElement).checked)} />
              <span class="toggle-slider"></span>
            </label>
          </label>

        <!-- escalate -->
        {:else if editingStep.type === "escalate"}
          <div class="field">
            <label>Reason</label>
            <input type="text" value={draftStr("reason")} oninput={(e) => setDraft("reason", (e.target as HTMLInputElement).value)} />
          </div>

        <!-- complete - no config -->
        {:else if editingStep.type === "complete"}
          <p class="hint-block">No configuration needed. This step ends the run cleanly.</p>
        {/if}
      </div>

      <div class="modal-footer">
        <button class="btn btn-ghost" onclick={closeEdit}>Cancel</button>
        <button class="btn btn-primary" onclick={saveEdit}>Save step</button>
      </div>
    </div>
  </div>
{/if}

<!-- ─── Dry run modal ─────────────────────────────────────────────────────────── -->
{#if showDryRun}
  <div class="modal-overlay" onclick={() => { showDryRun = false; }}>
    <div class="modal modal-wide" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <span>Test with example email</span>
        <button class="modal-close" onclick={() => { showDryRun = false; }}><X size={16} /></button>
      </div>
      <div class="modal-body">
        {#if dryRunError}
          <div class="error-banner">{dryRunError}</div>
        {/if}
        <div class="field">
          <label>Paste an example email</label>
          <textarea rows={8} bind:value={dryRunEmail} placeholder="Subject: Where is my order?&#10;&#10;Hi, I placed order #1234 last week and haven't received a shipping update. Can you help?"></textarea>
        </div>
        <button class="btn btn-primary" onclick={runDryRun} disabled={dryRunning}>
          {dryRunning ? "Running…" : "Run simulation"}
        </button>

        {#if dryRunResult}
          <div class="dry-run-result">
            <div class="dry-run-status status-{dryRunResult.finalStatus}">
              Final status: {dryRunResult.finalStatus}
            </div>

            {#if Object.keys(dryRunResult.context).length > 0}
              <div class="context-bag">
                <h4>Context bag</h4>
                <table class="ctx-table">
                  <tbody>
                  {#each Object.entries(dryRunResult.context) as [k, v]}
                    <tr><td class="ctx-key">{k}</td><td class="ctx-val">{String(v)}</td></tr>
                  {/each}
                  </tbody>
                </table>
              </div>
            {/if}

            <h4>Execution trace</h4>
            <div class="trace-list">
              {#each dryRunResult.trace as entry}
                <div class="trace-entry trace-{entry.status}">
                  <div class="trace-header">
                    <span class="trace-type">{meta(entry.stepType).label}</span>
                    <code class="trace-id">{entry.stepId}</code>
                    <span class="trace-status-badge">{entry.status}</span>
                  </div>
                  <div class="trace-summary">{entry.summary}</div>
                  {#if entry.messageSent}
                    <div class="trace-detail"><strong>Message:</strong> {entry.messageSent}</div>
                  {/if}
                  {#if entry.condition}
                    <div class="trace-detail"><strong>Condition:</strong> {entry.condition.expression} = {entry.condition.result}</div>
                  {/if}
                  {#if entry.extractedVars && Object.keys(entry.extractedVars).length > 0}
                    <div class="trace-detail"><strong>Extracted:</strong> {JSON.stringify(entry.extractedVars)}</div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  .back-btn {
    background: none;
    border: none;
    color: var(--color-text-muted);
    font-size: 13px;
    cursor: pointer;
    padding: 6px 0;
  }

  .back-btn:hover { color: var(--color-text); }

  .header-right {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .version-badge {
    font-size: 12px;
    color: var(--color-text-muted);
    background: var(--color-surface-2);
    padding: 2px 8px;
    border-radius: 4px;
  }

  .status-badge {
    font-size: 12px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    text-transform: uppercase;
    background: rgba(100 116 139 / 0.15);
    color: var(--color-text-muted);
  }

  .status-badge.active {
    background: rgba(16 185 129 / 0.15);
    color: var(--color-success);
  }

  .loading { color: var(--color-text-muted); padding: 40px; text-align: center; }

  .editor-layout {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .top-bar {
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
  }

  .top-bar .field {
    flex: 1;
    min-width: 200px;
  }

  .main-cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  @media (max-width: 900px) {
    .main-cols { grid-template-columns: 1fr; }
  }

  .col-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .col-header h2 {
    font-size: 14px;
    font-weight: 700;
  }

  .hint {
    font-size: 12px;
    color: var(--color-text-muted);
  }

  .col-left textarea {
    width: 100%;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    color: var(--color-text);
    padding: 12px;
    font-family: var(--font);
    font-size: 13px;
    line-height: 1.6;
    resize: vertical;
    margin-bottom: 12px;
  }

  .generate-btn { width: 100%; }

  .warnings {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .warning-item {
    background: rgba(245 158 11 / 0.1);
    border: 1px solid rgba(245 158 11 / 0.3);
    color: #fcd34d;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 12px;
  }

  .steps-empty {
    color: var(--color-text-muted);
    font-size: 13px;
    padding: 20px 0;
    text-align: center;
  }

  .step-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .step-card {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 10px 12px;
  }

  .step-icon {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    flex-shrink: 0;
  }

  .step-body {
    flex: 1;
    min-width: 0;
  }

  .step-type {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }

  .step-id {
    font-size: 11px;
    color: var(--color-text-muted);
    font-family: monospace;
  }

  .step-summary {
    font-size: 12px;
    color: var(--color-text);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .step-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .step-btn {
    width: 26px;
    height: 26px;
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
  }

  .step-btn:hover { background: var(--color-surface); color: var(--color-text); }
  .step-btn:disabled { opacity: 0.3; cursor: default; }
  .step-btn.danger:hover { background: rgba(239 68 68 / 0.15); border-color: rgba(239 68 68 / 0.4); color: var(--color-danger); }

  .insert-step-row {
    display: flex;
    justify-content: center;
  }

  .insert-btn {
    background: none;
    border: none;
    color: var(--color-text-muted);
    font-size: 11px;
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 4px;
    opacity: 0.5;
  }

  .insert-btn:hover {
    opacity: 1;
    background: var(--color-surface-2);
    color: var(--color-text);
  }

  .add-step-area {
    margin-top: 10px;
    display: flex;
    justify-content: center;
  }

  .add-step-form {
    display: flex;
    gap: 8px;
    width: 100%;
    align-items: center;
  }

  .add-step-form input {
    flex: 1;
  }

  .toggle-field {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .toggle {
    position: relative;
    display: inline-block;
    width: 36px;
    height: 20px;
    flex-shrink: 0;
  }

  .toggle input { opacity: 0; width: 0; height: 0; }

  .toggle-slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: 20px;
    transition: 0.2s;
  }

  .toggle-slider:before {
    position: absolute;
    content: "";
    height: 14px;
    width: 14px;
    left: 2px;
    bottom: 2px;
    background: var(--color-text-muted);
    border-radius: 50%;
    transition: 0.2s;
  }

  .toggle input:checked + .toggle-slider { background: var(--color-primary); border-color: var(--color-primary); }
  .toggle input:checked + .toggle-slider:before { transform: translateX(16px); background: white; }

  .bottom-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  .save-group {
    display: flex;
    gap: 10px;
  }

  /* ─── Fields ─────────────────────────────────────────────────────────────── */

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  label {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-muted);
  }

  input[type="text"], select {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    color: var(--color-text);
    padding: 8px 12px;
    font-size: 13px;
    font-family: var(--font);
    width: 100%;
  }

  input[type="text"]:focus, select:focus, textarea:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  /* ─── Modal ──────────────────────────────────────────────────────────────── */

  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0 0 0 / 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    width: 520px;
    max-width: 95vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
  }

  .modal-wide { width: 680px; }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--color-border);
    font-size: 14px;
    font-weight: 600;
  }

  .modal-close {
    background: none;
    border: none;
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: 16px;
    padding: 4px;
  }

  .modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .modal-body textarea {
    width: 100%;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    color: var(--color-text);
    padding: 10px 12px;
    font-size: 13px;
    font-family: var(--font);
    line-height: 1.5;
    resize: vertical;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 16px 20px;
    border-top: 1px solid var(--color-border);
  }

  .hint-block {
    color: var(--color-text-muted);
    font-size: 13px;
    font-style: italic;
  }

  /* ─── Dry run ────────────────────────────────────────────────────────────── */

  .dry-run-result {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 8px;
  }

  .dry-run-status {
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 600;
    text-transform: capitalize;
  }

  .status-complete { background: rgba(16 185 129 / 0.15); color: var(--color-success); }
  .status-waiting_for_customer { background: rgba(245 158 11 / 0.15); color: #fcd34d; }
  .status-waiting_for_human { background: rgba(249 115 22 / 0.15); color: #fb923c; }
  .status-failed, .status-escalated { background: rgba(239 68 68 / 0.15); color: var(--color-danger); }

  h4 { font-size: 13px; font-weight: 700; color: var(--color-text-muted); }

  .ctx-table { border-collapse: collapse; width: 100%; font-size: 12px; }
  .ctx-key { color: var(--color-text-muted); padding: 3px 8px 3px 0; font-family: monospace; white-space: nowrap; }
  .ctx-val { color: var(--color-text); padding: 3px 0; word-break: break-all; }

  .trace-list { display: flex; flex-direction: column; gap: 6px; }

  .trace-entry {
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 12px;
  }

  .trace-success { border-left: 3px solid var(--color-success); }
  .trace-paused  { border-left: 3px solid #f59e0b; }
  .trace-failed  { border-left: 3px solid var(--color-danger); }
  .trace-skipped { border-left: 3px solid var(--color-border); opacity: 0.7; }

  .trace-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .trace-type { font-weight: 700; color: var(--color-text); }
  .trace-id { color: var(--color-text-muted); font-size: 11px; }
  .trace-status-badge {
    margin-left: auto;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--color-surface-2);
  }

  .trace-summary { color: var(--color-text); margin-bottom: 4px; }
  .trace-detail { color: var(--color-text-muted); margin-top: 4px; font-size: 11px; }

  .context-bag { background: var(--color-surface-2); border-radius: 6px; padding: 10px 14px; }

  .success-banner {
    background: rgba(16 185 129 / 0.1);
    border: 1px solid rgba(16 185 129 / 0.3);
    border-radius: var(--radius);
    color: #6ee7b7;
    padding: 12px 16px;
    margin-bottom: 16px;
  }
</style>
