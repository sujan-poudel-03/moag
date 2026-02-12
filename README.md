# Agent Task Player

Define **playlists** (epochs) of **tasks** (steps) and play them sequentially using coding agent CLIs — Claude Code, Codex, Gemini CLI, Ollama, or any custom CLI.

Think of it as a music player for AI coding tasks: hit Play and watch your agents work through a structured plan, one task at a time.

## Features

### Plan Editor
- Side panel tree showing playlists and tasks
- Add, edit, reorder, and delete playlists and tasks
- Live status icons (pending, running, completed, failed)

### Play / Pause / Stop Controls
- **Play** — runs tasks sequentially across all playlists
- **Pause** — waits for the current task to finish, then holds
- **Stop** — kills the running process and halts execution
- Configurable autoplay delay between tasks

### Multi-Engine Support
Run each task with a different agent engine:

| Engine | CLI | Notes |
|--------|-----|-------|
| Claude Code | `claude -p` | Non-interactive print mode |
| Codex | `codex` | OpenAI Codex CLI |
| Gemini | `gemini` | Google Gemini CLI |
| Ollama | `ollama run <model>` | Local LLMs |
| Custom | Configurable | Any CLI with `{prompt}` placeholder |

### Execution History
- Timestamped logs for every task run
- Stdout, stderr, exit code, and duration
- Grouped by date in the sidebar
- Click any entry to view full details

### Dashboard Webview
- Tabbed UI: Plan / Output / History
- Live output streaming during execution
- Inline task editing

## Getting Started

1. Install the extension
2. Click the **Agent Task Player** icon in the Activity Bar
3. Click **New Plan** to create a `.agent-plan.json` file
4. Add playlists and tasks
5. Hit **Play**

## Plan File Format

Plans are stored as `.agent-plan.json` files in your workspace.

```json
{
  "version": "1.0",
  "name": "My Project Plan",
  "defaultEngine": "claude",
  "playlists": [
    {
      "id": "pl-setup",
      "name": "Setup",
      "autoplay": true,
      "tasks": [
        {
          "id": "task-1",
          "name": "Initialize project",
          "prompt": "Create a new Node.js project with TypeScript and Express",
          "engine": "claude",
          "files": ["package.json", "tsconfig.json"],
          "verifyCommand": "npm test"
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
| `prompt` | Yes | Instruction sent to the agent CLI |
| `engine` | No | Override the playlist/plan default engine |
| `cwd` | No | Working directory (relative to workspace root) |
| `files` | No | File paths to include as context in the prompt |
| `verifyCommand` | No | Shell command to validate the result (exit 0 = pass) |

## Configuration

Open VS Code Settings and search for `agentTaskPlayer`:

| Setting | Default | Description |
|---------|---------|-------------|
| `defaultEngine` | `claude` | Default agent engine |
| `engines.codex.command` | `codex` | Codex CLI path |
| `engines.claude.command` | `claude` | Claude Code CLI path |
| `engines.claude.args` | `["-p"]` | Claude Code arguments |
| `engines.gemini.command` | `gemini` | Gemini CLI path |
| `engines.ollama.command` | `ollama` | Ollama CLI path |
| `engines.ollama.model` | `codellama` | Ollama model name |
| `engines.custom.command` | `""` | Custom engine command |
| `engines.custom.args` | `[]` | Custom args (`{prompt}` placeholder) |
| `autoplayDelay` | `2000` | Delay (ms) between tasks |
| `maxHistoryEntries` | `200` | Max history entries to keep |

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P`):

- **Agent Task Player: Play** — start or resume execution
- **Agent Task Player: Pause** — pause between tasks
- **Agent Task Player: Stop** — stop execution
- **Agent Task Player: Open Plan File** — load an existing plan
- **Agent Task Player: New Plan** — create a new plan
- **Agent Task Player: Add Playlist** — add a playlist to the current plan
- **Agent Task Player: Add Task** — add a task to a playlist
- **Agent Task Player: Show Dashboard** — open the webview dashboard
- **Agent Task Player: Show History** — view execution history

## Requirements

- VS Code 1.85.0 or later
- At least one agent CLI installed and available on your PATH (e.g., `claude`, `codex`, `gemini`, `ollama`)

## License

MIT
