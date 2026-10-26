# MOAG — AI Agent Orchestrator

[![CI](https://github.com/sujan-poudel-03/moag/actions/workflows/ci.yml/badge.svg)](https://github.com/sujan-poudel-03/moag/actions/workflows/ci.yml)
[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/moag.agent-task-player)](https://marketplace.visualstudio.com/items?itemName=moag.agent-task-player)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/moag.agent-task-player)](https://marketplace.visualstudio.com/items?itemName=moag.agent-task-player)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Run AI agents like a playlist.** Build a plan, pick your engines, hit Play — Claude Code, Codex, Gemini, Ollama, GitHub Copilot or the Anthropic API execute your tasks while you watch.

---

## Why MOAG

- **Smart Planning** — Describe what you want and MOAG generates a structured plan with playlists, tasks, and verification steps. Or pick from 12 built-in templates. Every prompt is enriched with project context, relevant files, and best practices automatically.

- **Multi-Agent Review** — After a task completes, a different engine reviews the changes. Or run the same task on multiple engines and keep the first success (consensus mode). Catch bugs one model misses.

- **Auto-Fix & Recovery** — When a task fails, MOAG reads the error, generates a targeted repair prompt, and retries. Combine with verify commands for fully autonomous execution chains. Recovered tasks show a badge so you know what was fixed.

---

## Quick Start

### 1. Install

Search **"MOAG"** in VS Code Extensions, or grab it from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=moag.agent-task-player).

You need at least one engine. Either an agent CLI:

```bash
npm i -g @anthropic-ai/claude-code   # Claude Code
npm i -g @openai/codex               # OpenAI Codex
npm i -g @google/gemini-cli          # Gemini CLI
# Or install Ollama from https://ollama.com
```

or no CLI at all: run **MOAG: Set Anthropic API Key** (the key is kept in VS Code's secret storage), or use GitHub Copilot through the Copilot Chat extension. **MOAG: Setup Guide** shows what is found and what is missing.

### 2. Create a Plan

- **Smart Plan** (recommended): `Ctrl+Shift+P` → `MOAG: Smart New Plan` → describe your goal → get a full plan
- **From Template**: `MOAG: New Plan from Template` → 12 ready-made plans
- **From GitHub Issue**: `MOAG: Plan from GitHub Issue` → paste an issue URL
- **Manual**: Click the rocket icon in the Activity Bar → New Plan → add playlists and tasks

### 3. Hit Play

Click **Play** in the title bar. MOAG opens the Dashboard, validates engines, and starts executing. Tasks stream live output, run verification commands, and auto-fix failures.

---

## Features

| Feature | Description | How to Use |
|---------|-------------|------------|
| **Smart New Plan** | AI generates a plan from a description | `MOAG: Smart New Plan` |
| **Plan from GitHub Issue** | Turn any issue into a runnable plan | `MOAG: Plan from GitHub Issue` |
| **Plan Templates** | 12 pre-built plans for common workflows | `MOAG: New Plan from Template` |
| **Task Editor** | Single-form webview for task editing | `MOAG: Edit Task` |
| **Quick Add Task** | Keyboard-first task creation | `Ctrl+Shift+T` |
| **Task from Selection** | Create a task from highlighted code | `MOAG: Add Task from Selection` |
| **Duplicate Task** | Clone any task | Context menu |
| **Split Task** | AI breaks a large task into focused steps | Context menu |
| **Peer Review** | A different engine reviews code changes | `MOAG: Add Review Step` |
| **Consensus Mode** | Run on N engines, first success wins | Set task type to `review` |
| **AI Auto-Fix** | Retries failures with a repair prompt | Profile setting or `autoFix` field |
| **Prompt Snippets** | Reusable prompt fragments (6 built-in) | `MOAG: Manage Prompt Snippets` |
| **Watch Mode** | Re-runs on file changes | `MOAG: Watch Mode` |
| **Execution Profiles** | Fast / Balanced / Quality / Budget | `MOAG: Switch Profile` |
| **Plan Variables** | `{{varName}}` substitution in prompts | Plan JSON |
| **Conditional Tasks** | `skipIf` controls whether a task runs | Task field |
| **Output Chaining** | Previous output feeds into next prompt | On by default |
| **Parallel Playlists** | Run playlists concurrently (1-8) | `agentTaskPlayer.parallelPlaylists` |
| **Dry Run** | Preview what will execute | `MOAG: Dry Run` |
| **Export Results** | Markdown, JSON, or clipboard | `MOAG: Export Results` |
| **Share as Gist** | Upload plan to GitHub Gist | `MOAG: Share Plan` |
| **Import from URL** | Load plans from any JSON URL | `MOAG: Import Plan from URL` |
| **Create PR** | Open a pull request after execution | `MOAG: Create PR` |
| **Review Changes** | Inline diff viewer for all changes | `MOAG: Review Changes` |
| **Dashboard** | Live output, progress bar, ETA, diffs | `MOAG: Show Dashboard` |
| **Cost Tracking** | Token usage and cost by engine | `MOAG: Show Cost & Usage Summary` |
| **Execution History** | Timestamped logs with stdout/stderr | `MOAG: Show History` |
| **Anthropic API key** | Store or remove the key for the Anthropic API engine (secret storage, never settings) | `MOAG: Set Anthropic API Key` / `MOAG: Clear Anthropic API Key` |
| **ONOSOO Builds** | Pair this machine with ONOSOO, or remove the pairing | `MOAG: Connect to ONOSOO Builds` / `MOAG: Disconnect from ONOSOO` |
| **Command-line tool** | Put `moag` on your PATH, running the CLI bundled in the extension | `MOAG: Install Command-Line Tool` |
| **Diagnostics** | Save a redacted support report (versions, engines, settings, recent errors) | `MOAG: Export Diagnostics` |

---

## Plan Templates

Run `MOAG: New Plan from Template` to start with one of these:

| Category | Template | What It Does |
|----------|----------|-------------|
| **Scaffold** | Next.js Full-Stack App | Pages, API routes, Prisma, auth, tests |
| **Scaffold** | Express REST API | Routes, middleware, validation, error handling |
| **Scaffold** | React Component Library | Components, Storybook, testing, Vite build |
| **Improve** | Add Comprehensive Tests | Unit + integration tests, coverage config |
| **Improve** | TypeScript Migration | Incremental JS-to-TS with strict checks |
| **Improve** | Add CI/CD Pipeline | GitHub Actions: lint, test, build, deploy |
| **Fix** | Security Audit & Fix | OWASP top 10, dependency audit, headers |
| **Fix** | Performance Optimization | Bundle analysis, lazy loading, caching |
| **Fix** | Accessibility Audit | WCAG, ARIA, keyboard nav, a11y tests |
| **Automate** | API Documentation | OpenAPI spec, JSDoc, docs site, examples |
| **Automate** | Database Migration | Migration scripts, seeds, rollback |
| **Automate** | Monorepo Setup | Workspaces, shared packages, Turborepo/Nx |

---

## Smart Features

### AI Auto-Fix

When a task fails, MOAG reads the error output, generates a targeted repair prompt, and retries automatically. Enable via the **Balanced** or **Quality** profile, or set `autoFix: true` on any task. Recovered tasks show a badge in the Dashboard.

### Project Analyzer

MOAG scans your workspace to detect frameworks, languages, missing config, and testing gaps. This powers Smart New Plan — it generates tasks tailored to your actual project, not generic boilerplate.

### Prompt Enhancement

Every prompt is automatically enriched with project context, referenced files, and coding rules. Customize with `agentTaskPlayer.promptRules.*` settings or create reusable snippets via `MOAG: Manage Prompt Snippets`.

### Multi-Agent Peer Review

Insert a review step after any task (`MOAG: Add Review Step`). A different engine reviews the changes and flags bugs, security issues, or style problems.

### Consensus Mode

Run the same task on multiple engines simultaneously. First successful result wins. Use for high-stakes tasks where you want the best output from competing models.

### Watch Mode

Toggle `MOAG: Watch Mode` to re-run tasks when source files change. Edit a spec, watch the agent implement it.

---

## GitHub Integration

| Action | Command | What Happens |
|--------|---------|-------------|
| **Plan from Issue** | `MOAG: Plan from GitHub Issue` | Paste an issue URL, get a runnable plan |
| **Create PR** | `MOAG: Create PR` | Opens a pull request with an execution summary |
| **Share Plan** | `MOAG: Share Plan` | Uploads the plan (redacted) as a **public** GitHub Gist, copies link |
| **Import Plan** | `MOAG: Import Plan from URL` | Load from gist, raw GitHub URL, or any JSON endpoint |
| **Review Changes** | `MOAG: Review Changes` | Inline diff viewer for all file changes |

---

## Autonomous Operation (Headless CLI & Daemon)

MOAG also runs **without a VS Code window** — as a CLI, a single-repo issue loop, or an
always-on multi-repo daemon. It closes the full lifecycle: intake GitHub issues →
develop → test → **(human-approved)** deploy → release → monitor → on incident, file an
issue → back to intake.

```bash
moag run    <plan.json> --full-auto                       # execute a plan, no VS Code
moag loop   --repo org/app --label moag --full-auto       # poll issues → fix → close
moag daemon --config .moag/daemon.json --full-auto        # always-on, multi-repo + monitors
```

New task types power the ship & maintain phases: **`deploy`** (pluggable command + health
smoke gate), **`release`** (tag + GitHub release), and **`monitor`** (health probe → files
an incident on breach). Shipping is **gated** — a `manual` approval task halts the run
(exit 3) until a human approves.

The CLI ships inside the extension: run **MOAG: Install Command-Line Tool** once, open a new
terminal, and `moag --version` works. Updating the extension updates `moag` too.

📖 **Full operator's guide:** [docs/AUTONOMOUS.md](docs/AUTONOMOUS.md) — commands, config,
task-type reference, JSONL output, systemd/cron, and the safety model.

---

## ONOSOO Builds

Connect a machine to the **Builds** app in ONOSOO and the workspace can follow and steer its work:

- **Watch:** live runs, with what each task changed, errors, cost and the pull request. Works with `moag run` on any OS.
- **Control:** start, stop, approve, skip and retry runs from ONOSOO, through `moag daemon` on Linux/WSL.
- **Open it live:** open a running branch inside ONOSOO, through `moag host` on Linux/WSL with Docker.

Pair in one step: **MOAG: Connect to ONOSOO Builds** in VS Code, or `moag pair` in a terminal, with the key from **Builds › Pair machine**. The device key stays in your user folder and never reaches the AI agents. Remote runs execute as a separate locked-down account.

📖 **End-to-end setup, both sides:** [docs/onosoo-builds.md](docs/onosoo-builds.md)

---

## Configuration

### Execution Profiles

Switch with `MOAG: Switch Profile` or the status bar icon:

| Profile | Engine | Timeout | Auto-Fix | Best For |
|---------|--------|---------|----------|----------|
| **Fast** | Claude (fast) | 10 min | Off | Quick iterations |
| **Balanced** | Claude (balanced) | 30 min | On | Daily work |
| **Quality** | Claude (deep) | 45 min | On | Critical tasks |
| **Budget** | Ollama (local) | 10 min | Off | Free, offline |

### Settings

Open `Ctrl+,` → search `agentTaskPlayer`:

| Setting | Default | Description |
|---------|---------|-------------|
| `defaultEngine` | `claude` | Default agent engine |
| `autoplayDelay` | `500` | Delay between tasks (ms) |
| `taskTimeoutMs` | `1800000` | Per-task timeout (30 min) |
| `parallelPlaylists` | `1` | Concurrent playlists (1-8) |
| `costBudgetUsd` | `10` | Hard spend ceiling (USD); calls that report no cost are not counted |
| `maxHistoryEntries` | `200` | History entries to retain |
| `engines.*.command` | varies | CLI path per engine |
| `engines.*.args` | varies | Extra CLI arguments |
| `engines.ollama.model` | `codellama` | Ollama model name |
| `engines.ollama.host` | `""` | Remote Ollama host (`host:port`) for OLLAMA_HOST |
| `engines.custom.command` | `""` | Custom engine command |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+T` | Quick Add Task |
| `Ctrl+Shift+P` → "MOAG" | All commands |

---

## Supported Engines

| Engine | CLI | Install |
|--------|-----|---------|
| **Claude Code** | `claude` | `npm i -g @anthropic-ai/claude-code` |
| **Codex** | `codex` | `npm i -g @openai/codex` |
| **Gemini** | `gemini` | `npm i -g @google/gemini-cli` |
| **Ollama** | `ollama run <model>` | [ollama.com](https://ollama.com) |
| **GitHub Copilot** | none | Uses the GitHub Copilot Chat extension; install it and sign in |
| **Anthropic API** | none | An API key, set with `MOAG: Set Anthropic API Key` (or `ANTHROPIC_API_KEY` for the CLI) |
| **Custom** | Configurable | Any CLI that accepts a prompt |

Engine priority: **task** > **playlist** > **plan `defaultEngine`** > **VS Code setting** > **execution profile**.

---

## Plan File Format

A new plan is saved as `.moag/plan.json`; `.moag/.agent-plan.json` is loaded too (and wins when both exist). A legacy `*.agent-plan.json` at the workspace root is moved into `.moag/` on load.

```json
{
  "version": "1.0",
  "name": "My Plan",
  "defaultEngine": "claude",
  "playlists": [
    {
      "id": "setup",
      "name": "Setup",
      "tasks": [
        {
          "id": "init",
          "name": "Initialize project",
          "prompt": "Create a TypeScript Express API with routes, tests, and error handling",
          "verifyCommand": "npm test",
          "failurePolicy": "continue"
        }
      ]
    }
  ]
}
```

### Task Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier |
| `name` | Yes | Display name |
| `prompt` | Yes | Instruction sent to the agent |
| `type` | No | `agent` (default), `command`, `service`, `check`, `review`, `validate`, `manual`, `visual-test`, `deploy`, `release`, or `monitor` |
| `engine` | No | Override engine for this task |
| `command` | No | Shell command (for command/service/check types) |
| `verifyCommand` | No | Validation command (exit 0 = pass) |
| `failurePolicy` | No | `continue`, `stop`, or `mark-blocked` |
| `retryCount` | No | Retries on failure (default: 0) |
| `autoFix` | No | AI auto-fix on failure |
| `dependsOn` | No | Task IDs that must complete first |
| `files` | No | Files to include as context |
| `skipIf` | No | Condition to skip this task |
| `cwd` | No | Working directory (relative to workspace) |

### Playlist Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier |
| `name` | Yes | Display name |
| `engine` | No | Default engine for tasks in this playlist |
| `parallel` | No | Run all tasks concurrently (default: false) |
| `autoplay` | No | Auto-advance to next task (default: true) |
| `autoplayDelay` | No | Delay between tasks (ms) |

---

## Development

```bash
git clone https://github.com/sujan-poudel-03/moag.git
cd moag && npm install
npm run compile      # build
npm run watch        # dev mode
npm test             # unit tests (Mocha + Sinon)
npm run lint         # ESLint
npm run package      # build .vsix
```

---

## Contributing

1. Fork → branch → make changes → add tests
2. `npm run lint && npm test`
3. Open a Pull Request

---

## License

[MIT](LICENSE)
