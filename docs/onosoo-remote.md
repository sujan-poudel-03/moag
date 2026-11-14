# Running ONOSOO remote work on a build machine

`moag daemon` can take commands from ONOSOO: **stop**, **retry**, **approve**, **skip** and
**start-run**. A person asks in ONOSOO; this machine checks the request against its **own** local
settings, runs it, and reports back. Nothing runs unless you switched it on here.

Remote runs execute as a **separate, low-privilege OS account** (the *runner account*). That account
cannot read the device key, `projects.json`, the spend ledger or the audit log, and it never touches
your checkout: every run works in its own git worktree of a private mirror, and only its branch comes
back into your project.

Isolated remote work is **Linux only** (a Linux server or WSL); for a plain PC see [Local mode](#local-mode-this-pc-no-runner-account). On Windows and macOS the daemon still polls
and still reports `stop`/`approve`/… results for runs it knows, but it reports `remote_start: false`,
lists no engines, and rejects every command that would start work with a readable message.

## 1. The runner account

Create a dedicated account. It must be used for nothing else: when a run has to be force-stopped,
MOAG kills **every process this account owns**.

```sh
sudo useradd --create-home --shell /usr/sbin/nologin moag-runner
```

Log every engine CLI in **as the runner account** (its credentials live in its own home):

```sh
sudo -u moag-runner -H claude login        # or codex login, etc.
```

API keys MOAG itself holds (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`,
`GOOGLE_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OLLAMA_HOST`) are passed to each run in its job, never
through the environment. The device key never reaches the runner account at all.

## 2. Install paths

Install MOAG somewhere the runner account can read but not write, and put `node` where sudo can name
it exactly:

| What | Where |
|---|---|
| MOAG | `/opt/moag` (built: `/opt/moag/out/headless/cli.js`) |
| `moag` command | `/usr/local/bin/moag` → `node /opt/moag/out/headless/cli.js` |
| Node | `/usr/bin/node` |

## 3. sudoers

Your own account (the one that runs `moag daemon`) may run exactly two commands as the runner
account, and nothing else. Add `/etc/sudoers.d/moag-remote` with `visudo -f`:

```
Cmnd_Alias MOAG_REMOTE = /usr/bin/node /opt/moag/out/headless/cli.js remote-child, /usr/bin/kill -KILL -1
Defaults!MOAG_REMOTE !use_pty, env_reset
<mainuser> ALL=(moag-runner) NOPASSWD: MOAG_REMOTE
```

Replace `<mainuser>` with your login. `remote-child` is a hidden MOAG subcommand: the job comes in on
its stdin and the run's events come back on its stdout. `kill -KILL -1` is the force-stop, and is also
run after every remote run so nothing the runner account started outlives it.

**The paths must match exactly.** sudo compares the command character for character: the node binary
must be the one the daemon itself runs on, and the cli.js path the one it was started from. Print both
on the machine, as the account that runs the daemon:

```sh
node -p process.execPath               # e.g. /usr/bin/node — not a version-manager shim
```

For cli.js: when `moag` is a symlink, `readlink -f "$(command -v moag)"` prints it. When `moag` is a
**wrapper script** (as in the install table above), readlink only finds the script — read the path
from the script itself (`cat "$(command -v moag)"`), or take it from the install directory: with MOAG
in `/opt/moag` it is `/opt/moag/out/headless/cli.js`. For an npm-installed package, ask node:

```sh
node -e "console.log(require.resolve('agent-task-player/out/headless/cli.js'))"
```

In every case the daemon prints the exact command it ran when the isolation check fails (below).

If they differ from the rule (a node from nvm, MOAG installed elsewhere), change the rule, not the
paths. When the rule does not match, sudo refuses silently and the daemon reports *"The runner account
did not answer the isolation check … MOAG ran: sudo -n -u … remote-child"* on its stderr — the command
it shows is the one the rule must allow.

**Engine CLIs and `secure_path`.** `env_reset` gives the child sudo's `secure_path`, not your PATH.
If the runner account's engine CLIs live in its own home (`~/.local/bin`, an npm prefix), add those
directories for this rule only:

```
Defaults!MOAG_REMOTE secure_path="/home/moag-runner/.local/bin:/home/moag-runner/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"
```

Command-specific `Defaults!` lines are easy to get subtly wrong (sudo applies the last matching line).
Check what sudo will actually do for your account:

```sh
sudo -l -U <mainuser>     # lists the MOAG_REMOTE commands and the secure_path that applies to them
```

## 4. projects.json

Next to the device key, in `~/.config/moag/` (or `$XDG_CONFIG_HOME/moag/`):

```json
{
  "version": 1,
  "remote_start": true,
  "daily_budget_usd": 25,
  "runner_user": "moag-runner",
  "projects": [
    { "id": "shop", "name": "Shop web app", "path": "/home/me/src/shop", "kinds": ["web"] }
  ]
}
```

| Field | Meaning |
|---|---|
| `remote_start` | The local switch. Only `true` turns remote starts on; anything else keeps them off. |
| `daily_budget_usd` | Cap on what remote runs may spend per local calendar day. `null` blocks remote starts. |
| `runner_user` | The runner account. Never `root`. Unset blocks remote starts. |
| `projects[].id` | The id ONOSOO uses (`^[a-z0-9][a-z0-9._-]{0,63}$`). |
| `projects[].name` | What ONOSOO shows. |
| `projects[].path` | Absolute path to the repository's top level. **Never sent to ONOSOO.** |
| `projects[].kinds` | Optional tags ONOSOO shows (e.g. `web`, `api`). |
| `projects[].delivery` | What to do with a finished run's branch: `"off"` (default), `"branch"` (push it) or `"draft-pr"` (push it and open a draft pull request). See [Delivering the branch](#delivering-the-branch). Anything else leaves it off. |
| `projects[].pr_base` | The branch a delivered pull request targets, such as `dev`. The repository's default branch when absent. |

A project is rejected (with a message on the daemon's stderr) if its path is missing, is not a git
top level, overlaps another project's path, or overlaps MOAG's own state directory. ONOSOO only ever
sees `id`, `name` and `kinds`.

## 5. What a remote run does

1. The daemon checks the request against `projects.json`, today's budget, the engines the runner
   account can use, and the isolation probe (runs as the runner, must have a different uid and must
   not be able to read the files above).
2. It reserves the run's budget (`budget_usd`, default $10) and bundles the project's code.
3. The runner account updates its mirror (`~moag-runner/.moag-remote/repos/<id>`), makes a worktree
   on a new `moag/…` branch (or the branch being continued) and runs the plan — a single task for a
   goal, or a plan generated from the PRD with tools locked down. Generated plans always end at a
   ship gate, run one playlist at a time, and no task runs longer than 30 minutes.
4. Each passing task is committed on the run's branch. When the run ends, the branch's new commits
   come back and appear in your project as **`refs/heads/<branch>`** — a fast-forward only; a branch
   someone moved in the meantime is not overwritten, and the run reports why.

### Delivering the branch

By default a run stops once its commits are in your project as `refs/heads/moag/…`: you push it and open the
pull request yourself. If you want MOAG to do the last step, say so **per project**, in this machine's own
`projects.json` (nobody can switch it on from ONOSOO):

```json
{ "id": "onosoo", "name": "ONOSOO", "path": "/home/me/code/onosoo", "delivery": "draft-pr", "pr_base": "dev" }
```

- `"branch"` pushes that one branch to `origin`.
- `"draft-pr"` pushes it and opens a **draft** pull request for it (`gh pr create --draft --head <branch> --base <pr_base>`).
  The text says that nothing was merged or deployed and that the diff must be read first.

What it will never do: merge, deploy, force-push, or push anything that is not a branch under the `moag/` prefix.
The push names the branch explicitly, git runs with hooks and prompts off, and a branch someone moved on the
remote is refused, not overwritten. It needs the daemon's own account to be able to push (`git` with a credential
helper, or `gh auth login` and `gh auth setup-git`) and, for a pull request, `gh`.

ONOSOO is told the result with the events `moag run --pr` already sends: `pr-created` (the run then shows the pull
request link) or `pr-skipped` with a reason (`unsafe-branch`, `no-branch`, `no-remote`, `push-failed`,
`gh-missing`, `no-commits`, `failed`). A skipped delivery never fails the run. What it did is on the run's record
(`remote/runs/<run>.json`, field `delivery`).

A remote run is stopped after **4 hours** at most; ONOSOO shows *"Stopped: the run exceeded the
4-hour limit for remote runs."* on the run.

## Local mode (this PC, no runner account)

The sections above describe the **isolated** mode: a Linux build machine and a separate runner
account. **Local mode** is a second, explicitly opt-in way to run for a plain Windows, macOS or Linux
PC: ONOSOO's **Start run** works, and the run executes **as the same user as `moag daemon`**. There
is no runner account, no `sudo`, no WSL and no isolation probe.

> **Risk: in local mode the agent runs with your own privileges.** It can read and change anything
> you can: your files, your SSH keys and tokens, your other repositories, your device key. The
> protections below limit *what MOAG lets ONOSOO start*, not what the agent can do once it runs.
> Turn it on only on a machine, and for projects, where you accept that. The daemon prints one
> stderr line saying so whenever it is in local mode.

Local mode is never inferred from the platform. It is on only when `projects.json` says
`"mode": "local"`; anything else, or no `mode` at all, is the isolated mode, unchanged (so
Windows and macOS are still refused there). An invalid value is reported on the daemon's stderr and
the isolated mode is used.

```json
{
  "version": 1,
  "mode": "local",
  "remote_start": true,
  "daily_budget_usd": 10,
  "projects": [
    {
      "id": "shop",
      "name": "Shop web app",
      "path": "C:\\Users\\me\\src\\shop",
      "kinds": ["web"],
      "delivery": "draft-pr",
      "pr_base": "dev"
    }
  ]
}
```

`runner_user` is not needed (and ignored). Everything else in [projects.json](#4-projectsjson) applies.

**What still protects you in local mode**

- Only projects listed in `projects.json` can be started; `remote_start` must be `true`.
- `daily_budget_usd` must be set (`null` blocks starts), each run has its own budget, and no run lives
  longer than 4 hours.
- A run works in its own git worktree on a `moag/...` branch, in a private mirror under MOAG's state
  directory (`<state dir>/local-runner/.moag-remote/`); your own checkout is never touched. MOAG
  never merges, deploys or force-pushes. `delivery` (`off`, `branch`, `draft-pr`) works as usual and
  pushes as you, through your own `git` and `gh` logins.
- The audit log and spend ledger are written as always. `copilot` and `custom` engines stay refused.
- The run's process gets a **small environment**: `PATH`, `LANG`, `TZ`, `LC_*`, plus what engine CLIs
  need to find their login — `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `XDG_*` and, on Windows,
  `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`, `TEMP`, `TMP`, `ComSpec`, `PATHEXT` and
  similar. The ONOSOO device key, every `MOAG_*` and `ONOSOO*` variable and `CI` are never passed. (The
  agent runs as you, so it could still read the key *file* if it went looking; that is the risk above.)
- On POSIX the state directory is still checked and kept private (mode 0700 / 0600).

**How to start**

1. `moag pair` with the key from ONOSOO, then create `projects.json` as above (in MOAG's
   state folder: `%APPDATA%\moag` on Windows, `~/.config/moag` elsewhere).
2. `moag daemon`, and leave it running.
3. In ONOSOO, **Start run** appears once this machine reports remote start and at least one approved
   project; the machine reports `mode: "local"` and the engines that are installed *and signed in* for
   your user.

The child is `node cli.js remote-child`, started directly. **Stop** is graceful first; after 30 s the
whole process tree is killed: `taskkill /PID <pid> /T /F` on Windows, SIGKILL to the child's process
group on macOS and Linux.

## 6. Running the daemon as a service

Stopping the daemon with an active remote run waits for that run to stop and for its branch to be
imported (up to about 3 minutes). Give the service manager at least that long before it kills it;
for systemd:

```
[Service]
ExecStart=/usr/local/bin/moag daemon
KillSignal=SIGTERM
TimeoutStopSec=180
```

A second SIGINT/SIGTERM during that wait gives up at once: MOAG releases its lock and exits 130 (the
run is then marked interrupted at the next start, and charged its full allotment).

## 7. Safeguards MOAG checks itself

Before it accepts remote work — at start-up, every 10 minutes and before every run — MOAG checks, on
its own and without trusting the runner account's word:

- the runner account resolves (`id -u`) to a uid that is neither MOAG's own nor root, and the
  isolation probe really ran as that uid;
- its state directory (`~/.config/moag` and `remote/`) is owned by MOAG's account with mode 0700, and
  every private file in it has no group or other permissions. MOAG sets these modes itself; on a file
  system that ignores them (a Windows drive under WSL, `/mnt/c/…`) the check fails and remote runs
  stay off — keep the state directory on the Linux file system;
- the runner account cannot read any of those files (the probe opens each one as the runner).

Only one daemon per state directory handles commands: it holds `remote/daemon.lock`. A second
`moag daemon` on the same machine and state directory says so on stderr and does not poll (its
GitHub-intake loop, if configured, still runs); it tries again every minute and takes over once the
first one has stopped.

## 8. Files MOAG keeps

All under the state directory (`~/.config/moag/`), owner-only (0700 / 0600):

| File | What it is |
|---|---|
| `remote/audit.jsonl` | Every command received and what MOAG decided, before anything ran. A PRD is recorded as its size and hash, never its text. Rotated to `audit.1.jsonl` at 5 MB. |
| `remote/spend.json` | Today's remote spend: each run's reserved allotment and what it was charged. Engines that report no cost (gemini, copilot, custom), and runs cut short, are charged their full allotment. |
| `remote/runs/<run>.json` | One record per remote run: project, branch, plan snapshot, exit code, the ship gate it halted at, and whether it was approved, skipped or retried. |
| `remote/outbox.json` | Results not yet delivered to ONOSOO; retried until they are. |
| `remote/daemon.lock` | Which daemon process handles remote commands (pid and a start-time token). |

If MOAG restarts mid-command, the command is reported as failed ("MOAG restarted before finishing
this command") and is never run twice; a run that was live is marked interrupted.
