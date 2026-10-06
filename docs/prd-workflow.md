# PRD Workflow — MOAG Feature Specification

> **Status (2026-05-09):** Feature is ~95% implemented and production-ready.
> All five core types, three commands, Anthropic adapter, memory extractor, task queue, and TTT checklist UI are complete.

---

## Overview

The PRD Workflow transforms MOAG from a task runner into a full development lifecycle tool. A user pastes or uploads a Product Requirements Document and MOAG generates, executes, tests, verifies, and commits the implementation — with the user staying in control at every gate.

---

## Full Workflow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      USER INPUT                             │
│              Paste PRD text  /  Open .md file               │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│                  AI PLAN GENERATION                         │
│  Claude reads PRD → generates 3-playlist MOAG plan JSON     │
│  • Playlist 1: Design      (skipped if no UI in PRD)        │
│  • Playlist 2: Development (feature implementation tasks)   │
│  • Playlist 3: Testing     (testPhase: true)                │
│  Saved to: .moag/prd-{timestamp}.agent-plan.json            │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│               PLAYLIST 1 — DESIGN (optional)                │
│  Tasks: wireframes, component specs, API contracts          │
│  Engine: Claude Code or Anthropic adapter                   │
│  Auto-fix: yes (up to configured retries)                   │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│             PLAYLIST 2 — DEVELOPMENT                        │
│  Tasks: implement features, write code, run lint/build      │
│  Engine: Claude Code or Anthropic adapter                   │
│  Auto-fix: yes                                              │
│  On complete → triggers TTT checkpoint                      │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│               TTT — TIME TO TEST CHECKPOINT                 │
│                                                             │
│  MOAG detects testPhase: true playlist starting             │
│  Reads agentTaskPlayer.testTool setting                     │
│                                                             │
│  ┌────────────┬──────────────┬──────────────┬────────────┐  │
│  │claude-     │  sandbox     │ playwright/  │  manual    │  │
│  │chrome      │  (built-in)  │ cypress/     │ checkpoint │  │
│  │            │              │ custom cmd   │            │  │
│  │Open app    │ Screenshot + │ Run CLI      │ Show PRD   │  │
│  │URL +       │ AI interprets│ test command │ checklist, │  │
│  │sidebar     │ output       │ automatically│ wait for ✓ │  │
│  │checklist   │              │              │            │  │
│  │            │              │              │            │  │
│  │Semi-auto   │ Fully auto   │ Fully auto   │ Manual     │  │
│  └────────────┴──────────────┴──────────────┴────────────┘  │
│                                                             │
│  Sidebar shows: TEST CRITERIA checklist parsed from PRD     │
│  User checks off items as they verify                       │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│             PLAYLIST 3 — TESTING                            │
│  Tasks: run test suite, capture results, screenshot verify  │
│  testPhase: true                                            │
│  prdContext: acceptance criteria extracted from PRD         │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│              PRD VERIFICATION (AI-powered)                  │
│                                                             │
│  Input:  Original PRD text + test run history               │
│  AI evaluates: does the output satisfy acceptance criteria? │
│  Output: PrdVerificationResult JSON                         │
│    { passed, score (0-100), gaps[], suggestion }            │
│                                                             │
│  MOAG generates HTML report → opens in browser             │
└──────────┬──────────────────────────┬───────────────────────┘
           │                          │
     PASS (score ≥ 80)         FAIL (score < 80)
           │                          │
           ↓                          ↓
┌──────────────────────┐  ┌─────────────────────────────────┐
│  GIT COMMIT & PUSH   │  │     FIX LOOP (max 3 iterations) │
│                      │  │                                 │
│  AI generates commit │  │  AI generates fix playlist      │
│  message from PRD    │  │  Appended to current plan       │
│  context + diff stat │  │  User reviews before running    │
│                      │  │  fixIterations counter tracked  │
│  User edits if needed│  │  On iteration 3: hard stop,     │
│  git commit          │  │  manual intervention required   │
│  Optional: git push  │  │         ↓                       │
└──────────────────────┘  │  Re-run Development playlist    │
                          │  → TTT → Testing → Verify again │
                          └─────────────────────────────────┘
