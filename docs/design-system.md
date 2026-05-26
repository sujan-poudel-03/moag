# MOAG Design System Reference
## For UI Prototype Agents & Designers

**Version:** 0.9.9  
**Tech stack:** VS Code Webview (single HTML file, inline CSS, vanilla JS, `postMessage` IPC)  
**Theme:** Adapts to VS Code's active theme — design for dark (`#1e1e1e`) as primary, verify in light

---

## 1. Design Tokens (Source of Truth)

These are the exact tokens defined in `src/ui/design-system.ts`. Every component uses these — never hardcode colors.

### Color Tokens

| Token | VS Code Variable | Dark Default | Purpose |
|-------|-----------------|-------------|---------|
| `--ds-bg` | `--vscode-editor-background` | `#1e1e1e` | Page/panel background |
| `--ds-surface` | `--vscode-editorWidget-background` | `#252526` | Cards, inputs, raised surfaces |
| `--ds-fg` | `--vscode-editor-foreground` | `#cccccc` | Primary text |
| `--ds-muted` | `--vscode-descriptionForeground` | `#8b949e` | Labels, hints, secondary text |
| `--ds-border` | `--vscode-panel-border` | `rgba(128,128,128,0.25)` | Dividers, input borders |
| `--ds-hover` | `--vscode-list-hoverBackground` | `rgba(128,128,128,0.1)` | Row/button hover state |
| `--ds-focus` | `--vscode-focusBorder` | `#007acc` | Focused input ring |

### Semantic Status Colors

| Token | VS Code Variable | Dark Default | When to Use |
|-------|-----------------|-------------|-------------|
| `--ds-success` | `--vscode-testing-iconPassed` | `#4caf50` | Completed tasks, pass states |
| `--ds-warning` | `--vscode-editorWarning-foreground` | `#cca700` | Paused, blocked, amber states |
| `--ds-error` | `--vscode-testing-iconFailed` | `#f44747` | Failed tasks, errors |
| `--ds-info` | `--vscode-textLink-foreground` | `#4fa3ff` | Running, links, info |

### Interactive Tokens

| Token | VS Code Variable | Purpose |
|-------|-----------------|---------|
| `--ds-btn-bg` | `--vscode-button-background` | Primary button fill |
| `--ds-btn-fg` | `--vscode-button-foreground` | Primary button text |
| `--ds-btn-hover` | `--vscode-button-hoverBackground` | Primary button hover |
| `--ds-btn-secondary-bg` | `--vscode-button-secondaryBackground` | Ghost/secondary button fill |
| `--ds-btn-secondary-fg` | `--vscode-button-secondaryForeground` | Ghost button text |
| `--ds-input-bg` | `--vscode-input-background` | Input/textarea fill |
| `--ds-input-fg` | `--vscode-input-foreground` | Input text |
| `--ds-input-border` | `--vscode-input-border` | Input border |

### Typography Tokens

| Token | VS Code Variable | Purpose |
|-------|-----------------|---------|
| `--ds-font-family` | `--vscode-font-family` | All UI text (system sans-serif) |
| `--ds-font-size` | `--vscode-font-size` | Base font size (13px) |
| `--ds-editor-font` | `--vscode-editor-font-family` | Code, terminal output (monospace) |

### Spacing Tokens

| Token | Value | Use |
|-------|-------|-----|
| `--ds-space-1` | `4px` | Tight gaps (icon + label, badge padding) |
| `--ds-space-2` | `8px` | Component internal padding |
| `--ds-space-3` | `12px` | Section internal padding |
| `--ds-space-4` | `16px` | Section gaps |

### Shape & Motion Tokens

| Token | Value | Use |
|-------|-------|-----|
| `--ds-radius-sm` | `4px` | Inputs, buttons, small cards |
| `--ds-radius-md` | `8px` | Large cards, panels |
| `--ds-radius-pill` | `999px` | Status badges, chip pills |
| `--ds-motion-fast` | `120ms` | Micro-interactions (hover, focus) |
| `--ds-motion-med` | `180ms` | Section collapse/expand |

---

## 2. Typography Scale

```
11px  --ds-muted color     Labels, section headers (uppercase), char counts
12px  --ds-muted color     Secondary text, breadcrumbs, metadata (cost, duration)
13px  --ds-fg color        Body text, inputs, buttons (= VS Code base)
15px  font-weight: 600     Panel / page headings
monospace 12px             Terminal output, code spans, error lines
monospace 11px             Inline code in messages
```

