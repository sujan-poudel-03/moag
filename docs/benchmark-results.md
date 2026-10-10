# MOAG benchmark results: first paid runs (greenfield-todo)

These are the first real-world runs of `moag bench` (see [benchmark.md](benchmark.md) for the harness and the metric definitions). Both runs are **partial**: neither reached a ship gate, and **no requirement shipped**. Read this as the first evidence and the first defect it found. It does not measure MOAG's throughput or quality.

Neither run wrote `summary.json`: the bench process stopped before its end-of-run step. Every figure below was derived by hand from the raw files named next to it. Anything those files cannot show is marked **not measured**.

Path abbreviations used below:

| Short | Path |
|---|---|
| `R1/` | `D:/moag-bench/greenfield/` |
| `R2/` | `D:/moag-bench/greenfield-2/` |
| `R1 proj/` | `R1/server-data/projects/e9b4d704-4984-405e-94da-082e68e5e65b/` |
| `R2 proj/` | `R2/server-data/projects/4447b879-61db-44f7-bfa8-2a802674f920/` |

## Setup

| Item | Run 1 | Run 2 | Source |
|---|---|---|---|
| Date (UTC) | 2026-10-07 10:39:44.584Z to 11:09:53.460Z (last event) | 2026-10-07 17:38:55.134Z to 17:40:38.708Z (last event) | first/last line of `R1/events.jsonl`, `R2/events.jsonl` |
| MOAG code | 9f1c7c0 (before automatic dependency installs) | 2349623 (with automatic dependency installs) | Run 1: operator note, not recorded in raw files. Run 2: `R2 proj/runs/4101fcd2-…/config.json` has `"autoInstallDependencies": true`. 2349623 was committed at 17:38:41Z, 14 s before run 2 started (`git show 2349623`). |
| Scenario | `bench/scenarios/greenfield-todo/scenario.json` (cap $10, per-call cap $1, gate `npm test`, intended bumps v1 initial / v2 patch / v3 minor) | same | `scenario.json`; `bench-start` line of each `events.jsonl` |
| Mode | paid, `capUsd: 10`, `perCallCapUsd: 1` | same | `bench-start` line |
| Engine | claude, `2.1.290 (Claude Code)` (probe and shell agree) | same | `engine-check` line |
| Workspace template commit | `42f10e8` | `8411a83` | `workspace` line (`head`) |
| Standards | profile v2 approved, blocking command `npm test` | same | `standards-approved` line |
| Machine | Windows 11 | same | operator note, not recorded in raw files |
| Node | v24.16.0 | same | operator note, not recorded in raw files (the scenario has no environment probe) |
| How it ended | bench stopped during v2, run `1d12cf48` still `running` | bench stopped during v1, run `4101fcd2` still `running` | raw files: `D:/moag-bench-greenfield*.log` end with no further lines; the 2 s `GET` polls in `R1/events.jsonl` and `R2/events.jsonl` end at 11:09:53.460Z and 17:40:38.708Z; `state.json` run status `running` |
| Why it stopped | Claude Code's low-memory reaper | same | operator note, not recorded in raw files |

The raw files show only that the bench stopped, not why. The operator attributes both stops to Claude Code's low-memory reaper (background shells are killed under memory pressure), which would not be a MOAG failure. Either way, neither run reached its end-of-run step, so both are incomplete.

## What each run did

### Run 1, v1 (initial, R-1 to R-5)

- Plan `cb3468d2` (initial): 8 tasks + ship gate. Plan call cost $0.1533. Approved and started as run `7fea023a` at 10:40:44Z.
- Tasks 1 to 6 (agent) completed. Task 7 `Compile with tsc` (command `npm run build`) failed in 0.7 s. Task 8 `Run full test suite` (`npm test`) and the ship gate were `blocked`.
- Run ended `gaps` (exit 1): `job-end` at 11:06:58.742Z. Trace: R-1 to R-5 all `not-shipped`; R-1 to R-4 `blockedBy: delta-muxz8fhi-8` (`npm test`), R-5 `blockedBy: delta-muxz8fhi-7` (`Compile with tsc`, the task that failed).

