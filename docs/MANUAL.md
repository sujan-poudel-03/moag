# MOAG — Manual

How MOAG runs coding agents against a plan, how it decides whether the work is
real, and how the night's output reaches you in the morning.

---

## 0. "Agent" means three different things here

Conflating these is the fastest way to get confused, so they are separated
throughout this document.

| Term | What it is | Where it lives |
|---|---|---|
| **Engine** | The AI backend that actually runs — Claude Code, Codex, Gemini, a local model | `src/adapters/` |
| **Role** | A persona injected into the prompt — architect, engineer, reviewer… | `src/models/roles.ts` |
| **Pipeline agent** | A subagent used to *develop MOAG itself*, not to run your plans | `.claude/agents/` |

An engine is **who does the typing**. A role is **what hat they wear**. A
pipeline agent is a tool for people working on MOAG's own source, and has
nothing to do with running your project.

---

# Part 1 — Engines

The interchangeable labour. Every engine is reached through one registry, so
routing by cost or capability is a configuration decision, not a code change.

| Engine id | What it is | Notes |
|---|---|---|
| `claude` | Claude Code CLI | Cannot be nested — MOAG cannot drive it from inside a Claude Code session |
| `codex` | Codex CLI | |
| `gemini` | Gemini CLI | |
| `ollama` | Local models | No API cost |
| `copilot` | GitHub Copilot | **IDE-only.** Uses `vscode.lm`, so it cannot run headless at all |
| `anthropic` | Anthropic API directly | No CLI required |
| `custom` | Any command you define | Escape hatch |

**Every engine pipes its prompt over stdin**, never as a command-line argument.
That is deliberate: Windows caps a command line around 8 KB, and a real prompt
with file context blows through it.

**Every engine call is accounted for.** Cost tracking is installed at
`registerEngine()`, the single point every adapter must pass through, so an
unaccounted call is not reachable — not merely discouraged.

### Choosing one

- Per task: `task.engine`
- Per playlist: `playlist.engine`
- Otherwise: `plan.defaultEngine`
- Headless default: `moag config set-engine <id>`

---

# Part 2 — Roles

A role is a **charter** — a paragraph prepended to the prompt that states what
this task's author owns, what to produce, and what to refuse. Roles are on by
default (`agentTaskPlayer.roles.enabled`).

| Role | Owns | Produces |
|---|---|---|
| `architect` | Module boundaries, data contracts, landing order | A decision before any code |
| `designer` | What the user sees and the path through it | A concrete spec — placement, states, wording |
| `engineer` | Working code inside the structure already there | The smallest change that fully does the job |
| `reviewer` | Whether the change is safe to keep | Findings anchored to a file and line, ordered by severity |
| `tester` | Evidence the behaviour holds | Cases for the paths a happy run never reaches |
| `devops` | How it is built, shipped, configured, recovered | Changes that reproduce from a clean checkout |
| `custom` | Whatever you write | Defined in `plan.customRoles` |

### Why charters, not job titles

Each charter names what the role **refuses**. The reviewer refuses to approve on
the strength of a summary. The tester looks hardest where it is expected to
break. That refusal is the useful part — an agent told only "you are a
reviewer" writes agreeable prose.

### Resolution order

```
task.role  →  playlist.role  →  plan.defaultRole  →  none
```

Most specific wins. A charter is capped at 800 characters so it cannot crowd
out the actual task.

---

# Part 3 — Pipeline agents (for working on MOAG itself)

These live in `.claude/agents/` and are **not** part of running your plans. They
encode this repository's conventions for anyone changing MOAG's source.

| Agent | Stage | Access |
|---|---|---|
| `product-owner` | Scope it — goal, actions, non-goals, acceptance criteria | read-only |
| `product-designer` | Only when a user sees or clicks something | read-only |
| `principal-architect` | Design it — task list with verified paths, verification order | read-only + shell |
| `senior-engineer` | Implement the list exactly; stops rather than re-architecting | all |
| `qa-reviewer` | Adversarial verify; runs the suite itself; explicit verdict | read-only + shell |
| `product-domain-expert` | One verified context block shared across a fan-out | read-only |

