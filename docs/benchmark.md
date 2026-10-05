# MOAG benchmark (`moag bench`)

`moag bench` measures how far MOAG gets on its own, and what it costs, when a team uses the hosted server the way it is meant to be used.

It starts the **real** hosted server, drives it **only over HTTP** the way a browser would (cookies, CSRF tokens, Server-Sent Events), and walks a scenario's PRD versions through the full flow: save PRD → plan → review → run → ship gate → trace.

- The bench plays every human role automatically.
- It **records** every point where a human had to decide something, so autonomy is measured honestly rather than assumed.

There are two modes:

- `--dry-run` swaps the engine for a fake `claude` and spends nothing. It proves the harness, not MOAG's agents.
- A **paid** run uses the real Claude Code CLI and needs `--max-usd`.

Only one bench may run at a time on a machine.

## What the bench drives

### Users and roles

The bench creates four users, each with its own session:

| User | Role | Does |
|---|---|---|
| `bench-admin` | admin | Bootstraps the server, creates the other users, reads the engine probe |
| `bench-po` | product-owner | Creates the project, sets the per-version budget, saves each PRD version, overrides a bump, requests plans |
| `bench-reviewer` | reviewer | Approves (or rejects) each generated plan, starts and stops runs |
| `bench-approver` | approver | Approves or rejects each ship gate |

Each non-admin user gets a random temporary password, signs in, and is forced to change it, exactly as a new team member would.

These setup steps are logged as `setup`. They are **not** counted as interventions.

### The HTTP sequence

Setup:

