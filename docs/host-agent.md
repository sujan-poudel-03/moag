# Host agent (`moag host`)

`moag host` turns a build machine into a place where a workspace's members can open any approved
project branch as a **running app**, from ONOSOO, without any port being opened on the machine.

- **Environments.** It runs a project branch as a Docker Compose stack (frontend, backend, database),
  one stack per branch, each with CPU/memory limits. It stops ones nobody has opened for a while.
- **Gateway.** A small HTTP server on `127.0.0.1` is the only way into an environment. It lets a
  person in only with a ticket from ONOSOO, keeps checking they are still in the workspace, and
  proxies the app (including hot-reload WebSockets). It also serves redacted logs and status.
- **Tunnel.** Cloudflare Tunnel carries `https://<environment>.<preview domain>` to the gateway.
  Outbound only.
- **ONOSOO.** It reports what it runs every 30 s and takes `env-start`, `env-stop`, `env-restart` and
  `env-reset-db` commands (ONOSOO's `docs/builds/PROTOCOL.md` §2–3).

It does not run AI tasks; `moag run` and the daemon do. It runs as the machine's **main user** (it
holds the device key and talks to Docker) and never passes the key or the tunnel token to anything
it starts.

## Requirements

- Linux (Ubuntu 24.04 LTS recommended), or Windows with everything inside **WSL2 Ubuntu** (`moag host` refuses to run on native Windows).
- Docker Engine with the Compose plugin **2.24.4 or newer** (`docker compose version`).
- Git **2.45.1 or newer**, Node 20, MOAG.
- `cloudflared`, and a Cloudflare-managed domain for previews (e.g. `preview.onosoo.com`).
- Always on: sleep off. Roughly 8 cores / 32 GB / 1 TB SSD for 3–4 environments at once.

## Setup

1. **Pair the machine** in ONOSOO (Builds → Pair machine) and put the key and URL in
   `<configDir>/moag/onosoo.json` (`{"key": "...", "url": "https://<ref>.supabase.co"}`), or in
   `MOAG_ONOSOO_KEY` / `MOAG_ONOSOO_URL`. `<configDir>` is `~/.config` on Linux.
2. `moag host init` writes `host.json` and an empty `projects.json` there.
3. In `host.json`, set `preview_domain` (and adjust limits if you like):

   ```json
   {
     "version": 1,
     "preview_domain": "preview.onosoo.com",
     "app_url": "https://app.onosoo.com",
     "app_origins": ["https://app.onosoo.com"],
     "gateway": { "port": 8787 },
     "limits": { "max_environments": 4, "cpus": 2, "memory_mb": 2048, "idle_stop_minutes": 120 },
     "tunnel": { "token_file": "/home/me/.config/moag/cloudflared.token" }
   }
   ```

4. In `projects.json`, list each folder this machine may run (format owned by
   `src/headless/onosoo-projects.ts`): `{ "id": "shop", "name": "Shop", "path": "/home/me/code/shop" }`.
5. For each project: `moag host draft shop`. It writes `.moag/environment.draft.json` (and, for a Node
   project without a compose file, `.moag/compose.generated.yml`). Check it and rename it to
   `.moag/environment.json`. **Nothing runs from a draft**, and the recipe is always read from this
   approved folder, never from the branch being run.
6. **Tunnel.** In Cloudflare: create a tunnel, add the public hostname `*.preview.onosoo.com` →
   `http://127.0.0.1:8787`, and a wildcard DNS record for it (the dashboard does this). Save the
   tunnel token in the `token_file` above (mode 600). Or leave `tunnel` out of `host.json` and run
   `cloudflared tunnel run` as its own service.
7. Run `moag host`. `moag host status` shows what is configured and running.

### As a service (systemd)

```ini
# /etc/systemd/system/moag-host.service
[Unit]
Description=MOAG host agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=me
ExecStart=/usr/bin/env moag host
Restart=on-failure
RestartSec=10
# Exit code 3 means ONOSOO refused the key (revoked): do not loop on it.
RestartPreventExitStatus=3 2

[Install]
WantedBy=multi-user.target
```

## The run recipe

`<project>/.moag/environment.json`:

```json
{
  "version": 1,
  "compose_file": "docker-compose.yml",
  "services": {
    "web": { "role": "web", "port": 5173 },
    "api": { "role": "api" },
    "db":  { "role": "db" }
  },
  "reset_db": { "service": "api", "command": ["npm", "run", "db:reset"] }
}
```

- `compose_file`: in the branch, or `@project/<path>` for one kept in the approved folder.
- `services`: one `web` service with its **container** port gets a preview. Others: `api`, `db`,
  `worker`, `other`. Compose services not listed run as `other`.
- `reset_db`: optional. Without it, "Reset database" recreates the stack's volumes.