Run the chain with `/feature <request>`, or invoke each stage in order, feeding
its output verbatim into the next. The sequence is deliberate — each stage
reacts to the one before it.

---

# Part 4 — The workflow

## Step 1 — Point it at a project

MOAG works on the folder you have open. It keeps its own state in `.moag/`.

**Add `.moag/` to `.gitignore`** unless you want the plan and queue committed —
and you may well want them committed, since that is what lets two people share
one queue.

## Step 2 — Write a plan

A plan is `.moag/plan.json`:

```
Plan
└── Playlist          a coherent phase — "Build the API"
    └── Task          one unit of work
```

A task has a `type`, and the type decides what runs:

| Type | Runs |
|---|---|
| `agent` | An AI engine with your prompt |
| `command` | A shell command — no AI, no cost |
| `check` / `validate` | A verification step |
| `review` | An engine in reviewer posture |
| `service` | A long-running process (a dev server) |
| `manual` | Stops and waits for a person — the ship gate |
| `visual-test` | Browser UAT |

You can also start from a PRD: **`MOAG: Plan from PRD`** turns a written brief
into a plan, assigning roles per playlist.

## Step 3 — Run it

**In the IDE:** click the MOAG icon in the Activity Bar, then Play. The
dashboard opens automatically.

**Unattended:**

```bash
moag run .moag/plan.json --full-auto --verify --pr
```

| Flag | Effect |
|---|---|
| `--full-auto` | Retries and self-repair without asking |
| `--verify` | Fold the PRD verdict into the exit code |
| `--pr` | Open a pull request for what was committed |
| `--engine <id>` | Override the plan's engine |

**Exit codes:** `0` ok · `1` failures or PRD gaps · `2` error/usage · `3` halted
at a ship gate · `4` halted on the cost ceiling.

## Step 4 — The morning

```bash
moag digest              # what needs you, what shipped, what it cost
moag queue               # everything the run parked
moag queue resolve <id>  # clear one
moag land                # what can merge, and what conflicts
moag land --merge        # merge the clean branches
```

In the IDE: **`MOAG: Morning Review`** renders the same digest as a document,
and **`MOAG: Resolve Parked Item`** clears one.

`digest` and `land` exit `1` while anything waits on a person, so
`moag digest || notify-me` is a complete morning check.

---

# Part 5 — How it actually works

## The data flow

```
Plan JSON  →  Runner (state machine)  →  Adapter  →  CLI subprocess
                   ↓                        ↓
            Context Builder            stdin pipe
                   ↓
   [Project Standards → AI Rules → Knowledge → Plan context → Prior outputs
    → Changed files → Task prompt → Contract]
```

The runner is a state machine: `Idle → Playing → Paused → Stopping → Idle`, with
a mutex preventing concurrent `play()` calls.

## Verification — the part that matters

Most tools ask a model whether the work is done. A model reading `passed=3
failed=0` will say yes, and a stub that exits 0 passes.

MOAG runs **deterministic gates first, before any model call**:

| Order | Gate | Fails when |
|---|---|---|
| 1 | **status** | Tasks did not reach a completed state |
| 2 | **change** | The diff since the base ref is empty — nothing was built |
| 3 | **standards** (static rules) | A rule you **promoted** to blocking has findings. By default nothing here stops a run: every rule MOAG scans for itself is advisory. Only when the workspace has standards |
| 4 | **command** | A gate command exited non-zero (`npm test`) |
| 5 | **standards** (profile commands) | A command listed in the standards profile exited non-zero: your linter, formatter, type-checker or tests. This is what stops a run on style and structure. A command that already ran in step 4 is not run again. The gate also fails when a command or a promoted rule ends **not checked**: unevaluated blocking evidence is not a pass |
| 6 | **command** (browser UAT) | The browser UAT failed, when one is configured |
| 7 | **artifact** | A declared output file does not exist |

