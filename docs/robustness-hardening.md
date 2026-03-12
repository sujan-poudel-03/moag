# Robustness & Hardening Checklist

Comprehensive audit and hardening pass performed on **2026-03-10**.
Covers critical bug fixes, error resilience, test coverage, and UX polish.

---

## Phase 1: Critical Bug Fixes

- [x] **1. Unhandled Promise Rejections**
  - **Problem:** `runner.play()`, `runner.playTask()`, and `runner.playPlaylist()` were called without `.catch()` in multiple places across `extension.ts`. A single unhandled rejection can crash the VS Code extension host.
  - **Fix:** Added `.catch()` handlers to all async runner calls in `cmdPlay()`, `cmdPlayPlaylist()`, `cmdPlayTask()`, `cmdRunPlanFile()`, and the prompt input handler. Each displays a user-facing error message.
  - **Files:** `src/extension.ts`

- [x] **2. Abort Listener Leaks in base-cli.ts**
  - **Problem:** The `abort` event listener added to `AbortSignal` in `runCli()` was never removed when the child process exited normally. Over many task executions, these leaked listeners accumulate on the signal object.
  - **Fix:** Store the abort handler reference and call `signal.removeEventListener('abort', handler)` in both the `close` and `error` event handlers.
  - **Files:** `src/adapters/base-cli.ts`

- [x] **3. Race Condition in Runner State Machine**
  - **Problem:** If `cmdPlay()` or `runner.play()` was called rapidly (e.g., double-clicking), there was a window between the state check and the `setState(Playing)` call where a second invocation could slip through, causing concurrent execution loops.
  - **Fix:** Added a `_playLock` boolean mutex. `play()` and `playTask()` check and set it atomically at entry, and clear it in `finally`. Second calls during the lock are silently ignored.
  - **Files:** `src/runner/runner.ts`

- [x] **4. Git Operation Timeouts**
  - **Problem:** `runGitCommand()` in the runner had no timeout. A large repo `git diff` or `git stash create` could hang indefinitely, blocking the entire task execution pipeline.
  - **Fix:** Added a 30-second timeout (`GIT_TIMEOUT_MS`) that kills the git process (using `taskkill /T /F` on Windows, `SIGTERM` on Unix) and resolves with `null`. Uses a `settled` flag to prevent double-resolution.
  - **Files:** `src/runner/runner.ts`

- [x] **5. Stale Dashboard Panel References**
  - **Problem:** `DashboardPanel.currentPanel` could reference a disposed webview panel if the user closed the dashboard during execution. Any `postMessage()` call on a disposed panel throws silently, losing all output.
  - **Fix:** Added a `_disposed` flag set in `dispose()`. All message posting now goes through `safePostMessage()` which checks the flag and wraps in try/catch. Applied to: `update()`, `appendOutput()`, `startTaskCard()`, `completeTaskCard()`, `clearTimeline()`.
  - **Files:** `src/ui/dashboard-panel.ts`

---

## Phase 2: Error Resilience

- [x] **6. Per-Task Timeout**
  - **Problem:** No timeout existed for individual task execution. A stuck CLI process (e.g., Ollama waiting for GPU, Claude hitting a network timeout) would block the entire playlist forever with no user feedback.
  - **Fix:** Added configurable `taskTimeoutMs` setting (default: 600,000ms / 10 minutes, minimum: 30,000ms). Implementation uses a per-task `AbortController` raced against a `setTimeout`. The parent abort signal is linked so manual stop still works. Timed-out tasks get exit code 124 (standard timeout code) and a descriptive message.
  - **Config:** `agentTaskPlayer.taskTimeoutMs`
  - **Files:** `src/runner/runner.ts`, `package.json`

- [x] **7. Graceful Abort Cleanup**
  - **Problem:** After `play()` finished (normally or via stop), the `_abortController` reference was never cleared. This stale controller could theoretically interfere with subsequent runs.
  - **Fix:** Set `_abortController = null` in the `finally` block of both `play()` and `playTask()`.
  - **Files:** `src/runner/runner.ts`

