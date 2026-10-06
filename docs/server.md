# MOAG hosted server (Product Owner web app)

The server lets a team use MOAG from a browser. A product owner writes and versions a PRD. A reviewer approves the generated delta plan. Coding agents run it inside a per-project workspace on the server, within a cost cap. An approver signs off the ship gate. Every step is recorded in an audit log under the user who took it.

It is a Node 20 process (`out/server/main.js`) with no database. All state lives in one data directory. It never loads the VS Code API: agent work runs in short-lived worker child processes under the headless shim, the same path `moag run` uses.

**Running agents on a server is remote code execution by design.** Read [Threat model](#threat-model) before exposing this to anyone.

To measure the whole flow end to end (PRD versions, plans, runs and ship gates, with cost and human interventions recorded), see [docs/benchmark.md](benchmark.md) (`moag bench`).

## Quick start (Docker)

```bash
docker build -t moag-server .

docker run --init -d --name moag -p 8080:8080 \
  -v moag-data:/data \
  -v /etc/moag/master.key:/run/secrets/moag_master_key:ro \
  -e MOAG_PUBLIC_URL=https://moag.example.com \
  -e MOAG_TRUST_PROXY=1 \
  -e MOAG_MASTER_KEY_FILE=/run/secrets/moag_master_key \
  -e MOAG_BOOTSTRAP_TOKEN="$(openssl rand -base64 32)" \
  moag-server
```

Then check it is up:

```bash
curl -fsS http://localhost:8080/healthz              # {"ok":true}
curl -fsS http://localhost:8080/api/bootstrap/status # {"needed":true} until the first admin exists
```

The image:

- builds and runs on `node:20-bookworm-slim`
- runs as the non-root user `moag` (uid 10001)
- keeps every piece of state on the `/data` volume
- exposes port 8080 and has a `HEALTHCHECK` against `/healthz`
- does **not** set `CI` (see [The CI lock](#the-ci-lock))

Use `--init` (or `tini`). Engine CLIs run in their own process groups. If a worker has to be force-killed, an init process reaps the orphans.

## Configuration

Everything is configured with environment variables, validated once at boot. A bad value stops the server with a message. It never falls back silently.

| Variable | Required | Meaning |
|---|---|---|
| `MOAG_DATA_DIR` | yes | Data directory. The image sets `/data`. Created with mode 0700. |
| `MOAG_PUBLIC_URL` | yes | The URL users type, such as `https://moag.example.com`. It decides cookie security and the allowed `Origin`. |
| `MOAG_PROJECTS_ROOT` | no | Where project workspaces live. Default `<data>/workspaces`. Projects can only be created inside it. |
| `MOAG_HOST` / `MOAG_PORT` | no | Listen address. Defaults `127.0.0.1` / `8080`; the image sets `0.0.0.0`. |
| `MOAG_TRUST_PROXY` | no | `1` to take the client IP from `X-Forwarded-For` (rightmost hop). Set it only behind your proxy. |
| `MOAG_BOOTSTRAP_TOKEN` | until an admin exists | One-time token, 24+ characters, used to create the first admin. |
| `MOAG_MASTER_KEY_FILE` or `MOAG_MASTER_KEY` | for API keys | Master secret for encrypting engine API keys, 16+ characters. The file must be **outside** the data dir. |
| `MOAG_MAX_CONCURRENT_JOBS` | no | Worker processes server-wide, 1–8, default 2. Extra requests get 429. There is no queue. |
| `MOAG_MAX_USD_PER_ENGINE_CALL` | no | Cap in USD on any single Claude call, greater than 0 and at most 1000. Passed as `--max-budget-usd`, together with what remains of the version cap (the smaller wins). See [Cost reporting](#cost-reporting). |
| `MOAG_GATE_TIMEOUT_MS` | no | How long, in milliseconds, verify lets one gate command (for example `npm test`) run in a run job: a whole number from 1000 to 3600000. Default 600000. A command still running then is killed and the gate fails, so nothing ships. A project cannot change it: the server never reads the repository's `.moag/config.json`. |
| `MOAG_RUN_ENV_PASSTHROUGH` | no | Comma-separated extra variable names passed to agents (see [below](#moag_run_env_passthrough)). |
| `MOAG_ALLOW_SSH_CLONE` | no | `1` to allow `ssh://` clone URLs as well as `https://`. |

`MOAG_MASTER_KEY` and `MOAG_BOOTSTRAP_TOKEN` are deleted from the server's `process.env` after they are read, so no child inherits them. The kernel still keeps the startup environment (`/proc/<pid>/environ`). Prefer `MOAG_MASTER_KEY_FILE`.

## TLS with a reverse proxy

The server speaks plain HTTP. Terminate TLS in a reverse proxy and set:

- `MOAG_PUBLIC_URL=https://…`. With an https public URL, the session cookie becomes `__Host-moag_sid; Secure; HttpOnly; SameSite=Lax; Path=/`, and HSTS is sent.
- `MOAG_TRUST_PROXY=1`, so the login rate limiter sees real client IPs.
- Bind the server to a private address, or don't publish its port. A client that reaches it directly can forge `X-Forwarded-For` when `MOAG_TRUST_PROXY=1`.

The proxy must forward `Host`. It must not buffer Server-Sent Events (`/api/projects/:id/events`); the server sends `X-Accel-Buffering: no` for nginx.

**Caddy**

```caddy
moag.example.com {
  reverse_proxy 127.0.0.1:8080 {
    flush_interval -1
  }
}
```

**nginx**

```nginx
server {
  listen 443 ssl http2;
  server_name moag.example.com;
  ssl_certificate     /etc/letsencrypt/live/moag.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/moag.example.com/privkey.pem;
  client_max_body_size 2m;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;          # Server-Sent Events
    proxy_read_timeout 1h;
  }
}
```

With `http://` public URLs (local trials only), cookies are not `Secure`.

## Bootstrap: the first admin

1. Start the server with `MOAG_BOOTSTRAP_TOKEN` set to a random string of 24+ characters. The server refuses to start when no admin exists and no token is set.
2. Open the public URL. While no admin exists, the app shows **Create the first admin**. Enter the token, a username and a password (12–256 characters).
3. Once an admin exists, `/api/bootstrap` returns 404 for good. Remove the token from the environment on the next restart.

Wrong bootstrap tokens are rate-limited **per client IP** (the same limiter as sign-in: 5 wrong tokens lock that IP for 15 minutes, before the token is even compared). One guessing client cannot lock out the operator, who signs in from another address. Behind a proxy this needs `MOAG_TRUST_PROXY=1`; otherwise every client shares the proxy's IP.
4. The admin creates everyone else under **Users**. New users get a temporary password and must change it at first sign-in.

Roles are `product-owner`, `reviewer`, `approver` and `admin`. One user can hold several. The server always keeps at least one active admin.

Changing a user's roles, disabling them or setting a temporary password (`PATCH /api/admin/users/:id`) signs that user out of every session. When the admin changes **their own** account, that includes the session the request came on: the answer is `200` with `"sessionEnded": true` beside the user, and every later request on that session is `401 unauthenticated` (a signed-in user who lacks a permission gets `403 forbidden` instead). The web app then goes to the sign-in page with "Your roles changed, so you were signed out. Sign in again." (or "Your account changed, …" for a disable or password change), never the "no permission" message.

## Engine CLIs and API keys

The base image ships no engine CLIs. Install them in a derived image. Log in as the `moag` user, with `HOME` on the data volume so the login survives container upgrades:

```dockerfile
FROM moag-server
USER root
RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli
USER moag
ENV HOME=/data/home
```

```bash
docker exec -it moag mkdir -p /data/home
docker exec -it moag claude      # complete the login flow once
```

Ollama can run as a sidecar. Point at it with `OLLAMA_HOST`, which is always passed to agents.

**Admin → Engines** shows which CLIs the server found (a `--version` probe, run at boot and on **Re-check**). The probe spawns the command exactly as a run does: on Windows through cmd.exe, so it reports the binary cmd resolves by PATH order and PATHEXT (an npm `claude.cmd` earlier on PATH wins over a `claude.exe` later on it), and the version shown is the version a run starts. A configured command that is not a plain name or path (spaces, quotes or shell characters) is never put on a shell line by the probe; it shows no version. MOAG makes no live provider call to check sign-in, so CLI auth always shows "unknown". `copilot` and `custom` are not supported in the web app. A run whose engine the probe did not find is refused with "isn't installed on this server".

The **anthropic** API key is set on the Engines screen:

- It is stored encrypted at rest in `<data>/secrets.json` (mode 0600), using AES-256-GCM under a key derived with HKDF-SHA256 from the master secret.
- The browser only ever gets back "set", its last 4 characters and when it was set.
- The audit log records "key set" / "key cleared" and never any characters of the key.
- Without a master key, setting a key returns 503. The rest of the server works.
- A key is decrypted only for a job whose plan references that engine, and is injected as that job's `ANTHROPIC_API_KEY`. Jobs on other engines never see it.
- If the master key changes, stored keys show **Key unreadable**. Set them again.

### Cost reporting

The per-version cost cap is enforced against the engine's **own** cost figure wherever one exists.

- **Claude jobs run in JSON mode.** Every server job (runs and plan generation) runs `claude -p --output-format json`, and the cap uses the CLI-reported `total_cost_usd` of each call. The extension keeps `text` mode by default, so VS Code users still see live output.
- **Every Claude call gets `--max-budget-usd`**, set to the smaller of what remains of the version cap and `MOAG_MAX_USD_PER_ENGINE_CALL`. With neither set, no flag is passed.
- **Every engine call reaches the run's `cost` events** with a `source`:
  - `reported`: the engine's own figure.
  - `estimated`: MOAG derived it (another engine's text output or a price table).
  - `none`: the call reported no cost at all, for example when it was killed, timed out or printed unparsable output. These calls are **counted but add $0**, and only the per-call cap bounds what they spent.
- In JSON mode Claude streams no live output. The answer arrives when the call ends, and error tails come from Claude's `result` text.
- A Claude CLI too old to know `--output-format` or `--max-budget-usd` exits with an error, so its jobs fail rather than run without a cost figure. Upgrade the CLI on the server.
- If the CLI is signed in with a Claude subscription rather than an API key, `total_cost_usd` is a notional figure, not what you are billed.

### Planner lockdown and `allowPlannerFileAccess`

Plan generation is triggered by a product owner, so the planning agent runs with its tools locked down as far as each engine allows. The server's `git ls-files` listing, placed in the prompt as a context section before the output-format rules, is meant to be its only view of the repository. What is enforced differs per engine:

| Engine | How plan generation is locked down |
|---|---|
| `claude` | `-p --strict-mcp-config --tools ""`: every built-in tool is removed and no MCP server loads. |
| `codex` | `exec --skip-git-repo-check --sandbox read-only --disable shell_tool --disable unified_exec -c shell_environment_policy.inherit=none`: no shell or exec tool, and a read-only sandbox. Whether Codex can still read files through a non-shell built-in tool is **unverified**, so a Codex planner may be able to read files the server uid can read. |
| `ollama` | `ollama run` is a plain completion with no tools. |
| `gemini`, `anthropic` | Cannot be restricted: Gemini CLI has no flag that removes its file tools, and the anthropic API adapter always offers `read_file`, `write_file`, `list_directory` and `run_bash` (plus `take_screenshot` and `run_playwright_test`). Refused with `409 planner-file-access` (no worker, no plan record) unless an admin turns on `allowPlannerFileAccess`. |

`allowPlannerFileAccess` (default **off**) is an admin setting, stored in `<data>/server-settings.json`:

```bash
GET   /api/admin/settings                                   # admin only
PATCH /api/admin/settings  {"allowPlannerFileAccess": true}  # admin only, CSRF-protected
```

- Each change of the value is audited as `settings.update` with the before and after values. A PATCH that changes nothing is not audited.
- While it is on, the `plan.generate` audit entry of a plan generated on gemini or anthropic carries `plannerFileAccess: true`.
- It only unlocks the engines in the last row. Claude and Codex plans stay locked down either way.
- On **anthropic** it grants **shell execution and file writes**, not just reads: the planner gets `run_bash` and `write_file` and runs them as the server uid. On **gemini** the planner gets its full default tool set.
- A malformed settings file reads as off.

### Master key

Generate it once and keep it **out of the data volume**, so a copy of `/data` alone never contains both the ciphertext and the key:

```bash
sudo install -d -m 0700 /etc/moag
openssl rand -base64 48 | sudo tee /etc/moag/master.key >/dev/null
sudo chown 10001 /etc/moag/master.key && sudo chmod 0400 /etc/moag/master.key
```

Mount it read-only (as a file or a Docker/Swarm/Kubernetes secret) and set `MOAG_MASTER_KEY_FILE`. The server refuses to start if that path resolves inside `MOAG_DATA_DIR`. Back the key up separately from the data volume.

## Data volume and backups

```
/data
  users.json  sessions.json  projects.json   accounts, hashed session ids, project registry
  audit.jsonl (+ audit-<ts>.jsonl)           append-only audit log, rotated at 20 MB, never deleted
  secrets.json                               encrypted engine keys (0600)
  outcomes.jsonl                             stack-recommendation evidence
  probe/                                     engine probe job files
  projects/<id>/plan.json                    canonical plan (outside the workspace)
  projects/<id>/state.json                   plans under review, runs, spend per PRD version
  projects/<id>/standards.json               every proposed version of the project standards (0600)
  projects/<id>/runs/<runId>/                job, config, plan snapshot, events, standards job file and report
  projects/<id>/plans/<planId>/              plan-generation job, repo file listing, standards job file, outcome; work/ = its empty cwd
  workspaces/<name>/                         the git checkouts agents work in
```

Every JSON file is written atomically (temp file then rename), so a file is never half-written. Two ways to back up:

- **Consistent:** `docker stop moag`, copy the volume (`docker run --rm -v moag-data:/data -v "$PWD":/backup busybox tar czf /backup/moag-data.tgz -C /data .`), then start it again.
- **Live:** `cp -a /data <backup>` while it runs. Each file is self-consistent. A run in flight may be caught mid-way, and a restore marks it `interrupted`.

Back up the master key separately. Restoring `/data` without it loses the stored API keys, but nothing else.

On Windows hosts, `chmod` 0600/0700 has no effect. Protect the data directory with NTFS ACLs instead.

## Restarts and the job lock

Each project with a job running has `projects/<id>/job.lock`. It names everything that may still be working in the workspace:

- the server pid and the worker pid;
- on POSIX, the worker's process group (`workerPgid`);
- `taskPids`: every agent CLI, shell command or gate command the worker currently has running. The worker reports each one as it starts and ends, and the server rewrites the lock to match (at most 64 pids).

The lock is **held** while any of them is alive, even when the server and the worker are both gone. A new job for that project gets `409 project-locked`.

On restart the server:

1. Removes every lock whose holders are all dead.
2. Recovers every project without a held lock: runs left `running` become `interrupted`, plan generations left `generating` become `interrupted`, and each interrupted run's snapshot is merged into the canonical plan, so tasks it completed (and paid for) are not rerun.
3. Leaves a project whose lock is still held **alone**. Its previous worker is still running and still writing its snapshot, so marking it now would record a half-finished run as final. The server re-checks that lock every 5 seconds. Once every holder has exited, and no job of this server's own is running there, it removes the lock and runs step 2 for that project, merging the worker's final snapshot.

A worker whose server dies stops its runner, which tree-kills the running task. If that has not settled within 30 seconds, the worker kills its own process tree and exits, so a hung task cannot hold a lock forever.

### Task processes that outlive their job

The same rule applies while the server is up. When a job ends but a recorded task pid is still alive (a tree-kill that missed a grandchild, or an agent that ignored its signal), the server **keeps** `job.lock`:

- It rewrites the lock to name only the live task pids, and checks them again every second.
- Once they have all exited, it removes the lock.
- After 5 minutes it stops checking but **keeps the lock**, and logs that an admin can force-release it. The lock is also reclaimed by itself at the next job start once those pids are gone.
- Meanwhile `GET /api/projects/:id` reports `lockHeld: true`, and a new run, gate approval or plan request on that project gets `409 project-locked`.

An admin can force-release the lock:

```bash
POST /api/admin/projects/<id>/lock/release   {"reason": "..."}   # admin only, CSRF-protected
```

- The reason is required (400 without it).
- The route returns `409 job-active` while this server runs a job in that project (stop the run instead), and `409 not-locked` when there is no lock.
- On success the entry is audited as `job.lock-force-release`, with the recorded `taskPids`, `workerPid`, and whether the server was still watching the lock (`lingering`, `expired`) as `before`, and the reason as `after`.
- **It kills nothing.** Confirm first that the recorded pids are gone, or kill them yourself (`taskkill /pid <pid> /T /F` on Windows, `kill -TERM` on POSIX). Otherwise a second agent can be admitted into a workspace where one is still running, and the audit entry is the only record that this happened.

### Windows notes

- Workers are spawned **detached on every platform**. Without that, Windows puts the worker in the server's kill-on-close job object, and a server crash would hard-kill the worker while leaving the agent it started running.
- Every child process the server and its workers start is spawned with `windowsHide`: agent CLIs, task and gate commands, git, `taskkill`, version probes. A detached worker has no console, so without it each child would open a console window on the server's desktop.
- Process trees are killed with `taskkill /pid <pid> /T /F`. Windows has no process groups, so the lock relies on the worker pid and `taskPids`.
- A task `cwd` such as `C:\x`, `C:x` or `\\server\share` is absolute, so a generated plan using one is refused at review.

## The CI lock

With `CI=true`, the headless runner auto-skips manual tasks, which would approve every ship gate. So when the server sees `CI=true`:

- it refuses to start runs and plan generation, and the UI shows "Runs are disabled";
- it strips `CI` from every worker environment, and the worker refuses to start if `CI` is somehow set.

Ship gates are also forced to halt in the generated worker config (`prdLoop.onManualGate: halt`). The repository's own `.moag/config.json` is never read for server runs. To leave the lock, unset `CI` and restart.

## `MOAG_RUN_ENV_PASSTHROUGH`

Agents get a **built** environment, not the server's. It contains:

- the OS and toolchain basics (`PATH`, `HOME`, locale, temp dirs, proxies and CA bundles, `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, `OLLAMA_HOST`)
- the path of a server-generated config
- the API keys of the engines the job's plan uses

`CI` and every `MOAG_*` variable are never passed.

To give agents more, such as a package-registry token, list the names:

```bash
-e MOAG_RUN_ENV_PASSTHROUGH=NPM_TOKEN,GH_TOKEN -e NPM_TOKEN=… -e GH_TOKEN=…
```

Names must match `^[A-Z_][A-Z0-9_]*$`. `MOAG_*` and `CI` are rejected at boot. Anything passed through is readable by every agent on this server.

## Project standards

Every project has one agreed, versioned **standards profile**. Every planner and task prompt carries it, and every run is checked against it before anything is marked shipped. No model is asked at any step: detection, proposal and checking are deterministic.

**MOAG blocks on your project's own tools; its own scans are advisory unless you promote them.** What stops a release is the profile's **commands** — real linters, formatters, type-checkers and tests, judged by their exit code — and nothing else by default. Everything MOAG scans for itself, required directories and nested repositories included, is **advisory**: it is reported with file, line and rule, and stops nothing. See [Blocking and advisory rules](#blocking-and-advisory-rules).

### The profile

A profile is a JSON object with exactly these sections. Unknown keys are rejected at every level.

| Section | Holds |
|---|---|
| `stackTemplateId` | One of the server's stack ids. |
| `repoState` | `greenfield` or `brownfield`. For greenfield, the planner is told that the first task scaffolds the required directories. |
| `structure` | `requiredDirs`, `allowedTopLevel` (names or globs), and `placement` rules (`{id, files, under[]}`: files matching a glob belong under one of the listed directories). A required directory is a path inside the repository: an absolute path (`/x`, `C:\x`, `\\host\x`), any `..` segment and any invisible or format character are rejected, and separators are normalised to `/` (a leading `./` and a trailing or doubled `/` are dropped). Its case is kept, and it is compared case-sensitively with the paths git lists. |
| `frontend` | `componentKit`, `styleSource`, and `rawPatterns` (`{id, kind, value, globs[], message}`). `kind` is `literal` (plain text) or `builtin` (`hex-color`, `css-color-function`, `inline-style`). |
| `backend` | `layers` (`{name, globs[]}`), `forbiddenImports` (`{from, to}` layer names) and `importAliases` (`{prefix, path}`). |
| `naming` | `files` (`{globs[], style}`, style one of `kebab-case`, `camelCase`, `PascalCase`, `snake_case`) and `notes`. |
| `comments` | `maxDensityPct`, `minAddedLines`, `forbidCommentedOutCode`, `bannedPhrases[]`. |
| `testing` | `runner`, `fileGlobs[]`, `notes`. |
| `commands` | Up to 6 `{label, run}` entries. Each `run` is one line of at most 500 characters. |
| `builtInRuleIds` | Ids of MOAG's built-in AI rules. The rule text is referenced, never copied. |
| `freeText` | Up to 20,000 characters of project rules in prose. |

Limits and refusals:

- Lists hold at most 50 entries of at most 200 characters each.
- A value that looks like a credential (`sk-…`, `ghp_…`, `AKIA…`, a PEM header) is refused.
- A profile never carries a regular expression. Patterns are literals, globs (`*`, `**`, `?`) or a named built-in.
- The text a prompt carries is at most 4,000 characters. The structured rules are always included in full; a profile whose structured rules alone exceed the cap is refused. Free text is added as a quoted block and cut to the room that is left. Built-in rule bodies are inlined while they fit, and listed by name otherwise.

Each proposed field is tagged `detected` (with the file that proved it) or `assumed` (the stack default). The tags are stored beside the profile as `provenance`. A detected directory's evidence ends in `tracked by git`; when git gave no listing, the structure fields are `assumed` and their evidence says why no directory was proposed.

For an existing repository the proposal's `commands` are the project's own tools, because only commands block a release. Each is a fixed template chosen by what a file proves; a script body is never copied:

| Proposed command | Proved by |
|---|---|
| `npm run lint`, `npm run format:check`, `npm run typecheck` | a script of that name in `package.json` |
| `npx eslint .`, `npx biome check .`, `npx prettier --check .`, `npx stylelint "**/*.css"` | the tool's config file, when no script covers it |
| `npm test` | a `test` script in `package.json` that runs something. The `npm init` placeholder (`echo "Error: no test specified" && exit 1`) and an empty script prove nothing |
| `ruff check .`, `flake8`, `black --check .` | the tool's config (`ruff.toml`, `.flake8`, `[tool.ruff]` / `[tool.black]` in `pyproject.toml`) |
| `pytest` | `pytest.ini`, `conftest.py`, or a Python manifest that lists `pytest` |
| `go vet ./...`, `go test ./...` | `go.mod`; plus `golangci-lint run` from a golangci config |
| `dotnet format --verify-no-changes` | `.editorconfig` in a .NET repository |

Java and .NET get no test command: the build wrapper or project file a test run needs is not proved by the detection, so it is left to the reviewer. Package.json, like every other file, counts only when git tracks it (when git gives no listing, it is read from disk, as the lint configuration is). The `commands` area is tagged `detected` with the first command's proving file and the note `not executed`; when no command can be proposed it stays `assumed` and names the stack's usual tools. A `test` script with no recognised framework also makes the testing area `detected` (`package.json — test script`). Every proposed command is shown verbatim and, as an enforcement change, needs the reviewer's acknowledged approval before it runs.

For an existing repository the file-naming rule follows the names the repository already has, measured over the first 1,000 source files. If at least 70% of the names a rule covers fit one style, that style is proposed, and tagged `detected` when a name proves it (`useAuth` proves camelCase; `index` proves nothing). If the names fit no single style, no naming rule is proposed and `naming/files` reports `not-checked`.

A `detected` tag is the server's own statement, so a person's edit cannot inherit it:

- When a person proposes a version, each area is compared with the last automatic version the proposal descends from, not with the version it was edited from.
- An area that is still identical to that automatic version keeps its tag.
- Every other area is tagged `assumed`, with the evidence `entered by <username>`. This includes a value that is submitted again unchanged on top of someone's edit.
- A proposal with no automatic ancestor is tagged `entered by <username>` throughout.

The screen also marks what changed since the previous version.

### Versions and who decides

Standards live in `projects/<id>/standards.json` in the data directory, outside the workspace. The server never reads a `.moag/standards.json` or `.moag/rules.json` that a repository ships.

- Proposing always creates version N+1 as `pending`. A pending version that a newer proposal replaces becomes `superseded`.
- A reviewer approves or rejects a pending version. An approved version is never changed again.
- The version **in effect** is the latest approved one. It stays in effect while a newer proposal is pending or rejected.
- A project keeps at most 200 versions.

| Action | Roles | Route |
|---|---|---|
| Read | any signed-in user | `GET /api/projects/:id/standards` |
| `standards.propose` | product-owner, admin | `POST /api/projects/:id/standards/versions` with `{profile, baseVersion}` |
| `standards.approve` | reviewer | `POST …/standards/versions/:version/approve` with `{contentHash, acknowledgedEnforcementHash?}` |
| `standards.reject` | reviewer | `POST …/standards/versions/:version/reject` with `{reason}` |
| `standards.accept-defaults` | admin | `POST …/standards/accept-defaults` with `{contentHash, acknowledgedEnforcementHash?}` |

- `baseVersion` is the latest version the proposer saw. If someone proposed in between, the answer is `409 stale`.
- Approve and accept-defaults echo the `contentHash` the user saw. If it does not match, the answer is `409 hash-mismatch` and nothing is approved. A version that was already decided answers `409 already-decided`.
- A version that **changes enforcement** (see [Changing what blocks](#changing-what-blocks)) is put into effect only with an acknowledgement: the approve or accept-defaults body must also carry `acknowledgedEnforcementHash`, equal to that version's `contentHash`. Without it, or with the hash of other content, the answer is `409 acknowledgement-required` with the differing `fields` and `comparedTo`; nothing is approved and nothing is audited. The review screen sends it only after the reviewer ticks the checkbox under the enforcement changes.
- An invalid profile answers `400 invalid-standards` with the list of problems in `errors`.
- A **product owner or an admin proposes; a reviewer approves or rejects.** That holds for every change to the standards, including promoting a rule to blocking or demoting one. A reviewer who wants a change asks for a proposal, or rejects the pending one with the reason.
- A user who holds both roles and approves their own proposal is allowed. The audit entry is flagged `self-approval`.
- Every mutation writes one audit entry holding the version number, the content hash and the origin (`auto` or `user`), plus what the version changes about enforcement (see **Changing what blocks** below): for each differing field, what it held before and after. That includes command lines and labels, required directories and rule severities — they decide what can stop a release, and an auditor needs to read them. No other profile text (free text, notes, style source) is written to the audit log. A refused request writes nothing.

Approving a version lets its `commands` run in the project workspace on every run. The reviewer is shown each command exactly as it will run.

### The plan gate

- `POST /api/projects/:id/plans` answers `409 standards-not-approved` while no version is approved. No job starts and nothing is audited. The response carries `state` (`pending`, `rejected` or `none`) and `pendingVersion`.
- The PRD resource omits the generate actions from `allowedActions` in that state and sets `planBlockedReason: "standards-not-approved"`.
- The check is made again when a plan is approved, so a plan that was pending before the project had standards cannot be approved while none are approved.
- A run is refused with the same code whenever the project has no approved version, whatever its plan was generated under (a plan approved before the project had standards included, and a store that lost its versions). The plan card says why (`startBlockedReason: "standards-not-approved"`). Approving or skipping a ship gate is refused the same way; rejecting the ship stays possible.

### New and existing projects

- **New project:** `POST /api/projects` proposes v1 at once. Detection reads **only the files git tracks** in the workspace (`git ls-files`, asked asynchronously, with a minimal environment that carries no `GIT_DIR` or `GIT_WORK_TREE`) and lays what it finds over the stack's built-in profile. A directory that `.gitignore` names, or that is merely on disk, is never proposed — as a required directory, in the allowed layout, or anywhere else. A repository with no tracked source files is proposed as greenfield, with every field `assumed`.
- **When git gives no listing** — the workspace is not a repository or not its root, git is missing or times out, or git refuses the directory (`safe.directory`: "dubious ownership") — no directory is proposed at all, and the provenance of the structure fields says why (for example `no directory is proposed: git refuses this workspace: it is owned by another user (see git safe.directory)`). Facts about the code itself (stack, test runner, lint configuration) are still read from disk.
- **Existing project:** at boot, each project without a standards file gets the same automatic v1, marked `migrated`. The audit entry is written by `system` with the flags `auto-proposed` and `migration`, plus `enforcement-changed` when the proposal brings a command or a required directory (it is measured against an empty baseline). A migrated workspace usually holds earlier runs' build and test output; none of it is proposed, because only what git tracks is. A second boot proposes nothing. If detection fails, the proposal is the built-in profile with every field `assumed`; the boot never fails for it.
- A migrated project has two ways forward:
  - a reviewer approves the proposal (or a product owner edits it first), or
  - an admin **accepts the defaults**. This is offered only while the project is `migrated` and its pending version is still the untouched automatic one. It is audited as `standards.accept-defaults`, never as an approval, and the version is shown as "not reviewed". It needs the same acknowledgement as an approval when the proposal changes enforcement.
- Until then, new plans are blocked, and so are runs, including runs of plans approved before the project had standards. Once a version is approved (or the defaults accepted), such a plan can start without being approved again, and its run is held to the standards then in effect like any other.
- A run that was started before the upgrade carries no standards version. Its ship gate can be approved only while the project has approved standards. Approving it freezes the standards then in effect onto the run, so the resumed segment runs the standards check in its verification pass and nothing ships unless that check passes. The check diffs from the last ship or, failing that, the earliest recorded run base. With neither, it checks every file, because HEAD may already include the run's own work. No pre-gate report exists for such a run, so the approver sees none. Skipping its gate freezes nothing, since a skip ships nothing.
- Changing a project's stack proposes nothing. The standards resource reports `stackMismatch: true` and the screen says so.
- Rolling back to an older server build is safe: it ignores `standards.json`. The standards version on a release row is dropped the next time that build saves the plan.

### What a run does with them

1. **At run start** the server freezes the version in effect on the run record, with its content hash and the diff base. A version approved later does not change a run that has started. A resumed segment uses the recorded version.
   - **The diff base is the last ref that shipped, not `HEAD` at run start.** When a run stamps a release, the server records the workspace's `HEAD` as the project's last-shipped ref, and every later run diffs against it. Before the first ship, a run uses the base of the project's earliest run; only the very first run uses `HEAD` as it stands. A ship whose `HEAD` cannot be read does not move the base: the previous one stays, so the next check covers that ship's work again rather than diffing against the empty tree. A last-shipped entry without a ref (written by an earlier build) is ignored the same way.
   - This keeps unshipped work inside the check. If a run commits a violation and ends `gaps`, the next run still sees that commit in its diff. Committing work never clears it.
   - If there is no base (a repository with no commits), every file counts as added.
   - If a base was recorded but the repository no longer has that commit (its history was rewritten and pruned, or the workspace was cloned again), the check also falls back to the empty tree: every file is judged as added, and the report's `baseRef` shows the empty-tree id. Code written before the run is then in scope and can fail the run. A lost base never turns the check off.
   - If a base was recorded and no diff can be taken at all, the standards gate fails.
   - A rule that finds nothing in the diff to judge is `not-checked`, never "no findings". An empty diff clears nothing.
2. The server writes the version to `projects/<id>/runs/<runId>/standards.json` and gives the worker that path. The file holds the profile and the prompt text, rendered by the server. The worker never renders the text, never infers a command, and never builds an AI-rules store.
3. **Every task prompt** carries the text under `## Project Standards`, directly before `## AI Rules`. It is present even when context building is turned off or the context budget is smaller than the block.
4. **Before the ship gate**, when the run halts for approval, the worker checks the standards once with no model call and sends a report marked `pre-gate`. The approver sees it, and it binds: while it shows a blocking failure, or a blocking rule or command that was **not checked**, `POST …/gate/approve` answers `409 standards-blocking` with a message that says which, and nothing resumes. Rejecting the ship is always possible; a skip, which ships nothing, is not held back. The check is made on the totals the server stored on the run record, never on a file in the run directory.
5. **After the gate**, the run's verification checks the standards again. That check decides.
6. **When the run ends**, the server accepts a clean exit only with proof of that check. The worker's report names the hash of the profile it used and the base ref it was given, and the server compares both, and the version, with what it froze on the run record at run start. If the run exited 0 without a verify-phase report, or the report was made with a different profile or base, the run ends `gaps` and nothing is shipped. The standards job file sits in the run directory, which an agent can write; this comparison is what detects a rewritten file.

### The verification order

Verification applies its gates in this order and stops at the first failure. No model is called unless all of them pass.

1. **status**: every task reached a completed state.
2. **change**: the diff is not empty.
3. **standards, static rules**: the diff is checked against the profile.
4. **command**: the repository's own gate commands.
5. **standards, profile commands**: the profile's `commands`. A command that already ran as a repository gate is not run twice.
6. **UAT** and **artifacts**, as before.

A **blocking** failure in step 3 or 5 is reported as the failed gate `standards`. The run ends with status `gaps` (worker exit 1), the approved ship is not stamped, and no requirement becomes `shipped`, even when every task completed and the ship gate was approved. An **advisory** finding is reported in the same place with the same detail and stops nothing; see [Blocking and advisory rules](#blocking-and-advisory-rules).

With a default profile, step 3 stops nothing: every static rule is advisory. What stops a run is step 5, the profile's commands. Step 3 can stop a run only where a project promoted a rule.

**Unevaluated blocking evidence is not a pass.** After step 5 the blocking set — the commands, and any promoted rule the profile configures — is in one of three states, and the gate row `moag:standards v<N>` says which:

| Blocking set | Gate row | Release |
|---|---|---|
| evaluated: every blocking row has a result and none failed | exit 0, `nothing blocking` | ships, stamped with the standards version |
| a blocking row failed or has findings | exit 1, `stopped` | stopped (`gaps`) |
| a blocking row was **not checked**: a command never ran, or a promoted rule could not read a changed file, had no diff, or found nothing in the change to judge | exit 1, `stopped`; its text says `could not be checked` and names each row and its reason | stopped (`gaps`) |
| none configured: no command and no promoted rule | exit 0, `no blocking rules configured` | ships; the stamp carries `noBlockingRules` and is shown as "no blocking rules configured", never as passed |

**The row is worded, never shown as a pass or a fail.** It is not a command, so no surface reads its exit code as a result. Each one says the same single word, from one function (`standardsGateWord`): `stopped`, `no blocking rules configured` or `nothing blocking`. That holds for the gate table of the VS Code verification report, the Gates cell of the hosted trace, the `standards` key on the row in `GET /api/projects/:id/trace` and `moag trace`, the evidence block handed to the verifying model (`- moag:standards v3 — nothing blocking (2 advisory findings · 1 file not checked, 12ms)`, where a command reads `exit 0 (PASS, 12ms)`), and the stored `.moag/verification-<ts>.json`, where the row has `standards` and `standardsOpen` and no `passed` key at all. A real command keeps `pass` / `fail` / `timeout` and its exit code everywhere.

The row's text also gives the number of advisory findings, of rules not checked and of files not checked. When an earlier gate already failed (a repository command, say), the profile's commands are listed as not checked in the report and no standards row is written at all: the run has already failed.

On the hosted server the same rule is applied a second time to the worker's report: which rows block is decided by the profile the server froze on the run, and a command of that profile the report says nothing about is added as not checked. A report that merely leaves a command out therefore stops the ship; it can never read as "no blocking rules".

Release and deploy tasks run after the ship gate and before this verification, as they do for a failing test suite. A deploy can therefore have happened before a standards failure is found. The pre-gate report exists so that the approver sees the result first.

### What is checked

The static rules look only at what the run changed: added lines of changed files, and for naming and placement, added and renamed files. Code the run did not touch is not judged.

- **Renames are detected.** A file git matches to one that existed at the base (`git mv`, or a plain move whose content is byte-for-byte a deleted file) is `renamed`: its new path is judged for placement and naming, and only the lines the change really altered count as added. Moving a legacy file adds no line. Every diff is taken with an explicit rename limit of 20,000 files, so neither a large change nor a `diff.renameLimit` or `diff.renames` setting in the repository's git config can turn detection off. This holds for the committed and staged versions below as well.
- **A nested repository is reported, never read past.** A directory that is a git repository of its own is one entry to git, which shows none of its files. The rule `structure/nested-repository` reads the **current state of the tree** — no base ref enters into it:
  - a gitlink in the index that no **tracked** `.gitmodules` declares, and an untracked directory holding a `.git`, are each a finding on the rule, naming the directory, **and** the directory is listed under files not checked as `not checked (nested repository — files inside were not read)`. It makes no difference whether this change added it or it has been there for years;
  - a submodule a tracked `.gitmodules` declares is listed as `not checked (submodule — files inside were not read)` and is no finding. A `.gitmodules` that exists only in the working tree declares nothing;
  - untracked directories are taken from git's own listing with its standard excludes, so `.git/info/exclude` and a global excludes file hide one exactly as `git status` would.

  The rule is advisory by default, like every scan; promoted, a finding stops the release.
- **What is committed is what ships.** A file committed since the base and then deleted or rewritten in the working tree without a commit is judged a second time, from the commit. Its findings say so.
- **What is staged is what the next commit ships.** Content that was `git add`ed and then deleted from, or rewritten in, the working tree is not in a working-tree diff at all. It is judged from the index, and its findings say so. A staged version that adds no line to a file the working tree still holds (a `git mv` followed by an unstaged edit) is not listed a second time.

Which files changed is decided without trusting git state that leaves no trace in the repository:

- Untracked files are listed honouring `.gitignore` files only. `.git/info/exclude` and a global excludes file are ignored, so a file listed there is still checked. On a developer's own machine this means files hidden only by a global ignore (editor folders, `.DS_Store`) are seen by `moag standards check`; add them to `.gitignore` or to the profile's allowed top level.
- A tracked file flagged `assume-unchanged` or `skip-worktree` in the index is listed as changed and unread. Its rules are `not-checked`, and the report names it.

Vendored and generated files are not judged like hand-written code. A file under a top-level `vendor/`, `node_modules/` or `third_party/` directory — or under a deeper `node_modules/` beside a `package.json`, or a deeper `vendor/` beside a `go.mod`, `composer.json` or `Gemfile` — a file named `*.pb.go`, `*.g.cs` or `*.Designer.cs`, the Maven and Gradle wrapper scripts, and a file whose first five lines carry `Code generated … DO NOT EDIT`, `@generated` or `<auto-generated` **in a comment** is left out. A directory that merely has the name (`src/vendor/`) and a marker inside a string literal exempt nothing. Such a file is left out of the placement, naming, raw-pattern, layering and comment rules. The top-level rule still applies to it. A profile cannot yet name its own generated directories.

**Every exemption is visible.** The report lists each changed file the line rules did not read, as `not checked (<reason>)`, and counts them (`notCheckedFiles`, `totals.notCheckedFiles`):

- vendored code, and whether this change added it;
- a generated file, and whether this change added or newly marked it;
- a file in a language with no lexer (`No checker for .rb files`);
- a file of a type no scanner reads, as `unsupported type (<type>)`: build scripts (`.gradle`, `.kts`), shell scripts (`.sh`, `.bash`, `.zsh`), component and stylesheet dialects (`.vue`, `.svelte`, `.scss`, `.sass`, `.less`), `.mdx`, `.svg`, pipeline and tool configuration (`.yml`, `.yaml`, `.toml`), `Dockerfile`, `Containerfile` and `Makefile`. These are code or configuration a project is built from; a change to one is listed, never skipped in silence;
- a file that could not be read or lexed (too large, binary, an ambiguous construct), with the reason;
- a directory that is a nested repository or a submodule (see above).

Such a file is never evidence for "no findings": a rule that read nothing else is `not-checked`. Plain data and prose (`.json`, `.md`, `.txt`, an image, `LICENSE`) is out of scope for the line rules and is not listed. The list is capped at 200 entries; the count is always the true one.

A file this change **newly marked as generated** — it wrote the marker comment, on a new file or onto an existing one — is also a finding of its own, on the marker's line, under the rule `exemption/newly-generated`. It is advisory by default. A file that is generated by its name or vendored by its directory carries no marker anybody wrote: it is listed as not checked and is no finding.

| Rule | Default | Checks |
|---|---|---|
| `structure/required-dirs` | advisory | Each required directory holds at least one path git lists for the tree — tracked, or untracked and not ignored. The comparison is case-sensitive whatever the file system is: `SRC` does not satisfy `src`. An empty directory, and one that only `.gitignore`d files sit in, does not exist for this rule. |
| `structure/top-level` | advisory | A new top-level entry is in the allowed layout. |
| `structure/placement` | advisory | An added or renamed file that matches a placement rule sits under one of its directories. |
| `structure/nested-repository` | advisory | The tree holds no directory that is a git repository of its own and that no tracked `.gitmodules` declares. |
| `frontend/raw-pattern` | advisory | No added line contains a configured raw pattern. |
| `layering/imports` | advisory | No added import crosses a forbidden layer boundary. Relative imports, declared aliases, the repository's own workspace packages (`package.json` `workspaces`, `pnpm-workspace.yaml`) and TypeScript path aliases are resolved: `compilerOptions.paths` and `baseUrl` in `tsconfig.json`, `tsconfig.base.json` or `jsconfig.json` at the root and above each changed file, with `extends` followed, and with project `references` followed one level (a "solution" config whose paths live in `tsconfig.app.json`). An alias import that cannot be resolved leaves the rule `not-checked`; it is never reported as "no findings". `.mts` and `.cts` files are read like `.ts`. For Python, `from <package> import <name>` also checks each imported name as a submodule. |
| `naming/files` | advisory | An added or renamed file's name follows the configured style. |
| `comment-policy/commented-out-code` | advisory | No added comment is commented-out code. A comment counts when it is unmistakably a statement, or when two code-shaped comment lines sit together. A call-shaped note such as `// O(1)` or `// rgb(0, 0, 0)` is not code on its own, and neither is an indented example in a Go doc comment. |
| `comment-policy/banned-phrase` | advisory | No added comment contains a banned phrase. Each phrase is matched against **one comment**: a single `//` or `#` comment, or one whole block comment with its lines put back together. Two comments on one line, or on neighbouring lines, are never run together. A phrase written as a comment (`// rest of the code`) must be the whole comment, give or take surrounding dots and brackets, a leading "the" and a leading `TODO:`; an ellipsis in a phrase matches `...`, `..` and `…`. The built-in list holds truncation placeholders only: whole-comment placeholders (`// rest of the code`, `// your code here`) and placeholders between two ellipses (`... existing code ...`). It holds no assistant-voice phrase such as "as an AI", which honest prose also contains, and no bare two-word label such as `// existing code`. A sentence that merely shares the words ("put your code here if you need a custom step") is not matched. A project may add any plain phrase to its own profile. Comments inside inline `<script>` and `<style>` in an HTML file are read like any other. |
| `comment-policy/density` | advisory | In a file with at least `minAddedLines` added lines, comment lines are at most `maxDensityPct` of them. Documentation comments are not counted. |
| `exemption/newly-generated` | advisory | No file was newly marked as generated by this change (see above). |
| profile commands | blocking (always) | Each command exits 0. A command is a real tool with a real exit code, and cannot be made advisory. |

### Blocking and advisory rules

Every rule is `blocking` or `advisory`. The finding detail is the same for both; the difference is what a finding does.

- A **blocking** rule that fails or has findings fails the standards gate: the run ends `gaps` and nothing is marked shipped.
- An **advisory** rule's findings are listed with file, line and rule in the report, shown to the reviewer and the approver, counted in the totals (`advisory`, `advisoryFindings`), and stop nothing.

**The default blocking set is the profile's commands, and only them.** Each is a real linter, formatter, type-checker or test, and its exit code is the evidence. A command is always blocking and cannot be made advisory.

Every rule MOAG decides itself — required directories, nested repositories, placement, the top-level layout, naming, layering, raw patterns, commented-out code, banned phrases, comment density and generated markers — is **advisory by default**: in the built-in profiles, in every proposal and in the defaults a profile inherits. Each has been shown to flag correct code or to miss real violations. Detecting a required directory in the repository does not make the rule blocking either. Style and structure are meant to be enforced by the stack's own tools as profile commands: a proposal adds the standard check command for each tool whose config file is tracked in the repository, and says so when it found none.

A profile with **no command and no promoted rule** has an empty blocking set. That is allowed: a run under it may ship. Every surface then says `no blocking rules configured` — the CLI, the web cards, the HTML report, the gate row and the release stamp — and none says that anything passed.

Detection proposes only **top-level** directories that hold tracked source files as required directories (a nested test or fixture folder is never required).

**Honest wording.** A scan that found nothing has not proved that nothing is there, so a scanner rule is never said to have passed:

| Kind of row | Outcomes shown |
|---|---|
| A profile command | `passed`, `failed`, `not checked` |
| Every rule MOAG decides itself | `no findings`, `findings`, `not checked` |

The CLI, the web cards, the HTML report and the `moag:standards` gate row all use these words. The badge of the run's standards card follows the same rule: the green `✓ NOTHING BLOCKING` is shown only when a profile **command** passed and nothing was left open. When the blocking set is made only of promoted scanner rules and they found nothing, the badge is `NOTHING BLOCKING · NO FINDINGS` in the neutral colour, with no tick and no green frame; with something left open it is `NOTHING BLOCKING · 3 ADVISORY · 2 FILES NOT CHECKED` in the warning colour. The stored report keeps one closed set of result values (`passed`, `failed`, `not-checked`) for every row; the words above are how a row is shown. The totals keep the two apart as well: `passed` counts commands only, and `noFindings` counts rules that read something and found nothing.

**Promoting a scanner rule.** A profile changes any rule with `"severity": { "<rule>": "blocking" | "advisory" }`, so a project may still make a scanner rule blocking. The editor warns at the control the moment one is set to blocking, the review screen repeats the warning for the reviewer, and every report of a run names the promoted rules: scanner rules are heuristic, and as blocking rules they can stop correct code and can miss real violations. A product owner or an admin proposes the promotion and a reviewer approves it, like any other change.

#### Changing what blocks

MOAG does not try to tell a change that tightens enforcement from one that loosens it. `npm test` rewritten to `npm test || true` removes nothing and adds nothing, and switches a check off all the same. So **any difference** between a version and the version in force, in a field that decides what can stop a release, is an *enforcement change*:

| Field | A difference is |
|---|---|
| `commands` | anything: a command added or removed, a command line edited, a label renamed, the order changed, the list emptied. Compared exactly. |
| `severity` | a rule promoted or demoted. Compared as each rule resolves, so writing a default out explicitly is not a difference. |
| `structure.requiredDirs` | anything: an entry added, removed or swapped, the order changed, the list emptied. Compared exactly. |
| the settings of a rule that is **blocking** (`ruleConfig`) | anything, for a rule that is blocking in either version: a promoted naming rule whose patterns were emptied can stop nothing, though its severity never moved. The settings of an advisory rule are not compared. |

One comparison (`enforcementReview`) drives three things, so none can show or require something another missed:

- **The review screen** shows the differences at the top of the version card, un-collapsed, with what each field held before and after (`enforcementChanged` on each version of `GET …/standards`: `comparedTo`, `changed`, `fields`, `commands`, `severity`, `requiredDirs`, `ruleConfig`). **Approve** (and **Accept defaults**) stay disabled until the reviewer ticks "I have read the enforcement changes…".
- **The server** refuses to approve such a version without the acknowledgement (`409 acknowledgement-required`; see above). The screen's checkbox is a convenience; this is the enforcement.
- **The audit log**: the entry of every propose, approve and accept-defaults carries the flag `enforcement-changed` and, in `after.enforcementChanged`, the same before/after for each differing field. `severity-changed` and `commands-changed` are added beside it when those fields are among the differences. The flags `blocking-set-reduced` and `blocking-set-extended` no longer exist.

The comparison is with the version **in force** — the latest approved version below the one being proposed or approved — at propose time and again at approve time. It is never made with the proposal a version was typed on top of, which may be a superseded or rejected one: a change carried along a chain of unapproved proposals under word edits is still shown, still needs the acknowledgement, and is still flagged when the last of them is approved. While nothing is approved the comparison is with an **empty baseline** — no command, default severities, no required directory — so a first version that brings any of them is an enforcement change too. A version that changes none of these fields is not flagged and needs no acknowledgement.

If the store cannot be read when the entry is written, the entry is flagged `enforcement-changed` and `enforcement-reference-unreadable`: a change is then over-reported, never missed.

Promoting or demoting a rule is an edit to the profile like any other: a new version, pending until a reviewer approves it. The review screen also keeps its list of promotions and demotions in the severity section (`severityChanged`, `severityComparedTo`), from the same comparison.

The report shows its groups apart and never mixes them: **Blocking**, **Advisory**, **Rules not checked** and **Files not checked**. A blocking rule or command that was not checked is listed first in its group, marked, and counted on its own (`blockingNotChecked`); any such row stops the release. On the server, severities are re-derived from the standards version frozen on the run, so a report cannot arrive with a blocking rule demoted — or with an advisory one made to block.

Each finding names a file, a line and a rule.

**Not checked is not a pass.** A rule is `not-checked`, with a reason, when:

- it is not configured in the profile;
- the file's language has no lexer (the supported ones are TypeScript and JavaScript — `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` — Java, C#, Go, Python, HTML and CSS);
- the file has no extension and starts with `#!`: it is a script the checker cannot read (`LICENSE` and similar prose files are out of scope by name; `Dockerfile` and `Makefile` are listed as an unsupported type);
- no diff could be taken, or git gave no listing of the tree (every rule then, required directories and nested repositories included);
- it is a profile command that did not run: an earlier command or gate failed, the check was stopped, or `--no-commands` was given;
- git was told to ignore changes to the file (`assume-unchanged` or `skip-worktree`);
- the diff holds only vendored or generated files for that rule;
- it is a rule the project promoted to blocking and the change itself made a file exempt: it added the file under a vendor directory, added a file with a generated name (`.pb.go`, `.g.cs`, `.Designer.cs`), wrote the generated marker, or added the manifest that marks the directory as third-party. The file is named and counted in `blockingNotChecked`. For an advisory rule, and for a file that was already vendored or generated at the base ref, the rule only notes how many files it did not check. Either way the file is in the report's list of files not checked;
- a Python `from <package> import (` or `import *` names one of the project's own packages and the imported names are not on that line;
- the file could not be read with certainty: it is over 512 KB, binary, has an unterminated string or comment, or holds a `/` that may divide or open a regular expression, a `<` that may open a JSX element or a type parameter list, or an inline `<script>` in a language other than JavaScript or JSON. Where the language settles the question the file is read: a property named like a keyword is an operand (`obj.in / 2`, `this.of! / 2` divide), and in a `.tsx` file `<T extends Base>(…)` and a `<T>(…)` after `type Name =` are type parameter lists, as the TypeScript compiler reads them. In a `.js` or `.jsx` file `<T extends …>` cannot be settled and the file is not checked;
- an import names a workspace package and the workspace could not be read;
- a tsconfig or jsconfig above the file could not be read, extends a file that was not found, or refers (`references`) to a config that is missing or unreadable: any non-relative import may then be one of its aliases;
- an earlier gate failed first;
- it is a layering rule for C#, whose `using` lines cannot be mapped to paths.

A not-checked rule is always shown and never counted as passed or as "no findings". An **advisory** rule that is not-checked stops nothing. A **blocking** row that is not-checked — a command, or a promoted rule the profile configures — stops the release, whatever the reason: no reason is weighed. A promoted scan therefore also stops a change that gives it nothing to judge (a documentation-only change under a promoted comment rule, say); a command always runs and does not have that problem, which is one more reason to block on commands.

The report is stored in the run directory as `standards-report.json`, with only its totals on the run record. Findings are capped at 200, not-checked files at 200 and command output at 2,000 characters; the totals keep the true counts. `GET /api/projects/:id` returns it as `currentRun.standardsReport`; a run with no report has no such field.

When a requirement ships, its release row records the standards version it shipped under (`standardsVersion`). `GET /api/projects/:id/trace` and `moag trace` both show it. A release whose check left a blocking rule or a command not-checked does not ship at all (above), so a recorded version means one of two things, and the counts beside it say which: the blocking set was evaluated and nothing in it failed, or the profile had no blocking set. What the advisory scans managed to read plays no part. A local release task follows the same rule: it stamps the version only when the requirement's latest gates hold an exit-0 `moag:standards v<N>` row for that version.

Each requirement's latest gates are in the row too (`gates`, as `{ command, exitCode }`). The `moag:standards` row among them carries two more keys, so that neither the trace screen nor a reader of `moag trace` has to guess what `exitCode: 0` means there: `standards`, the word above (`stopped`, `no blocking rules configured` or `nothing blocking`), and `standardsCounts` when the row was recorded with them. No other gate has either key. The trace screen's Gates cell tallies commands only (`1/1 pass`) and puts the word beside the tally (`· standards: no blocking rules configured`).

Beside the version, the release row records what the check left open, as numbers only (`standardsCounts`): `advisoryFindings`, `notCheckedRules` (rules the profile configures that were not checked) and `notCheckedFiles` — and `noBlockingRules: true` when the profile had no command and no promoted rule. The trace screen then shows "no blocking rules configured" beside the version; the key is absent whenever a blocking set existed. A checked release is not always a clean one, and the trace says by how much. The counts are never recorded without a version. A plan file written before they existed loads unchanged.

### Local workspaces

The VS Code extension and the headless CLI use `<workspace>/.moag/standards.json`, which is trusted because the workspace is the user's own. There is no approval step locally.

```json
{ "schemaVersion": 1, "version": 1, "profile": { "…": "…" }, "provenance": { "…": "…" } }
```

A file that exists but is invalid is an error that names the file. It is never treated as "no standards".

```
moag standards show
moag standards check [--base <ref>] [--no-commands]
moag standards propose [--stack <id>] [--write [--force]]
```

- `show` prints the document and the text every prompt carries.
- `check` checks the diff since `--base`. Without `--base` that is the commit captured when the first run since the last passed verification started (`.moag/standards-base.json`), so work a run committed is still checked; with none captured it is `HEAD`. Its exit codes are: **0** nothing blocking — every command passed, or the profile has no blocking rules configured (the output then says so, and prints no row as passed); **1** a command failed, or a promoted rule has findings; **2** a usage error, or no usable profile; **5** no diff could be taken at all, so nothing was checked; **6** nothing blocking failed, but a command or a promoted rule was **not checked** — unevaluated blocking evidence is not a pass. `--no-commands` leaves every command not checked, so with a profile that has commands it exits 6. Advisory findings are printed and do not change the exit code. The output has four groups — Blocking, Advisory, Rules not checked, Files not checked — with one `file:line rule` line per finding and one `path — not checked (reason)` line per file. Only a command is printed as `passed` or `FAILED`; every rule MOAG decides itself as `no findings` or `FINDINGS`. A blocking row that was not checked is marked `!! BLOCKING RULE NOT CHECKED`. When the profile promotes a scanner rule to blocking, the output says which and repeats the warning.
- `propose` detects the repository's conventions from the files git tracks (it asks git which they are; with no listing it proposes no directory and says why in the provenance) and prints a proposal. It writes the file, as the next version, only with `--write`. An existing file that differs from the proposal may hold hand edits and is replaced only with `--force`; the file it replaces is kept as `.moag/standards.json.bak`.
- `--no-standards` on `run` and `verify` turns project standards off for that invocation: task prompts carry no standards block, and verification runs no standards gate.

## Threat model

**Assets**
- user credentials and sessions
- engine API keys and the master secret
- the audit log's integrity
- the canonical plans and approval state
- the repos and workspaces
- the host and container
- spend (tokens cost money)

**Actors**
- unauthenticated network clients
- authenticated users in each role
- a malicious or compromised repo (its `.moag/*`, its build scripts)
- **coding agents**, which execute arbitrary commands by design and can be prompt-injected through PRD text or repo content
- the operator

**Trust boundaries**
- browser ↔ reverse proxy ↔ server
- server ↔ worker (process boundary, scrubbed env, IPC)
- worker ↔ agent CLI (same uid)
- the container ↔ the host

| Threat | Mitigation | Residual |
|---|---|---|
| Credential stuffing or brute force | scrypt, 429 per account+IP and per IP, uniform error and timing. Bootstrap tokens are limited per IP. Wrong *current* passwords on `POST /api/me/password` are limited per user, from any IP (5 wrong, then 15 minutes of 429 before scrypt runs), so a stolen session is not a password oracle | In-memory limiters reset on restart |
| Session theft | HttpOnly, `__Host-`, Secure on https, hashed ids at rest, epoch invalidation, no-store on `/api`. A revoked session (logout, role change, disable, password set) ends its live event streams at once with an SSE `session-ended` event; an expired one at the next heartbeat | TLS is the reverse proxy's job (documented) |
| CSRF | synchronizer token, JSON-only bodies, Origin check, SameSite=Lax | — |
| XSS from agent-authored task names, error tails or PRD text | CSP `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`, nosniff. A static test bans `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write`, `eval`, `new Function` and inline handlers/scripts in `web/**` | — |
| Privilege escalation | `canPerform` on every route, last-admin guard, role change kills sessions, table-driven matrix test | — |
| **Run = RCE** | Only `reviewer` and `admin` start runs, only on a reviewer-approved, content-hash-bound plan. A run job runs as a separate process with `cwd` = its project workspace, a server-generated config (the repo's `.moag/config.json` is ignored, `custom`/`copilot` are rejected at plan approval), and an env allowlist plus only that job's engine keys. **Plan generation** (`product-owner`-triggered) does NOT start in the repository: its agent CLI runs with `cwd` = an empty server-owned scratch dir (`projects/<id>/plans/<planId>/work`), auto-approve forced off (no `--dangerously-skip-permissions`, no Claude allow-list, no Codex `--full-auto`, no Gemini extra args), and its tools locked down (see [Planner lockdown](#planner-lockdown-and-allowplannerfileaccess)): Claude gets `--tools "" --strict-mcp-config` (no tools at all), Codex `--disable shell_tool --disable unified_exec --sandbox read-only` and `--skip-git-repo-check` (the scratch dir is not a repo; no shell or exec tool, but whether it can still read files through a non-shell built-in is unverified), and engines that cannot be restricted (gemini, anthropic) are refused unless an admin turns on `allowPlannerFileAccess`. The planner sees the repo only as a server-generated, size-capped `git ls-files` listing (first 2000 paths) in its prompt. No repo-shipped engine config (`.claude/settings*.json` hooks, `.mcp.json`, `.gemini/`) is loaded during plan generation. The generated playlist and rejections are scrubbed of the job's injected engine key before they are hashed, stored or shown; if the key appeared, the plan can never be approved. | **Agents run as the same OS user as the server.** An agent can read the data dir (`users.json` hashes, `secrets.json`, other workspaces) and `/proc/<server pid>/environ`, which holds the master key if it came from env. **The container is the real boundary.** An approved **run** executes inside the repository, so the engine CLI loads the repo's own engine config (`.claude/`, `.mcp.json`, `.gemini/`): hooks and MCP servers run as the server uid. That is why only `reviewer` and `admin` can start runs, and why a reviewer must trust a repository before approving its first run (the plan review card warns when the repo ships engine config or agent instructions; see [Who can trigger agents](#who-can-trigger-agents-and-how-they-are-contained)). Documented with a recommendation: one instance per trust domain. Separating the agent UID is deferred. **Plan generation still runs as the server uid** with the engine key in its environment. Under the lockdown a Claude or Ollama planner has no tool to read files with; a Codex planner has no shell, but may still be able to read files the server uid can read (unverified). The job's own engine key is redacted from its output in case the model echoes it. If an admin turns on `allowPlannerFileAccess`, a gemini or anthropic planner **can** read any file that uid can, and a PRD can steer those contents into the generated plan, which every signed-in user can read. On anthropic the override also grants shell execution and file writes (`run_bash`, `write_file`). A CLI too old to know a lockdown flag exits with an error, so its plans fail rather than run unrestricted. Codex only warns about an unknown *feature name* (`--disable <name>`) rather than rejecting it; the read-only sandbox is the backstop there. |
| Generated plan reaching outside its project | Every task `cwd` must stay inside the workspace: an absolute path (POSIX, `C:\`, drive-relative `C:x`, UNC) or a `..` that climbs above the root makes the plan unapprovable (`409 review-errors`), and unstartable if it was approved before the check existed. Every command, cwd, `healthCheckUrl`, `skipIf`, `failurePolicy` and monitor `incidentRepo`/`incidentLabel` is listed verbatim on the review card. `env`, `inheritEnvFiles`, `githubRelease` and `releaseTag` are stripped before hashing | A command can still `cd` anywhere the uid can; the reviewer reads the commands |
| Two projects sharing files | A project's workspace must be a git repository's top-level folder (`not-a-git-repo`, `not-repo-root`), and may not contain or sit inside another project's workspace (`409 workspace-nested`), compared as realpaths | — |
| Command injection through clone URL or path | `execFile('git', ['-c','protocol.file.allow=never','-c','protocol.ext.allow=never','clone','--no-recurse-submodules','--',url,dest], {shell:false})`, `GIT_ALLOW_PROTOCOL`, URL allowlist, paths realpath-confined to the projects root | Re-validated at each job start (symlink TOCTOU) |
| Ship-gate bypass | `CI` stripped and refused, `onManualGate:'halt'` forced, approve is approver-only, skip is admin-only with a reason, distinct audit actions | An agent could edit the run snapshot plan file (same uid). The server re-reads only statuses and trace from it. Documented. |
| Key exfiltration through the API | GET returns last4 only; audit records "key set"/"key cleared" only; error tails are redacted of injected key values before persisting | Keys in the agent env are visible to that agent by design |
| Audit tampering | Append-only API with no edit or delete route | Same-uid writes are not prevented. A hash chain is deferred. |
| Cost runaway | per-version cap, worker `costBudgetUsd` = remaining, plan generation counted, Claude jobs in JSON mode with `--max-budget-usd` per call ([Cost reporting](#cost-reporting)) | Overshoot by one call (the ceiling check runs after each call, `runner.ts:533-551`) |
| DoS | 1 MB body cap, SSE limit 5 per session, job concurrency cap, scrypt semaphore | — |
| Standards text as a prompt-injection carrier (author-written, in every task and planner prompt) | Reviewer approval bound to a content hash. Caps of 20,000 characters of free text and 4,000 characters rendered. Free text is rendered as a `> ` blockquote. A credential-shape scan rejects the proposal. The audit log records the version and hash only | A reviewer who approves hostile text has approved it, the same as a PRD |
| Profile commands are server-side execution | Commands are shown verbatim before approval. Each is a single line of at most 500 characters, and there are at most 6. The worker never infers them, and takes them from the approved version's job file. Approve echoes `contentHash`. A job file rewritten during the run is detected when the run ends (the reported profile hash no longer matches the frozen one) and the run ends `gaps` | `npm run lint` expands to a repo-defined script the reviewer does not see. This is the same exposure as auto-detected gates. The detection of a rewritten job file comes after verification ran, so a command an agent wrote into the file can execute once before the run is failed. That gives the agent nothing new: it already runs commands as the same user |
| Repo-shipped `.moag/standards.json` or `.moag/rules.json` steering a server run | The server worker always receives `--standards <jobfile>` or `--no-standards` and never constructs an AI-rules store. A test stubs `fs` and asserts neither path is read | A local headless run trusts both files by design |
| Standards detector fed a hostile repo | Detection reads files as data. The only processes it starts are bounded, read-only git queries (`git rev-parse --show-prefix`, `git ls-files`) to learn which files the repository tracks — run asynchronously, never on the server's event loop, with a minimal environment from which every inherited `GIT_*` variable is removed; nothing from the repository is executed. Proposed commands are fixed templates, never copied script bodies. File reads are capped, and proposals pass the same validator as user input | Detected values are attacker-influenced until the reviewer reads them, which is why every field is tagged |
| An agent making the standards checker go blind (same uid) | The server freezes the standards version, its content hash and the base ref on the run record in `state.json`. The worker reads them from a job file in the run directory, which the agent can write, so the file is not trusted: the worker reports the hash of the profile it really used and the base it was given, and the server ends the run `gaps` unless a verify-phase report matches what it froze. The base ref is the last ref that shipped, so committing work does not move it out of the diff. The base commit itself lives in the agent-writable `.git`; if it can no longer be resolved the check diffs against the empty tree and judges every file, and if no diff can be taken the gate fails. The patch is taken with `--text --no-textconv --no-ext-diff`, so a `-diff` or `binary` attribute, a textconv driver or an external diff driver cannot hide hunks. A changed file that has content but no rendered hunk is reported as not checked, never as "no lines added". Untracked files are listed honouring `.gitignore` files only, never `.git/info/exclude` or a global excludes file, with `core.fsmonitor=false`. A tracked file flagged `assume-unchanged` or `skip-worktree` is reported as changed and not checked. A rule that found nothing to judge is not checked, never passed, and a release stamps a standards version only when a diff-based rule was decided. `.moag/` is excluded from the diff | Same-uid tampering cannot be fully closed without isolating the agent. What remains: an agent can turn a failure into `not-checked` by crafting a file the lexer finds ambiguous, by flagging a file in the index, or by putting a generated marker (`@generated`) or a `vendor/` path on a file. All three are named in the report. It can hide a new file by adding it to a `.gitignore`; that edit is itself in the diff, but the hidden file is not reported. Not-checked does not block shipping. An agent that can write `state.json` or the server's memory is outside this row: see **Run = RCE** |
| Standards pattern denial of service | No profile-authored regular expression. Globs compile through a bounded internal translator. List and length caps apply to every field | — |
| Standards report as an XSS or leak path | The `verify-standards` payload is shape-validated server-side, findings are capped at 200, command tails at 2,000 characters and redacted with the job's redact list, and the web app renders it with DOM text nodes only | — |
| Planner prompt splice confusion | The `Rules:` marker line cannot occur inside the rendered standards block, because free text is blockquoted. A test covers a profile whose free text contains a `Rules:` line | — |

### Who can trigger agents, and how they are contained

- **Starting a run** is restricted to `reviewer` and `admin`. It needs a plan a reviewer approved, and the approval is bound to the plan's content hash.
- **Plan generation** (product owner) runs an agent CLI in an **empty server-owned scratch directory**, never in the repository, with every engine's auto-approve forced off. Because the CLI does not start inside the repo, repo-shipped engine config (`.claude/settings*.json` hooks, `.mcp.json`, `.gemini/settings.json`) cannot load and run code on a product owner's click. The planner's tools are also locked down ([Planner lockdown](#planner-lockdown-and-allowplannerfileaccess)): Claude runs with `--tools ""` and `--strict-mcp-config` (no tools), Codex with no shell or exec tool and a read-only sandbox (whether it can still read files through a non-shell built-in is unverified), and gemini and anthropic are refused unless an admin sets `allowPlannerFileAccess`, which on anthropic grants shell execution and file writes. The planner gets the repository only as text: a server-generated `git ls-files` listing capped at 2000 paths (git runs with array args, no shell, `core.fsmonitor=false`), placed before the output-format rules in the prompt. The server still redacts the job's engine key from the generated plan and refuses to approve a plan that contained it.
- **Approving a plan** (reviewer, admin) binds two things: the plan's content hash, and **the engine the review card shows**, which is the engine the plan was generated with.
  - If the project's default engine changed while the plan was pending, approval is refused with `409 engine-changed`. Switch the project back or request a new plan.
  - After approval the engine stays locked. A run, or a resumed segment, on a project whose engine has since changed is also refused with `409 engine-changed`.
  - A plan with a task `cwd` outside the workspace cannot be approved at all.
  - A plan whose playlist is marked `parallel` cannot be approved at all. Server runs make one engine call at a time, because the per-call cap and the per-version budget depend on it. The review card says so; request a new plan.
  - A plan that fails review is refused with one of two codes. The response `message` is the review errors joined, and `errors` is the same text as a list:
    - `409 engine-not-allowed` when every error is about an engine the server does not allow (`custom`, `copilot`, or one outside the server's list).
    - `409 review-errors` for anything else: a `parallel` playlist, a `cwd` outside the workspace, a redacted credential, or a mix that includes one of these.
  - The review is **re-run at approval**, not read from the stored result. A plan that was already pending before a review rule existed is refused by that rule.
  - The review is **re-run again when a run starts**, on both the approved playlist and the copy in the project's plan. An approval is not a waiver: a plan approved before a rule existed gets `409 review-errors` (or `409 engine-not-allowed`), no worker is started and no run is recorded. The message starts with `This plan no longer passes review, so it cannot start.` Request a new plan.
  - The review is **re-run when a ship-gate decision resumes a run** (`gate/approve` and `gate/skip`), on the approved playlist and on the run's own snapshot, which is the copy the next segment loads. A run that halted at its gate before a rule existed — a `parallel` playlist, say — is refused with the same two codes; no segment is spawned, the snapshot is not rewritten, no decision is recorded and the run stays `awaiting-approval`. The message starts with `This plan no longer passes review, so the run cannot resume.` `gate/reject` resumes nothing and stays possible: it is how such a run is closed.
  - **The plan card is drawn from the same re-run**, so it never offers a button the server would refuse. In `GET /api/projects/:id`, a pending plan the rules now refuse has `review.ok: false` with today's errors and no `plan.approve` in `allowedActions` (`plan.reject` and `plan.cancel` stay). An approved plan the rules now refuse has no `run.start`, `startBlockedReason: "review-errors"` and the errors in `startBlockedErrors`; the card lists them. Nothing is written back to the stored plan: the review is derived on every read.
- **Starting a run** (reviewer, admin) is where repository code and repository config become live: the run's agent starts inside the repo and loads what the repo ships. **A reviewer must trust the repository before approving its first run.** The plan review card warns, listing each of these entries the repo has:
  - engine config: `.claude/`, `.mcp.json`, `.gemini/`, `.codex/`
  - agent instruction files: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules`
  - MOAG workspace rules: `.moag/rules.json`. A hosted run does **not** inject this file: its prompts carry only the approved [project standards](#project-standards). It is listed because a local `moag run` or VS Code session in the same checkout does inject it

  Read them before approving.
- **Stopping a run** (reviewer, admin) asks the worker to stop over IPC, and kills it if it has not exited 30 seconds later. Stop is idempotent: a second stop while the first is still settling returns `200` with `alreadyStopping: true`, changes nothing and is not audited again.
- **The ship gate gates shipping.** The server appends a `manual` task, **Ship approval**, to every generated plan.
  - The gate depends on all the non-shipping work.
  - Every `release` and `deploy` task, and anything that depends on one, depends on the gate, so nothing ships before an approver says so.
  - The playlist is reordered to: work, then the gate, then shipping tasks.
  - Without a release or deploy task, the gate is simply the last task.
- **Approving a ship gate** (approver) resumes the halted run, and the release and deploy tasks run after it. The server stamps each ready requirement as shipped only when the resumed run finishes with its verify gates green (exit 0) **and** every `release` and `deploy` task in its playlist completed. The stamp goes under the server-generated tag `ship-<runId>`, a trace label rather than a git tag (generated plans may not tag or push). A failing verify ships nothing, and so does a release or deploy task that failed, was skipped, was blocked or never ran. **Skipping** a gate is admin-only, needs a reason, is audited separately from approval, and never ships: the gate is marked done so the rest of the run (its verify pass included) continues, but every release and deploy task behind the gate, and everything that depends on one, is set to Skipped and never runs. Only an approval runs the release.

Each job is its own process: a run with the project workspace as its working directory, a plan generation with its empty scratch directory. It gets the built environment above and only its own engine's key.

**The same-uid residual is the important one.** Agents run as the server's OS user. An agent can read `/data`, which includes password hashes, the encrypted key store and other projects' workspaces, as well as the server's environment. **In practice, anyone who can get a run approved and started — including through engine config shipped in the repository, which loads when the run starts — can read the server's secrets.** Treat the container as the security boundary and run **one instance per trust domain**. Separating the agent UID is deferred.

Other known limits:

- The login, bootstrap and current-password rate limiters are in memory and reset on restart.
- The audit log is append-only through the API but not tamper-evident against the server's own user.
- One extra model call can overshoot the cost cap.
- Two server instances on one data directory are unsupported.