A failed gate returns `passed: false` with **`modelCallsMade: 0`**. The model is
never asked, so it cannot override evidence — and the failure is free.

Only if all of them pass does a model give a verdict.

### Dependencies are installed for you

An agent that adds `typescript` to `package.json` and never runs `npm install` used to leave
the next `npm run build` failing with "'tsc' is not recognized". MOAG now installs dependencies
itself, deterministically, before any step that runs a command: a command, check, service,
deploy or release task, a `verifyCommand`, the gate commands of the verify loop (gate 4 above),
and the standards profile commands (gate 5).

It installs when a dependency manifest or lockfile changed since the last successful install
(the hashes are recorded in `.moag/dependencies.json`), or when the install output is missing or
lacks a declared package: `node_modules` for npm, pnpm and Yarn classic; `.pnp.cjs` (or `.pnp.js`)
for Yarn Berry Plug'n'Play, which is Yarn 2+'s default when `.yarnrc.yml` sets no `nodeLinker`.
Nothing changed means nothing runs. Only manifests and lockfiles are hashed: a change to
`.npmrc` or `.yarnrc.yml` alone (for example a registry URL) does not trigger a reinstall.

The commands come from a fixed table, never from the model or the repository:

| Found | Command |
|---|---|
| `package-lock.json` | `npm ci --no-audit --no-fund` (`npm install --no-audit --no-fund` when `package.json` changed and the lockfile did not, or there is no lockfile) |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` (`--no-frozen-lockfile` to refresh) |
| `yarn.lock` | `yarn install --frozen-lockfile`, or `yarn install --immutable` on Yarn 2+ (`yarn install` to refresh) |
| `requirements.txt` | `<venv> python -m pip install -r requirements.txt`, only into `.venv`, `venv` or the configured virtualenv; never the system Python |
| `go.mod` | `go mod download` |
| `*.sln` / `*.csproj` | `dotnet restore` |
| `pom.xml` / `build.gradle` / `Cargo.toml` | nothing: the build resolves them |

The first time MOAG sees a project whose `node_modules` already holds every declared package,
it records it and installs nothing; an empty or partial `node_modules` is installed over. On
first sight an npm lockfile that does not match `package.json` is refreshed with `npm install`
instead of `npm ci`, and a failing frozen pnpm or Yarn install is retried once with the refresh
command. A failed install fails the step that needed it, with the command and the end
of its output; it is never a silent pass. Each install appears in the dashboard output and as
one line in the **MOAG** output channel; headless runs emit `dependencies-installed`,
`dependencies-install-failed` and `dependencies-not-installed` events.

| Setting | Default | Meaning |
|---|---|---|
| `agentTaskPlayer.autoInstallDependencies` | `true` | Turn automatic installs on or off |
| `agentTaskPlayer.dependencyInstall.ignoreScripts` | `false` | Skip npm/pnpm/yarn lifecycle scripts (`--ignore-scripts`) |
| `agentTaskPlayer.dependencyInstall.pythonVenv` | `""` | Virtualenv directory, relative to the workspace; blank detects `.venv` then `venv` |

The headless CLI reads the same keys from `.moag/config.json`. The hosted server uses
`MOAG_AUTO_INSTALL_DEPENDENCIES` and `MOAG_INSTALL_IGNORE_SCRIPTS` instead; see
[server.md](server.md#dependency-installs).

## Project standards

A workspace can keep one standards profile in `.moag/standards.json`: where files
go, which layers may import which, how files are named, how much commentary is
tolerated, and which commands prove conformance. When the file is there:

- every task prompt carries it under `## Project Standards`, directly before
  `## AI Rules` — also when context building is off;
- the planner prompt carries it, and for a greenfield repository tells the
  planner that the first task scaffolds the required directories;
