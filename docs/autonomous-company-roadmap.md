# MOAG → Autonomous Software Company: Executable Roadmap

> **Vision:** Operate a software company autonomously — intake → development → testing →
> deployment → maintenance — driven by AI coding agents (Claude Code, Codex, Gemini, …),
> with MOAG as the orchestration brain.

## Decisions locked (2026-06-20)

| Decision | Choice |
|---|---|
| **Autonomy level** | **Gated at ship** — agents run intake→build→test→PR fully autonomously; a human approves merge & deploy. Deploy-to-prod stays human. |
| **Execution surface** | **Headless CLI/daemon first** — a standalone entry wraps `runner.play()` so the loop runs from terminal/cron/server with no VS Code window. VS Code stays as the dashboard. |
| **Deploy target** | **Pluggable / command-based** — deploy is configurable shell commands + a `deploy` task type. No vendor lock-in. |
| **First milestone** | **Vertical slice on ONE repo** — prove issue→PR→(gated)deploy end-to-end, then widen. |

## Where MOAG stands today

**Already built (~80% of autonomy primitives):**
- Full-auto retry (≥4 attempts) + auto-fix repair loop — `runner.ts:856-986`
- Auto-advance between tasks (`Playlist.autoplay`) — `runner.ts:740-792`
- Task DAG: `dependsOn`, `skipIf`, blocked-dependent unblocking
- Failure classification (auth/rate-limit/cli-missing/timeout/compile/test/code) — `runner.ts:83-198`
- Service health checks (port / readyPattern / healthCheckUrl) — `runner.ts:2112-2190`
- GitHub issue polling → task creation — `extension.ts:5207-5265`
- State persistence (plan.json + VS Code memento)
- Clean task-type dispatch switch — `runner.ts:1486-1517`
- Pluggable validation-adapter pattern — `src/adapters/validation/`

**The de-risking finding — headless is feasible without a rewrite.**
The `vscode` coupling across the entire execution path (`runner`, adapters, context-builder,
history store) is **shallow**: of 20 `vscode.*` refs in `runner.ts`, 17 are
`workspace.getConfiguration`, plus 2 `showWarningMessage` and 1 `workspaceFolders`. A thin
`vscode` **shim** (config provider + no-op window + in-memory `Memento`/`EventEmitter`)
lets the whole runner run in plain Node. **The headless CLI is a shim + thin entry, not a rewrite.**

**Gaps blocking the closed loop:**
1. **Human-gated execution** — profile picker, Resume/Restart prompt, and engine check each block on a click.
2. **Loop not closed** — issue polling *creates* tasks but doesn't auto-run; completion doesn't close issues; escalations are recorded (`task-escalate`) but spawn no follow-up work.
3. **No ship half** — no `deploy`/`release` task types, no CI trigger/monitor.
4. **No maintain half** — no monitoring/incident→fix loop.
5. **VERIFIED SECURITY BLOCKER** — `gh` command-injection cluster (`extension.ts:4266, 5466, 5275, 5281`; `owner`/`repo`/`label` interpolated unescaped into shell). Must be fixed before any unattended multi-repo operation.

---

## The phased build

### Phase 0 — Security & reliability hardening *(prerequisite, blocks autonomy)* — **DONE**
Fixed the verified injection cluster and the highest-severity runner reliability bugs.

- ✅ Replaced string-interpolated `execSync(\`gh …\`)` with `ghSync`/`ghAsync` (`execFileSync`/`execFile`, `shell:false`) across all 12 call sites → `src/utils/gh.ts`.
- ✅ Capped output buffer in Anthropic `run_bash` (`anthropic-adapter.ts`) at 1 MB.
- ✅ Fixed silent `.catch(() => {})` in parallel-playlist exec (`runner.ts`) — now emits `error` + correct continuation.
- ✅ Added a 30 s `Stopping`-state watchdog so the runner can't hang.
- ✅ Regression test: `src/test/unit/utils/gh.test.ts`.

### Phase 1 — Headless core (the load-bearing milestone) — **BUILT**
Make `runner.play()` runnable outside VS Code.

- `src/headless/vscode-shim.ts` — implements the shallow API surface (`workspace.getConfiguration`, `workspace.workspaceFolders`, `window.show*Message`, `commands`, `EventEmitter`, `Uri`, `ConfigurationTarget`; Copilot symbols are throwing stubs). Config sourced from `.moag/config.json` + env.
- `src/headless/install-shim.ts` — a Node `Module._load` require hook mapping `require('vscode')` → the shim, plus a file-backed `FileMemento` (atomic writes) for the history/session stores. (CLI lives under `src/` because tsconfig `rootDir: src`; compiles to `out/headless/cli.js`, exposed via the `bin.moag` field + `npm run moag`.)
- `src/headless/cli.ts` — CLI entry: `moag run <plan.json> --no-interactive --full-auto`. Wraps `runner.play()`; emits structured JSONL; exit codes **0** success / **1** failed / **2** error / **3** halted at ship gate.
- `--no-interactive` is largely free: the human gates (profile picker, Resume/Restart, engine check) live in `extension.ts` command handlers, which the CLI bypasses by calling `runner.play()` directly. The only in-runner gate is the `manual` task type — the CLI treats it as **halt-for-approval** (exit 3), matching the "gated at ship" decision.

