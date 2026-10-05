# MOAG hosted server (Product Owner web app)

The server lets a team use MOAG from a browser. A product owner writes and versions a PRD. A reviewer approves the generated delta plan. Coding agents run it inside a per-project workspace on the server, within a cost cap. An approver signs off the ship gate. Every step is recorded in an audit log under the user who took it.

It is a Node 20 process (`out/server/main.js`) with no database. All state lives in one data directory. It never loads the VS Code API: agent work runs in short-lived worker child processes under the headless shim, the same path `moag run` uses.

**Running agents on a server is remote code execution by design.** Read [Threat model](#threat-model) before exposing this to anyone.

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
| Credential stuffing or brute force | scrypt, 429 per account+IP and per IP, uniform error and timing | In-memory limiter resets on restart |
| Session theft | HttpOnly, `__Host-`, Secure on https, hashed ids at rest, epoch invalidation, no-store on `/api` | TLS is the reverse proxy's job (documented) |
| CSRF | synchronizer token, JSON-only bodies, Origin check, SameSite=Lax | — |
| XSS from agent-authored task names, error tails or PRD text | CSP `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`, nosniff. A static test bans `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write`, `eval`, `new Function` and inline handlers/scripts in `web/**` | — |
| Privilege escalation | `canPerform` on every route, last-admin guard, role change kills sessions, table-driven matrix test | — |
| **Run = RCE** | Only `reviewer` and `admin` start runs, only on a reviewer-approved, content-hash-bound plan. A run job runs as a separate process with `cwd` = its project workspace, a server-generated config (the repo's `.moag/config.json` is ignored, `custom`/`copilot` are rejected at plan approval), and an env allowlist plus only that job's engine keys. **Plan generation** (`product-owner`-triggered) does NOT start in the repository: its agent CLI runs with `cwd` = an empty server-owned scratch dir (`projects/<id>/plans/<planId>/work`), auto-approve forced off (no `--dangerously-skip-permissions`, no Claude allow-list, no Codex `--full-auto`, no Gemini extra args), Codex additionally given `--disable shell_tool --disable unified_exec --sandbox read-only` (no command tool) and `--skip-git-repo-check` (the scratch dir is not a repo), and sees the repo only as a server-generated, size-capped `git ls-files` listing (first 2000 paths) in its prompt. No repo-shipped engine config (`.claude/settings*.json` hooks, `.mcp.json`, `.gemini/`) is loaded during plan generation. The generated playlist and rejections are scrubbed of the job's injected engine key before they are hashed, stored or shown; if the key appeared, the plan can never be approved. | **Agents run as the same OS user as the server.** An agent can read the data dir (`users.json` hashes, `secrets.json`, other workspaces) and `/proc/<server pid>/environ`, which holds the master key if it came from env. **The container is the real boundary.** An approved **run** executes inside the repository, so the engine CLI loads the repo's own engine config (`.claude/`, `.mcp.json`, `.gemini/`): hooks and MCP servers run as the server uid. That is why only `reviewer` and `admin` can start runs, and why a reviewer must trust a repository before approving its first run (the plan review card warns when the repo ships engine config). Documented with a recommendation: one instance per trust domain. Separating the agent UID is deferred. **Plan generation is not read-proof:** the planning engine still runs as the server uid with the engine key in its environment, and tools that need no approval (Claude's read tools; Codex's read-only sandbox) can read any file that uid can. A PRD can therefore steer file contents into the generated plan, which every signed-in user can read. Only the job's own engine key is redacted from that output. A Codex too old to know the `--disable` flags exits with an error, so its plans fail rather than run with commands. |
| Command injection through clone URL or path | `execFile('git', ['-c','protocol.file.allow=never','-c','protocol.ext.allow=never','clone','--no-recurse-submodules','--',url,dest], {shell:false})`, `GIT_ALLOW_PROTOCOL`, URL allowlist, paths realpath-confined to the projects root | Re-validated at each job start (symlink TOCTOU) |
| Ship-gate bypass | `CI` stripped and refused, `onManualGate:'halt'` forced, approve is approver-only, skip is admin-only with a reason, distinct audit actions | An agent could edit the run snapshot plan file (same uid). The server re-reads only statuses and trace from it. Documented. |
| Key exfiltration through the API | GET returns last4 only; audit records "key set"/"key cleared" only; error tails are redacted of injected key values before persisting | Keys in the agent env are visible to that agent by design |
| Audit tampering | Append-only API with no edit or delete route | Same-uid writes are not prevented. A hash chain is deferred. |
| Cost runaway | per-version cap, worker `costBudgetUsd` = remaining, plan generation counted | Overshoot by one call (the ceiling check runs after each call, `runner.ts:533-551`) |
| DoS | 1 MB body cap, SSE limit 5 per session, job concurrency cap, scrypt semaphore | — |

### Who can trigger agents, and how they are contained

- **Starting a run** is restricted to `reviewer` and `admin`. It needs a plan a reviewer approved, and the approval is bound to the plan's content hash.
- **Plan generation** (product owner) runs an agent CLI in an **empty server-owned scratch directory**, never in the repository, with every engine's auto-approve forced off. Because the CLI does not start inside the repo, repo-shipped engine config (`.claude/settings*.json` hooks, `.mcp.json`, `.gemini/settings.json`) cannot load and run code on a product owner's click. Codex is also given no shell tool (`--disable shell_tool --disable unified_exec`) and a read-only sandbox. That stops the planner running commands, but **not reading files**: an engine's read tools need no approval. The server therefore redacts the job's engine key from the generated plan and refuses to approve a plan that contained it. The planner gets the repository only as text: a server-generated `git ls-files` listing capped at 2000 paths (git runs with array args, no shell, `core.fsmonitor=false`).
- **Approving a plan / starting a run** (reviewer, admin) is where repository code and repository engine config become live: the run's agent starts inside the repo and its CLI loads `.claude/`, `.mcp.json` and `.gemini/` from there. **A reviewer must trust the repository before approving its first run.** The plan review card shows a "repo ships engine config" warning listing those entries when they exist; read them before approving.
- **Approving a ship gate** (approver) resumes a halted run. When that resumed run finishes with its verify gates green (exit 0), the server stamps each ready requirement as shipped in the trace, under the server-generated tag `ship-<runId>` (a trace label, not a git tag; generated plans may not tag or push). A failing verify ships nothing. **Skipping** a gate is admin-only, needs a reason, is audited separately from approval, and never ships.

Each job is its own process: a run with the project workspace as its working directory, a plan generation with its empty scratch directory. It gets the built environment above and only its own engine's key.

**The same-uid residual is the important one.** Agents run as the server's OS user. An agent can read `/data`, which includes password hashes, the encrypted key store and other projects' workspaces, as well as the server's environment. **In practice, anyone who can get a run approved and started — including through engine config shipped in the repository, which loads when the run starts — can read the server's secrets.** Treat the container as the security boundary and run **one instance per trust domain**. Separating the agent UID is deferred.

Other known limits:

- The login rate limiter is in memory and resets on restart.
- The audit log is append-only through the API but not tamper-evident against the server's own user.
- One extra model call can overshoot the cost cap.
- Two server instances on one data directory are unsupported.
