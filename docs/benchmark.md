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
| `bench-po` | product-owner | Creates the project, proposes its standards, sets the per-version budget, saves each PRD version, overrides a bump, requests plans |
| `bench-reviewer` | reviewer | Approves the project standards, approves (or rejects) each generated plan, starts and stops runs |
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
6. The product owner proposes the project standards (`POST …/standards/versions`) and the reviewer approves them (`POST …/standards/versions/:version/approve`, echoing the `contentHash`). See [Project standards](#project-standards). No plan is requested before this succeeds.

Then, for each PRD version:

1. The product owner sets the version's cap: `PATCH /api/projects/:id {versionBudgetUsd}`.
2. The product owner reads `GET /api/projects/:id/prd`, then saves the version: `POST …/prd/versions {text, baseCreatedAt}`.
3. From v2 on, if the server's `recommendedBump` differs from the scenario's intended bump, the product owner overrides it: `POST …/prd/versions/latest/bump`. This is an **unplanned** intervention.
4. From v2 on, if `deltaScope` is null, there is nothing to plan and the version's outcome is `no-delta`.
5. The product owner requests a plan: `POST …/plans {mode: initial | delta}`. The bench polls `GET /api/projects/:id` until the plan stops `generating`.
6. The reviewer approves the plan with its `contentHash` (**required**), or rejects it (**unplanned** `plan-rejected`, the reason names every offending item) when the bench may not approve it unread: the server says it cannot be approved (which includes any `parallel` playlist), the playlist is `parallel` by the bench's own check (every budget guard assumes one engine call in flight), it has a `release` or `deploy` task, or its review lists any `command`/`verifyCommand` that is not exactly one of the scenario's `gateCommands`, `allowedCommands` or `dryRun.planCommand` (see [The command allow-list](#the-command-allow-list)), or any `cwd` or side-effect field. Then the reviewer starts the run: `POST …/runs`.
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
| `repo` | `{"kind":"template","templateDir":"template"}`: the folder is copied into a fresh directory, then `git init -b main` and one commit. `{"kind":"clone","path":"../../..","ref":"<branch>"}`: `git clone --no-hardlinks --branch <ref> --single-branch` into a fresh directory. The clone then loses every path back to its source: `git remote remove origin` (no push, tag push or fetch can reach it) and `git reflog expire --expire=now --all` (the reflog records `clone: from <source path>`). The bench checks both, and stops if a remote or any mention of the source path is left in the clone's git metadata. The destination may never be, contain, or sit inside the clone source, so the live working tree is never used. Only **committed** work at that ref is cloned. |
| `setupCommands` | Shell commands run in the new workspace before anything else (for example `npm ci`). A failure stops the bench. |
| `stack`, `engine` | The project's stack and engine. `custom` and `copilot` are refused, as the server refuses them. |
| `budgetUsd` | Total budget, greater than 0 and at most 100. A paid run's cap is `min(--max-usd, budgetUsd)`. |
| `perCallCapUsd` | Most one engine call may cost. It is passed to Claude as `--max-budget-usd` (through `MOAG_MAX_USD_PER_ENGINE_CALL`) and used as the cost of every call that reports none. Greater than 0 and at most `budgetUsd`. |
| `minVersionUsd` | Default 1. A version whose cap would be lower is `not run (budget)`. |
| `reserveFactor` | Default 1.5. How many per-call caps are held back from each version's cap, because a call can overshoot its cap by about one turn. |
| `versionTimeoutMin` | Default 60. Covers plan generation plus every run segment of one version. |
| `passEnv` | Variable names passed to agents (`MOAG_RUN_ENV_PASSTHROUGH`). `CI` and `MOAG_*` are refused. |
| `gateCommands` | The bench's **acceptance gates**: at least one. |
| `gateTimeoutMs` | Default 600000, per gate command, from 1000 to 3600000. It bounds the bench's acceptance gates and environment probes, and it is passed to the server as `MOAG_GATE_TIMEOUT_MS`, so MOAG's own verify gives each of its gate commands the same time. |
| `environmentProbes` | Optional. Commands MOAG's own verify is expected to run. The bench runs each once in the untouched workspace, before any plan. See [Environment probes](#environment-probes). Same format rules as `allowedCommands`. |
| `allowedCommands` | Optional. Extra shell commands a generated plan may carry and still be approved unread. Exact strings, never patterns. See [The command allow-list](#the-command-allow-list). |
| `versions[]` | `{id, prdFile, intendedBump, dryRunFixture?}`. The first version's bump must be `initial`, and only the first may be. Later versions use `patch`, `minor` or `major`. |
| `dryRun.planCommand` | Dry-run only: the test command the fake planner puts in every plan. |
| `standardsProfile` | Optional. Path of a standards profile JSON file inside the scenario directory. See [Project standards](#project-standards). |

Tag every requirement line explicitly (`- [R-3] …`). An untagged line whose wording changes gets a new id, which counts as a removal and makes the bump `major`.

### The command allow-list

The bench approves plans that no human has read, so it approves a plan only when every shell command in it is one the scenario author has already reviewed.

- The planning prompt **requires** a Testing playlist with a `command` task that runs the test suite. A real plan therefore always carries commands such as `npm test`.
- A command is allowed when it is exactly one of `gateCommands`, `allowedCommands` or `dryRun.planCommand`. Leading and trailing spaces are ignored; nothing else is. Matching is case-sensitive.
- Entries are literal strings. `npm run *` allows only the command `npm run *`.
- `npm test && git push` is not `npm test`: a listed command with anything added is refused.
- Anything else makes the bench reject the plan through the reviewer route. The version is `plan-failed`, with an **unplanned** `plan-rejected` whose detail names each offending task and command.
- Each `allowedCommands` entry must be a single line of at most 500 characters, and may be listed only once.

Put a command in `allowedCommands` only if you would approve it in any plan for that repository. Never list a command that pushes, publishes, tags or deploys.

### Project standards

The server generates no plan until a reviewer has approved a standards version for the project. The bench goes through that reviewed path once per run, right after it creates the project:

1. The server proposes v1 itself when the project is created. The bench does not approve that version.
2. The product owner proposes the scenario's profile as the next version:
   - the file named by `standardsProfile`, when the scenario has one;
   - otherwise the built-in profile for the scenario's `stack`, with no commands. A `clone` repository gets it as `brownfield`, a `template` repository as `greenfield`. Such a profile has no blocking rule at all (a run under it ships, stamped "no blocking rules configured"), so every shipped scenario names its own profile with a command.
3. The bench checks what the server returned before it plays the reviewer. It refuses to approve when the version is not `pending`, when its `contentHash` is not the hash of the profile the bench sent, or when any command in it is not exactly one of `gateCommands`, `allowedCommands` or `dryRun.planCommand`.
4. The reviewer approves it, echoing the `contentHash` — and, because a first version that brings a command changes enforcement, the same hash again as `acknowledgedEnforcementHash`. The bench gives that acknowledgement for exactly the content it checked in step 3.

The bench never uses `accept-defaults`, so the path it measures is the reviewed one.

A refusal at any of these steps is a harness error (exit 2). The error names the step, and no plan is requested.

Approving standards is project setup, like creating the users. It is written to `events.jsonl` (`standards-approved` or `standards-refused`) and to `notes` in the summary. It is **not** counted as an intervention.

Rules for a `standardsProfile` file:

- It must be inside the scenario directory and pass the same validator as a profile submitted through the API.
- Its `stackTemplateId` must be the scenario's `stack`.
- Each command in it must be exactly one of `gateCommands`, `allowedCommands` or `dryRun.planCommand`. Otherwise parsing fails and names the field, for example `standardsProfile.commands[1].run`. Approving a profile lets its commands run on every run, so this is the same rule as for plan commands.

Every dry-run fixture must conform to the profile its scenario gets approved, unless the scenario exists to show a violation. A unit test runs the checker over each shipped fixture and requires zero findings, blocking or advisory, and no file left unchecked.

The shipped profiles follow the checker's defaults: **MOAG blocks on the project's own tools; its own scans are advisory unless promoted.** Every shipped profile therefore carries at least one command, which is its whole blocking set, and promotes nothing; a unit test pins both. Banned phrases in the shipped profiles are truncation placeholders only; none lists "as an AI".

The server refuses to approve a ship while the standards check made at the ship gate shows a blocking failure, or a blocking rule or command that was not checked (`409 standards-blocking`). The bench approver then does what a person would: rejects the ship. It is written to `events.jsonl` as `ship-refused-standards` and listed as an **unplanned** intervention of that kind; the run ends `ship-rejected`.

If the plan request itself answers `409 standards-not-approved`, the version is `plan-failed` with an **unplanned** `plan-standards-not-approved`. The bench does not retry it.

### The scenarios in `bench/scenarios/`

**`greenfield-todo`** ($10):

- A Node + TypeScript command-line todo app, built from an empty repository.
- The bench's acceptance gate is `npm test`.
- Also allowed in a plan: `npm run test`, `npm run build`, `npm install`, `npm ci`, `npm install && npm test`, `npm run build && npm test`.
- Standards: its own profile, `standards.json`. It requires no directory, because the dry-run stand-in is plain JavaScript in `bin/` and `test/`, while a real engine writes TypeScript. It carries one command, `npm test`, which is its whole blocking set, and promotes no rule: every scan in it is advisory. A dry-run therefore exercises the default blocking path end to end: the command runs at the ship gate and again in verify, its row is `passed`, and each release is stamped with the standards version.
- Versions:
  - v1 `initial`: add, list, complete, JSON persistence, tests.
  - v2 intended `patch`: Overview reworded, R-2 clarified, and a bugfix in R-3.
  - v3 `minor`: due dates and an overdue filter.

**`brownfield-moag`** ($5):

- A fresh clone of this repository at the HEAD of `feat/sdlc-automation`, followed by `npm ci` and `npm run compile`. The unit suite reads compiled output (the webview scripts in `out/webview`), so without the compile step the `npm test` probe fails in the untouched clone (11 failures) and a paid run stops there.
- One small PRD: a `formatUsd` helper and its mocha test file.
- The bench's acceptance gates are `npm run compile` and that one mocha file (`npx mocha --require ts-node/register src/test/unit/utils/usd-format.test.ts`).
- Also allowed in a plan: `npm run lint`, `npm test`, `npm run test`, and the same mocha command with the file path in double quotes.
- Standards: its own profile, `standards.json` — the built-in `node-ts` profile as `brownfield`, plus the one command `npm run compile` (already an acceptance gate of the scenario), so that its blocking path is real. Its required directory is advisory, as in every built-in, and so is every scan.
- `gateTimeoutMs` is 1800000 (30 minutes). MOAG's verify runs the full unit suite (`npm test`), which takes longer than the 600000 default on a typical machine; with the default, verify killed it and the version could never ship. The bench passes the value to the server as `MOAG_GATE_TIMEOUT_MS`. A clone's own `.moag/config.json` would not help: the server never reads it.

**`standards-violation`** ($3):

- A negative scenario for the standards gate: one small PRD (a `slugify` helper) in an empty repository.
- The bench's acceptance gate is `npm test`. Also allowed: `npm run test` and `npm run lint`.
- Standards: its own profile, `standards.json`, which forbids commented-out code, lists truncation placeholders as banned phrases, and runs one command, `npm run lint`. It **promotes nothing**: what stops the ship is the project's own tool, by its exit code — not a scan of MOAG's.
- Its dry-run fixture passes its own tests but leaves two violations in `src/slug.js`: line 4 is commented-out code, and line 6 is the placeholder comment `// ... rest of the code ...`. The fixture's lint script (`tools/lint.js`, run by `npm run lint`) exits 1 on the placeholder. MOAG's own scans report both lines as **advisory** findings beside it; on their own they would stop nothing.
- Expected dry-run result: the acceptance gate (`npm test`) is green; the standards check at the ship gate shows the command row `npm run lint` **failed** (exit 1) and two advisory findings; the server refuses the ship approval (`409 standards-blocking`), the bench approver rejects the ship, and nothing is marked shipped. The version's outcome is `not-shipped` with `endState: "run-ship-rejected"`, one unplanned intervention `ship-refused-standards`, and `moagVerify: null` (verify never ran: the ship was never approved).
- The scenario format has no expected-outcome field. Unit tests pin the two advisory findings and the exit codes of the fixture's own scripts; read the summary of a dry-run against the list above.
- It is meant for dry-runs. A real engine would be told the standards and would normally write conforming code.

## Two gate notions: never merged

- **Bench acceptance gates** are the scenario's `gateCommands`. The bench runs them in the workspace at each ship-gate halt, as a careful approver would, and approves only when they are green. They are reported as `gateFirstRunPass`.
- **MOAG's own verify gates** run inside the worker after an approved gate. The server never reads the repository's `.moag/config.json`, so these are **auto-detected** from `package.json`:
  - greenfield: `npm test`;
  - brownfield: `npm run lint` and the **full** unit suite (`npm test`).

  These are reported as `moagVerify`.

  Verify also checks the diff against the approved project standards, before the auto-detected commands, and runs the profile's commands after them. A standards failure — a failed profile command, a promoted rule with findings, or a blocking rule or command that was not checked — is reported as `moagVerify.failedGate: "standards"` with `failedCommand: null`. It is never recorded as an `environment` finding, because it names no command the machine could have failed to run.

The two can disagree, and both are reported. A brownfield version that MOAG refuses to ship because its own lint or full suite failed is a valid finding, not a harness failure.

### Environment probes

A command that the machine cannot run fails whatever MOAG does. The bench must not report that as a product failure.

- A scenario lists such commands in `environmentProbes`. The bench runs `node --version` and then each probe, once, in the untouched workspace: after the setup commands, before any plan.
- The results are in `summary.json` → `environment` (`node`, and per probe `command`, `exitCode`, `timedOut`, `durationMs`, `pass`, `detail`).
- A failing probe never stops a **dry-run**: it spends nothing.
- A failing probe **stops a paid run** before any plan is requested, so before any engine call. See [`--allow-failed-probes`](#--allow-failed-probes).
- A version gets an `environment` entry only on evidence. The probe must have failed in the untouched workspace, **and** it must be exactly the command MOAG's verify stopped at (`moagVerify.failedCommand`) or the command of a task that failed.
- The entry reads, for example: `environment: Node v24.16.0 cannot run "npm test": it exits 1 in the untouched workspace, before any plan (…). MOAG's own verify stopped at this command.`
- The version's `outcome` and `endState` do not change: nothing shipped, and the summary says so. The `environment` entry says why that is not MOAG's doing.
- Where the probe passes, a later failure of the same command stays a product failure.

### `--allow-failed-probes`

A paid run on a machine that cannot run a probed command would spend money to measure something the machine cannot measure. So a paid run stops as soon as a probe fails.

- The stop comes right after the probes: no user, project or plan has been created and no engine call has been made.
- The exit code is `2`. `summary.json` → `harnessError` names each failed probe and its exit code (or `timed out`), for example: `paid run refused: environment probe "npm test" (exit 1) fails in the untouched workspace on Node v24.16.0. …`
- Every version has `outcome: "error"` and `endState: "harness-error"`. `events.jsonl` has an `environment-probes-stop` entry.
- To run anyway, pass `--allow-failed-probes`. The run then goes ahead as described above, and `summary.json` → `notes` records that the flag was used and which probes failed.
- The flag has no effect on a dry-run, or when every probe passes.

### Brownfield and the Node version

The brownfield scenario probes `npm test`, because that is the full suite MOAG's verify auto-detects.

- **Node 20** (the version `.nvmrc` and CI pin) **gives the full signal.** `npm test` runs, so the probe passes and MOAG's verify result is a real verdict on the work. The probe runs the whole suite once, which takes several minutes.
- **Node 22.6 or later cannot start `npm test`.** Node loads the suite's `.ts` files as ES modules, and the run exits 1 in about 2 s with `require is not defined in ES module scope`. Neither `--no-experimental-strip-types` nor `--no-experimental-detect-module` fixes this when passed through `NODE_OPTIONS`. Only flags given directly to `node` do, and `npm test` cannot take them.
- So on Node 22.6 or later a **paid** brownfield run stops at the probe (exit 2) before it spends anything. Switch to Node 20, or pass [`--allow-failed-probes`](#--allow-failed-probes) to run it anyway. A dry-run is not stopped.
- With the flag (or in a dry-run) on such a machine, the brownfield version ends `run-gaps` with `moagVerify.failedGate: "command"`, `moagVerify.failedCommand: "npm test"`, and an `environment` entry. Read it as "not measured here", not as a MOAG failure.
- A plan task that runs `npm test` (the planner must emit one) fails on such a machine for the same reason, and is reported the same way.
- The bench's own acceptance gate is one mocha file run through `npx mocha`, with no Node flag. With the dry-run fixture it passes on Node 20 and on Node 24.16. A flag given directly to `node` is not an option: Node 20 rejects `--no-experimental-strip-types` as a bad option.
- On Node 22.6 or later that gate has the same limit as the full suite for one kind of file: a test that mixes ES `import` with `require(...)`, as many tests in this repository do, fails to load. In a paid run the agent writes the test file, so on such a machine a red acceptance gate (`gate-rejected`) can also be the machine's doing. No probe covers that case. Use Node 20 for a paid brownfield run.

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
| `moagVerify` | The last `verify-finished` event: `passed` and `failedGate`. `failedCommand` is the last gate command verify started before it reported `failedGate: "command"`; otherwise null. |
| `environment` | Failures of this version that the machine caused, not the product. Empty unless a failed [environment probe](#environment-probes) matches. |
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

The summary also has `totals`, the `budget` ledger snapshot, the engine's version, the `environment` probe results, `stoppedForBudget`, `aborted` and `harnessError`.

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

Run a dry-run with Git Bash. No `NODE_OPTIONS` setting is needed, on Node 20 or on Node 24; see [Brownfield and the Node version](#brownfield-and-the-node-version) for what each Node version measures:

```bash
npm run compile
node out/headless/cli.js bench bench/scenarios/greenfield-todo/scenario.json --dry-run --out <dir>/greenfield
node out/headless/cli.js bench bench/scenarios/brownfield-moag/scenario.json --dry-run --out <dir>/brownfield
node out/headless/cli.js bench bench/scenarios/standards-violation/scenario.json --dry-run --out <dir>/violation
```

Exit codes:

- `0`: the harness completed, whatever the product outcome.
- `4`: stopped for budget.
- `2`: a harness or usage error, including Ctrl+C, a paid run stopped by a failed environment probe, and standards that could not be proposed or approved.

The `standards-violation` dry-run exits `0`: the harness completed, and the product correctly refused to ship (the ship gate could not be approved).

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

Caveat: `--max-budget-usd` can overshoot by one turn, which is why the reserve is 1.5 per-call caps. A generated `parallel` playlist cannot be approved: the server's own plan review refuses it for every project, and the bench checks it again. So at most one engine call is in flight.

### Steps (Windows PowerShell)

1. Prepare. The brownfield scenario clones the HEAD of `feat/sdlc-automation`, so uncommitted work is not part of it:

   ```powershell
   cd <path-to-moag-repo>
   git status
   npm ci; npm run compile
   node --version   # use Node 20 (nvm use) for brownfield: on Node 22.6+ the npm test probe fails and the paid run stops (exit 2) unless --allow-failed-probes is given
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