- verification checks the diff against it (gates 3 and 5 above).

The check reads only what the run changed: added lines, and for naming and
placement, added and renamed files. Each finding names a file, a line and a
rule.

**Blocking and advisory.** MOAG blocks on your project's own tools; its own
scans are advisory unless you promote them. Every rule is one or the other. A
blocking rule that fails or has findings fails verification. An advisory rule's
findings are reported the same way and stop nothing.

What blocks by default is only every **command** in the profile — a real
linter, formatter, type-checker or test, judged by its exit code. A command
always blocks.

Everything MOAG scans for itself advises by default: required directories, a
git repository nested inside the workspace, placement, the top-level layout,
file naming, layer imports, raw frontend patterns, commented-out code, banned
placeholder phrases, comment density, and a file newly marked as generated.
These scans read paths and text; they can flag correct code and they can miss
real violations. Put what must stop a release into a command.

A profile with no command and no promoted rule has nothing that can stop a
release. That is allowed, and every report then says **no blocking rules
configured** — never that anything passed.

`moag standards propose` builds its proposal from the files git tracks. A
directory that is merely on disk — build output, reports, anything
`.gitignore` names — is never proposed. When git gives no listing (the folder
is not a repository, or git refuses it: `safe.directory`), no directory is
proposed at all and the proposal's provenance says why. Nested test folders
are never required. A required directory must be a path inside the repository
(no absolute path, no `..`), and is compared case-sensitively with the paths
git lists: `SRC` does not satisfy `src`.

The proposal's commands are the project's own tools, as fixed commands chosen
by what a file proves (a script body is never copied): `npm run lint`,
`npm run format:check` and `npm run typecheck` from those scripts; `npm test`
from a `test` script that runs something (not npm init's
`echo "Error: no test specified" && exit 1`); the linter or formatter a config
file sets up (ESLint, Biome, Prettier, Ruff, flake8, black, golangci-lint,
`dotnet format`); `pytest` where `pytest.ini`, `conftest.py` or a manifest
proves it; `go vet ./...` and `go test ./...` from `go.mod`. Java and .NET get
no test command. Nothing is run while proposing; review each command before
you write the proposal.

**Design system.** A project with a user interface keeps a design system in
its standards: a `DESIGN.md` (colour palette, typography, spacing, radii,
components, page layout, empty/loading/error states, forms, accessibility,
writing tone) and the tokens file the code must use. For a `node-ts` or
`static-web` project that shows a UI (a static site, React, Vue, Svelte,
Angular, Next.js, a known component library, or an `index.html`), `moag
standards propose` drafts one from a fixed template —
`docs/design/DESIGN.md` plus `src/styles/tokens.css` (node-ts) or
`css/tokens.css` (static-web) — and adopts an existing tokens file or design
document as it is instead of overwriting it. A file it cannot adopt (too
large, unreadable, not tracked by git, or not a `:root` tokens stylesheet) is
never overwritten either: the template goes to a fallback path such as
`css/design-tokens.css` or `docs/design/DESIGN-SYSTEM.md`, and the proposal's
provenance names the file it kept. An adopted tokens file paired
with the template DESIGN.md gets a note at the top of the doc naming the
template tokens the adopted file does not define and the names it does, so
agents never reference an undefined token. `--write` writes both files too;
one that already exists and differs is replaced only with `--force` (kept as
`<file>.bak`), and that conflict is found before anything is written.
`moag standards show` prints the design system and its tokens.

When there is a design system, every task prompt also carries a
`## Design System` block (at most 2,000 characters) right after the
standards: where the two files are, the rules, and the tokens. The planner gets
a short summary. Verification adds the advisory rule `frontend/design-tokens`:
a raw colour or length on an added line of a CSS, HTML, JSX or TSX file, or
inside a string or template literal of a JS/TS file (not the tokens file), an
import of another known UI kit than the approved one, or
a DESIGN.md or tokens file that no longer matches the approved one is a
finding. Like every MOAG scan it says "findings" or "no findings", never
"passed", and blocks only if you promote it. On the hosted server the design
system is reviewed with the standards (a change needs the reviewer's
acknowledgement) and written into the workspace when a run starts (a hand-edited copy it
replaces is kept in the server's run data and named in the audit log; a file
there that MOAG never wrote or adopted refuses the run instead of being
replaced); see
`docs/server.md` → The design system.

