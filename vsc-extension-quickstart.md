# Agent Task Player — Quick Start

## Setup

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Or watch for changes during development
npm run watch
```

## Run & Debug

1. Open this folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. In the new VS Code window, the **Agent Task Player** icon appears in the Activity Bar

## Usage

### Create a Plan
1. Click the **Agent Task Player** icon in the Activity Bar
2. Click the **New Plan** button in the Plan view toolbar
3. Enter a plan name — a `.agent-plan.json` file is created in your workspace

### Add Playlists & Tasks
1. Click **Add Playlist** in the toolbar or right-click menu
2. Right-click a playlist and choose **Add Task**
3. Enter a task name and prompt (the instruction for the AI agent)

### Run Tasks
- **Play** — runs all tasks in order across all playlists
- **Pause** — pauses between tasks (current task finishes)
- **Stop** — stops execution and kills the current process
- Right-click a playlist or task to run it individually

### Configure Engines
Open VS Code Settings and search for `agentTaskPlayer` to configure:
- Default engine (`claude`, `codex`, `gemini`, `ollama`, `custom`)
- CLI paths and arguments for each engine
- Autoplay delay between tasks

### View History
- The **History** panel in the sidebar shows past executions
- Click an entry to view full logs, prompt, and output
- Use **Clear History** to reset

## Plan File Format

Plans are stored as `.agent-plan.json` files. See `examples/demo.agent-plan.json` for a complete example.

```json
{
  "version": "1.0",
  "name": "My Plan",
  "defaultEngine": "claude",
  "playlists": [
    {
      "id": "unique-id",
      "name": "Playlist Name",
      "autoplay": true,
      "tasks": [
        {
          "id": "task-id",
          "name": "Task Name",
          "prompt": "Instruction for the AI agent",
          "engine": "claude",
          "files": ["src/index.ts"],
          "verifyCommand": "npm test"
        }
      ]
    }
  ]
}
```

## Supported Engines

| Engine | CLI Command | Notes |
|--------|-------------|-------|
| Claude Code | `claude -p` | Non-interactive print mode |
| Codex | `codex` | OpenAI Codex CLI |
| Gemini | `gemini` | Google Gemini CLI |
| Ollama | `ollama run <model>` | Local LLM |
| Custom | Configurable | Use `{prompt}` placeholder in args |