1. `GET /api/session` gets the pre-auth cookie and token, then `POST /api/bootstrap` creates the admin, then `POST /api/login`.
2. The bench waits until `GET /api/admin/engines` shows a finished probe, then checks the engine (see [Zero-spend guarantees](#zero-spend-guarantees)).
3. `POST /api/admin/users` creates three users. Each one signs in (`POST /api/login`) and sets a new password (`POST /api/me/password`).
4. The product owner calls `POST /api/projects` with source `{kind: "path"}` (the prepared workspace), the scenario's stack, and its engine.
5. The admin opens `GET /api/projects/:id/events` (SSE). Every `job-event` is logged; `cost` events also feed the budget watchdog.

Then, for each PRD version:

1. The product owner sets the version's cap: `PATCH /api/projects/:id {versionBudgetUsd}`.
2. The product owner reads `GET /api/projects/:id/prd`, then saves the version: `POST …/prd/versions {text, baseCreatedAt}`.
3. From v2 on, if the server's `recommendedBump` differs from the scenario's intended bump, the product owner overrides it: `POST …/prd/versions/latest/bump`. This is an **unplanned** intervention.
4. From v2 on, if `deltaScope` is null, there is nothing to plan and the version's outcome is `no-delta`.
5. The product owner requests a plan: `POST …/plans {mode: initial | delta}`. The bench polls `GET /api/projects/:id` until the plan stops `generating`.
6. The reviewer approves the plan with its `contentHash` (**required**), or rejects it (**unplanned** `plan-rejected`, the reason names every offending item) when the bench may not approve it unread: the server says it cannot be approved, the playlist is `parallel` (every budget guard assumes one engine call in flight), it has a `release` or `deploy` task, or its review lists any `command`/`verifyCommand` that is not exactly one of the scenario's `gateCommands` or `dryRun.planCommand`, or any `cwd` or side-effect field. Then the reviewer starts the run: `POST …/runs`.
7. The bench polls the run. At every `awaiting-approval` halt:
   - It records `ship-approval` (**required**) when the halted gate is the server's own `Ship approval`, and `generated-manual-gate` (**unplanned**) for any other manual gate.
   - It runs the scenario's acceptance gates in the workspace.
   - Green: the approver calls `POST …/gate/approve`. A `409 project-locked` is retried every 5 s for up to 6 minutes and recorded as `lock-wait`. The bench **never** force-releases a lock.
   - Red: the approver calls `POST …/gate/reject` with the failing commands as the note (`gate-rejected`, **unplanned**).
8. When the run ends, the bench reads the run detail and `GET /api/projects/:id/trace`.

After the last version, the bench closes the SSE stream, stops the server (`app.jobs.stopAll()`, then close), and writes `summary.json`.

## Scenario files

A scenario is a JSON file. Relative paths resolve against the scenario's directory. The template, PRDs and fixtures must stay inside it.

| Field | Meaning |
|---|---|
| `name`, `description` | Shown in the summary. |
| `repo` | `{"kind":"template","templateDir":"template"}`: the folder is copied into a fresh directory, then `git init -b main` and one commit. `{"kind":"clone","path":"../../..","ref":"<branch>"}`: `git clone --no-hardlinks --branch <ref> --single-branch` into a fresh directory, then `git remote remove origin` so no push or tag push from the workspace can reach the source. The destination may never be, contain, or sit inside the clone source, so the live working tree is never used. Only **committed** work at that ref is cloned. |
| `setupCommands` | Shell commands run in the new workspace before anything else (for example `npm ci`). A failure stops the bench. |
| `stack`, `engine` | The project's stack and engine. `custom` and `copilot` are refused, as the server refuses them. |
| `budgetUsd` | Total budget, greater than 0 and at most 100. A paid run's cap is `min(--max-usd, budgetUsd)`. |
| `perCallCapUsd` | Most one engine call may cost. It is passed to Claude as `--max-budget-usd` (through `MOAG_MAX_USD_PER_ENGINE_CALL`) and used as the cost of every call that reports none. Greater than 0 and at most `budgetUsd`. |
| `minVersionUsd` | Default 1. A version whose cap would be lower is `not run (budget)`. |
| `reserveFactor` | Default 1.5. How many per-call caps are held back from each version's cap, because a call can overshoot its cap by about one turn. |
| `versionTimeoutMin` | Default 60. Covers plan generation plus every run segment of one version. |
| `passEnv` | Variable names passed to agents (`MOAG_RUN_ENV_PASSTHROUGH`). `CI` and `MOAG_*` are refused. |
| `gateCommands` | The bench's **acceptance gates**: at least one. |
| `gateTimeoutMs` | Default 600000, per gate command. |
| `versions[]` | `{id, prdFile, intendedBump, dryRunFixture?}`. The first version's bump must be `initial`, and only the first may be. Later versions use `patch`, `minor` or `major`. |
| `dryRun.planCommand` | Dry-run only: the test command the fake planner puts in every plan. |

Tag every requirement line explicitly (`- [R-3] …`). An untagged line whose wording changes gets a new id, which counts as a removal and makes the bump `major`.

### The two scenarios in `bench/scenarios/`

**`greenfield-todo`** ($10):

- A Node + TypeScript command-line todo app, built from an empty repository.
- The bench's acceptance gate is `npm test`.
- Versions:
  - v1 `initial`: add, list, complete, JSON persistence, tests.
  - v2 intended `patch`: Overview reworded, R-2 clarified, and a bugfix in R-3.
  - v3 `minor`: due dates and an overdue filter.

**`brownfield-moag`** ($5):

- A fresh clone of this repository at the HEAD of `feat/sdlc-automation`, followed by `npm ci`.
- One small PRD: a `formatUsd` helper and its mocha test file.
- The bench's acceptance gates are `npm run compile` and that one mocha file.

## Two gate notions: never merged

- **Bench acceptance gates** are the scenario's `gateCommands`. The bench runs them in the workspace at each ship-gate halt, as a careful approver would, and approves only when they are green. They are reported as `gateFirstRunPass`.
- **MOAG's own verify gates** run inside the worker after an approved gate. The server never reads the repository's `.moag/config.json`, so these are **auto-detected** from `package.json`:
  - greenfield: `npm test`;
  - brownfield: `npm run lint` and the **full** unit suite (`npm test`). **Run brownfield on Node 20** (the version `.nvmrc` and CI pin). On Node 22.6 or later, Node loads the suite's `.ts` files as ES modules. Neither `--no-experimental-strip-types` nor `--no-experimental-detect-module` fixes `npm test` when passed through `NODE_OPTIONS`: only direct `node` flags do, and `npm test` cannot take them. On Node 24.16 the brownfield dry-run therefore ends `run-gaps`, with `moagVerify.failedGate: "command"` (`npm test` exits 1 in about 2 s with `require is not defined in ES module scope`), while the bench's own single-file gate passes.
  
  These are reported as `moagVerify`.

The two can disagree, and both are reported. A brownfield version that MOAG refuses to ship because its own lint or full suite failed is a valid finding, not a harness failure.

## Metrics

There is one entry per PRD version in `summary.json` → `versions[]`.

| Field | Definition |
|---|---|
| `intendedBump` / `recommendedBump` / `bumpMatch` | From the scenario / from the PRD save response. `bumpMatch` is null for the first version. |
| `bumpOverridden` | The bench applied the intended bump through the override route. |
| `requirementsAdded` / `requirementsChanged` / `requirementIds` | From the save response's diff. For v1, every requirement counts as added. |
| `tasksGenerated` | Tasks in the generated playlist, not counting the server's ship gate. |
| `tasksCompleted` / `tasksFailed` / `tasksBlocked` / `tasksSkipped` | From the final run detail, ship gate excluded. |
| `gateFirstRunPass` | The bench acceptance gates at the first ship-gate halt, with per-command exit codes. Null if no halt was reached. |
| `moagVerify` | The last `verify-finished` event: `passed` and `failedGate`. |
| `fixIterations` | Sum of `verify-finished.iterations`. See [Why fix iterations are mostly invisible](#why-fix-iterations-are-mostly-invisible). |
| `taskRestarts` | **Proxy** for retries and auto-fix: extra `task-started` events for a task id that already started. |
| `wallClockMs` | From the PRD save to the poll that saw the run `completed` with every one of this version's ids `shipped`. Null otherwise. |
| `endState` | How the version ended when it did not ship: `run-gaps`, `run-ship-rejected`, `plan-parse-failed`, `timeout`, `no-delta`, and so on. |
| `costUsd` | A number only when **every** engine call of the version reported its own cost. One estimated or unreported call makes it `"unknown"`. Nothing is ever silently estimated. |
| `reportedUsd`, `reportedCalls`, `estimatedCalls`, `unreportedCalls`, `upperBoundUsd` | The breakdown behind `costUsd`. `upperBoundUsd` = reported + estimated + `unreportedCalls × perCallCapUsd`. |
| `costPerRequirementShippedUsd` | `costUsd` ÷ requirements shipped this version. `"unknown"` when the cost is, null when nothing shipped. |
| `requirementsShipped` | This version's ids whose trace status is `shipped`. |
| `interventions.required[]` | `plan-approval`, `ship-approval`: what every version needs from people by design. |
| `interventions.unplanned[]` | `bump-override`, `plan-<status>` (for example `plan-parse-failed`, `plan-engine-failed`, `plan-project-locked`), `plan-rejected`, `gate-rejected`, `generated-manual-gate`, `task-escalate`, `lock-wait`, `timeout`, `budget-halt`, `run-error`. |
| `trace` | `{"R-n": status}` for this version's ids, from `GET /trace`. |
| `outcome` | `shipped`, `partially-shipped`, `not-shipped`, `no-delta`, `plan-failed`, `not run (budget)` or `error`. |
| `serverSpentUsd`, `notes` | What the server recorded for the version (for reconciliation with the SSE cost events), and anything odd. |

The summary also has `totals`, the `budget` ledger snapshot, the engine's version, `stoppedForBudget`, `aborted` and `harnessError`.

### Why v2 of the greenfield scenario is expected to mismatch

MOAG recommends `minor` for **any** changed requirement line (`recommendBump` in `src/models/requirements.ts`). It recommends `patch` only for edits outside the requirement list, and then there is no delta scope and nothing to plan.

Greenfield v2 rewords R-2 and bug-fixes R-3, which the scenario author intends as a patch. So v2 will show:

- `recommendedBump: "minor"`, `bumpMatch: false`;
- an unplanned `bump-override`.

This is by design and **not a regression**. It is the finding: deciding that a requirement edit is "only a fix" is a human call today.

### Why fix iterations are mostly invisible

- The server's verify never passes `--fix`.
- The runner's auto-fix retries emit no event of their own.

`fixIterations` therefore counts only verify iterations, and `taskRestarts` is reported alongside as a labelled proxy.

## Dry-run vs paid

### Dry-run

- The bench writes a fake `claude` (`claude.cmd` on Windows, an sh script elsewhere) into `<out>/fake-bin`.
- The server's PATH starts with that directory, and **every directory that holds a real `claude` is removed** from it. The real CLI cannot be reached from the server or its workers.
- Everything else is real: the server, the workers, the runner, `ClaudeAdapter`, `runCli`, plan parsing, verify, and the ship stamp.
- The fake plans one task per requirement plus the scenario's test command. It returns a passing verdict to verify. For every task, it copies the version's `dry-run/vN` fixture into the workspace.
- The fixtures are **stand-ins** that prove the harness, offline. The greenfield fixtures are plain JavaScript with `node:test`, not the TypeScript app the PRD asks for.

### Zero-spend guarantees

1. **Before any plan request**, the bench resolves `claude --version` through a shell with the server's PATH, exactly as runs resolve it.
   - A dry-run requires the fake's marker (`moag-bench-fake`).
   - If the server's own probe reports a version, that must be the fake too.
   - Otherwise the bench stops (exit 2) without planning anything.
   - Windows note: the server's probe runs the CLI without a shell, and Node will not run a `.cmd` that way. On Windows the probe therefore reports no version for the fake, and the shell check is what proves the fake is in place.
2. A **paid** run refuses to start if it sees the marker.
3. At the end of a dry-run, `fake-bin/calls.jsonl` must exist and be non-empty, or the bench exits 2.

### Commands

Run a dry-run with Git Bash. On Node 22.6 or later, the `NODE_OPTIONS` line is needed for the brownfield acceptance gate; see the note above about MOAG's own full-suite gate:

```bash
npm run compile
export NODE_OPTIONS=--no-experimental-strip-types
node out/headless/cli.js bench bench/scenarios/greenfield-todo/scenario.json --dry-run --out <dir>/greenfield
node out/headless/cli.js bench bench/scenarios/brownfield-moag/scenario.json --dry-run --out <dir>/brownfield
```

Exit codes:

- `0`: the harness completed, whatever the product outcome.
- `4`: stopped for budget.
- `2`: a harness or usage error, including Ctrl+C.

`--out` must be empty or missing. Keep it short on Windows: `MAX_PATH` applies to the workspace and its `node_modules`.

If the brownfield `npm ci` setup fails with `ETIMEDOUT` (and npm's "Exit handler never called!") while `curl https://registry.npmjs.org` works, the machine probably has no working IPv6 route. Node 24's network-family autoselection then times out before it falls back to IPv4. Add `--no-network-family-autoselection` to `NODE_OPTIONS` for that run.

## The paid run (human only, total ≤ $15)

### How cost is measured

- The only cost figure is Claude's own `total_cost_usd`. Every server job runs `claude -p --output-format json`, and the figure travels adapter (`costSource: "reported"`) → cost ledger → worker `cost` event → SSE → bench.
- A call that reports no figure (killed, timed out, unparsable output) is still counted, as `source: "none"`. It makes its version's `costUsd` `"unknown"` and adds `perCallCapUsd` to the upper bound.
- If the CLI is signed in with a Claude **subscription** rather than an API key, `total_cost_usd` is a notional figure, not what is billed.

### How the cap is enforced

There are four layers:

1. **Engine:** every Claude call gets `--max-budget-usd` = min(remaining version cap, `perCallCapUsd`).
2. **Server:** the bench sets the project's `versionBudgetUsd` before each version. That becomes the runner's cost ceiling and stops the run with `budget-exceeded`.
3. **Bench, between versions:** the next version's cap is `cap − upperBound − reserveFactor × perCallCapUsd`. Below `minVersionUsd`, that version and every later one are `not run (budget)`.
4. **Bench watchdog:** on every SSE `cost` event, if `upperBound + perCallCapUsd > cap`, the reviewer stops the run (or the product owner cancels the generating plan) and the bench exits 4.

Caveat: `--max-budget-usd` can overshoot by one turn, which is why the reserve is 1.5 per-call caps. Generated `parallel` playlists are rejected before approval, so at most one engine call is in flight.

### Steps (Windows PowerShell)

1. Prepare. The brownfield scenario clones the HEAD of `feat/sdlc-automation`, so uncommitted work is not part of it:

   ```powershell
   cd D:\Projects\moag
   git status
   npm ci; npm run compile
   $env:NODE_OPTIONS = "--no-experimental-strip-types"   # only needed on Node 22.6+; prefer Node 20 (nvm use) for brownfield
   ```

2. Check `claude --version`. It must be 2.1.287 or later. Find out whether `claude` is billed through the API (Console) or a subscription.
3. Run a smoke test. It costs at most $0.05, counted toward the $15:

   ```powershell
   "Reply with OK" | claude -p --output-format json --max-budget-usd 0.05 --tools ""
   ```

   The JSON must have `total_cost_usd` and `"is_error": false`. If `total_cost_usd` is missing, **stop**: the cost cap cannot work.
4. Both dry-runs must have completed.
5. Run greenfield (cap $10):

   ```powershell
   node out\headless\cli.js bench bench\scenarios\greenfield-todo\scenario.json --max-usd 10 --out D:\moag-bench\greenfield-2026-10-xx
   ```

6. Read `budget.upperBoundUsd` from that run's `summary.json`. The brownfield cap is `min(5, 15 − smokeCost − greenfieldUpperBound)`, which is at most $4.95:

   ```powershell
   node out\headless\cli.js bench bench\scenarios\brownfield-moag\scenario.json --max-usd 4.95 --out D:\moag-bench\brownfield-2026-10-xx
   ```

7. If billed through the API, cross-check the day's usage on the Anthropic Console.

### Aborting

- Press **Ctrl+C once**. The bench stops the active run through the API, stops every job (`stopAll`), closes the server and writes `summary.json` with `"aborted": true`.
- If it hangs, list the processes and kill each one:

  ```powershell
  Get-Process claude,node | Format-Table Id,ProcessName,Path
  taskkill /T /F /PID <id>
  ```

- **Always** check `Get-Process claude` afterwards. Workers are detached, and an orphaned `claude` keeps spending.

## Output layout

```
<out>/
  events.jsonl        every HTTP call (credentials redacted), SSE event and gate run; capped at 50 MB
  summary.json        per-version metrics, totals, budget ledger, engine version, harness error
  server-data/        the bench server's data dir (users, audit.jsonl, projects/<id>/runs/…)
  workspaces/bench-ws the scenario's repository after the run
  fake-bin/           dry-run only: claude shims, fake-state.json, calls.jsonl (one line per fake call)
```
