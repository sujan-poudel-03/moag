# Changelog

## [0.2.0] - 2026-02-14

### Added
- ESLint configuration with `@typescript-eslint` recommended rules
- Unit test suite (Mocha + Sinon) covering models, utils, adapters, history store, and runner
- Integration tests verifying extension activation and command registration
- CI/CD via GitHub Actions (lint, build, test on ubuntu/windows/macos)
- Publish workflow triggered by version tags
- Test infrastructure: `tsconfig.test.json`, `.vscode-test.mjs`, VS Code test debug launch config
- Marketplace-ready README with badges, detailed feature docs, and configuration reference

### Changed
- Updated `package.json` with test dependencies, scripts, gallery banner, and badges
- Enhanced `.vscodeignore` to exclude test and config files from packaged extension
- Added `Extension Tests` debug configuration to `.vscode/launch.json`
- Added eslint-disable comments for intentional non-null assertions in `runner.ts` and `history-tree.ts`

### Removed
- `vsc-extension-quickstart.md` (scaffolding file)
- `agent-task-player-0.1.0.vsix` (build artifact should not be in version control)

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