### Phase 2 — Close the loop (intake → execute → report) — **BUILT (headless)**
Built as a vscode-free, unit-tested core rather than bolted onto `extension.ts`:
- `src/github/issue-sync.ts` — `fetchOpenIssues` (defensive gh JSON parse, [] on any failure), `newIssuesToTasks` (dedup via a known-set, tags `sourceIssueNumber/Repo`), and `reportIssueResult` (✅ comment+close on success; ❌ comment+label on failure). All `gh` calls via the safe `ghSync`/`ghAsync`.
- `moag loop --repo <o/r> [--label] [--interval] [--once]` in `src/headless/cli.ts` — polls → converts new issues to tasks → `runner.play()` → reports each issue-backed task's **final** status back to GitHub (reporting after `play()` resolves avoids double-reporting from mid-run auto-fix). Sequential `await` = built-in re-entrancy guard (fixes the overlap risk the audit flagged). SIGINT-aware; ship gate halts with exit 3.
- Tests: `src/test/unit/github/issue-sync.test.ts`.
- Escalation: the runner's auto-fix loop already handles in-run repair; `task-escalate` is now surfaced in the JSONL stream. Dynamic cross-run repair-task injection remains a follow-up.

### Phase 3 — Ship half (gated at ship) — **BUILT**
- ✅ `deploy` task type (`types.ts` union + `runDeployTask`): pluggable command, env-aware via `inheritEnvFiles` (`.env.staging`/`.env.prod`), optional `healthCheckUrl` **smoke gate** (`waitForHealthy` polls until `startupTimeoutMs`).
- ✅ `release` task type (`runReleaseTask`): pluggable command (version bump / changelog / publish) → optional annotated `git tag` (reuses `runGitCommand`) → optional push + GitHub release (reuses safe `ghSync`). New fields: `releaseTag`, `releaseNotes`, `githubRelease`.
- ✅ **Ship gate** via plan structure, not new runner code: a `type:'manual'` approval task that deploy `dependsOn` — the headless CLI halts on it (exit 3) for out-of-band human approval. Demonstrated by the new **"Ship & Release (Gated)"** built-in template.
- ✅ Tests: 5 runner tests (`runner.test.ts`); verified headless end-to-end (deploy→release, exit 0).
- Follow-up: a dedicated `DeployValidator` validation adapter for richer post-deploy smoke on `staging`/`prod` targets.

### Phase 4 — Maintain half — **BUILT**
- ✅ `monitor` task type (`runMonitorTask`): samples `healthCheckUrl` (`monitorSamples`/`monitorIntervalMs`); when failures reach `failureThreshold` it raises an incident, emits an `incident` event, and (if `incidentRepo` set) files a labelled issue via the new vscode-free `fileIncidentIssue` — which the Phase 2 loop intakes → fixes → gated-redeploys. **The self-healing loop is closed.**
- ✅ New Task fields round-trip through `hydrateTask`/`dehydrateTask` (fixed a latent bug where new fields — and pre-existing `inheritEnvFiles`/`scopedVerify` — were dropped on plan load; covered by a regression test).
- ✅ "Health Monitor (Self-Healing)" built-in template; `incident` surfaced in the headless JSONL stream.
- ✅ Tests: 3 monitor runner tests + 2 `fileIncidentIssue` tests + 1 round-trip test; verified headless.
- Available for follow-up: seed maintenance issues from `.moag/errors.jsonl` via the existing `readRecentErrors` + `fileIncidentIssue`.

### Phase 5 — Daemon & scale — **BUILT**
- ✅ `moag daemon [--config .moag/daemon.json] [--interval] [--max-ticks] [--full-auto]` — the always-on operator. Each tick: multi-repo issue intake → run → report, then monitor sweeps over configured health endpoints (file incidents on breach → picked up next tick). SIGINT/SIGTERM graceful stop; `--max-ticks` for one-shot/cron use.
- ✅ Multi-repo: `daemon.json` lists N repos (each with label/engine) + N monitors. See `.moag/daemon.example.json`.
- ✅ Core (`src/headless/daemon.ts`) is **dependency-injected and unit-tested** (5 tests: multi-repo intake, dedup across ticks, monitor sweeps, prompt stop, lifecycle). Verified headless end-to-end.
- systemd/pm2-friendly (single long-running Node process); cron-friendly via `--max-ticks 1`.

---

## Verification (end-to-end, per phase)
- **P0:** `npm run lint && npm test`; add a unit test that a crafted malicious `owner`/`label` does NOT execute (arg-array invocation).
- **P1:** `node bin/moag run .moag/sample.plan.json --no-interactive --full-auto` completes a 1-task plan with **no VS Code running**; correct exit code.
- **P2:** Open a test issue on the slice repo → daemon auto-runs → PR opened → issue commented/closed. No human click until the ship gate.
- **P3:** A `deploy` task runs the pluggable command against staging, smoke-gate passes; `release` produces a tag + GitHub release. Human approval required before deploy executes.
- **P4:** Kill the staging health endpoint → `monitor` files an issue → loop intakes it.

## Risks & mitigations
- **Shim drift** — adapters may grow new `vscode` calls. *Mitigation:* keep the shim's surface tested; CI grep-guard for new `vscode.*` symbols outside the shim allowlist.
- **Runaway cost** — agentic loops (Anthropic 40 iterations) unbounded. *Mitigation:* cumulative cost cap + abort, surfaced in headless logs.
- **Autonomy safety** — keep the ship gate human-approved until monitoring + auto-rollback are proven, then revisit "gated at prod only."
