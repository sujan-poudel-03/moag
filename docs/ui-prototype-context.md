# MOAG — UI Prototype Brief
## Single context document for Claude Artifacts / Google Stitch

---

## WHAT IS MOAG

MOAG (Agent Task Player) is a **VS Code sidebar extension** that lets developers run AI coding agents (Claude, Codex, Gemini, Ollama) like a task playlist. You write a plan of tasks, press Play, and the AI executes each one — fixing failures automatically, testing visually, and verifying the result against a requirements document.

**Mental model:** Think of a music player, but instead of songs it runs AI coding tasks. Playlists of tasks. Play/Pause/Stop. Live output dashboard. Auto-fix when a task fails. Verify everything against the original spec at the end.

**Design environment:**
- VS Code webview (renders inside VS Code's sidebar and editor tabs)
- Dark theme primary (`#1e1e1e` background)
- Sidebar width: 280–400px (constrained)
- Full-screen panels open as editor tabs (no width limit)
- Icon set: VS Code Codicons ($(play), $(stop), $(check), etc.)
- Font: system sans-serif 13px for UI, monospace for code/output

---

## DESIGN TOKENS (use these exact values)

```
BACKGROUNDS
  Page bg:        #1e1e1e
  Surface/cards:  #252526
  Input bg:       #3c3c3c
  Hover row:      rgba(128,128,128,0.10)

TEXT
  Primary:        #cccccc
  Secondary:      #8b949e   (labels, hints, metadata)
  Link/info:      #4fa3ff

BORDERS
  Default:        rgba(128,128,128,0.25)
  Input border:   rgba(128,128,128,0.40)
  Focus ring:     #007acc

STATUS COLORS
  Success/pass:   #4caf50
  Running/info:   #4fa3ff   (+ rgba(79,163,255,0.15) bg tint)
  Warning/paused: #cca700   (+ rgba(204,167,0,0.15) bg tint)
  Error/failed:   #f44747   (+ rgba(244,71,71,0.15) bg tint)
  Muted/pending:  #8b949e

BUTTONS
  Primary bg:     #0e639c
  Primary text:   #ffffff
  Primary hover:  #1177bb
  Secondary bg:   transparent
  Secondary text: #cccccc
  Secondary border: rgba(128,128,128,0.40)

SPACING (4px base unit)
  xs:  4px
  sm:  8px
  md:  12px
  lg:  16px
  xl:  24px

RADIUS
  Buttons/inputs: 2px   (VS Code style — very subtle)
  Cards:          4px
  Pills/badges:   999px
```

---

## THE 6 SCREENS TO DESIGN

### SCREEN 1 — Sidebar: PLAN Tab (full layout)

The main control center. 320px wide sidebar column.

```
┌─────────────────────────────────────────┐
│ [Chat] [Plan] [History]    [Claude ▼]   │  ← Tab bar (36px)
├─────────────────────────────────────────┤
│                                         │
│  ── Plan Header ──────────────────────  │
│  Feature Plan                   IDLE   │
│  PRD: prd.md ✓  ←── green pill badge  │
│  [████████░░░░░░░░] 7/10  70%          │  ← 4px progress bar
│                                         │
│  ── SDLC Stepper ─────────────────────  │
│  Chat → Plan → Execute → Test → Verify  │
│                  ↑ active (bold+blue)   │
│                                         │
│  ── Playlists ─────────────────────────│
│  ▼ Design                      3/3 ✓   │
│    ✓ Define data model                  │
│    ✓ Write API spec                     │
│    ✓ Create wireframes                  │
│                                         │
│  ▼ Development                 4/5      │
│    ✓ Implement API endpoints            │
│    ⟳ Add auth middleware  CLAUDE  2m14s│  ← Running (blue border left)
│    ○ Write unit tests                   │
│    ○ Add error handling                 │
│    ✗ Fix database types  [COMPILE]     │  ← Failed (red border left)
│      error TS2345: string not number…  │
│                        [🔨 Smart Fix]   │
│                                         │
│  ▼ Testing  [TEST PHASE]       0/3      │  ← Blue tinted header
│    ○ Run tests (npm test)               │
│    👁 Visual test: homepage             │
│    ○ Verify PRD criteria                │
│                                         │
├─────────────────────────────────────────┤
│  ── TAV Panel (bottom strip) ─────────  │
│  TEST & VERIFY              [SETUP]    │
│  Sandbox  ● Stopped         [Launch]   │
│  Tool     [Playwright ▼]               │
│  PRD      prd.md ✓          [Open]     │
│                                         │
│  Acceptance Criteria                    │
│  ☐ User can log in                     │
│  ☐ Dashboard loads < 2s                │
│  ☐ Mobile nav collapses                │
│                                         │
│                   [▶ Play with TAV]     │
└─────────────────────────────────────────┘
```

**Key components to render:**
- Plan header with PRD badge (3 states: linked ✓ green / not-linked dashed gray / outdated ⚠ amber)
- SDLC stepper: `Chat → Plan → Execute → Test → Verify → Done` — active phase bold + blue underline, done phases green with ✓
- Task rows: status icon left, name, metadata right (cost/duration in `#8b949e`)
- Failed task: red left border (2px), error preview in red monospace box, Smart Fix button
- Running task: blue left border, spinning icon, engine badge
- TEST PHASE playlist: blue-tinted header, beaker icon, `[TEST PHASE]` pill
- TAV Panel at bottom: SETUP mode (pre-run config)

---

### SCREEN 2 — TAV Panel: Three Modes

Show all 3 modes side by side or as a state flow.

**SETUP mode** (before Play is pressed):
```
TEST & VERIFY                      [SETUP]
─────────────────────────────────────────
Sandbox   ● Stopped              [Launch]
Tool      [Playwright ▼]
PRD       prd.md ✓               [Open]

Acceptance Criteria (3)
  ☐ User can log in with email
  ☐ Dashboard loads in < 2s
  ☐ Mobile layout collapses nav

                        [▶ Play with TAV]
```

**RUNNING mode** (test playlist is active):
```
TEST & VERIFY                     [RUNNING]
─────────────────────────────────────────
Sandbox  🟢 localhost:3000  [Stop] [📷]
Tool     Playwright

⟳ Visual test: homepage          running…
  └ screenshot captured → analyzing…

Fix loop:  ○ ○ ○   (0/3 iterations)

                      [✓ Verify Against PRD]
                           (disabled, gray)
```

**VERIFY mode** (all test tasks done, verify clicked):
```
PRD Verification                   PASS 4/5
─────────────────────────────────────────
✓  User can log in
✓  Dashboard loads in < 2s
✗  Mobile layout collapses nav  [details ▼]
✓  API /health returns 200
✓  404 page renders

Score: 80%           [↺ Re-run]  [📤 Export]
```

**States to show:**
- ✗ row has red icon and slightly different row background
- Score pill: green if ≥80%, amber if 60–79%, red if <60%
- Fix loop dots fill in as iterations progress (○ → ● for each attempt)

---

### SCREEN 3 — Dashboard Panel (full editor width, 800px)

The live execution view. Opens as a VS Code tab beside the editor.

```
┌──────────────────────────────────────────────────────────────────┐
│ MOAG Dashboard          [▶ Play]  [⏸ Pause]  [⏹ Stop]          │  ← Fixed header 48px
│ Feature Plan            ● EXECUTING                              │
├──────────────────────────────────────────────────────────────────┤
│ [█████████████████░░░░░░░░░░░░░░]  9/10 tasks  · 3 failed       │  ← Fixed progress 40px
│ ████ ████ ████ ██░░ ░░░░ (minimap dots — green/red/blue/gray)    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ ⟳  Add auth middleware          [CLAUDE]  2m 14s   [⏹]  │   │  ← Active task card
│  ├──────────────────────────────────────────────────────────┤   │    (flex:1, hero section)
│  │ $ claude --model claude-sonnet-4-6 --no-stream...        │   │
│  │ Creating authentication middleware...                    │   │
│  │ ✓ Writing src/middleware/auth.ts                         │   │
│  │ ✓ Writing src/middleware/auth.test.ts                    │   │
│  │ Running: npm test                                        │   │
│  │ ▮                                                        │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │ ▶ Details (prompt · criteria · policy)                   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ▼ COMPLETED TASKS                                          8    │
│    ✓ Define data model          CLAUDE  45s   2 files           │
│    ✓ Write API spec             CLAUDE  1m2s  1 file            │
│    ✗ Fix database types         CLAUDE  2m    0 files           │
│      │ error TS2345: Argument of type 'string'…                 │
│      │                         [Retry]  [View Output]           │
│                                                                  │
│  ⚠ 3 TASKS FAILED                                               │
│  compile (2): Fix TypeScript type errors                        │
│  timeout (1): Increase taskTimeoutMs setting                    │
│  [Retry Failed]  [Switch Engine]                                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Key design specs:**
- Active task card: blue border (`#4fa3ff`), subtle blue glow (`box-shadow: 0 0 12px rgba(79,163,255,0.15)`), takes all vertical flex space
- Terminal output: `#1e1e1e` background, `#cccccc` text, 12px monospace, auto-scroll
- Minimap: 4px dots, no gaps between, 1 row max-height (overflow hidden), colors match task status
- Completed tasks: ✗ failed rows have red left border, auto-expand first error line in red monospace
- Error banner: groups by category (compile/test/timeout/rate-limit), shows count + actionable message + contextual buttons
- Section headers: VS Code tree style — uppercase 11px bold, chevron, count right-aligned, hover highlight

**Dashboard states to show:**
- EXECUTING (hero active task, output streaming)
- IDLE (task list is primary, no active card)
- RUN COMPLETE (result banner: green for all pass, amber if failures, with action buttons)

---

### SCREEN 4 — Task Editor: visual-test Type

Full-screen editor tab. Max-width 720px, centered in editor area.

```
┌──────────────────────────────────────────────────────────────┐
│ [✓ Save]  [Cancel]                              task-007     │  ← Sticky toolbar
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ── Core ─────────────────────────────────────────────────  │
│                                                              │
│  Name                                                        │
│  [Homepage visual regression check                       ]   │
│                                                              │
│  Type                                                        │
│  [Visual Test ▼]                                            │
│                                                              │
│  Engine                                                      │
│  [Anthropic API]  (ℹ Visual tests require Anthropic API)    │  ← Read-only, info tooltip
│                                                              │
│  Prompt                                                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Take a screenshot of the homepage. Verify that:       │ │
│  │ - Navigation links are visible at mobile (375px)      │ │
│  │ - Hero image loads without broken src                 │ │
│  │ - CTA button text reads "Get Started"                 │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  URL  (optional — defaults to sandbox URL)                   │
│  [http://localhost:3000                                   ]   │
│                                                              │
│  Playwright Spec  (optional — .spec.ts file path)            │
│  [tests/homepage.spec.ts                                  ]   │
│                                                              │
│  ── Verification ──────────────────────────────────────────  │
│                                                              │
│  Acceptance Criteria  (one per line)                         │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Nav visible on mobile                                  │ │
│  │ Hero image loads                                       │ │
│  │ CTA text correct                                       │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Type dropdown options:**
```
Agent       — AI agent with full prompt
Command     — Shell command (npm test, go build)
Visual Test — Screenshot + Claude vision analysis   ← NEW
Service     — Long-running background process
Check       — One-shot health check
Manual      — Human approval gate
Review      — AI code review pass
```

**When Visual Test is selected:**
- URL field appears (optional, defaults to sandbox URL)
- Playwright Spec field appears (optional)
- Engine field shows `Anthropic API` with a lock icon and info tooltip
- Command field is hidden (not applicable)

---

### SCREEN 5 — Share Feedback Panel

Full-screen editor tab. Max-width 720px centered.

```
┌──────────────────────────────────────────────────────────────────┐
│  Share Session Feedback                                          │
│  ──────────────────────────────────────────────────────────────  │
│  MOAG v0.9.9  ·  Engine: claude  ·  Project: typescript / vscode │
│                                                                  │
│  Run Summary                                                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  10 tasks    7 passed    2 failed    1 escalated        │    │
│  │  Duration: 8m 42s        Est. cost: $0.31               │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Friction Points                                                 │
│  ┌──────────────┬──────────┬──────────┬───────────┬───────────┐ │
│  │ Task         │ Attempts │ Auto-fix │ Escalated │ Error     │ │
│  ├──────────────┼──────────┼──────────┼───────────┼───────────┤ │
│  │ Build VSIX   │    3     │    ✓     │    ✗      │ TS2345…   │ │
│  │ Run Tests    │    2     │    ✓     │    ✗      │ Assert…   │ │
│  │ Deploy       │    1     │    ✗     │    ✓      │ ENOENT…   │ │
│  └──────────────┴──────────┴──────────┴───────────┴───────────┘ │
│                                                                  │
│  Error Patterns                                                  │
│  [compile: 2]  [test: 1]  [cli-missing: 1]   ← chip pills       │
│                                                                  │
│  Notes  (optional)                                               │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ This happened right after updating Node 20 → 22         │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Repo:  moag / agent-task-player             [▼ change repo]    │
│                                                                  │
│                        [Cancel]    [📤 File GitHub Issue]       │
└──────────────────────────────────────────────────────────────────┘
```

---

### SCREEN 6 — Issue → PRD → Plan: Full Flow

Show these 3 screens as a connected flow:

**Step 1: PRD Editor Panel** (full-screen tab)
```
┌──────────────────────────────────────────────────────────────────┐
│  📄 PRD Editor                                  [Save as .md]   │
│  ──────────────────────────────────────────────────────────────  │
│  Issue: #42 — Add user authentication                            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ # User Authentication PRD                                  │ │
│  │                                                            │ │
│  │ ## Overview                                                │ │
│  │ Add email/password authentication to the web app.          │ │
│  │                                                            │ │
│  │ ## Acceptance Criteria                                     │ │
│  │ - User can register with email + password                  │ │
│  │ - User can log in and receive a session token              │ │
│  │ - Invalid credentials show a clear error message          │ │
│  │ - Session persists across page refreshes                   │ │
│  │ - Log out clears the session                               │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  [✨ Draft with AI]    [📁 Browse .md file]                      │
│                                                                  │
│  ─────────────────────────────────────────────────────────────  │
│                                    [Generate Plan →]            │
└──────────────────────────────────────────────────────────────────┘
```

**Step 2: Plan Generated** (Plan tab, sidebar)
```
  Feature Plan                    IDLE
  PRD: prd.md ✓
  [░░░░░░░░░░░░░░░░░░░] 0/10

  Chat → Plan → Execute → Test → Verify → Done
         ↑ active

  ▼ Design                        0/3
    ○ Define data model
    ○ Write API spec
    ○ Design auth flow diagrams

  ▼ Development                   0/5
    ○ Implement /auth/register
    ○ Implement /auth/login
    ○ Add JWT session handling
    ○ Add auth middleware
    ○ Write auth tests

  ▼ Testing  [TEST PHASE]         0/2
    ○ Run full test suite
    👁 Visual test: login flow
```

**Step 3: Run Complete + Verify** (TAV Panel, VERIFY mode)
```
  PRD Verification                  PASS 5/5
  ─────────────────────────────────────────
  ✓  User can register
  ✓  User can log in
  ✓  Invalid credentials show error
  ✓  Session persists
  ✓  Log out works

  Score: 100%         [↺ Re-run]  [📤 Export]

  ────────────────────────────
  [Suggest Commit]  [Create PR →]
```

---

## COMPONENT SPECIFICATIONS

### Status Badge / Pill
```
Padding:      2px 7px
Border-radius: 999px (full pill)
Font-size:    11px
Font-weight:  500

Completed:   bg rgba(76,175,80,0.15)   text #4caf50
Running:     bg rgba(79,163,255,0.15)  text #4fa3ff
Failed:      bg rgba(244,71,71,0.15)   text #f44747
Blocked:     bg rgba(204,167,0,0.15)   text #cca700
Pending:     bg rgba(128,128,128,0.12) text #8b949e
```

### Task Row
```
Height:       44px (compact), auto (expanded)
Padding:      6px 12px
Left border on active: 2px solid (status color)
Hover:        background rgba(128,128,128,0.10)

Layout:  [16px icon] [flex-1 name] [badge] [11px metadata]

Failed expanded adds:
  - Red monospace error preview box (11px, #f44747, bg rgba(244,71,71,0.08))
  - Smart Fix button (small, right-aligned)
```

### Playlist Section Header
```
Height:       32px
Font:         11px bold uppercase letter-spacing 0.06em
Color:        #cccccc
Hover bg:     rgba(128,128,128,0.10)
Chevron:      left, rotates 90° when collapsed

Layout:  [chevron] [name flex-1] [progress] [play-btn on hover]

TEST PHASE variant: text color #4fa3ff, adds pill badge
```

### Buttons
```
Primary:    bg #0e639c  text #fff  radius 2px  padding 6px 16px  font 13px
Secondary:  bg transparent  border 1px solid rgba(128,128,128,0.4)  text #ccc  same padding
Icon btn:   22×22px  bg transparent  hover bg rgba(128,128,128,0.10)
Danger hover: bg rgba(244,71,71,0.12)  text #f44747
```

### PRD Badge (3 states)
```
Linked (✓):    bg rgba(76,175,80,0.12)   border rgba(76,175,80,0.3)    text #4caf50
Not linked:    bg transparent  border dashed rgba(128,128,128,0.4)  text #8b949e
Outdated (⚠):  bg rgba(204,167,0,0.12)   border rgba(204,167,0,0.3)    text #cca700

Padding: 2px 8px  radius: 999px  font-size: 11px  cursor: pointer
```

### Progress Bar
```
Track height: 4px   bg: rgba(128,128,128,0.2)   radius: 999px
Fill: #4fa3ff   transition: width 400ms ease
With failures: blue portion + red tail
```

### SDLC Stepper
```
Font: 11px
Inactive step: color #8b949e
Active step:   color #cccccc  font-weight 600  border-bottom 2px solid #4fa3ff
Done step:     color #4caf50  prepend ✓
Separator →:   color rgba(128,128,128,0.3)
```

---

## INTERACTION STATES

### Notification (post-run with failures)
```
Position:  VS Code info bar (bottom of window, or top of sidebar)
Style:     bg #252526  border-left 3px solid #f44747  text #cccccc  12px

"2 tasks failed · 1 escalated — help MOAG improve?"     [Share ↗]

Dismiss:   × button right side
Auto-hide: never (user must dismiss or click Share)
```

### Engine Fallback Toast
```
bg #252526  border-left 3px solid #cca700  text #cccccc

"Rate limit hit — switching to Codex as fallback"
```

### Empty States

**No plan loaded (Chat tab):**
```
Center of sidebar, gray icon + message

"Start building with AI"
Subtitle: "Create a plan, generate from a PRD, or start from a GitHub issue"

[Smart Plan]       ← primary button
[Plan from PRD]    ← secondary
[Plan from Issue]  ← secondary
[Open Plan]        ← secondary
```

**No history (History tab):**
```
Center: clock icon (muted)
"No history yet"
Subtitle: "Run a plan to see execution history here"
```

---

## WHAT NOT TO REDESIGN

These screens already exist and work — only design the 6 screens above:
- Chat tab message feed and composer
- AI Rules section (toggle/add rules)
- Sandbox basic launch/stop/screenshot
- History tab list and filters
- Task Editor for Agent/Command/Service/Check/Manual types (not visual-test)
- Plan import/export flows

---

## PROMPT FOR THE PROTOTYPE AGENT

Use this exact prompt when submitting to Claude Artifacts or Google Stitch:

---

**For Claude Artifacts:**

> Design a VS Code extension sidebar UI for MOAG (AI agent orchestrator). Dark theme, 320px sidebar width. Use these exact colors: bg #1e1e1e, surface #252526, text #cccccc, muted #8b949e, border rgba(128,128,128,0.25), blue accent #4fa3ff, green #4caf50, red #f44747, amber #cca700. Font: system sans-serif 13px, monospace for code. Buttons: 2px border-radius (VS Code style).
>
> Design Screen 1: The Plan Tab showing — (a) plan header with "PRD: prd.md ✓" green pill badge, (b) SDLC stepper "Chat → Plan → Execute → Test → Verify → Done" with Execute highlighted, (c) 3 playlists with tasks showing all status states (pending, running with blue left border, completed with strikethrough, failed with red left border and error preview + Smart Fix button), (d) a [TEST PHASE] playlist with blue tinted header, (e) TAV Panel at the bottom in SETUP mode showing sandbox status, test tool dropdown, PRD link, acceptance criteria checkboxes, and Play with TAV button.

---

**For Google Stitch:**

> Create a UI prototype for a VS Code dark-theme sidebar extension called MOAG. The sidebar is 320px wide. Design the following screens:
>
> 1. Plan tab: task playlist manager with status indicators (pending/running/completed/failed), collapsible playlist groups, a progress bar, PRD badge, SDLC phase stepper, and a TEST & VERIFY panel at the bottom
> 2. Dashboard: full-width execution view with live terminal output, active task card (hero), progress bar with minimap dots, completed task list, and grouped error banner
> 3. TAV Panel: 3 states (Setup with checkboxes, Running with live status, Verify with pass/fail results per criterion)
> 4. Task Editor: form for visual-test type with URL field, spec file, locked engine selector
> 5. Share Feedback: friction table showing failed tasks with retry counts and error summaries
>
> Color palette: bg #1e1e1e, surface #252526, text #cccccc, accent #4fa3ff (blue), #4caf50 (green), #f44747 (red), #cca700 (amber). Border-radius: 2px for inputs/buttons, 4px for cards.