```

---

## Components

### 1. cmdPlanFromPRD

**Trigger:** MOAG sidebar topbar `$(note)` icon / Command Palette → `MOAG: Generate Plan from PRD`

**Input options:**
- Paste PRD text directly (input box)
- Open `.md` or `.txt` file (file picker)

**AI prompt contract:**
```
Given this PRD, generate a MOAG plan JSON with:
- version: "1.0"
- name: <short plan name from PRD title>
- prdSource: <full PRD text>
- playlists: Design (optional), Development, Testing (testPhase: true)
- Each task: id, name, prompt (detailed enough for Claude Code), status: "pending"
Return ONLY valid JSON. No markdown fences.
```

**Output:** `.moag/prd-{timestamp}.agent-plan.json` — opened automatically in MOAG.

**Implementation:** `cmdPlanFromPRD()` in `src/extension.ts`. Stores PRD text in `plan.prdSource`.

---

### 2. Test Tool Options

Configured via `agentTaskPlayer.testTool` setting. Set once, used for all PRD plans.

| Value | Name | Behavior |
|-------|------|----------|
| `claude-chrome` | Claude.ai Chrome | Opens app URL + sidebar checklist. User tests with Claude Chrome extension. Semi-automated. |
| `sandbox` | MOAG Sandbox | Built-in screenshot + Claude visual analysis. Fully automated. |
| `playwright` | Playwright | Runs `npx playwright test`. Fully automated. |
| `cypress` | Cypress | Runs `npx cypress run`. Fully automated. |
| `custom` | Custom command | Runs `agentTaskPlayer.testToolCommand`. Fully automated. |
| `manual` | Manual checkpoint | Shows PRD checklist in sidebar. Waits for user sign-off. |

**Secondary setting:** `agentTaskPlayer.testToolCommand` — used only when `testTool = "custom"`.

**Implementation:** `handleTttPhaseStart()` in `src/extension.ts` routes on the setting value.

---

### 3. TTT Sidebar Checklist

When a `testPhase: true` playlist starts, the PLAN tab sidebar shows a **TEST CRITERIA** section above the task list.

- Parsed from `prdSource` via `parsePrdCriteria()` in `src/ui/prompt-input-view.ts`
- Patterns matched: `AC:`, `Acceptance Criteria`, `- [ ]`, numbered items under `Criteria` heading
- Max 20 criteria extracted
- Each criterion renders as a checkbox row
- Checking all criteria reveals **"Verify Against PRD ✓"** button
- Clicking sends `{ type: 'tttAllCriteriaVerified' }` to extension — triggers `verifyAgainstPrd`
- State is in-memory only (resets when playlist changes)

**Implementation:** `renderTttCriteria()` and `parsePrdCriteria()` in `src/ui/prompt-input-view.ts`.

---

### 4. PRD Verification Browser Report

**File:** `.moag/verification-{timestamp}.html`
**Opens:** Default browser via `vscode.env.openExternal()`

#### Report layout

```
┌─────────────────────────────────────────────────────────────┐
│  MOAG  |  {Plan Name}  |  Score: {N}/100  |  {date}         │
├──────────────────────────┬──────────────────────────────────┤
│  PRD Requirements        │  Verification Results            │
│                          │                                  │
│  Each acceptance         │  ✓ / ✗ per criterion             │
│  criterion from the      │  matched against AI gap analysis │
│  original PRD,           │  with short evidence snippet     │
│  highlighted             │                                  │
├──────────────────────────┴──────────────────────────────────┤
│  Test Run Summary                                           │
│  Task | Status | Attempts | Error snippet                   │
├─────────────────────────────────────────────────────────────┤
│  💡 AI Suggestion                                           │
│  {suggestion text from PrdVerificationResult}               │
├─────────────────────────────────────────────────────────────┤
│  [Generate Fix Tasks]  or  [Commit & Push]                  │
│  (buttons copy VS Code command to clipboard)                │
└─────────────────────────────────────────────────────────────┘
```

**Styling:** Dark theme (`#1e1e1e` bg, `#d4d4d4` text, `#0078d4` accent). Inline CSS only. No external dependencies.

