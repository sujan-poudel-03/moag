# Changelog

## [0.9.10] - 2026-05-27

### GitHub Two-Way Auto-Sync

- **Connect GitHub** — link a GitHub repo to your workspace via the "Connect GitHub" pill in the Plan tab header; configures issue polling, label filtering, and sync state in one guided flow
- **Auto-poll for new issues** — MOAG polls the connected repo on a configurable interval (default 5 min); any new issue matching the sync label is automatically added as a task in a "GitHub Issues" playlist — no manual "Plan from Issue" step required
- **Progress comments posted back** — when a task starts, MOAG posts `▶ Working on: <task>` to the source issue; on completion `✓ Done — N files changed`; on failure `✗ <task> failed — <first error line>`
- **Label automation** — `moag:in-progress` label applied when task starts; `moag:done` when all tasks for the issue complete; all labels created automatically if missing
- **`ghSyncConfigureInteractive` command** — keyboard-friendly QuickPick menu to toggle sync on/off, poll immediately, change repo/label, or disconnect; accessible from the header pill or command palette
- **`ghSyncPollNow` command** — manually trigger a poll from the toolbar overflow menu at any time
- **Auth indicator** — GitHub Sync panel shows a green dot + username when `gh` is authenticated; red warning when not set up; 30 s cache avoids repeated subprocess calls
- **`sourceIssueNumber` / `sourceIssueRepo` on tasks** — issue traceability stored on each task; plan serialized and reloaded without data loss; `#N` badge shown on task rows with click-to-open in browser
- **Report Issue → sync loop** — bug reports filed via "Report Bug" button use the connected repo (not a hardcoded URL), apply both `bug` and sync labels automatically, and trigger an immediate poll so the filed issue appears as a task within seconds

### Per-Version PRD

- **`prdContext` per playlist** — plan generation now extracts and stores a PRD slice for each playlist (the acceptance criteria governing that version sprint); persisted in `plan.json` and restored on reload
- **Verify uses playlist PRD** — `Verify Against PRD` now prefers the active playlist's own `prdContext` over the global `prdSource`; test playlists verify against their specific acceptance criteria, not the whole 29 KB PRD
- **PRD pill on playlist header** — playlists with a `prdContext` show a `PRD` badge in the Plan tab; click opens the PRD slice in the existing PRD viewer panel
- **Plan generation prompt updated** — generation prompt now instructs the model to quote the PRD slice governing each playlist; test playlists must include `type:"command"` and `type:"visual-test"` tasks (not all `type:"agent"`)

### Fixes

- **`gh.cmd` interceptor removed** — a stale test stub in the project root was intercepting all `gh` CLI calls via Windows CWD-before-PATH resolution, causing all GitHub operations to silently return a fake URL (`issues/999`); deleted
- **Auth check fixed** — `gh auth status` check now uses exit code (not stdout content) since `gh` writes to stderr; eliminates false "not authenticated" errors for users who are correctly logged in

## [0.9.9] - 2026-05-12

### Browser-Level Visual Testing

- **`visual-test` task type** — new task type that wires Claude's vision to your live sandbox; the Anthropic API adapter sends a screenshot directly to the model for visual analysis without leaving the MOAG workflow
- **Playwright integration** — `browser-driver.ts` provides `capturePageScreenshotBase64` (full-page screenshot → base64 PNG) and `runPlaywrightSpec` (run `.spec.ts` files and return output); both prefer a local `node_modules/.bin/playwright` over npx
- **Browser tools in Anthropic adapter** — `take_screenshot` and `run_playwright_test` tools are conditionally injected into the agentic loop when `browserEnabled: true`; the model can autonomously capture screenshots and iterate on visual regressions
- **Sandbox URL forwarded** — the current sandbox URL is passed to visual-test tasks so `take_screenshot` can target the running dev server without extra configuration

### UI Accessibility — Single Toolbar for All Actions

