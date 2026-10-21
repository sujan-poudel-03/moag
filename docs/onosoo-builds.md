# MOAG + ONOSOO Builds: end-to-end setup

This guide connects a machine running MOAG to the **Builds** app in ONOSOO, from nothing to a run you
can watch, control and open live. It covers both sides in order. The detail of each piece lives in
its own document:

| Piece | Document |
|---|---|
| ONOSOO side: deploy, pairing, roles | ONOSOO repo: `docs/builds/README.md` and `docs/builds/SETUP.md` |
| The contract between the two | ONOSOO repo: `docs/builds/PROTOCOL.md` |
| Remote runs (`moag daemon`), the runner account, `projects.json` | [onosoo-remote.md](onosoo-remote.md) |
| Live previews (`moag host`), Docker, the gateway, the tunnel | [host-agent.md](host-agent.md) |
| One-shot Linux/WSL setup | [`scripts/setup-build-server.sh`](../scripts/setup-build-server.sh) |

## What you get, in three levels

| Level | What works in ONOSOO | Machine | MOAG process |
|---|---|---|---|
| **1. Watch** | Runs appear live: tasks in plan order, what each task changed (files, line counts, diff), error output, cost, branch, pull request. | Windows, macOS or Linux | `moag run` |
| **2. Control** | Start a run (goal or a PRD from Notes), stop, approve or skip a gate, retry. | **Linux or WSL2 only** | `moag daemon` |
| **3. Open it live** | Open a running branch inside ONOSOO, see service health, read logs. | **Linux or WSL2 only**, with Docker | `moag host` |

Each level builds on the one before. Get level 1 working first: it proves the pairing, the URL and
the key.

## Before you start (ONOSOO side)

Someone with owner or admin rights in the ONOSOO workspace:

1. Has deployed the Builds feature: the migrations, the `builds` edge function deployed with
   `--no-verify-jwt`, and the frontend. See the ONOSOO repo's `docs/builds/SETUP.md`.
2. Has switched the app on: **Settings › Apps › Builds**.
3. Knows the **base URL** of the ONOSOO backend, e.g. `https://<project-ref>.supabase.co`. MOAG adds
   `/functions/v1/builds/…` itself, so do not include that path.

Quick check that the backend is live, from any terminal:

```sh
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -d '{}' \
  https://<project-ref>.supabase.co/functions/v1/builds/events
```

`401` means it is deployed and waiting for a key. `404` means the function is not deployed.

## Level 1: watch a run

### 1. Pair the machine

In ONOSOO open **Builds**, go to the machines list, click **Pair machine**, give the machine a name
(e.g. "Office PC") and copy the key. Only owners and admins see the button. The key starts with
`onosoo_live_` and is shown **once**. One key per machine. A WSL2 Ubuntu on a Windows PC
is a separate machine: pair it separately.

### 2. Save the key on the machine

The key belongs in a file in **your user folder**. Never put it inside a project (MOAG refuses to
relay if its config folder is inside the workspace, so a commit can never carry it). Never set it as
an account-wide environment variable either (`setx`, System Properties, `/etc/environment`): every
process would get it, including the AI agents MOAG runs.

**Windows (PowerShell):**

```powershell
$dir = "$env:APPDATA\moag"
New-Item -ItemType Directory -Force $dir | Out-Null
@{ key = "<paste key>"; url = "https://<project-ref>.supabase.co" } | ConvertTo-Json | Set-Content "$dir\onosoo.json" -Encoding ascii
```

This creates `%APPDATA%\moag\onosoo.json`.

**Linux / WSL2 / macOS:**

```sh
mkdir -p ~/.config/moag && chmod 700 ~/.config/moag
printf '{"key":"<paste key>","url":"https://<project-ref>.supabase.co"}' > ~/.config/moag/onosoo.json
chmod 600 ~/.config/moag/onosoo.json
```

The file lives in `$XDG_CONFIG_HOME/moag/` if you set that variable. On first use MOAG adds a
`device_id` to the file by itself.

**For one terminal only** (a quick test, or `scripts/builds-smoke.mjs` in the ONOSOO repo), set the
environment variables instead. They win over the file:

```powershell
$env:MOAG_ONOSOO_URL = "https://<project-ref>.supabase.co"
$env:MOAG_ONOSOO_KEY = "<paste key>"
```

Rules MOAG applies:

- The URL must be `https` (`http` only for `localhost`), with no query string and no credentials.
- The key must be 8 to 512 printable characters. A stray space or quote turns the relay off.
- **No key at all turns the relay off silently.** A key with no URL prints a one-line warning.

### 3. Run something

Any `moag run` now reports to ONOSOO. In a git repository:

```sh
moag run --prompt "Add a short README describing this project" --cwd /path/to/repo
```

On Windows without a `moag` command on the PATH, call the CLI directly:

```powershell
node D:\Projects\moag\out\headless\cli.js run --prompt "Add a short README" --cwd D:\path\to\repo
```

