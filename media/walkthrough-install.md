> **Auto-detection**: Agent Task Player scans your PATH for known CLIs on first launch and auto-selects the best available engine. Re-run anytime via Command Palette: **Agent Task Player: Detect Installed Engines**.

## Install a Coding Agent CLI

The extension runs your prompts through a coding agent CLI installed on your machine.

```bash
# Claude Code (recommended)
npm install -g @anthropic-ai/claude-code

# OpenAI Codex
npm install -g @openai/codex

# Google Gemini CLI
npm install -g @google/gemini-cli

# Ollama (local models)
# Download from https://ollama.com
```

### Verify it works

```bash
claude -p "say hello"
# Should print a response from Claude
```

> The extension uses **non-interactive mode** — it passes your prompt as a CLI argument and captures the output. The agent reads and writes files in your workspace just like it would in a terminal.