- **All features in one place** — all 20+ MOAG actions are now reachable from the `agentTaskPlayer.promptView` title bar; previously split across non-existent `planView`/`historyView` groups that never appeared in the UI
- **Always-visible navigation group** — Switch Plan, Play, Stop, and Dashboard promoted to the `navigation` group so they remain pinned to the title bar regardless of sidebar width
- **Organized overflow menu** — remaining actions grouped into labelled sections: Run controls, Plan management, PRD, Sandbox, GitHub, History, Git, and Manage; no duplicate entries, no dead menu items
- **Command palette decluttered** — 25 tree/webview-internal commands hidden from Ctrl+Shift+P via `"when": "false"` in `commandPalette` entries (playPlaylist, editTask, setTaskStatus, etc.)

### SDLC — Test Tasks Auto-Injected at Plan Generation

- **`detectTestCommand`** — inspects `package.json` scripts, `pytest.ini`, `go.mod`, `Cargo.toml`, and `pom.xml`/`build.gradle` to identify the project's test runner automatically
- **`injectTestTaskIfMissing`** — appended to all three plan-generation flows (smart plan, GitHub issue, PRD); if no `type:"command"` test task exists, a testing task is appended to the last playlist
- **Updated plan-generation prompt** — task type rules and a mandatory `testPhase: true` Testing playlist are now part of the generation prompt, so freshly-generated plans always include a test runner step
- **`testPhase` playlist flag** — playlists with `testPhase: true` display as a distinct TEST & VERIFY section in the PLAN tab

### Run Friction Feedback

- **Silent friction capture** — after any run with failures or escalations, `collectRunFriction` builds a `RunFrictionReport` (retry counts, escalations, error categories, cost) and appends it to `.moag/feedback.jsonl`; limited to the last 20 runs
- **Opt-in share notification** — a non-modal info bar appears after a friction run: "N failed — help MOAG improve? [Share Feedback]"; nothing is sent automatically
- **`cmdShareRunFeedback`** — reads the last friction entry, resolves the GitHub repo (setting → auto-detect from `git remote` → prompt), and files a structured issue with a Friction Points table, error pattern breakdown, and an optional freeform notes field
- **Enhanced bug reports** — `cmdReportIssue` (the "Report Bug" topbar button) now automatically appends the last friction report (< 24 h) to the bug issue body

### PRD Source Linking

- **`prdSource` persisted in plan.json** — when a plan is generated from a PRD, the full PRD text is stored in `plan.prdSource`; powers "Verify Against PRD" and makes plan intent self-contained
- **Existing plan fix** — `.moag/plan.json` updated to carry the 29 KB PRD that produced it

### Docs

- `CLAUDE.md` added — project conventions, architecture overview, and test guidance for AI assistants working on this repo
- `docs/architecture.md` — data flow, module responsibilities, and key design decisions
- `docs/prd-workflow.md` — end-to-end PRD → Plan → Test → Ship workflow guide

## [0.9.8] - 2026-05-09

### PRD → Plan Generation

- **PRD editor panel** — "Generate Plan from PRD" now opens a full-width dark-theme editor tab instead of VS Code's narrow QuickPick popup; paste long PRDs without width constraints, browse `.md`/`.txt` files directly
- **Save PRD as file** — "Save as .md" button in the PRD editor lets you preserve the document before generating; no more lost PRDs when closing the panel early
- **AI-assisted PRD drafting** — CHAT tab now has a "Draft PRD with AI" starter; MOAG asks one follow-up question about your project context, then generates a full PRD using the configured AI engine and opens it pre-filled in the editor
- **"I have a PRD" shortcut** — second starter button opens the PRD file browser directly from the empty chat state

### Engine Setup Guide

- **Setup Guide** — when no AI engine (Claude Code, Codex, Gemini CLI, Ollama) is detected, MOAG shows a one-time setup panel listing all four engines with install commands, auth steps, and links; accessible any time via `MOAG: Open Setup Guide`
- **No-deadlock guard** — AI-assisted PRD drafting checks for a configured engine first; if none is found, a clear notification with "Open Setup Guide" action replaces silent failure

### Sidebar & UX Polish