**Rules:**
- Section headers: `11px, uppercase, letter-spacing: 0.08em, --ds-muted`
- Task names: `13px, --ds-fg`
- Error text: `12px, --ds-error, font-family: monospace`
- Cost/duration metadata: `11px, --ds-muted`
- Never go below `10px`

---

## 3. Icon System — VS Code Codicons

All icons use VS Code's built-in Codicon font. Reference: https://microsoft.github.io/vscode-icons/

### Status Icons

| Icon class | Codicon | Use |
|-----------|---------|-----|
| `$(circle-outline)` | ○ | Pending task |
| `$(loading~spin)` | ⟳ | Running task (animated) |
| `$(check)` | ✓ | Completed task |
| `$(error)` | ✗ | Failed task |
| `$(circle-slash)` | ⊘ | Blocked task |
| `$(debug-step-over)` | → | Skipped task |
| `$(pause-circle)` | ⏸ | Paused |

### Action Icons

| Icon class | Use |
|-----------|-----|
| `$(play)` | Play / Run |
| `$(debug-pause)` | Pause |
| `$(debug-stop)` | Stop |
| `$(refresh)` | Retry / Reload |
| `$(edit)` | Edit task |
| `$(trash)` | Delete |
| `$(copy)` | Duplicate |
| `$(split-horizontal)` | Split task |
| `$(add)` | Add item |
| `$(chevron-down)` / `$(chevron-right)` | Collapse/expand |
| `$(feedback)` | Share feedback |
| `$(github)` | GitHub actions |
| `$(layout-panel)` | Dashboard |
| `$(list-tree)` | Switch plan |
| `$(camera)` | Screenshot |
| `$(server)` | Sandbox |
| `$(beaker)` | Visual test |
| `$(file-text)` | PRD / document |
| `$(verified)` | Verify against PRD |
| `$(git-pull-request)` | Create PR |
| `$(wand)` | AI-generate / Smart fix |

---

## 4. Component Library

### 4.1 Buttons

**Primary button** — for the main action in a section
```css
padding: 6px 16px;
background: var(--ds-btn-bg);
color: var(--ds-btn-fg);
border: none;
border-radius: 2px;       /* VS Code uses 2px, not 4px, for buttons */
font-size: 13px;
font-family: inherit;
cursor: pointer;

:hover { background: var(--ds-btn-hover); }
:disabled { opacity: 0.4; cursor: not-allowed; }
```

**Secondary / ghost button** — for cancel, secondary actions
```css
padding: 6px 12px;
background: transparent;
color: var(--ds-btn-secondary-fg);
border: 1px solid var(--ds-border);
border-radius: 2px;
font-size: 12px;

:hover { background: var(--ds-hover); }
```

**Icon button** — toolbar actions, inline task row actions
```css
width: 22px; height: 22px;
padding: 0;
background: transparent;
border: none;
border-radius: var(--ds-radius-sm);
display: flex; align-items: center; justify-content: center;
color: var(--ds-muted);
cursor: pointer;

:hover { background: var(--ds-hover); color: var(--ds-fg); }
```

**Danger button** — destructive actions (delete, clear)
```css
/* Same as secondary but with error color on hover */
:hover { background: rgba(244,71,71,0.12); color: var(--ds-error); border-color: var(--ds-error); }
```

---

### 4.2 Inputs & Textareas

```css
/* All inputs */
background: var(--ds-input-bg);
color: var(--ds-input-fg);
border: 1px solid var(--ds-input-border);
border-radius: 2px;
padding: 5px 8px;
font-size: 13px;
font-family: inherit;
width: 100%;

:focus {
  outline: none;
  border-color: var(--ds-focus);
  box-shadow: 0 0 0 1px var(--ds-focus);
}

/* Textarea */
resize: vertical;
min-height: 60px;
max-height: 200px;
overflow-y: auto;
font-family: inherit; /* NOT monospace unless it's code input */
```

**Select / dropdown:**
```css
/* Same as input but with */
appearance: none;
padding-right: 24px;
background-image: url("data:image/svg+xml,...chevron"); /* or use Codicon */
cursor: pointer;
```

---

### 4.3 Status Badges / Pills

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: var(--ds-radius-pill);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

