# Changelog

## [0.1.0] - 2026-02-12

### Added
- Plan editor with TreeView sidebar for playlists and tasks
- Play / Pause / Stop controls with state machine
- Sequential task runner using `child_process.spawn()`
- Engine adapters: Claude Code, Codex, Gemini CLI, Ollama, Custom
- Webview dashboard with Plan, Output, and History tabs
- Execution history stored via VS Code workspace state
- Live status icons in the tree view (pending, running, completed, failed)
- Optional verification commands per task
- Configurable autoplay delay between tasks
- `.agent-plan.json` file format for defining plans
- Auto-load plan files from workspace on activation