**Cost.** Claude Code reports what a call cost only in JSON mode. `moag run` handles this for you:
when it is connected to ONOSOO and you have not set the format yourself, it uses JSON mode for that
run (it prints one line saying so and changes no file). The CLI shows no live engine output anyway,
so you lose nothing. To keep text mode anyway, set the format explicitly in the project's
`.moag/config.json` (any value you set there wins):

```json
{ "agentTaskPlayer.engines.claude.outputFormat": "text" }
```

The VS Code panel keeps text mode (live output, no cost) unless you set
`agentTaskPlayer.engines.claude.outputFormat` to `json` in its settings, so ONOSOO shows $0.00 for
runs started from the panel until you do. Remote runs started from ONOSOO always use JSON mode.

### 4. Check it in ONOSOO

Open **Builds**. Within seconds you should see:

- the machine **online**;
- the run with its plan name, then the task going from running to completed;
- under the task, the changed files with line counts and the diff;
- cost and duration; after a failed task, its error output.

Nothing secret leaves the machine. Values from `.env` / `.env.local`, engine keys, the device key and
common key formats are redacted, and absolute paths are shortened. If ONOSOO is unreachable, events
wait in a local spool (`<config>/moag/onosoo-spool/`) and are sent by the next run.

### 5. Stay online

Between runs ONOSOO shows the machine **offline** after 3 minutes without a request. To keep it
**online**, keep `moag daemon` running. With the key saved and no `.moag/daemon.json`, the daemon
only polls ONOSOO: it never starts work on its own and, on Windows and macOS, reports remote start
as off.

**Windows:** install it as a logon task for your own account (no administrator rights needed):

```powershell
powershell -ExecutionPolicy Bypass -File D:\Projects\moag\scripts\install-daemon-windows.ps1 -Install
powershell -ExecutionPolicy Bypass -File D:\Projects\moag\scripts\install-daemon-windows.ps1 -Status
powershell -ExecutionPolicy Bypass -File D:\Projects\moag\scripts\install-daemon-windows.ps1 -Uninstall
```

`-Install` refuses unless `%APPDATA%\moag\onosoo.json` exists (step 2), and needs a built checkout
(`npm run compile`) and `node` on the PATH. It registers a Scheduled Task named **MOAG daemon** that
starts at your logon with a hidden window and runs `node <repo>\out\headless\cli.js daemon` in
`%LOCALAPPDATA%\moag\daemon` (deliberately not your profile folder, which contains `%APPDATA%\moag`:
MOAG refuses to relay when its config folder is inside the working directory). If the daemon exits
with an error it is started again after a minute. Output goes to `%LOCALAPPDATA%\moag\daemon.log`.
The key stays in `onosoo.json`: it is never put in the task's arguments or environment.

**Linux / WSL2:** run it as a systemd service, as in
[onosoo-remote.md, "Running the daemon as a service"](onosoo-remote.md#6-running-the-daemon-as-a-service).

## Level 2: control runs from ONOSOO

Remote runs need **Linux or WSL2**. MOAG runs them as a separate low-privilege account
(`moag-runner`) that cannot read the device key or MOAG's own settings, each in its own git worktree,
so your checkout is never touched. On native Windows and macOS, `moag daemon` still connects, but it
tells ONOSOO that remote start is off and refuses every command that would start work.

### 1. Get Linux

**On a Windows PC:** open PowerShell **as Administrator** and run `wsl --install -d Ubuntu-24.04`,
then restart. Open **Ubuntu** from the Start menu and create your Linux user. Everything below
happens inside Ubuntu.

**On a Linux server:** any Ubuntu 24.04 LTS works.

### 2. Run the setup script

From the MOAG repository (on WSL it is visible as `/mnt/<drive>/…`):

```sh
bash /mnt/d/Projects/moag/scripts/setup-build-server.sh
```

It asks for your Linux password where it needs `sudo`, and is safe to run again. It installs Node 20,
a current git and Docker with Compose, builds MOAG read-only at `/opt/moag` with a `moag` command, and
creates the `moag-runner` account and the exact `sudoers` rule for it (validated before it is
installed). It also writes `~/.config/moag/projects.json` with remote starts **off**, and makes a
clone at `~/src/moag` for running the tests.

On WSL, if it says it enabled systemd, run `wsl --shutdown` in Windows and open Ubuntu again, then
re-run it. When it finishes, do `wsl --shutdown` once more so the docker group applies.

### 3. Save the key in Linux

Pair the Linux machine in ONOSOO (a WSL2 Ubuntu does not see the Windows file) and save its key with
the Linux commands from level 1.

### 4. Give the runner account an engine

Pick one:

- **API key:** start `moag daemon` with `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`, …) set **in that
  terminal only**. MOAG passes it to each run in the job, never through the environment.
