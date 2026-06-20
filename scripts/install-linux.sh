#!/usr/bin/env bash
#
# MOAG — build, package, and (re)install the extension into VS Code on Linux.
#
#   ./scripts/install-linux.sh            # build → package → install/update extension
#   ./scripts/install-linux.sh --app      # also try to update the VS Code app (best-effort)
#
# Updates the installed MOAG extension to the current source. VS Code itself
# auto-updates; pass --app to attempt an app upgrade via apt/snap.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
UPDATE_APP=0
[ "${1:-}" = "--app" ] && UPDATE_APP=1

say() { printf '  %s\n' "$*"; }

# ── Ensure node/npm are available (also check a local portable install) ──
if ! command -v npm >/dev/null 2>&1; then
  [ -d "$HOME/.local/node/bin" ] && export PATH="$HOME/.local/node/bin:$PATH"
fi
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm not found. Install Node.js 18+ first." >&2; exit 1; }

# ── Locate the VS Code CLI (stable, insiders, or remote/server) ──
find_code() {
  for c in code code-insiders codium; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; return; }; done
  for c in /usr/bin/code /snap/bin/code "$HOME"/.vscode-server/cli/servers/*/server/bin/remote-cli/code; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  return 1
}
CODE="$(find_code || true)"
[ -n "$CODE" ] || { echo "ERROR: VS Code CLI ('code') not found on PATH or in standard locations." >&2; exit 1; }
say "VS Code CLI : $CODE"

# ── Build ──
[ -d node_modules ] || { say "Installing dependencies…"; npm install; }
say "Compiling…"; npm run compile

# ── Package VSIX ──
VERSION="$(node -p "require('./package.json').version")"
VSIX="agent-task-player-${VERSION}.vsix"
say "Packaging ${VSIX}…"
npx --yes vsce package --no-dependencies --allow-missing-repository --skip-license -o "$VSIX"

# ── Install / update the extension ──
say "Installing extension into VS Code…"
"$CODE" --install-extension "$VSIX" --force

# ── Optional: update the VS Code app itself ──
if [ "$UPDATE_APP" = "1" ]; then
  say "Attempting VS Code app update (best-effort)…"
  if command -v snap >/dev/null 2>&1 && snap list code >/dev/null 2>&1; then
    sudo snap refresh code || say "snap refresh skipped"
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install --only-upgrade -y code || say "apt upgrade skipped"
  else
    say "No supported package manager (snap/apt) found — update VS Code manually."
  fi
fi

echo
say "✅ Done. Installed MOAG ${VERSION}. Reload VS Code (Ctrl+Shift+P → 'Reload Window') to activate."