- **Dashboard stays put** — Dashboard no longer auto-opens on every play/chat submit; open it manually when you need it (13 unconditional auto-opens removed)
- **Taller textarea** — composer input now grows up to 200px before scrolling (was 120px); overflow-y added so very long prompts scroll inside the box rather than expanding it infinitely
- **AI Rules in PLAN tab only** — the AI Rules collapsible section is no longer shown under the CHAT tab, reducing clutter when composing free-form prompts

### Smarter Context Memory

- **Task summaries** — after each task completes, a compact ~250-char summary is extracted from the agent output and stored alongside the raw stdout; the summary captures the final meaningful lines of the agent's work, filtered of spinner/progress noise, with a file-count prefix when available
- **Relevance-ranked prior outputs** — prior task context is now selected by relevance score (token overlap with current prompt + shared file overlap + recency) rather than simple "last N tasks"; the most topically related prior tasks surface first regardless of playlist order
- **Summary-first context** — non-dependency prior tasks now inject their compact summary into context instead of raw truncated output, reducing noise and freeing budget for code spans and file content
- **Explicit deps still get full fidelity** — tasks listed in `dependsOn` always receive raw head+tail output (unchanged), since those are the direct contractual inputs to the current task
- **Backward compatible** — existing history entries without a summary field fall back to the previous raw-tail behavior automatically

### Storage

- **Workspace state size fix** — reduced default storage budgets for history (3 MB → 400 KB) and run sessions (800 KB → 200 KB); per-entry output clamping lowered to 4 KB (was 12 KB); eliminates VS Code's "large extension state" workspace warning

## [0.9.7] - 2026-05-06

### Sidebar UX Redesign
- **Tabs with labels** — Chat / Plan / History tabs now show icon + text label in a compact column layout; previously icon-only
- **All-in-one composer toolbar** — attach, Plan, engine selector, char count, +Queue, and Execute all live in a single toolbar row inside the bordered input box; engine row and action row no longer stack separately
- **Compact textarea** — composer starts at 60px when empty (was ~95px); grows to 120px max before scrolling; no more tall blank textarea dominating the sidebar
- **Execute button** — send button relabelled from "Run" to "Execute" for clarity
- **State-aware plan header** — plan tools bar shows a colored left border that reflects current execution state: green (running), amber (paused), orange (stopping), red (failed tasks), green (completed)
- **Keyboard queue shortcuts** — `Shift+Enter` now queues a prompt (joins existing `Alt+Enter`); button tooltip updated to reflect both shortcuts

### Fix Flow Improvements
- **Fix prompt** — clicking Fix on a failed task no longer embeds the full original task prompt (700+ chars); fix prompt is now concise (~100 chars): task name, failure category, up to 6 error lines, and a short directive
- **Tab switch on Fix** — clicking Fix automatically switches to the Chat tab so the composer is visible without the plan list behind it
- **Blocked dependents auto-unblock** — when a task completes (retry or manual mark-done), any Blocked dependents whose full dependency set is now satisfied are automatically reset to Pending; previously required Fix All
- **Manual status → unblocks chain** — setting a task to Completed or Pending via right-click → Set Status now cascades to unblock dependents
- **Parallel playlists use Blocked** — parallel-mode playlists now set dependency-failed tasks to `Blocked` (matching sequential mode) instead of `Skipped`; Fix All now catches these correctly
- **Auto-fix escalation** — `saveAndRefresh()` fires immediately when auto-fix exhausts all attempts, so Smart Fix button is visible before the warning dialog appears

### Notification Polish
- **No toast storm** — per-task completion toasts suppressed during multi-task runs; the existing end-of-run summary ("Plan complete: 10/10 passed in 4m") is the only notification shown
- **Failure cap** — failure toasts capped at 3 per run; additional failures are counted in the summary instead of stacking

### History Tab
- **Timeline layout** — history items now show a status icon (✓/✗/▶/dot), task name, plan/playlist breadcrumb, and age; previously a dense single-line format
- **Compact toolbar** — View / Group / Status controls collapsed from 4 stacked rows into a single line; no labels, status chips use ✓/✗ symbols

