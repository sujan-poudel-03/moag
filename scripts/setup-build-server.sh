#!/usr/bin/env bash
#
# MOAG — prepare a Linux (or WSL2 Ubuntu) machine as an ONOSOO build server.
#
#   bash scripts/setup-build-server.sh [--source <path-or-git-url>] [--branch <name>]
#
# Run it as your own login (not root); it asks for your sudo password where needed.
# Safe to run again: every step checks before it changes anything.
#
# What it does (see docs/onosoo-remote.md and docs/host-agent.md):
#   1. base packages, Node 20 at /usr/bin/node, git >= 2.45.1
#   2. Docker Engine + Compose plugin, and your login in the docker group
#   3. MOAG built at /opt/moag (read-only for the runner) and a `moag` wrapper
#   4. the dedicated runner account `moag-runner` and the sudoers rule for remote runs
#   5. a starter ~/.config/moag/projects.json with remote starts OFF
#   6. a developer clone at ~/src/moag for running the test suite on Linux
#
# It never writes the ONOSOO device key: export MOAG_ONOSOO_URL / MOAG_ONOSOO_KEY yourself
# (or put them in ~/.config/moag/onosoo.json, mode 0600).
set -euo pipefail

SOURCE="/mnt/d/Projects/moag"
BRANCH="feat/sdlc-automation"
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

RUNNER=moag-runner
ME="$(id -un)"
say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

[ "$(id -u)" -ne 0 ] || { echo "Run this as your own login, not root." >&2; exit 1; }
command -v apt-get >/dev/null || { echo "This script expects Ubuntu/Debian (apt-get)." >&2; exit 1; }

# ── WSL: systemd is needed for the docker service ───────────────────────────
if grep -qi microsoft /proc/version 2>/dev/null; then
  if [ "$(ps -p 1 -o comm= 2>/dev/null)" != "systemd" ]; then
    say "WSL without systemd"
    printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf >/dev/null
    note "Enabled systemd in /etc/wsl.conf. In Windows PowerShell run:  wsl --shutdown"
    note "then open Ubuntu again and re-run this script."
    exit 0
  fi
fi

say "1/6 Base packages and Node 20"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git build-essential rsync
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "20" ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
note "node: $NODE_BIN $(node --version)"
[ "$NODE_BIN" = "/usr/bin/node" ] || note "WARNING: node is not /usr/bin/node; the sudoers rule below uses $NODE_BIN"
GIT_V="$(git --version | awk '{print $3}')"
if ! printf '2.45.1\n%s\n' "$GIT_V" | sort -V -C; then
  note "git $GIT_V is older than 2.45.1 (the host agent needs it); adding the git-core PPA"
  sudo apt-get install -y software-properties-common
  sudo add-apt-repository -y ppa:git-core/ppa
  sudo apt-get update -y && sudo apt-get install -y git
fi
note "git: $(git --version)"

say "2/6 Docker Engine and Compose"
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
sudo systemctl enable --now docker >/dev/null 2>&1 || true
if ! id -nG "$ME" | grep -qw docker; then
  sudo usermod -aG docker "$ME"
  note "Added $ME to the docker group (takes effect after you log out and in: in WSL, 'wsl --shutdown')."
fi
note "$(docker --version)"; note "$(docker compose version)"

say "3/6 MOAG at /opt/moag"
# git runs as you (git refuses repos owned by someone else); /opt/moag is handed to root afterwards.
sudo mkdir -p /opt/moag
sudo chown -R "$ME":"$ME" /opt/moag
if [ ! -d /opt/moag/.git ]; then
  git clone -q "$SOURCE" /opt/moag
fi
git -C /opt/moag fetch --all --quiet || true
git -C /opt/moag checkout -q "$BRANCH"
git -C /opt/moag pull -q --ff-only || true
( cd /opt/moag && npm ci --no-audit --no-fund && npm run compile )
sudo chown -R root:root /opt/moag
sudo chmod -R go-w,a+rX /opt/moag
printf '#!/bin/sh\nexec %s /opt/moag/out/headless/cli.js "$@"\n' "$NODE_BIN" | sudo tee /usr/local/bin/moag >/dev/null
sudo chmod 0755 /usr/local/bin/moag
note "moag: $(moag --help 2>/dev/null | head -1 || echo installed)"

say "4/6 Runner account and sudoers"
if ! id "$RUNNER" >/dev/null 2>&1; then
  sudo useradd --create-home --shell /usr/sbin/nologin "$RUNNER"
fi
sudo chmod 0700 "/home/$RUNNER"
SUDOERS_TMP="$(mktemp)"
cat >"$SUDOERS_TMP" <<EOF
# MOAG remote runs: $ME may run exactly these as $RUNNER (docs/onosoo-remote.md)
Cmnd_Alias MOAG_REMOTE = $NODE_BIN /opt/moag/out/headless/cli.js remote-child, /usr/bin/kill -KILL -1
Defaults!MOAG_REMOTE !use_pty, env_reset
$ME ALL=($RUNNER) NOPASSWD: MOAG_REMOTE
EOF
if sudo visudo -cf "$SUDOERS_TMP" >/dev/null; then
  sudo install -m 0440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/moag-remote
else
  rm -f "$SUDOERS_TMP"; echo "sudoers rule did not validate; nothing installed" >&2; exit 1
fi
rm -f "$SUDOERS_TMP"
if sudo -n -u "$RUNNER" -l "$NODE_BIN" /opt/moag/out/headless/cli.js remote-child >/dev/null 2>&1; then
  note "sudo rule works: $ME may start remote-child as $RUNNER without a password"
else
  echo "sudo rule is not effective for $ME; check: sudo -l -U $ME" >&2; exit 1
fi

say "5/6 ~/.config/moag/projects.json"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/moag"
mkdir -p "$CFG" && chmod 0700 "$CFG"
if [ ! -f "$CFG/projects.json" ]; then
  cat >"$CFG/projects.json" <<EOF
{
  "version": 1,
  "remote_start": false,
  "daily_budget_usd": null,
  "runner_user": "$RUNNER",
  "projects": []
}
EOF
  chmod 0600 "$CFG/projects.json"
  note "Created $CFG/projects.json with remote starts OFF. Add projects, set daily_budget_usd and remote_start to turn them on."
else
  note "$CFG/projects.json already exists; left unchanged."
fi

say "6/6 Developer clone for the Linux test run"
mkdir -p "$HOME/src"
[ -d "$HOME/src/moag/.git" ] || git clone -q "$SOURCE" "$HOME/src/moag"
git -C "$HOME/src/moag" fetch -q --all || true
git -C "$HOME/src/moag" checkout -q "$BRANCH"
git -C "$HOME/src/moag" pull -q --ff-only || true
( cd "$HOME/src/moag" && npm ci --no-audit --no-fund )

say "Done"
note "Next:"
note "  1. Log out and in again (WSL: run 'wsl --shutdown' in Windows, reopen Ubuntu) so the docker group applies."
note "  2. Run the tests on Linux:   cd ~/src/moag && npm test"
note "  3. Give the runner an engine: either set ANTHROPIC_API_KEY for the daemon, or"
note "     sudo npm install -g @anthropic-ai/claude-code && sudo -u $RUNNER -H claude   (log in once)"
note "  4. Pair this machine in ONOSOO, then: export MOAG_ONOSOO_URL=... MOAG_ONOSOO_KEY=...  and run: moag daemon"
