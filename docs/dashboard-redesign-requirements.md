# MOAG Dashboard — UI/UX Redesign Requirements

## Context

MOAG is a VS Code extension that orchestrates AI coding agents (Claude, Codex, Gemini, Ollama) to execute task playlists. The dashboard is a webview panel that shows plan overview, live execution output, task progress, error reporting, and execution history.

The dashboard must handle plans ranging from **1 task to 200+ tasks** across multiple playlists. It renders inside a VS Code webview panel, typically 400–1000px wide and 500–900px tall.

**Tech stack**: Single HTML file with inline CSS + vanilla JS. No framework. Communicates with the extension via `postMessage`. Must use VS Code CSS variables for theming (`--vscode-editor-background`, etc.).

**File**: `src/ui/dashboard-panel.ts` → `getHtml()` method returns the full HTML.

---

## Current Problems (with screenshots reference)

### P1: Pill grid does not scale
- With 184 tasks, the numbered pill grid (22×22px squares) fills the **entire viewport** — 8+ rows of pills
- All useful content (live output, errors, task list, history) is pushed below the fold
- User must scroll past a wall of colored squares to see anything actionable
- Pills are too small to read numbers on, yet too large in aggregate

### P2: No clear visual hierarchy
- During execution, the most important thing is: **what's running now + its live output**
- Currently: header → ETA → stats → pills (massive) → active task → errors → completed → history → task list
- The active task output is buried in the middle, often off-screen
- When idle, the task list (plan view) should be primary, but it's at the bottom

### P3: Competing sections fight for space
- Active task panel, error banner, completed tasks, info panel (3 tabs), and plan section all want vertical space
- No clear priority system — everything renders at full height
- Sections don't respond to context (executing vs idle vs completed)

### P4: Error reporting is not actionable
- Error banner shows "[failed] task name" but the actual error (stderr, exit code) requires clicking "View Detailed Error Log"
- When multiple tasks fail, the banner just lists names — no pattern recognition
- Rate limit errors look the same as code errors

### P5: History panel is disconnected
- "CURRENT RUN / ALL HISTORY / SUMMARY" tabs are a separate section with its own scrolling
- Duplicates information already shown in the completed tasks section
- Takes vertical space even when empty

---

## Design Requirements

### Layout Architecture

The dashboard should use a **3-zone stacked layout** that adapts based on state:

```
┌──────────────────────────────────┐
│  HEADER (fixed)                  │  Always visible: plan name, status badge, transport controls
├──────────────────────────────────┤
│  PROGRESS (compact, fixed)       │  Always visible: progress bar + stats (one line)
├──────────────────────────────────┤
│                                  │
│  MAIN ZONE (scrollable, flex-1)  │  Context-dependent content — see states below
│                                  │
├──────────────────────────────────┤
│  STATUS BAR (fixed)              │  One-line footer: status text, elapsed time
└──────────────────────────────────┘
```

### State-Based Main Zone Content

**State: IDLE (no execution running)**
```
MAIN ZONE:
  ├─ [Error/Success banner if last run had results]
  ├─ TASKS section (collapsible, VS Code tree style)
  │   ├─ Playlist 1 (collapsible)
  │   │   ├─ Task row
  │   │   └─ Task row
  │   └─ Playlist 2 (collapsible)
  │       └─ Task row
  └─ HISTORY section (collapsible, collapsed by default)
      └─ History list
```

**State: EXECUTING (task actively running)**
```
MAIN ZONE:
  ├─ ACTIVE TASK (flex-grow: 1, takes maximum space)
  │   ├─ Header: task name, engine badge, elapsed timer
  │   └─ Live output terminal (fills remaining space)
  ├─ COMPLETED (collapsible, collapsed by default, max-height capped)
  │   └─ Completed task cards
  └─ [Error banner if failures occurred]
```

**State: RUN COMPLETE**
```
MAIN ZONE:
  ├─ RESULT BANNER (success green / amber with failures)
  │   └─ Action buttons: Review Changes, Retry Failed, Export
  ├─ COMPLETED TASKS (expanded, scrollable)
  │   └─ Completed task cards with expandable details
  └─ TASKS section (shows final status of all tasks)
```

### Progress Section Redesign

**Replace the pill grid with a compact progress bar + summary:**

```
┌──────────────────────────────────────────┐
│ ████████████░░░░░░░░░  15/184 tasks      │  ← Single progress bar (green fill, red for failures)
│ 8 passed · 7 failed · 169 remaining      │  ← One-line text summary
│ ETA: ~4h 32m · 66 files changed          │  ← Second line (only during execution)
└──────────────────────────────────────────┘
```

- **No individual task pills** at this scale. The numbered squares are unreadable at 184 tasks.
- Instead, show a **minimap** (optional, collapsed by default): a thin strip of colored dots (4px each, no numbers, no spacing) — purely a visual heatmap of pass/fail distribution. Click to expand into full pill grid.
- The minimap should be **max 1 row tall** (overflow hidden with horizontal scroll on hover, or wrapped to max 2 rows).

**Threshold behavior:**
- **≤30 tasks**: Show numbered pills (current behavior works fine at this scale)
- **>30 tasks**: Show progress bar + minimap dots. Expand to full pills via toggle.

### Active Task Panel

During execution, this is the **hero section**. It should:

- Take **all available vertical space** (flex-grow: 1)
- Show: task name, playlist, engine, timer in a compact header (one line)
- Live output terminal: monospace, dark background, auto-scroll, full width
- **No contract section** visible by default (move to expandable "Details" at bottom)
- **No prompt section** visible by default (move to expandable "Details")
- Details expandable should contain: prompt text, failure policy, acceptance criteria, verify command

