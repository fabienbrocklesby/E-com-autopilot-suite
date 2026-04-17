# UI Redesign Proposal

## Current state - what's broken

8 nav items. Screenshots taken 2026-04-15 of every page in its current form.

| Page | What it does | Problem |
|---|---|---|
| Threads (/) | Table of all threads with status filters | No hierarchy. "Needs attention" threads mixed with spam categorised as "Other" |
| Review Queue (/review) | Threads in_review + playbook approval queue | Splits actionable items from main thread view. User must check two places. |
| Categories (/categories) | CRUD for email categories | Orphaned from playbooks. Category is meaningless without a playbook. |
| Playbooks (/playbooks) | Table of all playbook versions | Shows inactive/legacy versions. No connection to categories. |
| Sheet Rules (/sheet-rules) | Legacy rule-based sheet updates | Deprecated by playbooks. Confusing overlap. |
| Sheet Updates (/sheet-updates) | Audit log of sheet rule executions | Nobody asked for this. Dead nav item. |
| Settings (/settings) | Google auth, workspace config, general settings | Dumping ground but functional. Needs tightening. |
| System (/system) | Dev observability dashboard | Useful but wrong audience for main nav. |

Data shape (from live DB):
- 24 threads: 14 new, 2 in_review, 7 replied, 1 closed
- 9 playbook runs: 4 complete, 1 escalated, 3 failed, 1 waiting_for_customer
- 5 categories, 2 active playbooks, 1 active sheet rule
- Most "new" threads are spam/noise categorised as "Other"

The core insight: **14 of 24 threads are noise**. The user's actual work is 2 threads in review + 1 waiting for customer. That's 3 actionable items buried in a flat table.

---

## Proposed information architecture

### 3 primary nav items + 1 hidden

```
┌─────────────────────┐
│  ✉ Autopilot        │
│                     │
│  📥 Inbox           │  ← threads + review queue unified
│  📋 Playbooks       │  ← categories + playbooks merged
│  ⚙ Settings         │  ← tightened, integrations moved in
│                     │
│                     │
│  System →           │  ← small text link at bottom, not a primary nav item
└─────────────────────┘
```

**Removed from nav**: Sheet Rules, Sheet Updates.
**Merged**: Threads + Review Queue → Inbox. Categories + Playbooks → Playbooks.
**Demoted**: System → footer link, still accessible at /system.

### Why not 4 tabs with an "Activity" page?

Considered adding Activity/History as a 4th tab. Rejected because:
- With only 24 threads, resolved items fit at the bottom of Inbox behind a filter
- Splitting resolved threads into a separate page would make it harder to follow a thread's lifecycle
- The playbook run history is visible per-thread in the thread detail page
- If the thread volume grows 10x, we can revisit. For now, fewer tabs = less cognitive load

### Why this beats the current design

1. **3 items vs 8** - the user can hold the entire nav in working memory
2. **Inbox = "what do I need to do?"** - single entry point for all actionable work
3. **Playbooks absorb categories** - one concept ("how do I handle refund emails?") instead of two
4. **Legacy pages hidden, not deleted** - sheet rules data preserved, code preserved, no breaking changes

---

## The Inbox (/inbox, also /)

The user's home screen. This is where they spend 90% of their time. Design goal: **within 2 seconds of opening, the user knows what needs their attention and can act on it**.

### Layout