Sources: `R1/events.jsonl` (SSE `job-event`/`job-end`), `R1 proj/runs/7fea023a-430b-4472-8e44-e50642001bc6/events.jsonl` and `plan.json`, `D:/moag-bench-greenfield.log`, trace `GET` at 11:07:00.343Z in `R1/events.jsonl`.

### Run 1, v2 (rewords R-2, bug-fixes R-3)

- PRD saved at 11:07:00.357Z. Server recommended `minor`. The bench overrode to `patch` (the scenario's intended bump), giving version 1.0.1.
- Plan `dfdced4b` (delta): 4 tasks + ship gate. Plan call cost $0.0697. Run `1d12cf48` started at 11:07:42Z.
- Task 1 `Scaffold greenfield repository structure` started at 11:07:42.840Z. No further event: the bench stopped. The last logged event is a poll at 11:09:53.460Z.

Sources: `R1/events.jsonl` (`POST …/prd/versions`, `POST …/prd/versions/latest/bump`), `R1 proj/runs/1d12cf48-8845-40f6-82e3-a93d98a78222/events.jsonl` and `plan.json`.

### Run 2, v1 (initial, R-1 to R-5)

- Plan `c26fa7fc` (initial): 8 tasks + ship gate, including `Build with tsc` (`npm run build`) and `Run full test suite` (`npm test`). Plan call cost $0.1719. Run `4101fcd2` started at 17:40:02Z.
- Task 1 `Scaffold TypeScript project structure` started at 17:40:02.606Z. No further event. The last logged event is a poll at 17:40:38.708Z. The workspace's last write is `test/errors.test.ts` at 17:40:35.737Z (file mtime; the workspace root's mtime is also 17:40:35.73Z). `src/errors.ts` (17:40:29.16Z) is the second-to-last. Both are before the last poll, so no project file outside `.git` was written after the bench stopped.
- The fix shipped in 2349623 was **not exercised**: the run stopped before any command task.

Sources: `R2/events.jsonl`, `R2 proj/runs/4101fcd2-7e0d-450b-9e24-ff47d5cacca1/events.jsonl`, `plan.json` and `config.json`, `D:/moag-bench-greenfield-2.log`.

Note: the operator estimated that run 2 stopped about 5 minutes in. The raw files show 1 min 44 s from `bench-start` to the last event (103.6 s). This document uses the files.

## Metrics per version

