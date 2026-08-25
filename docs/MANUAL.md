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
   [AI Rules → Knowledge → Plan context → Prior outputs
    → Changed files → Task prompt → Contract]
```

The runner is a state machine: `Idle → Playing → Paused → Stopping → Idle`, with
a mutex preventing concurrent `play()` calls.

## Verification — the part that matters

Most tools ask a model whether the work is done. A model reading `passed=3
failed=0` will say yes, and a stub that exits 0 passes.

MOAG runs **four deterministic gates first, before any model call**:

| Order | Gate | Fails when |
|---|---|---|
| 1 | **status** | Tasks did not reach a completed state |
| 2 | **change** | The diff since the base ref is empty — nothing was built |
| 3 | **command** | A gate command exited non-zero (`npm test`, a browser UAT) |
| 4 | **artifact** | A declared output file does not exist |

A failed gate returns `passed: false` with **`modelCallsMade: 0`**. The model is
never asked, so it cannot override evidence — and the failure is free.

Only if all four pass does a model give a verdict.

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
| `queue.jsonl` | Parked work — append-only |
| `knowledge/facts.json` | Proven facts about this repo |
| `errors.jsonl` | Internal error log |
| `verification-*.json` | PRD verification reports |
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
```

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