## [0.9.6] - 2026-04-27

### AI Rules (Prompt Rules)
- **AI Rules sidebar section** — add, toggle, edit, and delete reusable coding rules that are automatically injected into every task prompt; rules appear under a collapsible "AI Rules" section alongside the sandbox and content sections
- **Built-in rule library** — 8 pre-made rules (SOLID, OWASP Top 10, Clean Code, TDD, Self-Documenting, Error Handling, Performance, DRY) browseable via "Open Library" or command palette
- **AI-generated rules** — when a configured engine (Claude, Copilot, Codex, etc.) is available, MOAG offers to ask it to generate 5 project-specific rules based on detected stack signals; rules appear in a multi-select picker (all pre-selected) before saving
- **Project auto-detection** — detects JS/TS (package.json), Python (requirements.txt, pyproject.toml), Go (go.mod), Rust (Cargo.toml), and Java (pom.xml, build.gradle) to pre-select relevant built-in rules and surface meaningful stack signals (React, FastAPI, GORM, Axum, Spring Boot, etc.)
- **Global vs Workspace scope** — rules saved globally apply to all projects; workspace rules live in `.moag/rules.json` alongside the plan file
- **Always-on injection** — enabled rules are injected at the highest context priority (never budget-trimmed) so the AI always sees them; rules appear in the `## AI Rules` section of every task prompt
- **Rule Editor webview** — full-screen form with name, category (Code Quality / Security / Architecture / Testing / Performance / Custom), scope picker, text area with live char count, and injection preview
- **One-time suggestion** — on first workspace open, MOAG checks for a configured engine and offers "Ask [Claude] for rules" or "Use Library"; shown once per workspace, dismissible

## [0.9.5] - 2026-04-23

### Prompt Workspace Upgrades
- Sidebar prompt workspace now supports inline task editing, one-click plan generation from prompt text, and active-file context injection for faster task authoring
- Live task output streams directly in the prompt sidebar while runs are in progress
- Task and session chips now show token usage and estimated cost metadata where available

### Reliability and Retry Guidance
- Added failure classification for auth, rate-limit, missing CLI, timeout, compile, test, and generic code failures to provide clearer recovery actions
- Retry-with-note now pre-fills actionable auto-fix context by extracting meaningful error lines and filtering CLI startup noise
- Improved stderr summarization by ignoring noisy preamble lines from agent CLIs before surfacing failure reasons

### Sandbox Configuration
- Plans can now define explicit sandbox targets (`sandbox.targets`) with per-target command/cwd/port to support monorepos and multi-service workspaces
- Sandbox launch now accepts plan-level sandbox overrides instead of relying only on project auto-detection

## [0.9.4] - 2026-04-20

### GitHub Copilot Engine
- **New engine: GitHub Copilot** — uses VS Code's `vscode.lm` API to route tasks through any Copilot-available model (GPT-4o, Claude, etc.); streams output in real-time; requires GitHub Copilot extension installed and signed in
- Select `copilot` as the engine in any plan task or as the global default

### Smarter Verification (False-Failure Prevention)
- **Pre-flight baseline check** — MOAG runs `verifyCommand` on clean state before the agent starts; if verify was already failing before the task ran, the task is not blamed — shown as "Pre-existing failures — not caused by this task" with a yellow badge
- **Scoped verify** (`"scopedVerify": true` on any task) — runs `git diff --name-only HEAD` after the agent, then automatically narrows `tsc --noEmit` and `eslint` to only the files the task touched; pre-existing lint/type errors in unrelated files no longer fail your task
- **Env file inheritance** (`"inheritEnvFiles": [".env.test", ".env.local"]`) — MOAG reads the specified files from workspace root and injects their vars into the agent's process env; stops integration test timeouts caused by missing `.env.test` in agent worktrees
- **Full verify output in UI** — failed task cards now show the complete verification stderr in a collapsible `<details>` block (up to 8 000 chars); no more truncated `[Verification command failed (e…]`
- **Retry with failure context** — on retry, the agent receives `[RETRY CONTEXT — previous attempt failed]` with the last stderr and verify output prepended; the agent now knows what to fix instead of re-running blind
- **Command task silent-success** — `type: "command"` and `type: "check"` tasks succeed on exit code 0, regardless of stdout content

