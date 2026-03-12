# Changelog

## [0.6.0] - 2026-03-12

### Execution Contracts Release

### Added
- Task contracts in the plan schema: `type`, `command`, `acceptanceCriteria`, `expectedArtifacts`, `ownerNote`, `failurePolicy`, `env`, `port`, `readyPattern`, `healthCheckUrl`, and `startupTimeoutMs`
- New task execution modes: `agent`, `command`, `service`, and `check`
- Background service orchestration with readiness detection from log patterns, port checks, or health URLs
- Verification evidence and artifact evidence persisted in history entries and export reports
- PM Summary section in the dashboard with phase, progress, failures, running task, changed files, and active services
- Built-in command/service templates for local automation flows
- New `blocked` task status for review-oriented failure handling

### Changed
- The runner now executes local shell commands and services directly instead of routing everything through agent engines
- Agent prompts now include execution contract details so acceptance criteria and artifacts are visible during generation
- The dashboard now shows task contracts, verification outcomes, artifact checks, task types, and service state
- Dry-run and export reports now include task types, command runtime details, artifacts, and blocked status
- Retry now supports both failed and blocked tasks

### Fixed
- Non-agent tasks no longer trigger engine preflight checks
- Context summaries now label blocked tasks correctly
- History tree and execution detail views now display blocked runs cleanly
- Dashboard runtime is validated again after the new inline contract/reporting changes
- Targeted runner/model/history tests now cover command tasks, blocked failure policy, artifact failure, and ready service tasks

## [0.5.0] - 2026-03-10

### Robustness & Hardening Release

Full audit and hardening pass across the entire codebase. See [docs/robustness-hardening.md](docs/robustness-hardening.md) for the detailed checklist.

### Fixed
- **Race condition in runner**: Added play lock mutex to prevent concurrent `play()` calls from corrupting state
- **Unhandled promise rejections**: All async `runner.play()`, `playTask()`, `playPlaylist()` calls now have `.catch()` handlers — prevents extension host crashes
- **Git operation hangs**: Added 30-second timeout to all git commands (`stash create`, `diff`, `rev-parse`) with platform-aware process kill
- **Abort listener memory leaks**: `base-cli.ts` now removes the abort event listener when the child process exits, preventing accumulation across task runs
- **Stale dashboard panel crashes**: All webview message posting goes through `safePostMessage()` which no-ops if the panel was disposed during execution
- **Verify command silent failures**: Verification commands now capture and stream stdout/stderr to the dashboard, and include output in failure messages
- **5 pre-existing test failures**: Updated adapter tests to match stdin piping behavior (prompt not in CLI args)
- **File watcher leak on deactivate**: `planFileWatcher` is now properly disposed when the extension deactivates

### Added
- **Per-task timeout**: Configurable via `agentTaskPlayer.taskTimeoutMs` (default 10 min). Stuck tasks are killed and marked failed with exit code 124
- **Retry failed tasks**: New `retryTask` command — right-click a failed task in the tree view to re-run just that task without restarting the entire plan
- **Dry-run preview**: New `dryRun` command — generates a Markdown preview showing engine availability (with version), execution plan table, task prompts, and settings
- **Export results**: New `exportResults` command — export execution results as Markdown, JSON, or clipboard with summary stats, per-task results, and changed files
- **Undo task changes**: New `undoTask` command — revert changes made by a specific task using git checkpoints captured before each task runs
- **Parallel playlist execution**: New `parallelPlaylists` setting (1–8) — run independent playlists concurrently with configurable concurrency limit
- **Progress notifications**: Persistent notification bar with task progress counts and cancellation support during plan execution
- **Pause state persistence**: Task statuses are saved to workspace state on pause/stop and restored on VS Code restart
- **Engine version probing**: Availability checks now run `--version` to verify engines actually work, version displayed in dry-run
- **Dashboard view/retry**: Dashboard webview can now open full task output and retry failed tasks directly
- **6 new runner tests**: Resume skip, mutex prevention, abort cleanup, stop-from-pause, play-while-busy guard
- **Robustness documentation**: `docs/robustness-hardening.md` — full checklist of all 20 fixes with problem/fix/files for each

### Changed
- Verify commands now use `stdio: pipe` instead of `ignore`, with a "Verify" header emitted before output
- Abort controller is nulled after play finishes (prevents stale references)
- `child_process.execSync` imported in runner for Windows process tree kill on git timeout

## [0.4.0] - 2026-03-09

### Added
- Dashboard redesign: single-view command center with pipeline overview, live output, error banners
- Multi-input plan creation: quick description, editor paste, clipboard import
- Large spec support: AI generates 4-12 playlists from detailed product specifications
- Bulk delete command for tasks and playlists
- Clear all tasks / clear entire plan commands
- Play button guard: Resume/Restart picker when progress exists
- Execution mode: dashboard hides non-essential sections during task execution
- Responsive CSS: @media queries for narrow panels (<300px, <420px, >600px)
- Stdin piping for all CLI adapters (avoids Windows 8K command-line length limit)
- Improved error messages in plan loader with file-specific validation

## [0.2.0] - 2026-02-14

### Added
- ESLint configuration with `@typescript-eslint` recommended rules
- Unit test suite (Mocha + Sinon) covering models, utils, adapters, history store, and runner
- Integration tests verifying extension activation and command registration
- CI/CD via GitHub Actions (lint, build, test on ubuntu/windows/macos)
- Publish workflow triggered by version tags
- Test infrastructure: `tsconfig.test.json`, `.vscode-test.mjs`, VS Code test debug launch config
- Marketplace-ready README with badges, detailed feature docs, and configuration reference

### Changed
- Updated `package.json` with test dependencies, scripts, gallery banner, and badges
- Enhanced `.vscodeignore` to exclude test and config files from packaged extension
- Added `Extension Tests` debug configuration to `.vscode/launch.json`
- Added eslint-disable comments for intentional non-null assertions in `runner.ts` and `history-tree.ts`

### Removed
- `vsc-extension-quickstart.md` (scaffolding file)
- `agent-task-player-0.1.0.vsix` (build artifact should not be in version control)

## [0.1.0] - 2026-02-12

### Added
- Plan editor with TreeView sidebar for playlists and tasks
- Play / Pause / Stop controls with state machine
- Sequential task runner using `child_process.spawn()`
- Engine adapters: Claude Code, Codex, Gemini CLI, Ollama, Custom
- Webview dashboard with Plan, Output, and History tabs
- Execution history stored via VS Code workspace state
- Live status icons in the tree view (pending, running, completed, failed)
- Optional verification commands per task
- Configurable autoplay delay between tasks
- `.agent-plan.json` file format for defining plans
- Auto-load plan files from workspace on activation