**Score badge colours:** ≥ 80 green · 50–79 yellow · < 50 red

**Gate table colours:** the gate rows and the standards section are built by `src/ui/standards-report-html.ts`, which writes each colour as a design-system token with a fallback (`REPORT_COLOR`): `var(--ds-success, #28a745)`, `var(--ds-error, #dc3545)`, `var(--ds-muted, #999)`. This report is a standalone file opened in the system browser, where no `--ds-*` token is defined, so the fallback — the colour the report has always had — is what you see. Rendered inside MOAG, in a webview whose stylesheet includes `designSystemCssTokens()`, the same markup follows the VS Code theme. The fallbacks in that one table are the only raw colours the module may hold; a unit test enforces it.

**Implementation:** `cmdVerifyAgainstPrd()` in `src/extension.ts`. Collects last 20 history entries, sends PRD + results to AI, parses `PrdVerificationResult`, renders HTML.

---

### 5. Fix Loop

**Trigger:** User clicks "Generate Fix Tasks" (from browser report or VS Code notification)

**Guard:** `plan.fixIterations` counter. Hard stop at 3. Shows error: `"Max fix iterations (3) reached. Manual intervention required."`

**Each iteration:**
1. AI generates a `Fix — Iteration N` playlist based on the gap list
2. Playlist appended to current plan (user can review before running)
3. User clicks Play on the fix playlist
4. Execution → TTT → Testing → Verification loop repeats

**Implementation:** `cmdGenerateFixTasks()` in `src/extension.ts`. Uses `TaskQueue.injectNext()` for dynamic task injection.

---

### 6. cmdSuggestCommit

**Trigger:** "Commit & Push" in browser report / VS Code notification after passing verification

**Steps:**
1. `git diff --stat HEAD` → changed files summary
2. AI-generated commit message pre-filled: `feat: {plan name}\n\n{prdSource first 150 chars}\n\nFiles changed:\n{diffStat}`
3. User edits message in input box → confirms
4. `git add -A && git commit -m "{message}"`
5. Notification: "Committed. Push to remote?" → optional `git push`

All git operations: workspace `cwd`, 30s timeout (`GIT_TIMEOUT_MS`).

**Implementation:** `cmdSuggestCommit()` in `src/extension.ts`.

---

### 7. Anthropic Adapter (new — `src/adapters/anthropic-adapter.ts`)

Direct Anthropic API integration for multi-turn agentic sessions. Replaces CLI subprocess for tasks that benefit from persistent conversation context across a playlist.

- Agentic tools available: `read_file`, `write_file`, `list_directory`, `run_bash`
- Per-playlist session memory via `_sessions` map
- Supports extended thinking
- Used when engine is set to `anthropic` in a task or playlist

---

### 8. Memory Extractor (`src/context/memory-extractor.ts`)

Compresses task stdout into ~250-char summaries for context budget management.

- `extractSummary(stdout)` — filters noise, extracts file change counts
- Used by `ContextBuilder` when prior output would exceed token budget
- Tracked via `contextBudgetUsage.usedSemanticRetrieval`

---

### 9. Task Queue (`src/runner/task-queue.ts`)

Dynamic task queue with runtime injection support.

- `TaskQueue` class wraps the active playlist's task list
- `injectNext(task)` — inserts a synthetic task immediately after the current one
- Tracks `repairCycleCount` on injected tasks (for fix loop guard)
- Used by `cmdGenerateFixTasks()` to append fix playlists without blocking the runner

---

### 10. Project standards (`src/standards/`)

A project can have one versioned standards profile. It reaches the PRD workflow at three points:

