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

**Node version.** CI pins Node 20 and `.nvmrc` matches it. On Node 22.6+ the runtime
strips TypeScript natively and loads `.ts` as ESM, which breaks `ts-node/register`
with `require is not defined in ES module scope`. If you are on a newer Node, either
`nvm use` or prefix test commands with `NODE_OPTIONS=--no-experimental-strip-types`.
That flag does not exist on Node 20, so it must not go into the npm scripts.

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

**Runner** (`src/runner/runner.ts`): State machine Idle→Playing→Paused→Stopping→Idle. Has `_playLock` mutex preventing concurrent `play()` calls. Git operations use a 30 s timeout. Per-task timeout is configurable via `agentTaskPlayer.taskTimeoutMs` (default 1800000 ms = 30 min, per `package.json`; profile timeouts are fast=10 min, balanced=30 min, quality=45 min).

**PRD verification loop** (`src/runner/prd-loop.ts` + `src/runner/evidence.ts`): Both files are dependency-injected and contain **zero `vscode` imports**, so the same loop runs from the VS Code command (`cmdVerifyAgainstPrd` → `runPrdLoopInteractive`) and from `moag verify` in the headless CLI. `evidence.ts` collects only facts — the git diff since a captured base ref, the exit code of each resolved gate command, whether declared artifacts exist. `prd-loop.ts` applies four deterministic gates (task status → changed files → gate commands → artifacts) **before** any model call; a failed gate returns `passed: false` with `modelCallsMade: 0`, so a model can never override evidence. Gate commands come from `agentTaskPlayer.prdLoop.gateCommands` or auto-detection; an empty resolved list is a hard failure when unattended and a warning when interactive. Halt state (`noteManualGate`/`noteBudgetExceeded`) is per-controller closure state, never module-level, because two loops can be live at once.

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

## Development pipeline

Six subagents in `.claude/agents/` encode this project's conventions. Prefer them over ad-hoc work on anything non-trivial.

| Agent | Stage | Tools |
|---|---|---|
| `product-owner` | Scope the request — goal, primary/secondary actions, non-goals, acceptance criteria, open questions | read-only |
| `product-designer` | Only when the change is user-facing — placement, layout spec, state matrix, copy, a11y, responsive | read-only |
| `principal-architect` | Design it — approach, numbered task list with verified paths, verification order, risks | read-only + Bash |
| `senior-engineer` | Implement the task list exactly; stops rather than re-architecting | all |
| `qa-reviewer` | Adversarial verify; runs the suite itself; ends with an explicit verdict | read-only + Bash |
| `product-domain-expert` | Not in the linear chain — produces one verified context block to share across a fan-out | read-only |

**Normal feature or fix:** run `/feature <request>`, or invoke the stages sequentially yourself, feeding each stage's output verbatim into the next. Sequential is deliberate — each stage reacts to the one before it. Insert `product-designer` between scope and architecture whenever the change touches anything a user sees or clicks; skip it for pure backend work.

**Before any fan-out** (auditing many files for one defect class, sweeping components for one convention, migrating every call site): call `product-domain-expert` first and paste its brief verbatim into every agent you spawn, so the whole fan-out shares one verified view of the closed enumerations instead of each agent re-deriving them.

**Closed enumerations are closed.** `EngineId`, `TaskType`, `TaskStatus`, `RunnerState`, `FailurePolicy`, `ValidationTarget`, `ValidationProfile` (`src/models/types.ts`), `ErrorCategory` (`src/utils/error-log.ts`), the `--ds-*` tokens (`src/ui/design-system.ts`), and the `agentTaskPlayer.*` command ids and setting enums (`package.json`). Never invent a member — stop and flag it, because a new one must be handled at every site that switches on it.

**This file is orientation, not authority.** Where it disagrees with the code, the code wins — verify before relying on any statement here.