/* Variants */
.badge-success { background: rgba(76,175,80,0.15);  color: var(--ds-success); }
.badge-error   { background: rgba(244,71,71,0.15);  color: var(--ds-error); }
.badge-warning { background: rgba(204,167,0,0.15);  color: var(--ds-warning); }
.badge-info    { background: rgba(79,163,255,0.15); color: var(--ds-info); }
.badge-muted   { background: rgba(128,128,128,0.12); color: var(--ds-muted); }
```

**Runner state badges** (larger, in plan header):
```
IDLE      → badge-muted
EXECUTING → badge-info  + pulsing dot
PAUSED    → badge-warning
STOPPING  → badge-warning
```

**Task status badges** (inline in task rows):
```
pending   → no badge (just icon)
running   → badge-info
completed → no badge (just ✓ icon)
failed    → badge-error
blocked   → badge-warning
skipped   → badge-muted
```

**Error category badges** (in failed task rows):
```
COMPILE      → badge-error
TEST         → badge-error
TIMEOUT      → badge-warning
RATE-LIMIT   → badge-warning
AUTH         → badge-warning
CLI-MISSING  → badge-muted
RUNTIME      → badge-error
```

---

### 4.4 Task Row

The fundamental repeating unit. 44px tall in compact mode, expands when selected/failed.

```
┌──────────────────────────────────────────────────────────────┐
│  [icon]  Task name here              [badge]  12k  $0.02  ▸  │
└──────────────────────────────────────────────────────────────┘

Failed state (auto-expands):
┌──────────────────────────────────────────────────────────────┐
│  [✗]  Task name here                [COMPILE]  3 attempts    │
│  │  error TS2345: Argument of type 'string'…                 │
│  │                               [🔨 Smart Fix]  [▸ details]│
└──────────────────────────────────────────────────────────────┘
```

```css
.task-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  min-height: 44px;
  border-radius: var(--ds-radius-sm);
  cursor: pointer;
}
.task-row:hover { background: var(--ds-hover); }
.task-row.failed { border-left: 2px solid var(--ds-error); }
.task-row.running { border-left: 2px solid var(--ds-info); }
.task-row.completed { color: var(--ds-muted); }  /* de-emphasize done tasks */

/* Status icon — left */
.task-status-icon { width: 16px; flex-shrink: 0; }

/* Name — flex-grow */
.task-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-name.completed { text-decoration: line-through; color: var(--ds-muted); }

/* Metadata — right (hidden on narrow) */
.task-meta { font-size: 11px; color: var(--ds-muted); white-space: nowrap; }

/* Error preview — below name, only when failed */
.task-error-preview {
  font-family: var(--ds-editor-font);
  font-size: 11px;
  color: var(--ds-error);
  padding: 4px 8px;
  background: rgba(244,71,71,0.08);
  border-radius: 2px;
  margin-top: 4px;
}
```

---

### 4.5 Playlist Section Header (VS Code Tree Style)

```
▼ Development Playlist                    3/5  ▶
  ✓ Implement API                              
  ⟳ Add auth middleware          CLAUDE  2m14s  
  ○ Write tests                                
```

```css
.playlist-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px 5px 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ds-fg);
  cursor: pointer;
  user-select: none;
  border-radius: var(--ds-radius-sm);
}
.playlist-header:hover { background: var(--ds-hover); }

.playlist-chevron { color: var(--ds-muted); font-size: 10px; }
.playlist-name { flex: 1; }
.playlist-progress { font-size: 11px; color: var(--ds-muted); font-weight: normal; }
.playlist-play-btn { opacity: 0; }
.playlist-header:hover .playlist-play-btn { opacity: 1; }

/* Test phase variant */
.playlist-header.test-phase { color: var(--ds-info); }
.playlist-header.test-phase::after {
  content: 'TEST PHASE';
  font-size: 9px;
  padding: 1px 5px;
  background: rgba(79,163,255,0.12);
  color: var(--ds-info);
  border-radius: var(--ds-radius-pill);
  margin-left: 4px;
}
```

---

### 4.6 Progress Bar

```css
.progress-bar-track {
  height: 4px;
  background: rgba(128,128,128,0.2);
  border-radius: var(--ds-radius-pill);
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background: var(--ds-info);
  border-radius: var(--ds-radius-pill);
  transition: width 400ms ease;
}