- **Planning.** `buildFullPlanPrompt` and `buildDeltaPlanPrompt` take the standards text and place it before the `Rules:` line. For a greenfield repository the text also tells the planner that the first task scaffolds the required directories.
- **Execution.** Every task prompt carries the text under `## Project Standards`, directly before `## AI Rules`.
- **Verification.** `runPrdLoop` checks the diff against the profile before any model call. The gate order is: status, change, standards (static rules), repository gate commands, standards (profile commands), browser UAT, artifacts, then the model. A standards failure is reported as `failedGate: "standards"` with `modelCallsMade: 0`.

Rules of the gate:

- MOAG blocks on the project's own tools; its own scans are advisory unless promoted. What blocks by default is the profile's commands (real tools, judged by exit code) and nothing else. Every rule MOAG decides itself — required directories, nested repositories, placement, layout, naming, layering, raw patterns, the comment policy, generated markers — is advisory unless the profile promotes it.
- Each rule is stored as `passed`, `failed` or `not-checked`. A scanner rule is shown as "no findings" or "findings", never as passed. **Not checked is not a pass**: it is reported with its reason and never counted as passed or as "no findings".
- A rule that found nothing in the diff to judge is `not-checked`. An empty diff therefore passes nothing.
- Every changed file the line rules did not read (vendored, generated, no lexer, an unsupported type such as `.yml` or `Dockerfile`, unreadable) is listed in the report with its reason and counted, and so is every nested repository and submodule.
- One synthetic gate row `moag:standards v<N>` carries the result. It is written with exit 0 once the **blocking set was evaluated** — every profile command ran, every promoted rule the profile configures was decided, and none stops the release — or when the profile has no blocking set at all, in which case its text and its counts say `no blocking rules configured` and never that anything passed. It is written with exit 1 when a blocking rule or command failed, and also when one ended **not checked**: unevaluated blocking evidence stops the release like a failure. The row records how many advisory findings, rules not checked and files not checked the check left open, and the release stamp copies them (`standardsCounts`). The row is never worded as a pass or a fail: the report's gate table, the evidence block the verifying model reads and the stored `verification-<ts>.json` all say `stopped`, `no blocking rules configured` or `nothing blocking` (one function, `standardsGateWord`); only a real command says `pass`, `fail` or `timeout`.
- Locally the diff base is `HEAD` (captured before the run for `moag run --verify`). Work that was committed before that point is outside the diff; pass `--base <ref>` to include it. Content that is committed or staged and no longer in the working tree is judged from the commit or the index.
- A base that was named but is not a commit in the repository does not turn the gate off. The diff is taken against the empty tree, every file is judged as added, and the loop reports a warning. If no diff can be taken at all against a named base, the gate fails as `standards`. Only a run with no base at all (a workspace that is not a repository) leaves the diff-based rules `not-checked`.
- With `--fix`, a standards failure costs one model call per fix iteration (ceiling 3). Detection, proposal and checking cost nothing.
- `PrdLoopConfig.standards` is required and nullable: a caller must say explicitly that a run has no standards.

Where the profile comes from:

- **VS Code and headless:** `<workspace>/.moag/standards.json`. There is no approval step.
- **Hosted server:** the version a reviewer approved, delivered to the worker in a server-written job file. Plan generation is refused with `409 standards-not-approved` until a version is approved.