**Nested repositories.** A directory that is a git repository of its own hides
its files from git. One that no tracked `.gitmodules` declares — a gitlink, or
an untracked directory with a `.git` — is a finding of
`structure/nested-repository`, whenever it got there, and is listed as
`not checked (nested repository — files inside were not read)`. A declared
submodule is listed as `not checked (submodule — files inside were not read)`
and is no finding. Directories hidden by `.git/info/exclude` or a global
ignore file are not reported, exactly as `git status` would not show them.

You may still promote a scanner rule in the profile with
`"severity": { "<rule>": "blocking" | "advisory" }`. Every report then names
the promoted rules and repeats the warning.

**The words in a report.** Only a command is shown as `passed` or `failed`.
Every rule MOAG decides itself is shown as `no findings` or `findings` —
never "passed": a scan that found nothing has not proved that nothing is
there. Any rule can also be `not checked`. The report lists
Blocking, Advisory, Rules not checked and Files not checked as separate groups.

**Banned phrases** are matched one comment at a time: a single `//` or `#`
comment, or one whole block comment. The default list holds truncation
placeholders only (`// rest of the code`, `// your code here`,
`... existing code ...`). It holds no "as an AI" phrase and nothing else that
ordinary prose contains; add your own phrases to the profile if you want them.

**Not checked is not a pass.** A rule is reported as not checked, with its
reason, when:

- it is not configured;
- it met a file MOAG could not read with certainty (an unsupported language, an
  unterminated string, a file over 512 KB, a changed file whose diff git did not
  render);
- it met an import it could not map to a path (declare an import alias for it);
- it met a script with no file extension, or a file git was told to ignore
  changes to (`assume-unchanged`, `skip-worktree`);
- the diff held nothing for it to judge, or only vendored and generated files
  (`vendor/`, `node_modules/`, `third_party/`, `*.pb.go`, a `@generated`
  marker).

It is never counted as passed or as "no findings". An advisory rule that was
not checked does not fail the run. A **blocking** one does — a command that
did not run, or a rule you promoted that could not read a changed file or
found nothing in the change to judge: it is listed first, marked, and
verification fails on the standards gate.

**Files that were not checked are listed.** Every changed file the line rules
did not read — vendored, generated, in a language MOAG has no lexer for, of a
type no scanner reads (`unsupported type`: `.gradle`, `.kts`, `.mdx`, `.svg`,
`.vue`, `.svelte`, `.scss`, `.sh`, `.yml`, `.toml`, `Dockerfile`, `Makefile`),
too large or otherwise unreadable — is named in the report as
`not checked (<reason>)` and counted. Nothing in such a file counts towards
"no findings". A file the change itself newly marked as generated (it wrote the
`@generated` or `DO NOT EDIT` comment) is also reported as an advisory
finding, on the line of the marker.

**What "checked against standards vN" means.** The gate row
`moag:standards vN`, and the standards version on a release in `moag trace`,
are written with exit 0 in two cases only: the blocking set was evaluated —
every command ran, every promoted rule was decided — and none stops the
release; or the profile has no blocking set at all, in which case the row and
the trace say `no blocking rules configured` instead. When a blocking rule or
command was not checked the row is written with exit 1 and nothing ships.
Beside the version the trace records how many advisory findings, rules not
checked and files not checked that check left open (`standardsCounts`).

The row is not a command, so it is never shown as a pass or a fail. Wherever a
gate is worded — the gate table of the verification report, the evidence the
verifying model reads, `moag trace` — it says one of three things: `stopped`,
`no blocking rules configured` or `nothing blocking`. Your own commands keep
`pass`, `fail` and `timeout`.