/* When failures exist: split — blue for passed, red stripe for failed */
.progress-bar-fill.has-failures {
  background: linear-gradient(
    to right,
    var(--ds-info) 0%, var(--ds-info) calc(var(--pass-pct) * 1%),
    var(--ds-error) calc(var(--pass-pct) * 1%), 100%
  );
}
```

**With >30 tasks — add minimap dots below:**
```css
.minimap {
  display: flex;
  flex-wrap: nowrap;
  gap: 1px;
  overflow: hidden;
  max-height: 6px;
  margin-top: 4px;
}
.minimap-dot {
  width: 4px; height: 4px;
  border-radius: 1px;
  flex-shrink: 0;
}
.minimap-dot.completed { background: var(--ds-success); }
.minimap-dot.failed    { background: var(--ds-error); }
.minimap-dot.running   { background: var(--ds-info); }
.minimap-dot.pending   { background: rgba(128,128,128,0.3); }
```

---

### 4.7 Collapsible Section Header

Used in dashboard and sidebar for TASKS, COMPLETED, HISTORY sections.

```
▼ COMPLETED TASKS                               12
```

```css
.section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ds-muted);
  cursor: pointer;
  user-select: none;
}
.section-header:hover { color: var(--ds-fg); }
.section-header .count { margin-left: auto; font-weight: normal; }
.section-header .chevron { transition: transform var(--ds-motion-fast); }
.section-header.collapsed .chevron { transform: rotate(-90deg); }

/* Animated content area */
.section-content {
  overflow: hidden;
  transition: max-height var(--ds-motion-med) ease;
}
```

---

### 4.8 Active Task Card (Dashboard — Hero During Execution)

Takes all available vertical space during execution. This is the most important element when running.

```
┌──────────────────────────────────────────────────────────────┐
│  ● Create auth middleware           [CLAUDE]  2m 14s  [stop] │
├──────────────────────────────────────────────────────────────┤
│ $ claude --model claude-sonnet-4-6 ...                       │
│ Creating authentication middleware...                        │  ← flex: 1
│ Added src/middleware/auth.ts (47 lines)                      │     (fills all
│ Added src/middleware/auth.test.ts                            │      space)
│ Running verification: npm test...                            │
│ ✓ 14 tests passed                                            │
│ ▮                                                            │
├──────────────────────────────────────────────────────────────┤
│ ▶ Details  (prompt · criteria · policy)                      │
└──────────────────────────────────────────────────────────────┘
```

```css
.active-task-card {
  display: flex;
  flex-direction: column;
  flex: 1;                    /* Takes all remaining space */
  min-height: 200px;
  border: 1px solid var(--ds-info);
  border-radius: var(--ds-radius-md);
  overflow: hidden;
  box-shadow: 0 0 0 1px rgba(79,163,255,0.15), 0 0 12px rgba(79,163,255,0.08);
}

.active-task-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(79,163,255,0.06);
  border-bottom: 1px solid var(--ds-border);
  font-size: 13px;
  font-weight: 600;
}

.active-task-output {
  flex: 1;
  font-family: var(--ds-editor-font);
  font-size: 12px;
  padding: 10px 12px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--ds-fg);
  background: var(--ds-bg);
  line-height: 1.5;
}

/* Pulsing dot indicator */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.3; }
}
.running-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--ds-info);
  animation: pulse 1.4s ease-in-out infinite;
}
```

---

### 4.9 Message Feed (Chat Tab)

User message (right-aligned):
```css
.message-user {
  align-self: flex-end;
  max-width: 85%;
  background: var(--ds-btn-bg);
  color: var(--ds-btn-fg);
  padding: 8px 12px;
  border-radius: var(--ds-radius-md) var(--ds-radius-md) 2px var(--ds-radius-md);
  font-size: 13px;
}
```

Assistant message (left-aligned):
```css
.message-assistant {
  align-self: flex-start;
  max-width: 90%;
  background: var(--ds-surface);
  border: 1px solid var(--ds-border);
  padding: 8px 12px;
  border-radius: 2px var(--ds-radius-md) var(--ds-radius-md) var(--ds-radius-md);
  font-size: 13px;
}
```

Result card (below assistant message):
```css
.result-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(128,128,128,0.06);
  border-top: 1px solid var(--ds-border);
  border-radius: 0 0 var(--ds-radius-md) var(--ds-radius-md);
  font-size: 11px;
  color: var(--ds-muted);
}
```

---

### 4.10 TAV Panel (Test & Verify)

Three modes: SETUP → RUNNING → VERIFY

**SETUP mode:** Sidebar width (280–360px), replaces bottom AI Rules + Sandbox strip when test playlist exists.

```
TEST & VERIFY                        [SETUP]
──────────────────────────────────────────
Sandbox    ● Stopped          [Launch]
Test Tool  [Playwright ▼]
PRD        prd.md ✓           [Open]