```
┌─────────────────────────────────────────────────────┐
│  📥 Inbox                          3 need attention  │
│                                                      │
│  [Needs attention] [In progress] [All] [Resolved]   │
│                                                      │
│  ┌─ NEEDS YOUR ATTENTION ────────────────────────┐  │
│  │                                                │  │
│  │  🟠 Tracking - Tracking Request                │  │
│  │     "Hey I was just curious what my tracking…" │  │
│  │     Playbook failed → needs manual review      │  │
│  │                                                │  │
│  │  🟡 Test - refund - Refund request             │  │
│  │     In review - no active playbook             │  │
│  │                                                │  │
│  │  🔵 Refund - Refund request                    │  │
│  │     Waiting for customer reply (3 days ago)    │  │
│  │                                                │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─ RECENTLY RESOLVED ───────────────────────────┐  │
│  │  ✓ Refund - Refund request - completed         │  │
│  │  ✓ Refund - Refund request - completed         │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─ OTHER ───────────────────────────────────────┐  │
│  │  Kia ora! Just some good news… - Other         │  │
│  │  Please Confirm your offer - Other             │  │
│  │  [Task Update] Top Reddit… - Other             │  │
│  │  (10 more)                                     │  │
│  └────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Grouping logic

Threads are grouped into sections based on urgency, not chronology:

1. **Needs attention** (top, always visible): threads where:
   - Playbook run status = `waiting_for_human` (manual approval needed)
   - Playbook run status = `escalated` or `failed` (something broke)
   - Thread status = `in_review` without an active run (legacy manual review)

2. **In progress** (below): threads where:
   - Playbook run status = `running`
   - Playbook run status = `waiting_for_customer`

3. **Recently resolved** (collapsed by default under "Resolved" filter): threads where:
   - Thread status = `replied` or `closed`
   - Playbook run status = `complete`

4. **Other** (bottom, collapsed): threads categorised as "Other" with no playbook run. These are noise. We show a count but collapse the list.

### Filter pills

`Needs attention` | `In progress` | `All` | `Resolved`

Default view on page load: shows "Needs attention" section expanded + "In progress" if any. "All" shows everything. "Resolved" shows completed threads.

### Per-thread row design

Each thread row shows:
- **Status indicator** (colored dot): orange = needs action, yellow = in review, blue = waiting, green = resolved, gray = other
- **Subject** (primary text, truncated)
- **Category badge** (small, colored)
- **Status description** (secondary text): human-readable string like "Step 4 of 7: Waiting for approval", "Waiting for customer reply", "Completed 2h ago"
- **Time** (relative: "3 days ago", "2h ago")

NO columns for: auto-replied (noise), drafts count (internal detail), received date (use relative time).

Click a row → navigate to /threads/[id].

### Keyboard navigation

- `j` / `k` or `↓` / `↑` to move between threads
- `Enter` to open selected thread
- `Escape` to go back to list from detail
- `1` / `2` / `3` / `4` to switch filter tabs

### Backend requirements

Need a new API endpoint or query shape that returns threads with their latest playbook run status joined. Currently the threads list endpoint doesn't include run data. Two options:

**Option A (preferred)**: Extend `GET /threads` to include `latest_run_status`, `latest_run_step`, `playbook_name` via a LEFT JOIN. Avoids N+1.

**Option B**: Fetch threads + runs separately and join client-side. Simpler backend change but worse performance.

Going with Option A.

---

## Thread Detail (/threads/[id])

The user clicks into a thread from Inbox. They need to:
1. Understand the conversation at a glance
2. See what the AI is doing / has done
3. Take action if needed (approve, reject, re-categorise, escalate)

### Layout

```
┌──────────────────────────────────────────────────────┐
│  ← Back to Inbox                                     │
│                                                      │
│  ┌─ ACTION BANNER (if applicable) ───────────────┐  │
│  │  🟠 Action required: Process refund in Stripe  │  │
│  │  Customer: Fabien | Product: Chaff | Amount: …  │  │
│  │  [Transaction ID input] [Done] [Reject]         │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─────────────────────────┬──────────────────────┐  │
│  │  CONVERSATION           │  PLAYBOOK STATUS     │  │
│  │                         │                      │  │
│  │  ← Fabien 3:01pm        │  Refund v4           │  │
│  │  "Hey mate, I need      │  ● Complete          │  │
│  │   refund."              │                      │  │
│  │                         │  1. ✓ extract        │  │
│  │  → You 3:04pm           │  2. ✓ find_sheet_row │  │
│  │  "Hi Fabien, Good news! │  3. ✓ evaluate       │  │
│  │   We've processed…"     │  4. ✓ update_sheet   │  │
│  │                         │  5. ✓ approval       │  │
│  │                         │  6. ✓ update_sheet   │  │
│  │                         │  7. ✓ send_reply     │  │
│  │                         │  8. ✓ complete       │  │
│  │                         │                      │  │
│  │                         │  ▸ Context (expand)  │  │
│  │                         │  ▸ AI calls (expand)  │  │
│  └─────────────────────────┴──────────────────────┘  │
│                                                      │
│  ┌─ QUICK ACTIONS ────────────────────────────────┐  │
│  │  Status: [Replied ▼]  Category: [Refund ▼]     │  │
│  │  [Re-run playbook] [Escalate]                   │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### Key changes from current