Metric names are from [benchmark.md → Metrics](benchmark.md#metrics). Computed by hand, because no `summary.json` exists.

| Metric | Run 1 v1 | Run 1 v2 | Run 2 v1 |
|---|---|---|---|
| `intendedBump` / `recommendedBump` / `bumpMatch` | initial / none / null | patch / minor / **false** | initial / none / null |
| Requirements in scope (`requirementIds`) | 5 (R-1 to R-5, added) | 2 (R-2, R-3, changed) | 5 (R-1 to R-5, added) |
| `requirementsShipped` | 0 | 0 (trace not reached) | 0 (trace not reached) |
| `tasksGenerated` (ship gate excluded) | 8 | 4 | 8 |
| `tasksCompleted` | 6 | 0 | 0 |
| `tasksFailed` | 1 (`Compile with tsc`) | 0 | 0 |
| `tasksBlocked` | 1 (`Run full test suite`) | 0 | 0 |
| Not finished when stopped | 0 | 4 (task 1 in flight, 3 pending) | 8 (task 1 in flight, 7 pending) |
| `gateFirstRunPass` | null (no ship-gate halt reached) | null | null |
| `moagVerify` | null (no `verify-finished` event) | null | null |
| `taskRestarts` | 0 | 0 | 0 |
| `interventions.required` | `plan-approval` | `plan-approval` | `plan-approval` |
| `interventions.unplanned` | none | `bump-override` | none |
| `wallClockMs` | null (nothing shipped) | null | null |
| Elapsed, PRD save to last event (not a metric) | 1,630.6 s (27 min 11 s), save to run end | 173.1 s, save to last event before the stop | 100.7 s, save to last event before the stop |
| Engine calls | 7 (1 plan + 6 agent tasks; task 7 had `engineRan: false`) | 2 (1 plan + 1 in flight) | 2 (1 plan + 1 in flight) |
| `reportedUsd` | $2.0112 | $0.0697 | $0.1719 |
| `unreportedCalls` | 0 | 1 | 1 |
| `costUsd` | **$2.0112** | `unknown` | `unknown` |
| `upperBoundUsd` (reported + unreported × $1) | $2.0112 | $1.0697 | $1.1719 |
| `costPerRequirementShippedUsd` | n/a (nothing shipped) | n/a | n/a |
| `serverSpentUsd` | $2.0111898 | $0.0697214 | $0.1719182 |
| `outcome` / `endState` | `not-shipped` / `run-gaps` | not measured (stopped mid-run) | not measured (stopped mid-run) |

Cost sources: SSE `cost` events in `R1/events.jsonl` and `R2/events.jsonl` (all `source: "reported"`), cross-checked against `versionSpend` in `R1 proj/state.json` and `R2 proj/state.json`, which match to 7 decimal places. Run 1 v1 per-call figures: plan 0.1532582; tasks 0.290411, 0.2657832, 0.3526144, 0.2766132, 0.3767836, 0.2957262 (task 1 to 6). The run's own `view.costUsd` is 1.8579316 (tasks only).

### Totals

| Total | Value | From |
|---|---|---|
| Reported cost, both runs | **$2.2528** (2.0111898 + 0.0697214 + 0.1719182) | `versionSpend` in both `state.json`; SSE `cost` events |
| `upperBoundUsd` formula, both runs | $4.2528 (reported + 2 unreported calls × $1 per-call cap). Not a hard ceiling: it assumes the `--max-budget-usd` cap held, and excludes the documented one-turn overshoot | the above, plus the two in-flight `task-started` events with no `cost` event; formula from [benchmark.md → Metrics](benchmark.md#metrics), overshoot caveat from [benchmark.md](benchmark.md) (the `--max-budget-usd` caveat under the budget layers) |
| Engine calls | 11 (9 reported, 2 unreported) | SSE events in both `events.jsonl` |
| Requirements shipped | 0 of 12 in scope (5 + 2 + 5) | trace in `R1/events.jsonl`; no trace for the two stopped versions |
| Tasks generated / completed / failed / blocked | 20 / 6 / 1 / 1 | the three run `plan.json` files |
| Interventions required / unplanned | 3 / 1 | HTTP lines in both `events.jsonl` |

Cost after each stop is **not measured, and the raw data does not bound it**. Server workers are detached (see [Aborting](benchmark.md#aborting)), and the two in-flight `claude` calls (`taskPids` 45072 and 36140 in `R1 proj/job.lock` and `R2 proj/job.lock`) may have kept running. Each was started with `--max-budget-usd` ≤ $1, but benchmark.md documents that this cap can overshoot by one turn, so the $4.2528 above is the metric's formula, not a guaranteed ceiling.

Run 1's work appears to have continued after the bench stopped. `R1/workspaces/bench-ws/node_modules/` was **created** at 11:26:45.591Z (16 min 52 s after the last logged event at 11:09:53.460Z), which is also the workspace root's mtime, and was **last written** at 12:00:07.330Z (50 min 14 s after the last logged event), leaving it empty. Something therefore created `node_modules/` and changed its contents again long after the stop. That fits a process left running after the stop, such as the in-flight v2 task 1 call (`taskPid` 45072) or a child of it, trying to install dependencies. Which process it was is not measured. Run 2's workspace shows no write after its last poll (see above). If `claude` is billed through the API, check the day's usage on the Anthropic Console.

Sources: `stat -c %w` / `%y` and PowerShell `CreationTimeUtc` on `R1/workspaces/bench-ws/node_modules` and `R1/workspaces/bench-ws/`.

**Follow-up.** A process the agent started could outlive the worker's tree kill. On Windows every stop path is `taskkill /T`, which finds descendants by parent pid, so a descendant whose parent had already exited could not be reached, and it kept running after the worker was gone. This is fixed in commit `<hash>`: each run and plan worker is now bound to a kill-on-close job object, so everything it started ends when the worker does. See [Windows notes in server.md](server.md#windows-notes). Which process wrote `node_modules/` in run 1 is still not measured.

## The failure found in run 1

**What happened:** the agents added TypeScript to `package.json` as a devDependency. Nothing ran `npm install`. The plan's command task `npm run build` then ran `tsc`, which was not installed. The task failed, `npm test` and the ship gate were blocked, and nothing shipped.

| Evidence | Where |
|---|---|
| `package.json` declares `"typescript": "^5"`, `"@types/node": "^20"` under `devDependencies`, with `"build": "tsc"` and `"test": "npm run build && node --test dist/test/"` | `R1/workspaces/bench-ws/package.json` |
| `package.json` was written at 10:41:24Z, during task 1 `Scaffold TypeScript project structure` (10:40:44Z to 10:43:54Z) | file mtime; `task-started`/`task-completed` in `R1 proj/runs/7fea023a-…/events.jsonl` |
| No `package-lock.json`. `node_modules/` empty, created at 11:26:45.591Z and last written at 12:00:07.330Z, both after the bench stopped (see Totals) | `R1/workspaces/bench-ws/`; `stat` creation and modification times |
| `{"event":"task-failed","id":"delta-muxz8fhi-7","name":"Compile with tsc","status":"failed","engineRan":false}` at 11:06:58.193Z | `R1 proj/runs/7fea023a-430b-4472-8e44-e50642001bc6/events.jsonl` |
| `{"event":"task-error-tail","id":"delta-muxz8fhi-7","tail":"'tsc' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n"}` | same file; also an SSE line in `R1/events.jsonl` |
| Parked for a person: `"reason":"repeated-failure"`, `"lastError":"Failure category: cli-missing … 'tsc' is not recognized … > todo-cli@1.0.0 build"` | `R1/workspaces/bench-ws/.moag/queue.jsonl` |
| `delta-muxz8fhi-8` (`npm test`) and `ship-gate-cb3468d2-…` `blocked`. Trace for R-1 to R-5: `not-shipped`; R-1 to R-4 `blockedBy: "delta-muxz8fhi-8"`, R-5 `blockedBy: "delta-muxz8fhi-7"` | `R1 proj/runs/7fea023a-…/plan.json`; trace `GET` at 11:07:00.343Z in `R1/events.jsonl` |
| Run `status: "gaps"`, `exitCode: 1`, tasks 1 to 6 `completed`, 7 `failed` | `job-end` at 11:06:58.742Z in `R1/events.jsonl`; `R1 proj/state.json` |

Two more things:

- The `cli-missing` category says "ensure the engine is installed". That wording points at the engine, but the missing binary was the project's own `tsc`.
- `npm install` was on the scenario's command allow-list, but the planner did not emit it, so no plan step installed dependencies.

## The fix: 2349623

`feat(runner): install dependencies automatically before steps that need them` (2026-10-07 17:38:41Z). Main file: `src/runner/dependency-install.ts`. Documented in [server.md → Dependency installs](server.md#dependency-installs).

| What | Behaviour |
|---|---|
| When | Before any command, check, service, deploy or release task, `verifyCommand`, verify-loop gate command or standards profile command |
| Condition | A manifest or lockfile changed since the last install, or the install output is missing or lacks a declared package (`node_modules`, or `.pnp.cjs` for Yarn PnP) |
| Commands | From a fixed table only: npm ci/install, pnpm, yarn, pip into an existing virtualenv, go mod download, dotnet restore |
| Visibility | Install events in the run view and the VS Code output. The plan review card states the rule |
| Failure | An install failure fails the step that needed it |
| Default | On. `agentTaskPlayer.autoInstallDependencies` or `MOAG_AUTO_INSTALL_DEPENDENCIES` turns it off. `MOAG_INSTALL_IGNORE_SCRIPTS=1` skips install scripts |
| Bench | Greenfield dry-run fixtures exercise the path offline, and the bench installs dependencies before its acceptance gates |

**Status against real data:** not yet verified. Run 2 had the fix enabled (`"autoInstallDependencies": true` in its run `config.json`) but stopped during task 1, before any command task. Its `R2/events.jsonl` has no `dependencies-installed` event.

## The bump-rule finding (run 1, v2)

| Field | Value | Source |
|---|---|---|
| Diff | `changed: R-2, R-3`; `added`, `removed`: none | `POST …/prd/versions` response at 11:07:00.359Z, `R1/events.jsonl` |
| Server recommendation | `minor`, rationale `"Minor: changed R-2, R-3."` | same response |
| Scenario intent | `patch` | `scenario.json` (`v2.intendedBump`) |
| Override | `POST …/prd/versions/latest/bump {"bump":"patch"}` → before `1.1.0`/`minor`, after `1.0.1`/`patch` | `R1/events.jsonl` at 11:07:00.363Z; `D:/moag-bench-greenfield.log` (`recommended minor, intended patch`) |

This is the mismatch that [benchmark.md](benchmark.md#why-v2-of-the-greenfield-scenario-is-expected-to-mismatch) predicts: MOAG recommends `minor` for any changed requirement line. Deciding that a reword plus a bug fix is a patch is still a human call, and it costs one unplanned intervention per such version.

## What these runs prove, and what they do not

**They show:**

- The paid path runs end to end through planning on the real engine. Standards approval, PRD save, plan generation (3 plans), plan approval and run start all worked, and 6 agent tasks completed.
- Cost reporting works: every finished engine call reported `total_cost_usd`, and the SSE figures match the server's `versionSpend` exactly.
- A real defect. Agent-written manifests are not installed before the plan's own build or test steps, so this plan, which had no step that installed dependencies, did not reach its ship gate. A plan that included `npm install` (allowed by `scenario.json`) would have installed `tsc`. A fix exists (2349623).
- The bump rule behaves as documented: a changed requirement line gives `minor`.

**They do not show:**

- That anything ships. Requirements shipped is 0, and no ship gate, acceptance gate or MOAG verify ran.
- That 2349623 fixes the failure. Run 2 stopped before any command task.
- Any rate or average. n = 3 version attempts across 2 runs, and only one version (run 1 v1) ran to the end of its run.
- Anything about other engines (claude only), other machines (one Windows 11 machine), other Node versions (v24.16.0 only), or brownfield work.
- Quality of the generated code. Not measured: no gate ran on it.
- Wall-clock to ship, or cost per shipped requirement. Both are undefined while nothing ships.
- Cost after the stops. Not measured, and not bounded by the raw data (see Totals).
- Why the bench stopped. The raw files show only that it stopped. The reaper is the operator's attribution.

## Running the full benchmark

Run it in the **foreground of your own terminal** (a normal PowerShell window), not as a Claude Code background shell. The reaper kills background shells under memory pressure, and the operator attributes both stops above to it (the raw files do not record the cause). The `--out` directory must be empty or missing.

```powershell
cd D:\Projects\moag
git log -1 --format=%h          # expect 2349623 or later
npm run compile
claude --version                # 2.1.287 or later
node out\headless\cli.js bench bench\scenarios\greenfield-todo\scenario.json --max-usd 10 --out D:\moag-bench\greenfield-3
```

Afterwards, run `Get-Process claude` and kill any leftover process (`taskkill /T /F /PID <id>`), because workers are detached. The results will be in `D:\moag-bench\greenfield-3\summary.json`. See [benchmark.md → The paid run](benchmark.md#the-paid-run-human-only-total--15) for the brownfield step and the $15 total budget.