Acceptance Criteria
  ☐ User can log in with email + password
  ☐ Dashboard loads in < 2s
  ☐ Mobile layout collapses nav

──────────────────────────────────────────
                        [▶ Play with TAV]
```

```css
.tav-panel {
  border-top: 1px solid var(--ds-border);
  padding: var(--ds-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
}

.tav-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ds-muted);
}

.tav-mode-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: var(--ds-radius-pill);
}
.tav-mode-badge.setup   { background: rgba(128,128,128,0.15); color: var(--ds-muted); }
.tav-mode-badge.running { background: rgba(79,163,255,0.15);  color: var(--ds-info); }
.tav-mode-badge.verify  { background: rgba(76,175,80,0.15);   color: var(--ds-success); }

.tav-row {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
  font-size: 12px;
}
.tav-label { width: 64px; color: var(--ds-muted); flex-shrink: 0; }
.tav-value { flex: 1; color: var(--ds-fg); }

.criteria-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}
.criteria-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.4;
}
.criteria-item.done { color: var(--ds-muted); text-decoration: line-through; }
.criteria-item input[type=checkbox] { accent-color: var(--ds-success); flex-shrink: 0; margin-top: 2px; }

.fix-loop-counter {
  font-size: 11px;
  color: var(--ds-warning);
  display: flex;
  align-items: center;
  gap: 4px;
}
```

**Verification Result card (VERIFY mode — replaces Verify button):**

```
PRD Verification                     PASS 4/5
─────────────────────────────────────────────
✓  User can log in                   
✓  Dashboard loads in < 2s           
✗  Mobile layout collapses nav    [details ▼]
✓  API /health returns 200           
✓  404 page renders                  

Score: 80%          [↺ Re-run]  [📤 Export]
```

```css
.verification-result {
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-sm);
  overflow: hidden;
}
.verification-result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  background: var(--ds-surface);
}
.verification-result-header.pass { border-left: 3px solid var(--ds-success); }
.verification-result-header.fail { border-left: 3px solid var(--ds-error); }

.criteria-result-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  font-size: 12px;
  border-bottom: 1px solid var(--ds-border);
}
.criteria-result-row:last-of-type { border-bottom: none; }
.criteria-result-row .icon-pass { color: var(--ds-success); }
.criteria-result-row .icon-fail { color: var(--ds-error); }

.verification-actions {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  justify-content: flex-end;
  background: var(--ds-surface);
  border-top: 1px solid var(--ds-border);
}
```

---

### 4.11 PRD Badge (Plan Header)

```
Feature Plan                    IDLE
PRD: prd.md ✓                            ← This
7/10 tasks  [████████░░] 70%
```

```css
.prd-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: var(--ds-radius-pill);
  cursor: pointer;
  text-decoration: none;
}

/* States */
.prd-badge.linked {
  background: rgba(76,175,80,0.12);
  color: var(--ds-success);
  border: 1px solid rgba(76,175,80,0.3);
}
.prd-badge.not-linked {
  background: transparent;
  color: var(--ds-muted);
  border: 1px dashed var(--ds-border);
}
.prd-badge.outdated {
  background: rgba(204,167,0,0.12);
  color: var(--ds-warning);
  border: 1px solid rgba(204,167,0,0.3);
}

.prd-badge:hover { filter: brightness(1.15); }
```

---

### 4.12 SDLC Phase Stepper

Horizontal, below plan header, collapsible.

```
Chat  →  Plan  →  Execute  →  Test  →  Verify  →  Done
                    ↑ active
```

```css
.sdlc-stepper {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 6px 12px;
  font-size: 11px;
  overflow-x: auto;
  scrollbar-width: none;
}

.sdlc-step {
  display: flex;
  align-items: center;
  white-space: nowrap;
  color: var(--ds-muted);
  padding: 2px 6px;
  border-radius: var(--ds-radius-sm);
}
.sdlc-step.done {
  color: var(--ds-success);
}
.sdlc-step.done::before {
  content: '✓ ';
  font-size: 10px;
}
.sdlc-step.active {
  color: var(--ds-fg);
  font-weight: 600;
  border-bottom: 2px solid var(--ds-info);
}