### Extended Thinking (Claude)
- New setting `agentTaskPlayer.engines.claude.extendedThinking` — when enabled, prepends a step-by-step thinking directive to every Claude task prompt for deeper reasoning on complex tasks

### Session Cost Display
- Running session cost appears as a `$0.04` chip in the composer context bar, accumulating across all tasks; resets at the start of each new run

## [0.9.0] - 2026-03-XX

### Validation Engine
- New `validate` task type — unified entrypoint for cross-platform quality gates
- **Web adapter** — auto-detects Playwright or Cypress config; runs lint → unit → integration → e2e based on profile
- **Mobile adapter** — supports Detox, Appium, and Expo; checks for connected Android device or booted iOS simulator; skips gracefully when unavailable with actionable guidance
- **Desktop adapter** — supports Electron+Playwright, Spectron, and WinAppDriver; normalizes result output
- Adapters are skipped (not failed) when tooling is absent, with descriptive skip reasons
- Targets: `web`, `mobile`, `desktop`, `all` (expands to all available adapters)

### CI Profiles (quick / pr / full)
- Three validation depth profiles: `quick` (lint+unit, 3 min), `pr` (all stages, 15 min), `full` (all stages + all targets, 60 min)
- `ValidationProfileConfig` type in `execution-profiles.ts` with `resolveValidationProfile()` helper
- Plan-level and task-level `validation` override fields (`targets`, `profile`, `contextBudget`)
- See `docs/ci-validation-guide.md` for GitHub Actions examples and sample CI plan files

### Context Intelligence
- **Semantic provider interface** (`src/context/semantic-provider.ts`) — pluggable local semantic search backend
- `semanticSearch()` with automatic fallback: when no provider is registered or confidence is below 0.45, falls back to deterministic rg/glob retrieval
- `runRetrievalCascade()` helper for retrieval cascade orchestration
- `ContextBudgetUsage` telemetry emitted by `buildContext()` — tracks chars used, sections dropped, and whether semantic retrieval fired
- `budgetUsage` out-parameter on `ContextOptions` for callers that need telemetry
- `formatSpans()` utility to render semantic spans as fenced code blocks within a char budget

### Evidence and Observability
- Expanded `TaskArtifact` schema: `validationTarget`, `stage`, `screenshots`, `traces`, `logs`, `failureSummary`, `flaky`
- `HistoryEntry.validationTargetResults` — per-target pass/fail/skip breakdown with stage counts and duration
- `HistoryEntry.flakyCount` — total flaky detections across targets in a single run
- `HistoryEntry.contextBudgetUsage` — context budget telemetry per task execution
- Dashboard **Validation Targets** table — collapsible section showing target × stage pass/fail/skip, duration, and summary
- `completeTaskCard()` now accepts and forwards `validationTargetResults` to the dashboard webview

### Schema
- `ValidationTarget`, `ValidationProfile`, `ContextBudget`, `ValidationSettings`, `TaskValidationSettings` types in `types.ts`
- `Plan.validation` and `Task.validation` — plan-level defaults and task-level overrides (backward-compatible; defaults to `quick` profile with `all` targets)
- `RunSession` — `validationProfile`, `validationTargets`, `contextBudget`, `contextTokensUsed` fields

### Documentation
- `docs/ci-validation-guide.md` — full CI/CD integration guide with GitHub Actions YAML, artifact retention, flaky test handling, and failure policy recommendations

### Migration Notes
- Existing plans without a `validation` field continue to work unchanged (defaults to `quick`/`all`).
- Existing tasks without `type: "validate"` run exactly as before.
- The `validate` task type is opt-in — no behavior changes for `agent`, `command`, `service`, `check`, or `review` tasks.

## [1.0.0] - 2026-03-24