1. **ManualActionBanner stays at top** - already built, works well. Keep it.
2. **Two-column layout**: conversation left, playbook status right. Currently both are stacked vertically which makes the page very long.
3. **Playbook sidebar** shows step pipeline with status dots (checkmark, spinner, X, pause). Collapsible context bag and AI call log. Power user feature.
4. **Quick actions bar** at bottom: status dropdown, category dropdown, re-run and escalate buttons. Currently status is a row of buttons in the header card - dropdown is cleaner.
5. **Relative times** throughout instead of absolute timestamps.
6. **"Back to Inbox" instead of "Back"** - explicit destination.

### Conversation display improvements

- Inbound messages: left-aligned, muted background
- Outbound messages: right-aligned, primary-tinted background (like a chat app)
- Sender shows display name only (not full email), with email as tooltip
- Message bodies rendered with proper line breaks, not `white-space: pre-wrap` on raw text

---

## Playbooks (/playbooks)

One page that answers: "What categories do I have, and how does the AI handle each one?"

### Layout

```
┌──────────────────────────────────────────────────────┐
│  📋 Playbooks                     [+ New Playbook]   │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  Refund request                                │  │
│  │  Active playbook: Refund v4 (11 steps)         │  │
│  │  12 threads handled · 2 needed your attention  │  │
│  │                                            [→] │  │
│  ├────────────────────────────────────────────────┤  │
│  │  Tracking Request                              │  │
│  │  Active playbook: Tracking v3 (6 steps)        │  │
│  │  3 threads handled · 1 escalated              │  │
│  │                                            [→] │  │
│  ├────────────────────────────────────────────────┤  │
│  │  Other                                         │  │
│  │  No playbook - emails in this category are     │  │
│  │  held for manual review                        │  │
│  │                                  [Create one]  │  │
│  ├────────────────────────────────────────────────┤  │
│  │  Introduction                                  │  │
│  │  No playbook                      [Create one] │  │
│  ├────────────────────────────────────────────────┤  │
│  │  Lead                                          │  │
│  │  No playbook                      [Create one] │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### Key changes from current

1. **Categories are the primary entity**. Each row is a category. A playbook is shown as a property of the category ("Active playbook: Refund v4").
2. **No separate categories page**. Category CRUD happens here. "Edit category" opens an inline form or modal.
3. **Activity stats per category**: thread count, escalation count. Makes the page useful at a glance.
4. **"Create one" CTA** for categories without playbooks. Navigates to /playbooks/new with category pre-selected.
5. **Click row → playbook editor** (/playbooks/[id]) if playbook exists, /playbooks/new if not.

### Playbook editor (/playbooks/[id])

The existing editor is solid. Key refinements:

1. **Plain language description gets more prominence**: larger textarea, positioned as the hero element. "Write instructions for the AI like you're explaining to a new staff member."
2. **Step cards below**: already good, keep the visual pipeline.
3. **"Test with example email" button** adjacent to the description. Opens a side panel (not a modal) that shows the dry-run trace live as steps execute.
4. **Category info at the top**: which category this serves, auto-reply status, confidence threshold. Editable inline.
5. **Version history**: small "v3 · last edited 2h ago" with link to see previous versions.

### Template browser (/playbooks/new)

Already built and functional. Keep as-is. Minor refinement: categories without playbooks should deep-link here with category pre-selected.

---

## Settings (/settings)

Tighten the scope. Three clear sections instead of a dumping ground.

### Layout

```
┌──────────────────────────────────────────────────────┐
│  ⚙ Settings                                          │
│                                                      │
│  ┌─ Integrations ────────────────────────────────┐  │
│  │  Google Account                                │  │
│  │  ● Connected as justfabienscoot@gmail.com     │  │
│  │  Token expires: 15/04/2026, 19:24             │  │
│  │                              [Reconnect]       │  │
│  │                                                │  │
│  │  Google Sheet                                  │  │
│  │  Sheet: 1qxjAEUs…  [Sync Columns] [Sync Labels]│  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─ AI Configuration ────────────────────────────┐  │
│  │  Model: [gpt-4o ▼]                            │  │
│  │  Confidence threshold: [0.8]                   │  │
│  │  Reply signature: [____]                       │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─ Workspace ───────────────────────────────────┐  │
│  │  Name: Fabien                                  │  │
│  │  Gmail: justfabienscoot@gmail.com             │  │
│  │  Sheet ID: 1qxjAEUs…                         │  │
│  │  Sheet name: Sheet1                           │  │
│  │                                [Edit]          │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### Changes from current