**Staged work is checked too.** Content you `git add` and then delete from the
working tree is judged from the index, like content that was committed and then
removed. Moved files are recognised as moves whatever `diff.renameLimit` the
repository's git config sets.

**The check starts where the run started.** When a run begins, MOAG records the
commit the workspace stood at in `.moag/standards-base.json`. Verification and
`moag standards check` diff against that commit, so work the run committed is
still checked. The record is kept until a verification passes; fix runs in
between do not move it. With no record the base is `HEAD`, and `--base <ref>`
always wins. A `--base` that is not a commit in the repository checks every
file as if it were new, and says so.

**An empty diff clears nothing.** If nothing changed since the base, every
diff-based rule is not checked. `moag standards check` exits 5 when no diff
could be taken at all (outside a git repository, for example): nothing was
checked, which is neither a pass nor a finding. It exits 6 when nothing
blocking failed but a command or a promoted rule was not checked — so also
with `--no-commands` on a profile that has commands.

New files are found honouring `.gitignore` only. A file you hide with
`.git/info/exclude` or a global ignore file is still checked; put it in
`.gitignore` if it should not be.

A standards file that exists but is invalid stops the task with an error naming
the file. It is never read as "no standards".

Locally there is no approval step: the workspace is yours. `moag standards
propose --write` creates the file from what the repository looks like, and you
edit it. On the hosted server a reviewer approves each version; see
docs/server.md → Project standards for the profile format and the review flow.

**Changed behaviour for headless runs.** `moag run` now injects the workspace's
`.moag/rules.json` into every task prompt. Earlier versions wired the AI rules
store only in VS Code, so a headless run ignored that file. Headless has the
workspace tier only; there is no global rules tier outside VS Code.

## Delivery

With `agentTaskPlayer.git.autoCommit` on:

1. The run takes a branch: `moag/<plan-slug>-<run-id>`
2. Every task that passes gets a commit carrying playlist, engine, cost, files
3. `--pr` opens a pull request from those commits

**It refuses rather than best-efforts.** Not a git repo, detached HEAD, or a
dirty tree — it declines and says why. An agent's commit must contain the
agent's work and nothing else. MOAG's own `.moag/` output is excluded from that
dirty check, since otherwise it would block on files it wrote itself.

## Parallelism and isolation

`parallelPlaylists > 1` gives each concurrent playlist **its own git worktree
and branch**, so two agents cannot edit the same file. Isolation requires
`git.autoCommit` — without it the work would be stranded in a throwaway
checkout. Teardown never passes `--force`: git refuses to remove a worktree
holding uncommitted work, and that refusal is the point.

Then `moag land` brings the branches back. Conflicts are detected with
`git merge-tree`, which merges **in memory** — assessing never leaves a
half-merged repository behind.

## Parking — halts that survive the night

A halt used to be an event, and events do not survive until morning. Every halt
now appends a line to `.moag/queue.jsonl` carrying the **decision you are being
asked to make**, not just what happened.

| Reason | What it means |
|---|---|
| `manual-gate` | Work is done, waiting for approval |
| `budget-exceeded` | Spend passed the ceiling |
| `repeated-failure` | Retries and one auto-fix are spent |
| `missing-capability` | A gate could not run — a tool is absent |
| `gate-failure` | A gate ran and failed |

`missing-capability` and `gate-failure` are kept distinct on purpose: one needs
a tool installed, the other needs code changed. Same halt, opposite remedy.

## Knowledge

`.moag/knowledge/facts.json` accumulates what the repository has **proven about
itself** — which commands verify it, which do not. The block is injected into
every prompt beside AI Rules.

AI rules come from two store tiers: the global one (VS Code only) and the
workspace's `.moag/rules.json`. The `agentTaskPlayer.promptRules` setting is a
separate raw block the runner appends on its own.