### Workflow
- Task Editor webview form for streamlined task creation
- Quick Add Task (Ctrl+Shift+T) — add tasks without leaving the keyboard
- Add Task from Editor Selection — highlight code, create a task
- Duplicate Task — clone any task with one click
- Split Task — AI decomposes large prompts into focused steps
- Plan Review picker — review and edit AI-generated plans before execution

### Smart Features
- AI Auto-Fix — analyzes failures and retries with a targeted repair prompt
- Smart Plan — scans your project and generates a structured improvement plan
- skipIf conditions — conditional task execution based on expressions
- Plan Variables — `{{varName}}` substitution across task prompts
- Output Chaining — previous task output feeds into the next task
- Prompt Snippets — reusable prompt fragments with auto-inject support
- Relevant File Detection — auto-detects and includes referenced files as context

### Multi-Agent
- Peer Review task type — a different engine reviews changes after each task
- Consensus Mode — run the same task on multiple engines, first success wins
- Add Review Step command — insert a review task after any existing task

### Auto-Test
- Auto-test after tasks — automatically runs your test suite after each task completes
- Full Auto mode — write → test → fix loop until tests pass

### GitHub
- Plan from Issue — turn any GitHub issue into a runnable plan
- Create PR — open a pull request from the completion notification
- Share as Gist — export any plan as a GitHub Gist
- Import from URL — load plans from gists, raw URLs, or any JSON endpoint

### Dashboard
- Inline Diff Viewer — syntax-highlighted file diffs inside task cards
- Progress Bar & ETA — track execution progress with time estimates
- Auto-fix Badge — recovered tasks show a visual indicator

### Templates
- 12 built-in plan templates across Scaffold, Improve, Fix, and Automate categories

### Config
- Execution Profiles — Fast, Balanced, Quality, and Budget presets
- Watch Mode — re-runs tasks when watched files change
- .moag/ directory — dedicated project directory with auto-migration from legacy files

### UX
- Truncated descriptions — long plan descriptions trimmed in the tree view
- Playlist progress counters — see "3/5 done" at a glance
- Colored status icons — green, red, blue, and gray for task states
- Rich markdown tooltips — hover any task for full details
- Custom activity bar icon

## [0.8.0] - 2026-03-17

### Marketplace Ready

### Added
- **Smart error detection**: Dashboard detects rate limits, auth failures, missing CLIs — shows clear banner with "Switch engine" button
- **Switch engine command**: One-click engine switch from error banner or command palette
- **Tabbed info panel**: "Current Run", "All History", "Summary" tabs with drag-to-resize
- **User-friendly error messages**: All error dialogs now explain what went wrong and suggest recovery actions
- **Auto-launch walkthrough**: New users see the getting started guide on first install
- **Compact task pills**: Numbered status indicators instead of truncated text
- **Post-run guidance**: Status bar shows actionable next steps after execution finishes
- **Playlist grouping**: Current Run tab groups history entries by playlist

### Changed
- Error messages module extracted (`user-messages.ts`) for consistency and testability
- TASKS section auto-expands after execution completes
- Dashboard width stays fixed during live output streaming
- Marketplace description and keywords optimized for discoverability
- Changelog rewritten for end users (no developer jargon)

### Fixed
- Dashboard width jumping during output streaming
- Duration text truncated in history panel
- Debug logging removed from production webview

## [0.7.0] - 2026-03-13

### Release Polish

### Added
- **Cost budget alerts**: Set a spending limit with `agentTaskPlayer.costBudgetUsd` — you'll get a warning when estimated costs exceed your budget, with the option to stop
- **Smart error banners**: Dashboard now detects rate limits, auth failures, and missing CLIs — shows clear messages with recovery actions like "Switch engine"
- **Switch engine command**: Quickly change your plan's default engine from the error banner or command palette
- **Tabbed info panel**: "Current Run", "All History", and "Summary" tabs replace the old drawer layout — drag to resize
- **Updated model support**: GPT-5.4, GPT-5.3-Codex, GPT-5.2-Codex, GPT-5.2, GPT-5.1-Codex-Max, GPT-5.1-Codex-Mini
- **Example plan in README**: New users can see what a `.agent-plan.json` looks like before creating one
- **User-friendly error messages**: All error dialogs now explain what went wrong and suggest what to do next