1. **Removed "Workspaces" as a separate section** - merged into "Workspace" (singular). Hardcoded to workspace 1.
2. **Grouped Google Account + Sheet** under "Integrations" - they're one integration.
3. **"AI Configuration" section** - model, threshold, signature. Clean and focused.
4. **Individual Save buttons removed** - each section saves on blur or via a single Save at the bottom. Reduces button clutter.

---

## Visual design system

### Colour palette (extending existing CSS variables)

The current palette is solid. Extending with semantic status colours and refining surfaces:

```css
/* Existing - keep */
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

/* New - semantic status */
--color-attention: #f59e0b;       /* needs human action - warm amber */
--color-in-progress: #6366f1;    /* AI working - indigo/purple */
--color-waiting: #3b82f6;        /* waiting for customer - blue */
--color-resolved: #10b981;       /* done - green */
--color-muted: #475569;          /* noise/other - gray */

/* New - surface refinements */
--color-surface-elevated: #1e2235;  /* cards that float above surface */
--color-surface-selected: rgba(99, 102, 241, 0.08);  /* selected row */
--color-surface-hover: rgba(99, 102, 241, 0.04);     /* hover row */

/* New - focus/a11y */
--color-focus-ring: rgba(99, 102, 241, 0.5);
```

### Typography scale

Constrained to 4 sizes. Currently several ad-hoc sizes.

```css
--text-xs: 0.75rem;    /* 12px - badges, meta */
--text-sm: 0.8125rem;  /* 13px - secondary text, table cells */
--text-base: 0.875rem; /* 14px - body text, primary content */
--text-lg: 1.125rem;   /* 18px - section headers */
--text-xl: 1.5rem;     /* 24px - page titles */
```

### Spacing scale

```css
--space-1: 0.25rem;  /* 4px */
--space-2: 0.5rem;   /* 8px */
--space-3: 0.75rem;  /* 12px */
--space-4: 1rem;     /* 16px */
--space-5: 1.5rem;   /* 24px */
--space-6: 2rem;     /* 32px */
--space-8: 3rem;     /* 48px */
```

### Status badges

Replace the current `badge-new`, `badge-in_review`, etc. with semantic badges:

```css
.badge-attention { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }
.badge-progress  { background: rgba(99, 102, 241, 0.15); color: #818cf8; }
.badge-waiting   { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
.badge-resolved  { background: rgba(16, 185, 129, 0.15); color: #34d399; }
.badge-muted     { background: rgba(71, 85, 105, 0.15); color: #94a3b8; }
```