The profile format, the review flow, migration of existing projects and the `moag standards` verbs are described in [server.md → Project standards](server.md#project-standards).

---

## New Settings

```json
"agentTaskPlayer.testTool": {
  "type": "string",
  "enum": ["claude-chrome", "sandbox", "playwright", "cypress", "custom", "manual"],
  "default": "manual",
  "description": "Default tool used for the TTT (Time to Test) phase in PRD workflow"
},
"agentTaskPlayer.testToolCommand": {
  "type": "string",
  "default": "",
  "description": "Shell command to run when testTool is 'custom' (e.g. npx playwright test)"
}
```

---

## New Commands

| Command ID | Title | Icon | Trigger |
|-----------|-------|------|---------|
| `agentTaskPlayer.planFromPrd` | Generate Plan from PRD | `$(note)` | Sidebar topbar |
| `agentTaskPlayer.verifyAgainstPrd` | Verify Against PRD | `$(checklist)` | Post-test phase |
| `agentTaskPlayer.suggestCommit` | Commit & Push (PRD Workflow) | `$(cloud-upload)` | Post-verification pass |

---

## New Types (`src/models/types.ts`)

```typescript
// Playlist additions
testPhase?: boolean          // marks this as the TTT playlist
prdContext?: string          // acceptance criteria slice (defined; populated at plan level)

// Plan additions
prdSource?: string           // full original PRD text
fixIterations?: number       // loop counter, capped at 3

// New export
interface PrdVerificationResult {
  passed: boolean;
  score: number;             // 0–100
  gaps: string[];            // unmet acceptance criteria
  suggestion: string;        // AI-generated fix direction
}
```

---

## Acceptance Criteria

- AC1: Pasting a PRD text generates a valid `.moag/prd-*.agent-plan.json` with Design/Development/Testing playlists
- AC2: Opening the plan in MOAG shows all playlists with correct task counts
- AC3: When the Testing playlist starts, the TTT checkpoint fires and the configured test tool launches
- AC4: The TEST CRITERIA checklist appears in the sidebar during the test phase, parsed from the PRD
- AC5: After testing, `cmdVerifyAgainstPrd` produces an HTML report that opens in the browser
- AC6: The browser report shows PRD criteria vs results in two columns with correct pass/fail icons
- AC7: Failing verification appends a Fix playlist and increments `fixIterations`
- AC8: After 3 failed iterations, the fix loop stops with a clear error message
- AC9: Passing verification opens the commit dialog with an AI-generated message pre-filled
- AC10: The entire flow from PRD paste to committed code works end-to-end with no manual steps except test verification (for `claude-chrome` and `manual` tool modes)
- AC11: Existing MOAG plans without `prdSource` are completely unaffected

---

## Implementation Status

Locations are given by file and symbol, not by line number. Line numbers in a
document rot the moment anything above them moves — every number that used to
be in this table was wrong within one refactor, and two of them pointed at the
wrong file entirely after the PRD code moved out of `extension.ts`.

| Component | Status | Location |
|-----------|--------|----------|
| `prdSource` / `fixIterations` types | ✓ Complete | `src/models/types.ts` |
| `testPhase` / `prdContext` types | ✓ Complete | `src/models/types.ts` |
| `PrdVerificationResult` interface | ✓ Complete | `src/models/types.ts` |
| `planFromPrd` command | ✓ Complete | `src/ui/prd-authoring.ts` — `generatePlanFromPrdText` |
| `verifyAgainstPrd` command | ✓ Complete | `src/extension.ts` — `cmdVerifyAgainstPrd` |
| `suggestCommit` command | ✓ Complete | `src/extension.ts` — `cmdSuggestCommit` |
| `cmdGenerateFixTasks` + fix loop | ✓ Complete | `src/extension.ts` — `cmdGenerateFixTasks` |
| TTT checklist UI + criteria parsing | ✓ Complete | `src/webview/dashboard.ts` |
| Test phase detection + TTT routing | ✓ Complete | `src/extension.ts` |
| `testTool` / `testToolCommand` settings | ✓ Complete | `package.json` — `contributes.configuration` |
| Anthropic adapter | ✓ Complete | `src/adapters/anthropic-adapter.ts` |
| Memory extractor | ✓ Complete | `src/context/memory-extractor.ts` |
| Task queue with `injectNext` | ✓ Complete | `src/runner/task-queue.ts` |
| `prdContext` per-playlist wiring | Partial | Defined in types; stored at plan level instead |

---

## Known Gaps / Future Work

1. **`prdContext` per-playlist** — The type is defined but the plan generator does not slice acceptance criteria per playlist. Criteria live on `plan.prdSource`. Low priority since the TTT checklist reads from the plan level anyway.

2. **Semantic retrieval** — `contextBudgetUsage.usedSemanticRetrieval` is typed but semantic vector search is not implemented. The memory extractor provides basic summary compression as a fallback.

3. **Automated criterion checking** — TTT checkboxes are manually ticked by design. There is no automated pass/fail detection from test runner output.