- [x] **8. Retry Individual Failed Tasks**
  - **Problem:** When a single task failed in a large playlist, the only options were to restart the entire plan or manually edit and re-run. There was no way to retry just the failed task.
  - **Fix:** Added `agentTaskPlayer.retryTask` command. It validates the task is in `Failed` state, resets it to `Pending`, runs preflight engine checks, and executes just that one task. Available in the tree view context menu for task items.
  - **Files:** `src/extension.ts`, `package.json` (command + menu entry)

- [x] **9. Verify Command Output Capture**
  - **Problem:** `runVerifyCommand()` used `stdio: 'ignore'`, meaning verification output was completely invisible. When a verify command failed, the user saw only "[Verification command failed]" with no details about what went wrong.
  - **Fix:** Changed to `stdio: ['ignore', 'pipe', 'pipe']`, capturing both stdout and stderr. Output is emitted to the dashboard via `task-output` event. On failure, the captured output is appended to the task's stderr. Also added a timeout kill using `taskkill` on Windows. The verify header `"── Verify: <command> ──"` is emitted before output starts.
  - **Files:** `src/runner/runner.ts`

---

## Phase 3: Test Coverage

- [x] **10. Fix Pre-existing Test Failures (5 tests)**
  - **Problem:** After switching all adapters to stdin piping (`useStdin: true`) in a previous session, 5 adapter tests still asserted that the prompt appeared as a CLI argument.
  - **Fix:** Updated all affected tests to assert `useStdin === true` and that the prompt is NOT in the args array:
    - `adapter-args.test.ts`: CodexAdapter, ClaudeAdapter, OllamaAdapter (3 tests)
    - `task-execution.test.ts`: Codex and Claude arg building (2 tests)
  - **Files:** `src/test/unit/adapters/adapter-args.test.ts`, `src/test/unit/adapters/task-execution.test.ts`

- [x] **11. New Runner State Machine Tests (6 tests)**
  - Added test: **Skip completed tasks on resume** - verifies only pending tasks execute when resuming
  - Added test: **Prevent concurrent play() via mutex** - confirms second `play()` is blocked
  - Added test: **Clean up abort controller after play** - verifies `_abortController` is null after completion
  - Added test: **Return to Idle after stop from pause** - tests Paused→Stopping→Idle transition
  - Added test: **Block playTask when runner is busy** - confirms guard works
  - Updated mock to include `execSync` stub (needed for git timeout kill)
  - **Files:** `src/test/unit/runner/runner.test.ts`

- [x] **12. Extension Deactivate Cleanup**
  - **Problem:** `deactivate()` only called `runner.stop()` but didn't dispose the file watcher, leaving it listening after the extension deactivated.
  - **Fix:** Added `planFileWatcher.dispose()` and null assignment in `deactivate()`.
  - **Files:** `src/extension.ts`

---

## Phase 4: UX Polish

- [x] **13. Engine Availability Probing**
  - **Problem:** Engine availability checks only verified `commandExists()` in PATH. A command could exist but be broken (wrong version, missing runtime, corrupt binary).
  - **Fix:** Added `probeVersion()` in `engine.ts` — runs `--version` with a 5s timeout after PATH check. Version string is stored in `EngineAvailability.version`. Used by dry-run to show detected engine versions.
  - **Files:** `src/adapters/engine.ts`

- [x] **14. Progress Notifications with Cancellation**
  - **Problem:** During long-running plan execution, there was no persistent progress indicator or way to cancel from the notification area.
  - **Fix:** Added `startProgressNotification()` / `updateProgressNotification()` / `endProgressNotification()` using `vscode.window.withProgress`. Shows current task name with pass/fail counts. Cancellation button triggers `runner.stop()`.
  - **Files:** `src/extension.ts`