### Changed
- CLI adapters no longer force a specific model — each engine uses its own default unless you override in settings
- Dashboard loads faster with a proper handshake instead of retry delays
- Task pills show numbered indicators instead of truncated names
- TASKS section auto-expands after execution finishes
- Status bar shows actionable guidance after runs ("retry or switch engine")
- History entries are grouped by playlist in the Current Run tab

### Fixed
- Codex tasks failing with "model not supported" on ChatGPT accounts
- Dashboard width jumping around during live output streaming
- Duration text getting cut off in the history panel

## [0.6.0] - 2026-03-12

### Execution Contracts

### Added
- **Task contracts**: Define acceptance criteria, expected artifacts, verification commands, and failure policies for each task
- **New task types**: `command`, `service`, and `check` — run shell commands, start dev servers, or validate endpoints alongside agent tasks
- **Background services**: Start dev servers that run in the background with port checks, health URL probes, and log pattern detection
- **Summary dashboard**: See progress, failures, running services, and changed files at a glance
- **Blocked status**: Tasks can be marked as blocked for manual review instead of failing the entire plan

### Changed
- Shell commands and services run directly — no need to route everything through an AI engine
- Dashboard shows verification results, artifact checks, and service status inline
- Retry works on both failed and blocked tasks

## [0.5.0] - 2026-03-10

### Stability & Recovery

### Fixed
- Fixed a bug where starting multiple runs simultaneously could cause unexpected behavior
- Fixed crashes that could occur when tasks failed unexpectedly
- Fixed issue where git operations could freeze indefinitely (now timeout after 30 seconds)
- Improved memory usage during long-running task sequences
- Fixed Dashboard stability when switching between views during execution
- Verification command output is now visible in the Dashboard

### Added
- **Per-task timeout**: Configurable timeout (default 10 min) — stuck tasks are automatically stopped
- **Retry failed tasks**: Right-click any failed task to re-run just that one
- **Dry-run preview**: See which engines are available, what will run, and in what order before executing
- **Export results**: Save execution results as Markdown, JSON, or copy to clipboard
- **Undo task changes**: Revert code changes made by a specific task using automatic git checkpoints
- **Parallel playlists**: Run independent playlists concurrently (1–8 at a time)
- **Progress bar**: See task progress with cancellation support in the notification area
- **Resume after restart**: Paused state is saved and restored when you reopen VS Code
- **Engine version check**: Availability checks verify engines actually work, not just that the command exists

## [0.4.0] - 2026-03-09

### Dashboard Redesign

### Added
- New single-view Dashboard with pipeline overview, live output streaming, and error banners
- Create plans from a quick description, editor paste, or clipboard import
- AI generates structured playlists from detailed product specifications
- Bulk delete for tasks and playlists
- Resume/Restart picker when re-running a plan that has progress
- Dashboard auto-adjusts layout during execution to keep output and navigation visible
- Responsive design for narrow side panels

## [0.3.0] - 2026-02-27

### Added
- Continue conversations with running agent tasks (reply ability)
- Click file references in task output to open them in the editor

## [0.2.0] - 2026-02-14

### Added
- Full test suite with 100+ tests across all components
- CI/CD pipeline: lint, build, and test on Linux, Windows, and macOS
- Automated marketplace publishing via GitHub Actions
- Comprehensive README with feature documentation and configuration reference

## [0.1.0] - 2026-02-12

### Initial Release
- Plan editor with sidebar tree view for playlists and tasks
- Play / Pause / Stop controls
- Sequential task execution with live status updates
- Engine support: Claude Code, Codex, Gemini CLI, Ollama, and Custom
- Live Dashboard with output streaming and execution history
- Verification commands per task
- Configurable autoplay delay
- `.agent-plan.json` file format with auto-load on workspace open
