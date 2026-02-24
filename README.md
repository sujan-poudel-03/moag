# Agent Task Player

[![CI](https://github.com/sujan-poudel-03/moag/actions/workflows/ci.yml/badge.svg)](https://github.com/sujan-poudel-03/moag/actions/workflows/ci.yml)
[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/moag.agent-task-player)](https://marketplace.visualstudio.com/items?itemName=moag.agent-task-player)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/moag.agent-task-player)](https://marketplace.visualstudio.com/items?itemName=moag.agent-task-player)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Define structured plans of AI coding tasks and execute them automatically through agent CLIs — Claude Code, Codex, Gemini CLI, Ollama, or any custom CLI.

**The problem:** You're building a project and need to give an AI agent 10+ separate instructions — scaffold the project, add auth, write tests, etc. Doing them one by one is tedious. You lose context between tasks, forget steps, and can't reproduce the workflow.

**The solution:** Write all your instructions in a plan file, organize them into playlists (phases), then hit Play. The extension feeds each prompt to the agent CLI sequentially, streams the output, and tracks what passed or failed.

---

## How It Works

```
┌─────────────────────┐     ┌──────────────┐     ┌──────────────┐
│  .agent-plan.json   │     │  Extension   │     │  Agent CLI   │
│                     │────>│  reads plan, │────>│  claude -p   │
│  Playlists > Tasks  │     │  feeds each  │     │  codex exec  │
│  (your prompts)     │<────│  prompt      │<────│  gemini      │
│                     │     │  to the CLI  │     │  ollama run  │
└─────────────────────┘     └──────────────┘     └──────────────┘
```

1. You write a `.agent-plan.json` file with your prompts organized into playlists
2. The extension sends each prompt to the agent CLI installed on your machine
3. The agent reads/writes your actual project files
4. The extension tracks results, moves to the next task, and reports status

---

## Quick Start

### Prerequisites

You need at least **one** coding agent CLI installed and available in your terminal:

```bash
# Pick one (or more):
npm install -g @anthropic-ai/claude-code   # Claude Code
npm install -g @openai/codex               # OpenAI Codex
npm install -g @google/gemini-cli          # Gemini CLI
# Or install Ollama from https://ollama.com
```

Verify it works by running the CLI directly, e.g.: `claude -p "say hello"`.

### Step-by-Step

1. **Install** the extension from the VS Code Marketplace (or `.vsix` file)
2. **Open a workspace** folder where you want the agent to work
3. Click the **rocket icon** in the Activity Bar — the Agent Task Player panel opens
4. Click **New Plan** — give it a name — a `.agent-plan.json` file is created
5. Click the **+** button to **Add Playlist** — name it (e.g., "Setup")
6. Click the **+** on the playlist to **Add Task** — enter a name and a prompt
7. Hit **Play** — the extension validates the engine is installed, then starts executing

The agent CLI receives your prompt, works on your project files, and the extension streams the output in real-time in the Dashboard panel.

### Or: Write the Plan File Directly

You can also create a `.agent-plan.json` file by hand — the extension auto-loads it:

```json
{
  "version": "1.0",
  "name": "My First Plan",
  "defaultEngine": "claude",
  "playlists": [
    {
      "id": "setup",
      "name": "Setup",
      "autoplay": true,
      "tasks": [
        {
          "id": "task-1",
          "name": "Create project",
          "prompt": "Create a new Node.js project with TypeScript and Express. Set up package.json, tsconfig.json, and a basic hello world server."
        }
      ]
    }
  ]
}
```

Save it in your workspace, open the Agent Task Player panel, and hit Play.

---

## Use Cases

### 1. Scaffold a Full Project from Scratch

Create a plan that builds a project step by step — each task builds on the previous one:

```json
{
  "version": "1.0",
  "name": "Build a FastAPI Backend",
  "defaultEngine": "claude",
  "playlists": [
    {
      "id": "setup",
      "name": "Project Setup",
      "autoplay": true,
      "tasks": [
        {
          "id": "init",
          "name": "Initialize project",
          "prompt": "Create a Python FastAPI project with pyproject.toml. Set up app/ directory with main.py. Add a health check endpoint at GET /health."
        },
        {
          "id": "db",
          "name": "Add database layer",
          "prompt": "Add SQLAlchemy with SQLite. Create app/models/ with a User model (id, email, name, created_at). Add Alembic for migrations.",
          "dependsOn": ["init"]
        }
      ]
    },
    {
      "id": "features",
      "name": "Build Features",
      "autoplay": true,
      "tasks": [
        {
          "id": "crud",
          "name": "User CRUD endpoints",
          "prompt": "Create CRUD endpoints for users: GET /users, POST /users, GET /users/{id}, PUT /users/{id}, DELETE /users/{id}. Use Pydantic schemas for validation.",
          "verifyCommand": "python -m pytest tests/ -x --tb=short"
        },
        {
          "id": "auth",
          "name": "JWT authentication",
          "prompt": "Add JWT auth with python-jose. Create POST /auth/login and POST /auth/register. Protect write endpoints with auth middleware.",
          "dependsOn": ["crud"],
          "retryCount": 1
        }
      ]
    }
  ]
}
```

**What happens:** Hit Play — the agent creates the project, adds the database, builds CRUD endpoints (verified with pytest), then adds auth. Each task works on the same workspace files, building on the previous results.

### 2. Add Features to an Existing Project

Already have a codebase? Create a plan to add a batch of features:

```json
{
  "version": "1.0",
  "name": "Q1 Feature Sprint",
  "defaultEngine": "claude",
  "playlists": [
    {
      "id": "features",
      "name": "New Features",
      "autoplay": true,
      "tasks": [
        {
          "id": "dark-mode",
          "name": "Add dark mode",
          "prompt": "Add dark mode to this React app. Create a ThemeContext, toggle button in the navbar, CSS variables for theming, persist preference in localStorage.",
          "files": ["src/App.tsx", "src/styles/globals.css"]
        },
        {
          "id": "search",
          "name": "Add search",
          "prompt": "Add a search bar that filters the product list in real-time with debounced input (300ms). Search across name, description, and category.",
          "files": ["src/components/ProductList.tsx", "src/types.ts"]
        }
      ]
    }
  ]
}
```

**Tip:** The `files` field injects file contents into the prompt, giving the agent context about your existing code without you having to paste it manually.

### 3. Testing & Code Quality Sprint

Run a quality pass — write tests in parallel, then refactor:

```json
{
  "version": "1.0",
  "name": "Code Quality Pass",
  "defaultEngine": "claude",
  "playlists": [
    {
      "id": "testing",
      "name": "Write Tests",
      "parallel": true,
      "tasks": [
        {
          "id": "unit-tests",
          "name": "Unit tests for utils",
          "prompt": "Write unit tests for all functions in src/utils/ using Jest. Cover edge cases and error handling.",
          "verifyCommand": "npx jest src/utils/ --coverage"
        },
        {
          "id": "api-tests",
          "name": "API integration tests",
          "prompt": "Write integration tests for all routes in src/routes/ using supertest. Test success, validation errors, auth failures, 404s.",
          "verifyCommand": "npx jest src/routes/"
        }
      ]
    },
    {
      "id": "refactor",
      "name": "Refactor",
      "tasks": [
        {
          "id": "cleanup",
          "name": "Fix code smells",
          "prompt": "Review the codebase for duplicated logic, long functions, deeply nested conditionals, magic numbers. Refactor what you find. Do not change public API signatures."
        }
      ]
    }
  ]
}
```

**Note:** `"parallel": true` makes both test tasks run concurrently since they don't depend on each other.

### 4. Multi-Engine Workflow

Use different agents for different tasks based on their strengths:

```json
{
  "version": "1.0",
  "name": "Multi-Agent Build",
  "defaultEngine": "claude",
  "playlists": [
    {
      "id": "build",
      "name": "Build & Review",
      "autoplay": true,
      "tasks": [
        {
          "id": "implement",
          "name": "Implement feature",
          "prompt": "Implement user authentication with JWT tokens, bcrypt password hashing, and login/register endpoints.",
          "engine": "claude"
        },
        {
          "id": "review",
          "name": "Code review",
          "prompt": "Review all code in this project. List any bugs, security issues, or improvements needed.",
          "engine": "ollama"
        }
      ]
    }
  ]
}
```

Engine priority: **task** `engine` > **playlist** `engine` > **plan** `defaultEngine` > **VS Code setting**.

---

## Features

### Plan Editor
- Side panel tree showing playlists and tasks
- Add, edit, reorder, and delete playlists and tasks inline
- Drag-and-drop reordering in the tree view
- Live status icons: pending, running, completed, failed, skipped

### Transport Controls (Play / Pause / Stop)
- **Play** — runs tasks sequentially across all playlists
- **Pause** — waits for the current task to finish, then holds
- **Stop** — kills the running process and halts immediately
- Configurable autoplay delay between tasks

### Pre-flight Engine Validation
- Before running, the extension checks if the required CLI tools are installed on your system
- Shows a clear warning with options: **Run Anyway** or **Open Settings**
- Scoped: validates only the engines needed for what you're about to run

### Multi-Engine Support

| Engine | CLI Command | Install |
|--------|-------------|---------|
| Claude Code | `claude -p` | `npm i -g @anthropic-ai/claude-code` |
| Codex | `codex exec` | `npm i -g @openai/codex` |
| Gemini | `gemini` | `npm i -g @google/gemini-cli` |
| Ollama | `ollama run <model>` | [ollama.com](https://ollama.com) |
| Custom | Configurable | Any CLI with `{prompt}` placeholder |

### Task Dependencies & Retries
- **Dependencies** — `dependsOn` ensures tasks run only after prerequisites complete successfully
- **Retries** — `retryCount` automatically retries failed tasks
- **Parallel** — `parallel: true` on a playlist runs all its tasks concurrently

### Task Templates
- Built-in template library (setup, features, testing, bugfix, refactor, docs)
- Save any task as a reusable template
- Add tasks from templates via right-click context menu

### Plan Import / Export
- Export to file or clipboard for sharing with teammates
- Import from file or clipboard
- Plans are portable `.agent-plan.json` files with no runtime state

### Cost & Usage Tracking
- Token usage tracking per task execution (when available from the engine)
- Aggregated cost summary by engine
- View via **Show Cost & Usage Summary** command

### Execution History
- Timestamped logs for every task run with stdout, stderr, exit code, duration
- Grouped by date in the History sidebar
- Click any entry for full details

### Dashboard Webview
- Tabbed UI: **Plan** / **Output** / **History**
- Live output streaming during execution
- Inline play/pause/stop controls and status badge

### Verification Commands
- Attach a shell command (e.g., `npm test`) to any task
- Runs after a successful task — if it exits non-zero, the task is marked as failed

---

## Plan File Format

Plans are `.agent-plan.json` files. The extension auto-loads the first one found in your workspace.

### Task Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier |
| `name` | Yes | Display name shown in tree view |
| `prompt` | Yes | Instruction sent to the agent CLI |
| `engine` | No | Override the playlist/plan default engine |
| `cwd` | No | Working directory (relative to workspace root) |
| `files` | No | File paths whose contents are appended to the prompt as context |
| `verifyCommand` | No | Shell command to validate the result (exit 0 = pass) |
| `retryCount` | No | Number of retries on failure (default: 0 = no retry) |
| `dependsOn` | No | Array of task IDs that must complete before this task runs |

### Playlist Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier |
| `name` | Yes | Display name shown in tree view |
| `engine` | No | Default engine for tasks in this playlist |
| `autoplay` | No | Auto-advance to next task (default: true) |
| `autoplayDelay` | No | Delay in ms between tasks (overrides global setting) |
| `parallel` | No | Run all tasks concurrently (default: false) |

---

## Configuration Reference

Open VS Code Settings (`Ctrl+,`) and search for `agentTaskPlayer`:

| Setting | Default | Description |
|---------|---------|-------------|
| `agentTaskPlayer.defaultEngine` | `claude` | Default agent engine for all tasks |
| `agentTaskPlayer.engines.codex.command` | `codex` | Codex CLI path or command name |
| `agentTaskPlayer.engines.codex.args` | `[]` | Extra arguments for Codex CLI |
| `agentTaskPlayer.engines.claude.command` | `claude` | Claude Code CLI path or command name |
| `agentTaskPlayer.engines.claude.args` | `["-p"]` | Arguments for Claude Code (default: print mode) |
| `agentTaskPlayer.engines.gemini.command` | `gemini` | Gemini CLI path or command name |
| `agentTaskPlayer.engines.gemini.args` | `[]` | Extra arguments for Gemini CLI |
| `agentTaskPlayer.engines.ollama.command` | `ollama` | Ollama CLI path or command name |
| `agentTaskPlayer.engines.ollama.model` | `codellama` | Model name for Ollama |
| `agentTaskPlayer.engines.custom.command` | `""` | Custom engine command (required for custom engine) |
| `agentTaskPlayer.engines.custom.args` | `[]` | Custom engine arguments; use `{prompt}` as placeholder |
| `agentTaskPlayer.autoplayDelay` | `2000` | Delay in ms between tasks during autoplay |
| `agentTaskPlayer.maxHistoryEntries` | `200` | Maximum number of history entries to keep |

---

## Commands Reference

All commands are available via the Command Palette (`Ctrl+Shift+P`):

| Command | Description |
|---------|-------------|
| Agent Task Player: Play | Start or resume execution |
| Agent Task Player: Pause | Pause between tasks |
| Agent Task Player: Stop | Stop execution and kill running process |
| Agent Task Player: Open Plan File | Load an existing `.agent-plan.json` |
| Agent Task Player: New Plan | Create a new plan file |
| Agent Task Player: Add Playlist | Add a playlist to the current plan |
| Agent Task Player: Add Task | Add a task to a playlist |
| Agent Task Player: Add Task from Template | Add a task from the template library |
| Agent Task Player: Save as Template | Save a task as a reusable template |
| Agent Task Player: Edit Task | Edit task properties |
| Agent Task Player: Delete | Delete a playlist or task |
| Agent Task Player: Move Up | Move item up in its list |
| Agent Task Player: Move Down | Move item down in its list |
| Agent Task Player: Show History | View execution history details |
| Agent Task Player: Show Dashboard | Open the webview dashboard |
| Agent Task Player: Clear History | Clear all execution history |
| Agent Task Player: Play Playlist | Run a single playlist |
| Agent Task Player: Run Task | Run a single task |
| Agent Task Player: Export Plan | Export plan to file or clipboard |
| Agent Task Player: Import Plan | Import plan from file or clipboard |
| Agent Task Player: Show Cost & Usage Summary | View token usage and cost breakdown |

---

## Development

### Prerequisites
- Node.js 20+
- VS Code 1.85.0+

### Setup
```bash
git clone https://github.com/sujan-poudel-03/moag.git
cd moag
npm install
```

### Build
```bash
npm run compile    # one-time build
npm run watch      # watch mode
```

### Test
```bash
npm run test:unit          # unit tests (Mocha + Sinon)
npm run test:integration   # integration tests (VS Code Extension Host)
npm test                   # alias for test:unit
```

### Lint
```bash
npm run lint
```

### Package
```bash
npm run package    # produces a .vsix file
```

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes and add tests
4. Run `npm run lint && npm test` to verify
5. Commit and push
6. Open a Pull Request

---

## Roadmap

- ~~Parallel task execution within a playlist~~ Done
- ~~Drag-and-drop reordering in the tree view~~ Done
- ~~Task templates and snippet library~~ Done
- ~~Cost/token tracking per engine~~ Done
- ~~Plan import/export and sharing~~ Done
- ~~Pre-flight engine availability validation~~ Done
- Visual dependency graph between tasks
- Multi-workspace plan management
- Conditional task execution (run only if previous output matches pattern)

---

## License

[MIT](LICENSE)
