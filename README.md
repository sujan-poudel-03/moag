# Agent Task Player

[![CI](https://github.com/sujan-poudel-03/moag/actions/workflows/ci.yml/badge.svg)](https://github.com/sujan-poudel-03/moag/actions/workflows/ci.yml)
[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/moag.agent-task-player)](https://marketplace.visualstudio.com/items?itemName=moag.agent-task-player)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/moag.agent-task-player)](https://marketplace.visualstudio.com/items?itemName=moag.agent-task-player)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> A music-player for AI coding tasks: define **playlists** of **tasks** and play them sequentially using coding agent CLIs.

Hit Play and watch your agents work through a structured plan, one task at a time — Claude Code, Codex, Gemini CLI, Ollama, or any custom CLI.

<!-- ![Screenshot](media/screenshot.png) -->
<!-- To add a screenshot: capture the extension in action and save as media/screenshot.png -->

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

### Multi-Engine Support
Run each task with a different AI agent engine:

| Engine | CLI Command | Notes |
|--------|-------------|-------|
| Claude Code | `claude -p` | Non-interactive print mode |
| Codex | `codex exec` | Non-interactive execution mode |
| Gemini | `gemini` | Google Gemini CLI |
| Ollama | `ollama run <model>` | Local LLMs (default: codellama) |
| Custom | Configurable | Any CLI with `{prompt}` placeholder |

Engine priority: task override > playlist default > plan default > VS Code setting.

### Task Dependencies & Retries
- **Dependencies** — specify `dependsOn` to ensure tasks run only after their prerequisites complete
- **Retries** — set `retryCount` to automatically retry failed tasks (with a 2-second delay between attempts)
- **Parallel execution** — set `parallel: true` on a playlist to run all its tasks concurrently

### Task Templates
- Built-in template library with common development tasks (setup, features, testing, bugfix, refactor, docs)
- Save any task as a reusable template
- Add tasks from templates via right-click context menu

### Plan Import / Export
- Export a plan to a file or copy to clipboard for sharing
- Import a plan from a file or paste from clipboard
- Plans are portable `.agent-plan.json` files with no runtime state

### Cost & Usage Tracking
- Token usage tracking per task execution (when available from the engine)
- Aggregated cost summary by engine with total duration and token counts
- View the summary via **Show Cost & Usage Summary** command

### Execution History
- Timestamped logs for every task run
- Stdout, stderr, exit code, and duration captured
- Grouped by date in the History sidebar
- Click any entry to view full details in a Markdown document

### Dashboard Webview
- Tabbed UI: **Plan** / **Output** / **History**
- Live output streaming during execution
- Inline play/pause/stop controls and status badge

### Verification Commands
- Attach a shell command (e.g., `npm test`) to any task
- Runs automatically after a successful task — if it exits non-zero, the task is marked as failed

---

## Quick Start

1. **Install** the extension from the VS Code Marketplace (or install from `.vsix`)
2. Click the **Agent Task Player** icon in the Activity Bar (rocket icon)
3. Click **New Plan** to create a `.agent-plan.json` file in your workspace
4. **Add playlists** (groups/phases) and **tasks** (individual agent instructions)
5. Ensure at least one agent CLI is installed and on your `PATH` (e.g., `claude`, `codex`)
6. Hit **Play** and watch the output stream in the Dashboard

---

## Plan File Format

Plans are stored as `.agent-plan.json` files. The extension auto-loads the first one found in your workspace.

```jsonc
{
  "version": "1.0",
  "name": "My Project Plan",
  "description": "Optional description",        // optional
  "defaultEngine": "claude",                     // global default engine
  "playlists": [
    {
      "id": "pl-setup",
      "name": "Setup",
      "engine": "claude",                        // optional playlist-level override
      "autoplay": true,                          // auto-advance to next task (default: true)
      "autoplayDelay": 3000,                     // optional delay override (ms)
      "parallel": false,                         // run tasks concurrently (default: false)
      "tasks": [
        {
          "id": "task-1",
          "name": "Initialize project",
          "prompt": "Create a new Node.js project with TypeScript and Express",
          "engine": "codex",                     // optional task-level override
          "cwd": "./backend",                    // optional working directory
          "files": ["package.json", "tsconfig.json"],  // context files
          "verifyCommand": "npm test",           // optional verification
          "retryCount": 1,                       // retry once on failure (default: 0)
          "dependsOn": []                        // task IDs that must complete first
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

## Supported Engines

| Engine | Package / Install | Typical Command |
|--------|-------------------|-----------------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude -p "prompt"` |
| Codex | `npm install -g @openai/codex` | `codex exec "prompt"` |
| Gemini CLI | `npm install -g @google/gemini-cli` | `gemini "prompt"` |
| Ollama | [ollama.com](https://ollama.com) | `ollama run codellama "prompt"` |
| Custom | Any CLI | Configure in settings |

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
- Visual dependency graph between tasks
- Multi-workspace plan management
- Conditional task execution (run only if previous output matches pattern)

---

## License

[MIT](LICENSE)