## What keeps it safe

| Risk | What the host agent does |
|---|---|
| A branch's compose file asks for the host | Before **every** `up` (start, restart from stopped, database reset) the configuration is resolved again and checked against an **allow-list** (`compose-policy.ts`): any key it does not know is refused. Refused in detail: privileged mode, capabilities, devices, host or `container:` namespaces, runtimes, sysctls, security profiles other than no-new-privileges, the Docker socket, bind mounts, env files, secrets and configs from outside the branch checkout (symlinks resolved), top-level volumes with driver options or external, external or non-bridge networks, unsafe `build:` options (contexts or Dockerfiles outside the checkout, additional contexts, build secrets, SSH forwarding, host build network, entitlements), device reservations, and any published port other than the web service's own `127.0.0.1:<allocated>`. |
| A container rewrites the compose file in its checkout | Docker always runs from the host-owned copy that was checked (`<configDir>/moag/host/compose/<env>/resolved.json`), never from the checkout; a rewrite only matters at the next start, which checks it again. |
| The branch's compose file reads the main user's secrets | Docker and git get an **allow-listed** environment only (PATH, HOME, locale, Docker connection settings), and every compose call gets an empty `--env-file`, so `${ANTHROPIC_API_KEY}`, `${GITHUB_TOKEN}`, `SSH_AUTH_SOCK`, the branch's `.env` and the machine key are not available for interpolation. |
| Environments fight over ports or reach the internet directly | Every service's published ports are reset; only the web service is published, on `127.0.0.1`, for the gateway — and the check above refuses anything else. |
| One environment starves the machine | CPU and memory limits on every service; a cap on running environments (also when restarting a stopped one) and on environments kept (50); idle ones stop. |
| An agent-written repo makes git run code (hooks, fsmonitor, filters, ext::) | The host never runs git in the project repo or in a checkout. It keeps its own mirror (`<configDir>/moag/host/repos/<id>.git`), fills it by reading the project as a remote, and passes every git call its repository explicitly (`--git-dir`, `--work-tree`) — never discovered from a checkout's `.git` file, which a container could repoint. Every call disables hooks, fsmonitor, prompts, system/global config and every transport but https/ssh (local paths only for the mirror refresh). git 2.45.1+ is required. |
| The key or tunnel token leaks into an environment | Not in any child's environment (allow-list above); only `cloudflared` gets its token, and the token file is refused unless it is mode 600. |
| Someone outside the workspace opens a preview | No session without a single-use, 60-second ONOSOO ticket bound to that environment; the session cookie is `__Host-` (host-only, Secure, no Domain); membership re-checked every minute, in batches, applied only when every batch answered. |
| One environment's app attacks another (they share the preview domain) | App cookies are made host-only (`Domain=` removed) and may not use the session's name; WebSocket upgrades must come from the environment's own origin; redirects after login stay on the same origin. |
| Logs reach someone who should not see them | Only a logs ticket (owner, admin or member) opens them — a preview session does not; logs are redacted and served straight from the machine, never stored in ONOSOO. |

### Accepted risks

- **Local processes can reach an environment's web port.** Each web service is published on a
  loopback port (41000–41999) for the gateway. Any process on the machine — the remote runner
  account included — can connect to it without going through the gateway. Those processes can
  already read the same code, and the apps are the workspace's own development builds, so this is
  accepted. If the machine runs anything you do not trust with your apps' data, run environments on
  a dedicated machine.
- **Sibling environments are same-site.** All previews share `*.<preview domain>`. The measures in
  the table above stop cookie and WebSocket abuse between them; adding the preview domain to the
  [Public Suffix List](https://publicsuffix.org/) makes browsers treat each environment as its own
  site and is recommended for a public deployment.
- **Files written by containers as root.** A container running as root can leave root-owned files
  in its checkout; `moag host remove` then cannot delete them and says so. Remove them with
  `sudo rm -rf` or run containers as a non-root user in the compose file.

## Commands from ONOSOO

| Command | Who (workspace role) | What happens |
|---|---|---|
| `env-start {project_id, branch}` | owner, admin, member | mirror refreshed, detached worktree of the branch, policy check, `up -d --build`. Starting an existing one refreshes it to the branch's latest commit. |
| `env-stop {environment_id}` | owner, admin, member | `compose stop`; open previews closed. Stays stopped until started again. |
| `env-restart {environment_id, service?}` | owner, admin, member | restart one service or all; a stopped environment is started. |
| `env-reset-db {environment_id}` | owner, admin | the recipe's `reset_db` command, or volumes recreated. |

Refusals come back as `rejected` with a sentence a manager can act on ("This project has no
approved run recipe…", "This branch's compose file asks for more than an environment may have…").
