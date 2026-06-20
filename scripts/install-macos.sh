#!/usr/bin/env bash
#
# MOAG — build, package, and (re)install the extension into VS Code on macOS.
#
#   ./scripts/install-macos.sh            # build → package → install/update extension
#   ./scripts/install-macos.sh --app      # also try to update the VS Code app via Homebrew
#
# Updates the installed MOAG extension to the current source. VS Code itself
# auto-updates; pass --app to attempt an app upgrade via Homebrew.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
UPDATE_APP=0
[ "${1:-}" = "--app" ] && UPDATE_APP=1

say() { printf '  %s\n' "$*"; }

# ── Ensure node/npm are available (Homebrew or nvm typically put it on PATH) ──
if ! command -v npm >/dev/null 2>&1; then
  [ -d "$HOME/.local/node/bin" ] && export PATH="$HOME/.local/node/bin:$PATH"
  [ -x /opt/homebrew/bin/npm ] && export PATH="/opt/homebrew/bin:$PATH"
fi
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm not found. Install Node.js 18+ (e.g. 'brew install node')." >&2; exit 1; }

# ── Locate the VS Code CLI (PATH, then the app bundle's bin) ──
find_code() {
  for c in code code-insiders codium; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; return; }; done
  for c in \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  return 1
}
CODE="$(find_code || true)"
[ -n "$CODE" ] || { echo "ERROR: VS Code CLI ('code') not found. In VS Code run: Shell Command: Install 'code' command in PATH." >&2; exit 1; }
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
  if command -v brew >/dev/null 2>&1; then
    brew upgrade --cask visual-studio-code || say "brew upgrade skipped"
  else
    say "Homebrew not found — update VS Code manually or via its in-app updater."
  fi
fi

echo
say "✅ Done. Installed MOAG ${VERSION}. Reload VS Code (Cmd+Shift+P → 'Reload Window') to activate."