### Component patterns

**Thread row**: 60px height, generous padding. Hover shows subtle background shift. Selected state has left border accent + elevated background.

**Card**: `--color-surface-elevated` background, `--color-border` border, `--radius-lg` corners, `--space-5` padding.

**Section header**: `--text-sm`, `--color-text-muted`, uppercase, letter-spacing 0.05em. Used for "NEEDS ATTENTION", "IN PROGRESS", etc.

**Empty state**: Centered icon + text + CTA button. Used when a section has no items.

**Transition**: `transition: all 0.15s ease` on interactive elements. No springy/bouncy animations. Clean and fast.

### Sidebar refinement

- Width: 200px (down from 220px - tighter)
- Nav items: 40px height, 12px padding, rounded corners
- Active item: primary background at 10% opacity + left accent bar
- Brand: "✉ Autopilot" (rename from "Email Dash" - more product-feeling)
- Bottom: small "System" text link + version number

---

## Accessibility

### Keyboard navigation

| Key | Context | Action |
|---|---|---|
| `j` / `↓` | Inbox list | Next thread |
| `k` / `↑` | Inbox list | Previous thread |
| `Enter` | Inbox list | Open selected thread |
| `Escape` | Thread detail | Back to Inbox |
| `1`-`4` | Inbox | Switch filter tab |
| `Tab` | Everywhere | Normal tab order |

Implementation: global keydown listener in Inbox page, scoped to when focus is on the thread list. Does NOT capture when user is in an input/textarea.

### ARIA

- ManualActionBanner: `role="alert"` `aria-live="assertive"` (already done)
- Filter pills: `role="tablist"` with `role="tab"` on each + `aria-selected`
- Thread list: `role="listbox"` with `role="option"` on each row + `aria-selected`
- Status dots: `aria-label` with human-readable status ("Needs your attention", "In progress")
- Icon-only buttons: `aria-label` on every one
- Focus ring: 2px solid `--color-focus-ring`, visible on all interactive elements via `:focus-visible`

### Colour contrast

All text colours meet WCAG AA (4.5:1) against their backgrounds:
- `--color-text` (#e2e8f0) on `--color-bg` (#0f1117): 12.6:1 ✓
- `--color-text-muted` (#64748b) on `--color-surface` (#1a1d27): 4.9:1 ✓ (AA)
- Badge text on badge background: all meet 4.5:1 ✓

---

## Implementation plan

### Phase 1: Layout + Inbox (biggest change)

1. Update `+layout.svelte`: new nav (3 items + footer system link), new CSS variables, rename to "Autopilot"
2. Extend `GET /threads` API to include latest run status, playbook name, current step
3. Build new Inbox page at `/` (replaces current threads list)
4. Redirect `/review` to `/` (or keep as alias)
5. Keyboard navigation on Inbox

### Phase 2: Thread detail refinement

6. Two-column layout (conversation + playbook sidebar)
7. Improved message display (chat-like)
8. Quick actions bar
9. ManualActionBanner integration (already done)

### Phase 3: Playbooks page

10. New Playbooks page showing categories as primary rows with playbook status
11. Backend: `GET /playbooks/categories-with-stats` endpoint
12. Category CRUD inline on this page
13. Playbook editor refinements (larger description, side-panel dry-run)

### Phase 4: Settings + cleanup

14. Reorganise Settings into 3 sections
15. Hide Sheet Rules and Sheet Updates from nav
16. Move System to footer link

### Per-page verification

After each phase, Playwright walkthrough to verify:
- Page renders without console errors
- Data loads correctly
- Interactions work
- Screenshot for TASK_LOG

---

## Decisions (signed off 2026-04-15)

1. **"Other" threads visible in default view** - collapsed at bottom with count. ✓
2. **Rename to "Autopilot"** ✓
3. **Dry-run stays as modal** - simpler, good enough. ✓
4. **Section save on Settings** - one Save per section. ✓