```
┌──────────────────────────────────────────┐
│ ● Create auth middleware  CLAUDE  2m 14s │  ← Compact header
├──────────────────────────────────────────┤
│ $ claude --model sonnet ...              │
│ Creating auth middleware...              │  ← Live output (flex: 1)
│ Added src/middleware/auth.ts             │
│ Added src/middleware/auth.test.ts        │
│ Running tests...                         │
│ ▮                                        │
├──────────────────────────────────────────┤
│ ▶ Details (prompt, criteria, policy)     │  ← Collapsed by default
└──────────────────────────────────────────┘
```

### Completed Task Cards

Compact by default, expandable:

```
✓ Create auth middleware          CLAUDE  45s  3 files    ← Collapsed (one line)
✗ Fix database migration          CODEX   2m   0 files    ← Failed: red left border
  │ Error: relation "users" does not exist               ← Inline error preview
  │ ▶ View full output                                   ← Expand for details
```

- Failed tasks auto-expand to show the **first meaningful error line** (not the full stderr)
- Inline action buttons on hover: Retry, View Output, View Diff
- When >10 completed tasks: show only last 5, with "Show all (N)" toggle

### Error Banner

Smart, actionable, compact:

```
┌──────────────────────────────────────────┐
│ ⚠ 7 tasks failed                        │
│                                          │
│ Rate limit (3): Switch engine or wait    │  ← Grouped by error type
│ Test failure (2): Fix code errors        │
│ Timeout (1): Increase taskTimeoutMs      │
│ Unknown (1): View logs                   │
│                                          │
│ [Retry Failed]  [Switch Engine]          │  ← Contextual actions
└──────────────────────────────────────────┘
```

- Group failures by detected cause (rate limit, auth, CLI not found, test failure, timeout, unknown)
- Show count per category, not individual task names
- Action buttons match the most common error type

### Section Headers (VS Code Tree Style)

All collapsible sections should look exactly like VS Code's sidebar tree headers:

```
▼ TASKS                            74
  ▼ v1.0 Sprint 5 — Test Coverage  3/8
      ○ Create template test file
      ✓ Test template IDs...
      ✗ Test skipIf...
  ▶ v1.0 Sprint 6 — Docs           0/2    ← Collapsed
```

- 22px row height, full-width click target
- Chevron ▼/▶ on the left
- Section name in bold uppercase
- Count on the right (muted)
- Hover: subtle background highlight
- Click anywhere on the row to toggle

### History Section

**Merge into the task list**, don't have a separate panel:

- Remove the 3-tab info panel (Current Run / All History / Summary)
- Instead, completed/failed tasks in the task list show their execution result inline
- Add a collapsible "HISTORY" section at the bottom with past run summaries (not individual task entries)
- The "Summary" tab content becomes a tooltip or info icon on the header

---

## Responsive Behavior

### Narrow panel (<400px)
- Hide engine badges
- Truncate task names aggressively
- Progress minimap: 3px dots
- Completed cards: icon + name only (no stats)

### Standard panel (400–700px)
- Full layout as described above

### Wide panel (>700px)
- Allow 2-column layout: task list on left, active output on right (optional)
- Larger progress text
- Show engine badges everywhere

---

## Interaction Patterns

1. **Click task in list** → If running: scroll to active output. If completed: expand card. If pending: show edit button.
2. **Click pill/dot in minimap** → Scroll task into view in task list, flash highlight
3. **Double-click completed task** → Open full output in a new editor tab
4. **Right-click task** → Context menu: Play, Retry, Edit, Set Status, View Output
5. **Drag resize** → Between sections (not needed if sections are properly collapsible)

---

## Animation / Transitions

- Section collapse/expand: 150ms ease height transition
- Progress bar: 400ms ease width transition
- Active task border: subtle pulse (current green glow is good)
- Task status change: brief flash on the row (200ms background-color transition)
- Avoid: anything that causes layout shifts during execution

---

## Data Contract (postMessage types)

The webview receives these message types from the extension:

```typescript
// Full state update (plan + runner state + history)
{ type: 'update', plan: Plan, runnerState: string, history: HistoryEntry[], services: Service[] }

// Task execution lifecycle
{ type: 'start-task-card', taskId, taskName, playlistName, engine, prompt, ... }
{ type: 'output', text: string, stream: 'stdout'|'stderr', taskId?: string }
{ type: 'complete-task-card', taskId, taskName, status, exitCode, durationMs, changedFiles?, codeChanges?, ... }

// Utility
{ type: 'clear-timeline' }
{ type: 'engine-fallback', fromEngine, toEngine }
```

The webview sends commands back via:
```typescript
vscode.postMessage({ type: 'play' | 'pause' | 'stop' | 'refresh' | 'editTask' | 'retryTask' | ... })
```

---

## Acceptance Criteria

1. Dashboard with 1 task renders correctly — no empty space abuse
2. Dashboard with 30 tasks shows numbered pills (current behavior)
3. Dashboard with 184 tasks shows progress bar + minimap — pills NOT filling the viewport
4. During execution: live output is visible without scrolling
5. After execution: completed tasks and result banner visible without scrolling past pills
6. Error banner groups failures by type, not individual names
7. All sections collapsible with VS Code tree-style headers
8. Ctrl+F in webview can find task names in the task list
9. Works in light and dark VS Code themes (uses CSS variables)
10. No layout shift when tasks start/complete during execution