.sdlc-arrow {
  color: var(--ds-border);
  margin: 0 2px;
  font-size: 10px;
}
```

---

### 4.13 Share Feedback Panel

Full-screen editor tab. Max-width 720px, centered.

```
Share Session Feedback
──────────────────────────────────────────────────────
MOAG v0.9.9 · Engine: claude · Project: ts / vscode-ext

Run Summary
  10 tasks   7 passed   2 failed   1 escalated
  Duration: 8m 42s     Est. cost: $0.31

Friction Points
┌───────────────┬──────────┬──────────┬───────────┬───────────────┐
│ Task          │ Attempts │ Auto-fix │ Escalated │ Error         │
├───────────────┼──────────┼──────────┼───────────┼───────────────┤
│ Build VSIX    │    3     │    ✓     │    ✗      │ TS2345…       │
│ Run Tests     │    2     │    ✓     │    ✗      │ AssertError…  │
│ Deploy        │    1     │    ✗     │    ✓      │ ENOENT…       │
└───────────────┴──────────┴──────────┴───────────┴───────────────┘

Error Patterns
  compile: 2   test: 1   cli-missing: 1

Notes
┌──────────────────────────────────────────────────┐
│ (optional — describe what you were trying to do) │
└──────────────────────────────────────────────────┘

Repo: moag / agent-task-player              [▼ change]

               [Cancel]    [📤 File GitHub Issue]
```

```css
.feedback-panel {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 28px 48px;
  font-family: var(--ds-font-family);
  font-size: 13px;
}

.feedback-meta-row {
  font-size: 12px;
  color: var(--ds-muted);
  margin-bottom: 20px;
}

.feedback-section { margin-bottom: 20px; }
.feedback-section-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ds-muted);
  margin-bottom: 8px;
}

.friction-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.friction-table th {
  text-align: left;
  padding: 6px 10px;
  background: var(--ds-surface);
  color: var(--ds-muted);
  font-weight: 600;
  font-size: 11px;
  border-bottom: 1px solid var(--ds-border);
}
.friction-table td {
  padding: 6px 10px;
  border-bottom: 1px solid rgba(128,128,128,0.1);
  vertical-align: middle;
}
.friction-table td .check    { color: var(--ds-success); }
.friction-table td .cross    { color: var(--ds-muted); }
.friction-table td .escalated { color: var(--ds-error); }