**Only facts with an exit code behind them are recorded.** Never a model's
opinion. A knowledge base that accepts assertions rots into confident fiction,
and this one is injected at high priority, so it would rot every future run.

## What lives in `.moag/`

| File | Holds |
|---|---|
| `plan.json` | The plan and task statuses |
| `config.json` | Settings for the headless CLI |
| `daemon.json` | Daemon configuration |
| `rules.json` | Workspace AI rules |
| `standards.json` | The project standards profile (see Project standards) |
| `dependencies.json` | Hashes of the dependency manifests and lockfiles at the last automatic install, and the command that ran (see Dependencies are installed for you) |
| `queue.jsonl` | Parked work — append-only |
| `knowledge/facts.json` | Proven facts about this repo |
| `errors.jsonl` | Internal error log |
| `verification-*.json` | PRD verification reports. A command gate is stored as it ran (`exitCode`, `passed`). The `moag:standards` row has no `passed` key: it has `standards` (`stopped`, `no blocking rules configured` or `nothing blocking`) and `standardsOpen` (what the check left open, in words) |
| `screenshots/` | Browser UAT captures |

## Layering

```
models/  ←  adapters/  ←  runner/  ←  extension.ts | headless/  →  ui/
```

Dependencies point one way. The core carries **zero `vscode` imports** —
enforced by lint — which is why the same loop runs in the IDE and in the daemon
with identical semantics. Configuration reaches the core through `core/host.ts`.

Webview scripts compile separately to `out/webview/*.js` and load via
`<script src>` behind a nonce. None of it is inline: JavaScript inside a
template literal is never parsed by the compiler, and that shipped two runtime
errors to users before it was fixed.

---

# Part 6 — Settings that change behaviour

| Setting | Default | Effect |
|---|---|---|
| `git.autoCommit` | `false` | Branch per run, commit per verified task |
| `git.branchPrefix` | `moag/` | Branch namespace |
| `costBudgetUsd` | `0` | Spend ceiling; `0` disables |
| `parallelPlaylists` | `1` | Concurrency — needs isolation above 1 |
| `taskTimeoutMs` | `1800000` | Per-task timeout (30 min) |
| `fullAuto` | `false` | Write → test → repair without asking |
| `autoFix` | `true` | One repair attempt per failed task |
| `autoTest` | `false` | Run the suite after each agent task |
| `roles.enabled` | `true` | Inject role charters |
| `failSafeMode` | `false` | Serial, conservative — for low memory |
| `prdLoop.gateCommands` | *(auto)* | Commands that must exit 0 |
| `prdLoop.uat.mode` | `auto` | `off` · `auto` (skip if absent) · `required` (fail if absent) |
| `prdLoop.versionBudgetUsd` | `0` | Spend ceiling for one PRD verify/fix loop run; `0` disables |

The headless CLI reads these from `.moag/config.json`, in any shape — flat
(`"agentTaskPlayer.git.autoCommit": true`), sectioned, or nested.

---

# Part 7 — Command reference

```
moag run <plan.json> [--full-auto] [--engine <id>] [--verify] [--fix] [--pr]
moag run --prompt "<text>" [--engine <id>] [--full-auto]
moag verify <plan.json> [--prd <file>] [--fix] [--gate "<cmd>"] [--uat]
moag loop --repo <owner/repo> [--label <l>] [--interval <sec>] [--once]
moag daemon [--config <.moag/daemon.json>] [--interval <sec>] [--max-ticks <n>]
moag config <get-engine | set-engine <id>>
moag queue <list | resolve <id>>
moag digest [--since <when>]
moag land [--into <branch>] [--merge]
moag trace [<plan.json> | --plan <path>] [--req R-<n>]
moag standards show
moag standards check [--base <ref>] [--no-commands]
moag standards propose [--stack <id>] [--write [--force]]
moag bench <scenario.json> [--dry-run] [--out <dir>] [--max-usd <n>]
moag host [run | init | draft <project> | status | stop <env> | remove <env>]
```

