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

**Admin → Engines** shows which CLIs the server found (a `--version` probe, run at boot and on **Re-check**). MOAG makes no live provider call to check sign-in, so CLI auth always shows "unknown". `copilot` and `custom` are not supported in the web app. A run whose engine the probe did not find is refused with "isn't installed on this server".

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
  projects/<id>/runs/<runId>/                job, config, plan snapshot, events
  projects/<id>/plans/<planId>/              plan-generation job, repo file listing, outcome; work/ = its empty cwd
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
| Generated plan reaching outside its project | Every task `cwd` must stay inside the workspace: an absolute path (POSIX, `C:\`, drive-relative `C:x`, UNC) or a `..` that climbs above the root makes the plan unapprovable (409). Every command, cwd, `healthCheckUrl`, `skipIf`, `failurePolicy` and monitor `incidentRepo`/`incidentLabel` is listed verbatim on the review card. `env`, `inheritEnvFiles`, `githubRelease` and `releaseTag` are stripped before hashing | A command can still `cd` anywhere the uid can; the reviewer reads the commands |
| Two projects sharing files | A project's workspace must be a git repository's top-level folder (`not-a-git-repo`, `not-repo-root`), and may not contain or sit inside another project's workspace (`409 workspace-nested`), compared as realpaths | — |
| Command injection through clone URL or path | `execFile('git', ['-c','protocol.file.allow=never','-c','protocol.ext.allow=never','clone','--no-recurse-submodules','--',url,dest], {shell:false})`, `GIT_ALLOW_PROTOCOL`, URL allowlist, paths realpath-confined to the projects root | Re-validated at each job start (symlink TOCTOU) |
| Ship-gate bypass | `CI` stripped and refused, `onManualGate:'halt'` forced, approve is approver-only, skip is admin-only with a reason, distinct audit actions | An agent could edit the run snapshot plan file (same uid). The server re-reads only statuses and trace from it. Documented. |
| Key exfiltration through the API | GET returns last4 only; audit records "key set"/"key cleared" only; error tails are redacted of injected key values before persisting | Keys in the agent env are visible to that agent by design |
| Audit tampering | Append-only API with no edit or delete route | Same-uid writes are not prevented. A hash chain is deferred. |
| Cost runaway | per-version cap, worker `costBudgetUsd` = remaining, plan generation counted, Claude jobs in JSON mode with `--max-budget-usd` per call ([Cost reporting](#cost-reporting)) | Overshoot by one call (the ceiling check runs after each call, `runner.ts:533-551`) |
| DoS | 1 MB body cap, SSE limit 5 per session, job concurrency cap, scrypt semaphore | — |

### Who can trigger agents, and how they are contained

- **Starting a run** is restricted to `reviewer` and `admin`. It needs a plan a reviewer approved, and the approval is bound to the plan's content hash.
- **Plan generation** (product owner) runs an agent CLI in an **empty server-owned scratch directory**, never in the repository, with every engine's auto-approve forced off. Because the CLI does not start inside the repo, repo-shipped engine config (`.claude/settings*.json` hooks, `.mcp.json`, `.gemini/settings.json`) cannot load and run code on a product owner's click. The planner's tools are also locked down ([Planner lockdown](#planner-lockdown-and-allowplannerfileaccess)): Claude runs with `--tools ""` and `--strict-mcp-config` (no tools), Codex with no shell or exec tool and a read-only sandbox (whether it can still read files through a non-shell built-in is unverified), and gemini and anthropic are refused unless an admin sets `allowPlannerFileAccess`, which on anthropic grants shell execution and file writes. The planner gets the repository only as text: a server-generated `git ls-files` listing capped at 2000 paths (git runs with array args, no shell, `core.fsmonitor=false`), placed before the output-format rules in the prompt. The server still redacts the job's engine key from the generated plan and refuses to approve a plan that contained it.
- **Approving a plan** (reviewer, admin) binds two things: the plan's content hash, and **the engine the review card shows**, which is the engine the plan was generated with.
  - If the project's default engine changed while the plan was pending, approval is refused with `409 engine-changed`. Switch the project back or request a new plan.
  - After approval the engine stays locked. A run, or a resumed segment, on a project whose engine has since changed is also refused with `409 engine-changed`.
  - A plan with a task `cwd` outside the workspace cannot be approved at all.
- **Starting a run** (reviewer, admin) is where repository code and repository config become live: the run's agent starts inside the repo and loads what the repo ships. **A reviewer must trust the repository before approving its first run.** The plan review card warns, listing each of these entries the repo has:
  - engine config: `.claude/`, `.mcp.json`, `.gemini/`, `.codex/`
  - agent instruction files: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules`
  - MOAG workspace rules: `.moag/rules.json`, which is injected into every task prompt

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