.error-patterns {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.error-pattern-chip {
  padding: 3px 10px;
  border-radius: var(--ds-radius-pill);
  font-size: 11px;
  background: rgba(128,128,128,0.1);
  color: var(--ds-fg);
}
.error-pattern-chip .category { color: var(--ds-error); font-weight: 600; }

.feedback-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}
```

---

## 5. Layout Architecture

### 5.1 Sidebar (280–400px)

```
┌──────────────────────────┐
│  TOOLBAR (title bar)     │  22px — VS Code title bar, not part of webview
├──────────────────────────┤
│  TAB BAR                 │  36px fixed
│  [Chat] [Plan] [History] │
├──────────────────────────┤
│                          │
│  TAB CONTENT             │  flex: 1, overflow-y: auto
│  (scrollable)            │
│                          │
├──────────────────────────┤
│  BOTTOM STRIP            │  auto height (collapsed by default)
│  AI Rules | TAV Panel    │
└──────────────────────────┘
```

**Sidebar widths:**
- Minimum usable: `280px`
- Comfortable: `320–380px`
- Maximum before feeling too wide: `420px`

**At <300px:** Hide metadata columns, truncate task names to 20 chars, use icon-only buttons in toolbar

### 5.2 Dashboard Panel (400–1200px, fills editor area)

```
┌──────────────────────────────────────┐
│  HEADER (fixed, 48px)                │  Plan name · status badge · transport controls
├──────────────────────────────────────┤
│  PROGRESS (fixed, 40–56px)           │  Progress bar · stats · minimap
├──────────────────────────────────────┤
│                                      │
│  MAIN ZONE (flex: 1, scrollable)     │  Content changes by runner state (see below)
│                                      │
└──────────────────────────────────────┘
```

**Main zone by state:**

| State | Primary content | Secondary |
|-------|----------------|-----------|
| IDLE | Task list (playlists + tasks) | History (collapsed) |
| EXECUTING | Active task card (flex: 1) | Completed (collapsed) |
| RUN COMPLETE | Result banner + completed tasks | Task list (final status) |

### 5.3 Full-Screen Panels (PRD editor, Task editor, Share Feedback)

```
┌──────────────────────────────────────────────────┐
│  STICKY TOOLBAR (48px)                           │  Save / Cancel / title
├──────────────────────────────────────────────────┤
│                                                  │
│  CONTENT (scrollable, max-width: 720px, centered)│
│                                                  │
└──────────────────────────────────────────────────┘
```

---

## 6. States & Transitions

### Runner States → Visual Treatment

| State | Header badge | Progress bar | Active task card | Toolbar |
|-------|-------------|-------------|-----------------|---------|
| Idle | `IDLE` (muted) | Static | Hidden | Play enabled |
| Playing | `EXECUTING` (info, pulsing dot) | Animating | Visible (flex:1) | Pause + Stop enabled |
| Paused | `PAUSED` (warning) | Static | Visible (dim) | Play + Stop enabled |
| Stopping | `STOPPING` (warning) | Static | Fading | Stop only |

### Task Status → Row Treatment

| Status | Icon | Left border | Text | Badge |
|--------|------|------------|------|-------|
| Pending | `○` gray | none | Normal | none |
| Running | `⟳` blue spin | 2px solid `--ds-info` | Bold | `RUNNING` info |
| Completed | `✓` green | none | Muted + strikethrough | none |
| Failed | `✗` red | 2px solid `--ds-error` | Red | Error category |
| Blocked | `⊘` orange | 2px solid `--ds-warning` | Muted | `BLOCKED` warning |
| Skipped | `→` muted | none | Muted | none |

---

## 7. Responsive Rules

| Viewport width | Changes |
|---------------|---------|
| `<300px` (narrow sidebar) | Icon-only toolbar, no metadata in task rows, 3px minimap dots |
| `300–400px` (standard sidebar) | Full layout as specified |
| `400–700px` (dashboard standard) | Full dashboard layout |
| `>700px` (dashboard wide) | Optional: 2-col (task list left, active output right) |

---

## 8. Accessibility

- All interactive elements have `:focus` ring using `--ds-focus` (`#007acc`)
- Status is never communicated by color alone — always icon + color
- `aria-label` on all icon-only buttons
- `role="tree"` on playlist/task list, `role="treeitem"` on rows
- `aria-live="polite"` on live output terminal
- `aria-live="assertive"` on task status changes (failed/completed)
- `prefers-reduced-motion`: disable pulsing animations, use instant transitions

---

## 9. The 5 Screens to Design (v1.0 Gaps)

These do not exist yet and are the deliverable for the UI prototype:

| # | Screen | Surface | Key new component |
|---|--------|---------|-----------------|
| 1 | TAV Panel — SETUP mode | Sidebar bottom strip | Pre-run config: sandbox + tool + PRD + criteria |
| 2 | TAV Panel — VERIFY mode | Sidebar bottom strip | Verification result card (§4.10) |
| 3 | Task Editor — visual-test type | Full-screen editor tab | URL field + spec file field + engine locked |
| 4 | PRD badge in Plan header | Plan tab header | Three-state badge (§4.11) |
| 5 | SDLC phase stepper | Plan tab, below header | Horizontal stepper (§4.12) |

Full specifications for each: `.moag/prd-ui-complete-flow.md`  
Acceptance criteria: `.moag/prd-ui-complete-flow.md` sections 4.1–4.4

---

## 10. Document Package for Prototype Agents

Send these 5 documents in this order:

| # | File | What it provides |
|---|------|-----------------|
| 1 | `docs/introduction.md` | Product overview, all capabilities, shipped vs gap table |
| 2 | `docs/design-system.md` | **This file** — tokens, components, layouts, states |
| 3 | `.moag/prd-ui-complete-flow.md` | Flow specs, screen states, acceptance criteria |
| 4 | `docs/dashboard-redesign-requirements.md` | Dashboard-specific problems + redesign spec |
| 5 | `docs/prd-workflow.md` | End-to-end user journey (why each screen exists) |

**Prompt template:**
> You are designing UI for a VS Code sidebar extension (dark theme, 280–400px sidebar, Codicon icons).  
> Read the design system in document 2 for tokens, components, and constraints.  
> Design the 5 missing screens listed in Section 9 of the design system, using specs from document 3.  
> Also redesign the Dashboard per document 4.  
> Do not redesign anything marked ✅ Shipped in document 1 Section 10.