- [x] **15. Pause State Persistence**
  - **Problem:** If VS Code restarted while a plan was paused, all pause state was lost. Tasks that had completed were re-run.
  - **Fix:** Save `PersistentPauseState` (task statuses + plan path) to workspace state on pause/stop. On activation, restore task statuses after auto-loading the plan. Cleared on `all-completed`.
  - **Files:** `src/extension.ts`

- [x] **16. Dashboard: View Task Output & Retry**
  - **Problem:** Dashboard webview had no way to view full task output or retry a failed task.
  - **Fix:** Added `viewTaskOutput` message handler that opens full output as a Markdown document. Added `retryTask` handler that invokes the `agentTaskPlayer.retryTask` command from the dashboard.
  - **Files:** `src/ui/dashboard-panel.ts`

- [x] **17. Dry-Run Preview**
  - **Problem:** No way to preview what a plan execution would do before running it — which engines, which tasks, what prompts.
  - **Fix:** Added `agentTaskPlayer.dryRun` command. Generates a Markdown document showing engine availability (with version), execution plan table (playlist → task → engine → verify), full task prompts, and relevant settings (timeout, parallel playlists).
  - **Files:** `src/extension.ts`, `package.json`

- [x] **18. Export Execution Results**
  - **Problem:** After plan execution, results existed only in the history store with no way to share or archive them.
  - **Fix:** Added `agentTaskPlayer.exportResults` command with 3 format options: Markdown file, JSON file, clipboard. Includes summary stats, per-task results table, failed task details, and changed files list.
  - **Files:** `src/extension.ts`, `package.json`

---

## Phase 5: Advanced Features

- [x] **19. Parallel Playlist Execution**
  - **Problem:** Playlists always ran sequentially, even when independent playlists could safely run in parallel.
  - **Fix:** Added `parallelPlaylists` setting (1–8, default 1). When > 1, `runPlaylistsConcurrently()` uses a concurrency limiter pattern with a running counter and recursive `startNext()` callback. Respects stop signals.
  - **Files:** `src/runner/runner.ts`, `package.json`

- [x] **20. Undo Task Changes with Git Checkpoints**
  - **Problem:** No way to revert changes made by a specific task. If an AI agent made unwanted edits, the user had to manually figure out what changed and revert.
  - **Fix:** Before each task executes, `captureGitRef()` creates a non-destructive git ref (`git stash create` or HEAD). The ref is stored in `_taskGitRefs` map. `agentTaskPlayer.undoTask` command lets users pick a task and runs `git checkout <ref> -- .` with a confirmation dialog.
  - **Files:** `src/runner/runner.ts`, `src/extension.ts`, `package.json`

---

## Test Results

```
185 passing (38s)
5 pending (intentionally skipped)
0 failing
```

All tests pass on Windows 11. Zero regressions from the hardening changes.

---

## Files Changed Summary

| File | Changes |
|------|---------|
| `src/runner/runner.ts` | Play mutex, task timeout, git timeout, verify output, abort cleanup, parallel playlists, git checkpoint capture |
| `src/adapters/base-cli.ts` | Abort listener cleanup on process exit |
| `src/adapters/engine.ts` | Version probing with `--version`, `EngineAvailability.version` field |
| `src/ui/dashboard-panel.ts` | `_disposed` flag, `safePostMessage()` wrapper, viewTaskOutput & retryTask handlers |
| `src/extension.ts` | `.catch()` on all runner calls, `retryTask`, `dryRun`, `exportResults`, `undoTask` commands, progress notifications, pause persistence, deactivate cleanup |
| `package.json` | `taskTimeoutMs`, `parallelPlaylists` settings; `retryTask`, `exportResults`, `dryRun`, `undoTask` commands + context menus |
| `src/test/unit/runner/runner.test.ts` | 6 new state machine tests |
| `src/test/unit/adapters/adapter-args.test.ts` | 3 tests fixed for stdin piping |
| `src/test/unit/adapters/task-execution.test.ts` | 2 tests fixed for stdin piping |