`moag host` runs on a build machine paired with ONOSOO. It runs approved project
branches as Docker Compose environments and lets workspace members open them from
ONOSOO through a gateway that admits only holders of an ONOSOO ticket, over an
outbound tunnel. `init` writes its config, `draft <project>` drafts a run recipe
for a person to approve, `status` shows what is configured and running. Setup,
the recipe and what keeps it safe: [host-agent.md](host-agent.md).

`moag trace` prints one JSON line per PRD requirement — shipped, in-progress,
not-shipped, untracked or removed — with the PRD version and release tag that
shipped it, the standards version that release was checked against and what
that check left open (`standardsCounts`), its tasks and its latest gate exit
codes. The `moag:standards` row among those gates also says what it means, in
`standards` (`stopped`, `no blocking rules configured` or `nothing blocking`)
and, when recorded, `standardsCounts`: an exit code of 0 there is not a pass.
It only reads the plan.

`moag standards` works on the workspace's own `.moag/standards.json`, with no
engine and no model call. `show` prints the document and the text every task
prompt carries. `check` checks the diff since `--base` (default: the base
captured at run start, else HEAD). It exits 0 when nothing blocking stopped it
(every command passed, or no blocking rules are configured), 1 when a command
failed or a promoted rule has findings, 2 when there is no usable profile, 5
when no diff could be taken and 6 when a command or a promoted rule was not
checked. Advisory findings are listed and do not change the exit code. A rule it could not decide is listed
under "Rules not checked" and a file it could not read under "Files not
checked"; neither is ever a pass.
`propose` detects the repository's conventions from the files git tracks and
prints a proposed profile; it writes the file, as the next version, only with
`--write`.

`moag bench` drives the hosted server end to end through a benchmark scenario
(PRD versions, plans, runs and ship gates, played by separate users) and writes
per-version metrics. `--dry-run` uses a fake engine and costs nothing; a paid
run needs `--max-usd`. See docs/benchmark.md.

`moag` reaches your PATH via `npm link` from the repository root.

### IDE commands worth knowing

`Ctrl+Shift+P` → `MOAG: …`

| Command | Opens |
|---|---|
| Show Dashboard | Live run output |
| Morning Review | The digest, as a document |
| Resolve Parked Item | Clear one parked decision |
| Plan from PRD | Turn a brief into a plan |
| Manage AI Rules | Rule editor |
| Show History | Session list |
| Setup Guide | First-run walkthrough |

---

# Part 8 — When something looks wrong

**A panel is blank.** The script did not load. `Ctrl+Shift+P` →
`Developer: Open Webview Developer Tools`. Source maps ship, so the console
points at the TypeScript. Likely a CSP violation or a bad script URI.

**Nothing committed after a run.** Check `git.autoCommit` is on, and read the
run output — delivery refuses loudly on a dirty tree, a detached HEAD, or a
non-repository, and names which.

**`--pr` says `no-commits`.** Correct, not a bug: it proposes commits, it does
not create them. Turn on `git.autoCommit`.

**Verification fails with no model call.** Working as designed — a deterministic
gate failed, and it says which of the four.

**A run stopped and you cannot see why.** `moag queue`. Every halt is parked
with the decision it is waiting on.

---

# Part 9 — The honest limits

**Judgment stays human.** MOAG automates execution, verification and delivery.
Deciding what is worth building, resolving a tradeoff with no right answer, and
judging when a *requirement* is wrong are not in scope — and an agent that
simulates them confidently is worse than one that refuses.

**One operator.** The park queue has no owner field and knowledge is
machine-local. Two people cannot yet share one queue.

**Endurance is unproven.** The full loop has been run unattended end to end, and
that single run found two bugs a thousand passing tests had missed. What breaks
on night nine is not yet known.

**Copilot is IDE-only** and `claude` cannot be nested inside a Claude Code
session.
