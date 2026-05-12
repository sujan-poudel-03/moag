# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile          # TypeScript compile (tsc -p ./)
npm run watch            # Incremental compile in background
npm run lint             # ESLint over src/
npm run test             # Unit tests (excludes live/credit tests)
npm run test:live        # Live tests that call real AI APIs
npm run test:integration # VS Code integration tests (requires display)
npm run deploy           # Compile + install VSIX into local VS Code
npm run deploy:watch     # deploy + watch for changes

# Run a single test file
npx mocha --require ts-node/register "src/test/unit/runner/runner.test.ts"
```

## Architecture

**VS Code extension** that orchestrates AI coding agents (Claude Code, Codex, Gemini CLI, Ollama) running task playlists. Compiled to `out/` (CommonJS ES2022). Activates on custom view show or workspace `.moag/plan.json`.

### Data flow

```
Plan JSON  →  Runner (state machine)  →  Adapter (per engine)  →  CLI subprocess
                   ↓                              ↓
            Context Builder              stdin pipe (avoids 8K Windows cmd limit)
                   ↓
         [AI Rules → Plan context → Prior outputs → Files → Task prompt → Contract]
```

**Plan model** (`src/models/types.ts`): `Plan` contains `Playlist[]`, each has `Task[]`. Tasks have `status: TaskStatus` (Pending/Running/Paused/Completed/Failed/Skipped/Blocked) persisted to the plan JSON via `dehydrateTask`/`hydrateTask`.

**Runner** (`src/runner/runner.ts`): State machine Idle→Playing→Paused→Stopping→Idle. Has `_playLock` mutex preventing concurrent `play()` calls. Git operations use a 30 s timeout. Per-task timeout is configurable via `agentTaskPlayer.taskTimeoutMs` (default 10 min).

**Adapters** (`src/adapters/`): One per engine, all use `useStdin: true` to pipe prompts. `BaseCliAdapter` handles spawn, abort, output streaming, and `--version` probing.

**Context builder** (`src/context/context-builder.ts`): Assembles the final prompt in priority-ordered sections. AI Rules are inserted at priority `-1` (highest), before plan overview, prior outputs, changed files, retrieved code spans, and screenshots.

**AI Rules** (`src/ai-rules/`): Three-tier injection — global (`<globalStorage>/ai-rules.json`), workspace (`.moag/rules.json`), VS Code setting (`agentTaskPlayer.promptRules`). `AiRulesStore.getEnabledText(cwd)` returns the merged markdown block injected into every task.

**Dashboard** (`src/ui/dashboard-panel.ts`): Webview with live output streaming. Uses `safePostMessage()` to handle disposed panels. Collapsible sections persist within session. Auto-opens on any execution command.

**Prompt input view** (`src/ui/prompt-input-view.ts`): Sidebar webview (PROMPT/PLAN/HISTORY tabs). Renders playlist and task rows, plan progress, queue, and inline task editing. All rendering is done in the webview JS (`renderPlanGroups`, `renderTasks`).

**Extension entry** (`src/extension.ts`, ~1800 lines): Registers all commands, wires runner events to tree views and dashboard, manages sandbox/screenshot lifecycle.

### Testing conventions

- Tests use `proxyquire` for module-level dependency mocking and `sinon` for stubs/spies.
- The mock VS Code module is at `src/test/unit/mocks/vscode.ts` — extend it when new VS Code APIs are needed.
- `child_process` mocks must stub both `spawn` **and** `execSync`.
- Tests that call real CLIs or spawn processes are marked `.live.test.ts` and excluded from `npm test`.
- Spawn-dependent tests skip gracefully on `EPERM` (common in restricted CI environments).

### Key conventions

- All CLI adapters pipe via stdin — never pass long prompts as CLI arguments.
- `saveAndRefresh()` is called after task-completed and task-failed to persist status to the plan file.
- `cmdPlayPlaylist` only resets the target playlist, not the whole plan. All play commands show a Resume/Restart picker when prior progress exists.
- Primary toolbar actions (Play, Stop, Dashboard) live in the `navigation` group so they're always visible.
- Dashboard must auto-open on every execution entry point.
