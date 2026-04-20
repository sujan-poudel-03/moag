# Changelog

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
- Prompt Rules — auto-injects best practices and constraints into every prompt
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
