# MOAG Autonomous Operation — Headless CLI & Daemon

> Run MOAG as an **autonomous software operator**: intake GitHub issues → develop →
> test → **(human-approved)** deploy → release → monitor → on incident, file an issue →
> back to intake. No VS Code window required.

This guide covers the headless side of MOAG. The VS Code extension (see the main
[README](../README.md)) is the dashboard and control panel on top of the same engine.

---

## Contents
- [How it works](#how-it-works)
- [Install](#install)
- [The `moag` CLI](#the-moag-cli)
  - [`run` — execute a plan](#run--execute-a-plan)
  - [`loop` — single-repo issue intake](#loop--single-repo-issue-intake)
  - [`daemon` — always-on multi-repo operator](#daemon--always-on-multi-repo-operator)
- [Task types for shipping & maintaining](#task-types-for-shipping--maintaining)
- [Gated at ship: the safety model](#gated-at-ship-the-safety-model)
- [Configuration](#configuration)
- [JSONL output](#jsonl-output)
- [Running in production](#running-in-production)
- [Security](#security)

---

## How it works

MOAG's runner (the same state machine the extension drives) runs in plain Node via a
thin `vscode` shim, so a plan can execute from a terminal, cron, or a long-running
daemon. The autonomous loop closes like this:

```
GitHub issue ──▶ intake ──▶ develop ──▶ test ──▶ [ Approve ⛔ ] ──▶ deploy ──▶ release ──▶ comment & close issue
     ▲                                            (human gate)                                   │
     │                                                                                           │
     └──────────────── file incident issue ◀── monitor breach ◀──────────────────────────────────┘
```

Everything except the **Approve** gate runs unattended.

---

## Install

The CLI ships inside the MOAG extension. After installing the extension (or building
from source), the binary lives at `out/headless/cli.js`.

**Build & install from source (updates the VS Code extension too):**

```bash
# Linux
./scripts/install-linux.sh            # build → package → install/update the extension
./scripts/install-linux.sh --app      # also update the VS Code app (snap/apt)

# macOS
./scripts/install-macos.sh
./scripts/install-macos.sh --app      # also update VS Code via Homebrew

# Windows
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -App
```

Each script auto-detects your `code` CLI (stable, Insiders, VSCodium, or remote/server),
compiles, packages a `.vsix`, and installs it.

**Run the CLI** (from a source checkout):

```bash
npm run compile
node ./out/headless/cli.js <command> ...
# or, once installed globally as a bin:
npx moag <command> ...
```

You need at least one agent CLI authenticated on the machine (`claude`, `codex`,
`gemini`, or `ollama`) and `gh` (GitHub CLI) authenticated for issue/PR operations.

---

## The `moag` CLI

```
moag run    <plan.json> [--full-auto] [--no-interactive] [--engine <id>] [--cwd <dir>]
                        [--verify] [--fix] [--pr] [--pr-base <branch>]
moag run    --prompt "<text>" [--engine <id>] [--full-auto]
moag verify <plan.json> [--prd <file>] [--fix] [--gate "<cmd>"] [--max-iterations <n>]
                        [--uat | --no-uat] [--uat-spec <path>]
moag loop   --repo <owner/repo> [--label <l>] [--interval <sec>] [--once] [--full-auto]
moag daemon [--config <.moag/daemon.json>] [--interval <sec>] [--max-ticks <n>] [--full-auto]
moag config <get-engine | set-engine <id>>
moag queue  <list | resolve <id>>
moag digest [--since <when>]
moag land   [--into <branch>] [--merge]
```

**Exit codes:** `0` success · `1` task(s) failed or work is waiting on a person ·
`2` error/usage · `3` halted at ship gate · `4` halted on the cost ceiling.

`digest` and `land` exit `1` while anything needs a decision, so
`moag digest || notify-me` is a complete morning check.

For the morning commands — `queue`, `digest`, `land` — and what they are for,
see [MANUAL.md](MANUAL.md).

### `run` — execute a plan

Runs a single plan file to completion.

```bash
moag run .moag/plan.json --full-auto
```

- `--full-auto` — enable retries + auto-fix (the runner repairs failing tasks).
- `--engine <id>` — override the plan's default engine (`claude`, `codex`, `gemini`, `ollama`, `anthropic`).
- A `manual` task halts the run with exit `3` (awaiting approval) — see [the safety model](#gated-at-ship-the-safety-model).

### `loop` — single-repo issue intake

Polls one repo for open issues, turns each new one into a task, runs them, and reports
the outcome back (comment + close on success; comment + label on failure).

```bash
moag loop --repo your-org/your-app --label moag --interval 300 --full-auto
moag loop --repo your-org/your-app --once          # one pass, then exit (cron-friendly)
```

Sequential by design — a poll never overlaps the previous run.

### `daemon` — always-on multi-repo operator

The full autonomous operator. Each tick it intakes issues across **all** configured
repos, then runs **monitor sweeps** over configured health endpoints (which file
incident issues on breach — picked up on a later tick).

```bash
moag daemon --config .moag/daemon.json --full-auto      # run forever
moag daemon --config .moag/daemon.json --max-ticks 1    # one tick (cron / systemd timer)
```

Graceful shutdown on `SIGINT`/`SIGTERM`. See [`.moag/daemon.example.json`](../.moag/daemon.example.json).

---

## Task types for shipping & maintaining

Beyond the standard task types (`agent`, `command`, `service`, `check`, `review`,
`validate`, `manual`, `visual-test`), the autonomous build adds:

| Type | What it does | Key fields |
|------|--------------|------------|
| `deploy` | Runs a pluggable deploy command, env-aware, with an optional post-deploy health **smoke gate** | `command`, `inheritEnvFiles` (`.env.staging`/`.env.prod`), `healthCheckUrl`, `startupTimeoutMs` |
| `release` | Pluggable command (version bump / changelog / publish) → optional annotated `git tag` → optional push + GitHub release | `command`, `releaseTag`, `releaseNotes`, `githubRelease` |
| `monitor` | Samples a health endpoint; on breach raises an incident and (optionally) files an issue the loop will intake | `healthCheckUrl`, `monitorSamples`, `monitorIntervalMs`, `failureThreshold`, `incidentRepo`, `incidentLabel` |

Two built-in plan templates demonstrate them:
- **Ship & Release (Gated)** — Build → Test → Approve → Deploy(+smoke) → Tag & Release
- **Health Monitor (Self-Healing)** — probe an endpoint → file an incident on breach

Example deploy + release tasks:

```json
{
  "id": "deploy-staging", "name": "Deploy to staging", "type": "deploy",
  "command": "npm run deploy:staging",
  "inheritEnvFiles": [".env.staging"],
  "healthCheckUrl": "https://staging.example.com/health",
  "dependsOn": ["approve-ship"]
},
{
  "id": "release", "name": "Tag & release", "type": "release",
  "command": "npm version patch --no-git-tag-version",
  "releaseTag": "v1.4.0", "githubRelease": true,
  "dependsOn": ["deploy-staging"]
}
```

---

## Gated at ship: the safety model

MOAG runs intake → build → test fully autonomously, but **a human approves before
anything ships**. You express the gate as a `manual` task that the deploy task
`dependsOn`:

```json
{ "id": "approve-ship", "name": "Approve ship", "type": "manual",
  "prompt": "Review build & test results, then Mark Complete to deploy." }
```

In headless mode a `manual` gate **halts the run with exit code 3** so a human can
approve out-of-band (re-run to continue). In CI you can auto-skip gates with `CI=true`
— only do this once you trust the pipeline.

> Recommendation: keep the ship gate human-approved until monitoring + rollback are
> proven in your environment, then consider loosening it.

---

## Configuration

### `.moag/config.json` (headless settings)

The shim reads `agentTaskPlayer.*` settings from this file. Example:

```json
{ "agentTaskPlayer": { "fullAuto": true, "taskTimeoutMs": 600000 } }
```

### `.moag/daemon.json` (daemon)

```json
{
  "intervalSec": 300,
  "fullAuto": true,
  "repos": [
    { "repo": "your-org/your-app", "label": "moag", "engine": "claude" },
    { "repo": "your-org/your-api", "label": "moag" }
  ],
  "monitors": [
    {
      "name": "prod-web",
      "healthCheckUrl": "https://your-app.example.com/health",
      "incidentRepo": "your-org/your-app",
      "incidentLabel": "moag",
      "samples": 3,
      "intervalMs": 5000,
      "failureThreshold": 2
    }
  ]
}
```

> Wire `incidentLabel` to the same `label` the repo's intake polls for, so a filed
> incident is automatically picked up → fixed → (gated) redeployed.

---

## JSONL output

Every command streams newline-delimited JSON to **stdout** (human notices go to stderr),
so a CI job or log pipeline can consume it. Representative events:

```jsonl
{"event":"run-started","plan":"...","fullAuto":true}
{"event":"task-started","id":"...","name":"..."}
{"event":"task-completed","id":"...","name":"..."}
{"event":"manual-gate","id":"...","note":"Halting for human approval (ship gate)."}
{"event":"incident","id":"...","summary":"Health check ... failed 2/3 samples.","issueUrl":"..."}
{"event":"daemon-intake","tick":1,"repo":"o/r","openIssues":3,"newTasks":2}
{"event":"issue-reported","repo":"o/r","issue":42,"success":true}
{"event":"run-finished","total":5,"completed":5,"failed":0}
```

---

## Running in production

**systemd** (`/etc/systemd/system/moag.service`):

```ini
[Unit]
Description=MOAG autonomous operator
After=network-online.target

[Service]
WorkingDirectory=/srv/moag
ExecStart=/usr/bin/node /srv/moag/out/headless/cli.js daemon --config /srv/moag/.moag/daemon.json --full-auto
Restart=on-failure
Environment=ANTHROPIC_API_KEY=...

[Install]
WantedBy=multi-user.target
```

**cron** (one tick every 5 min — no resident process):

```cron
*/5 * * * * cd /srv/moag && node out/headless/cli.js daemon --config .moag/daemon.json --max-ticks 1 --full-auto >> /var/log/moag.jsonl 2>&1
```

**Burn-in checklist before trusting `--full-auto` unattended:**
- [ ] Agent CLI(s) authenticated (`claude`, `codex`, …) and `gh auth status` is green
- [ ] Real deploy commands wired into the ship template; staging reachable
- [ ] Ship gate kept human-approved for the first cohort of changes
- [ ] Monitor endpoints + incident labels match the intake labels (loop closes)
- [ ] Cost guardrails reviewed for long agentic runs

---

## Security

- All GitHub CLI calls go through safe wrappers (`execFileSync`/`execFile`, `shell:false`,
  arguments passed as discrete array elements) — untrusted issue/repo/label content can
  never reach a shell.
- Agent shell output (`run_bash`) is bounded to prevent runaway memory use.
- The runner has a stop-state watchdog so it can't wedge.

These are covered by the test suite (`npm test`).