- **CLI login:** `sudo npm install -g @anthropic-ai/claude-code`, then `sudo -u moag-runner -H claude`
  once to log the runner account in.

### 5. Approve projects and switch remote start on

Edit `~/.config/moag/projects.json`:

```json
{
  "version": 1,
  "remote_start": true,
  "daily_budget_usd": 10,
  "runner_user": "moag-runner",
  "projects": [
    { "id": "shop", "name": "Shop web app", "path": "/home/me/src/shop", "kinds": ["web"] }
  ]
}
```

Remote starts stay off unless `remote_start` is `true` **and** `daily_budget_usd` is a number.
ONOSOO only ever sees each project's `id`, `name` and `kinds`, never its path. The full field list
is in [onosoo-remote.md](onosoo-remote.md).

### 6. Start the daemon

```sh
moag daemon
```

It keeps running and polls ONOSOO every 5 seconds. To run it as a service, see the systemd unit in
[onosoo-remote.md](onosoo-remote.md), and give it `TimeoutStopSec=180`.

### 7. Check it in ONOSOO

- The machine shows **remote start: on** and lists your projects and engines.
- **Start run** on a project with a small goal. The run appears like a level-1 run, executed by the
  daemon.
- **Stop** stops it within seconds.
- A run that reaches an approval gate shows **Approve** / **Skip**. Approving starts a new run
  linked to the first.
- When a run ends, its branch (`moag/…`) is imported into the project repository on the machine.

Every command is written to `~/.config/moag/remote/audit.jsonl` before it is acted on.

## Level 3: open branches live

Needs level 2's Linux machine, with Docker (installed by the setup script) and a preview domain on
Cloudflare. All steps are in [host-agent.md](host-agent.md). In short:

1. **DNS:** move the ONOSOO domain's DNS to Cloudflare (hosting can stay where it is), so previews
   live at `*.preview.<domain>`.
2. **Tunnel:** in Cloudflare, create a tunnel with the public hostname `*.preview.<domain>` pointing
   at the gateway. Save its token in a file of mode 600, e.g. `~/.config/moag/cloudflared.token`.
3. **Configure:** `moag host init`, then set `preview_domain` and `tunnel.token_file` in `host.json`.
4. **Recipe per project:** `moag host draft <project-id>`, review the draft, and save it as the
   project's `.moag/environment.json`.
5. **Run:** `moag host`. `moag host status` shows what is configured and running.
6. **In ONOSOO:** Environments → **Start** on a branch, then **Open**.

Only images from **public** registries can be used: previews never get your Docker logins.

## Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| The run works but nothing appears in ONOSOO | No key found: the relay is off and says nothing | Check the file is at `%APPDATA%\moag\onosoo.json` (Windows) or `~/.config/moag/onosoo.json`, and that it is valid JSON. In WSL, the Windows file is not visible. |
| "ONOSOO relay is off: MOAG_ONOSOO_URL must be an https URL …" | URL rejected | Use the base `https://<ref>.supabase.co`, with no path, query or credentials. |
| "ONOSOO relay is off: a device key is set but no URL …" | Key without a URL | Add `"url"` to `onosoo.json`, or set `MOAG_ONOSOO_URL`. |
| "ONOSOO relay is off: the device key is not 8-512 printable characters." | Bad paste (quotes, spaces, a line break) | Paste the key again, exactly as shown in ONOSOO. |
| "ONOSOO device key was revoked or is wrong — re-pair this machine" | 401 from ONOSOO | Pair the machine again and replace the key. Unsent events stay in the spool. |
| Machine shows offline | No request for 3 minutes | Check `moag daemon` (or a run) is running and the machine is awake. |
| Remote start shows off although `projects.json` says on | `daily_budget_usd` is null, or isolation failed | Set a budget. Read the daemon's stderr: it names the failed check. |
| "The runner account did not answer the isolation check … MOAG ran: sudo -n -u …" | The sudoers rule does not match | The rule must allow exactly the command shown. Re-run the setup script, or check `sudo -l -U <you>`. |
| "Remote runs stay off: MOAG's state directory must be private to its account …" | MOAG's config is on a Windows drive (`/mnt/c/…`), where Linux permissions don't apply, or its mode was changed | Keep `~/.config/moag` in the Linux home, mode 700. |
| A start is rejected with "This run asks for $… but only $… of today's $… remote budget is left." | The daily remote budget is used up | It resets at local midnight. Raise `daily_budget_usd` if needed. |
| "ONOSOO: another MOAG daemon (pid …) already handles remote commands for this machine …" | A second daemon on the same machine | Only one daemon runs per machine. Stop the other one; this one takes over within a minute. |
| "moag host runs on Linux. On Windows, install it inside WSL2 Ubuntu …" | Host agent started on native Windows | Run it inside WSL2 Ubuntu. |
| A preview start is refused with a policy message | The branch's compose file asks for something an environment may not have | The message names the key. See "What keeps it safe" in [host-agent.md](host-agent.md). |
