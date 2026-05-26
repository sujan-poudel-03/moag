# MOAG — AI Agent Orchestrator
## Product Introduction & Capability Reference

**Version:** 0.9.9  
**Type:** VS Code Extension  
**Publisher:** moag  
**Extension ID:** agent-task-player

---

## 1. What Is MOAG?

MOAG is a VS Code extension that turns your AI coding agents into a managed, trackable software delivery pipeline. Instead of running Claude Code or Codex manually in a terminal and copy-pasting results, MOAG lets you:

- **Write your intent** — as a prompt, a PRD, or a GitHub issue
- **Generate a plan** — structured playlists of tasks, with test phases auto-injected
- **Hit Play** — MOAG runs each task through your chosen AI engine, streams output live, auto-fixes failures, and verifies the result
- **Ship with confidence** — PRD verification, visual regression testing, and a full audit trail before you create the PR

Think of it as a **music player for AI tasks**: playlists of tasks, engines as instruments, Play/Pause/Stop controls, a live dashboard showing what's running, and a history of every session.

---

## 2. The Problem It Solves

| Without MOAG | With MOAG |
|-------------|-----------|
| Run Claude in a terminal, wait, copy output manually | Tasks run in sequence automatically, output streamed live |
| Re-run failed commands by hand | Auto-fix loop retries with error context, escalates when stuck |
| No record of what the AI changed | Full history: diffs, tokens, cost, verification status |
| PRD in a Google Doc, plan in your head | PRD → Plan generation, PRD verification at completion |
| Screenshot testing requires a separate setup | `visual-test` tasks: screenshot → Claude vision → fix loop |
| No way to know if the AI broke existing tests | Baseline verification runs before and after each task |
| Rate limit hits kill the whole session | Fallback engine automatically switches when primary is throttled |

---

## 3. Supported AI Engines

MOAG works with any installed AI coding agent CLI. All engines pipe prompts via stdin (never via CLI arguments, to avoid Windows 8K command-line limits).

| Engine | What It Is | How MOAG Uses It |
|--------|-----------|-----------------|
| **Claude Code** | Anthropic's official CLI | Primary default — agentic, tool-use, extended thinking |
| **Anthropic API** | Direct `@anthropic-ai/sdk` integration | Visual testing, multi-turn sessions, browser tools |
| **Codex CLI** | OpenAI's coding agent CLI | Alternative to Claude; good for JS/Python tasks |
| **Gemini CLI** | Google's Gemini coding agent | Strong at multi-file refactors |
| **Ollama** | Local model runner (Llama, Mistral, etc.) | Fully offline, no API key required |
| **GitHub Copilot** | VS Code's built-in Copilot agent | Uses existing auth, no extra setup |
| **Custom** | Any CLI that reads from stdin | Bring your own agent |

MOAG auto-detects which engines are installed. If none are found, a Setup Guide walks you through installing and authenticating each one.

---

## 4. Core Concepts

### Plan
A plan is a JSON file (`.moag/plan.json`) that describes a complete piece of work. It has:
- A name and description
- A default AI engine
- A fallback engine (for rate limit recovery)
- Plan-level AI Rules (injected into every task)
- A linked PRD (`prdSource`) for verification
- User-defined template variables
- One or more **Playlists**

### Playlist
A playlist is an ordered group of tasks. Playlists can:
- Run sequentially (default) or in parallel
- Have their own AI Rules that merge with plan-level rules
- Be marked as a **Test Phase** — MOAG treats these differently, auto-launching the sandbox and enabling the Test & Verify (TAV) panel

### Task
A task is a single unit of work. Every task has:
- A **name** and **prompt** (what to tell the AI)
- A **type** that determines how it runs (see below)
- An optional **engine override** (override the plan default for this task only)
- Optional **verify command** (shell command run after the task to check it worked)
- Optional **acceptance criteria** (human-readable success conditions)
- Optional **dependencies** (task IDs that must complete first)
- A **failure policy**: stop, continue, or mark-blocked

### Task Types

| Type | What Runs | Use Case |
|------|-----------|---------|
| `agent` | AI engine with full prompt | Feature implementation, refactoring, bug fixes |
| `command` | Shell command | `npm test`, `go build`, `pytest`, linters |
| `service` | Background process | Start dev server, database, mock API |
| `check` | One-shot shell command | Health check, port probe |
| `visual-test` | Anthropic API + Playwright + Claude vision | Screenshot a URL → analyze visually → fix loop |
| `validate` | Multi-platform test suite | Web + mobile + desktop quality gates |
| `review` | AI code review pass | Audit changes before merging |
| `manual` | Human approval gate | Pause until user marks complete |

### Engine Result
Every task produces an `EngineResult`: stdout, stderr, exit code, duration, token usage, and estimated cost. This is stored in History and used by the auto-fix loop.

---

## 5. The SDLC Loop MOAG Enables

```
╔══════════════════════════════════════════════════════════╗
║                  MOAG SDLC LOOP                          ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  1. CAPTURE INTENT                                       ║
║     GitHub Issue → PRD → Plan (auto-generated)           ║
║     or: free-form Chat → Smart Plan                      ║
║                                                          ║
║  2. PLAN                                                 ║
║     Edit playlists + tasks                               ║
║     Set AI Rules, engine, failure policy                 ║
║     Add visual-test and verify steps                     ║
║                                                          ║
║  3. EXECUTE                                              ║
║     Play → agent runs each task                          ║
║     Live output in Dashboard                             ║
║     Auto-fix loop on failure (up to 3 iterations)        ║
║     Fallback engine on rate limit                        ║
║                                                          ║
║  4. TEST                                                 ║
║     Test Phase playlist runs                             ║
║     Sandbox auto-launches                                ║
║     visual-test tasks: screenshot → Claude vision        ║
║     Playwright specs run programmatically                ║
║                                                          ║
║  5. VERIFY                                               ║
║     "Verify Against PRD" — Claude checks each criterion  ║
║     Per-criterion pass/fail score                        ║
║     Re-run loop if score < threshold                     ║
║                                                          ║
║  6. SHIP                                                 ║
║     "Suggest Commit" — AI writes the commit message      ║
║     "Create PR" — opens GitHub PR with execution summary ║
║     Source GitHub issues auto-closed on plan completion  ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
```

---

## 6. Complete Capability Reference

### Plan Management
| Capability | How to Access |
|-----------|--------------|
| Create empty plan | Toolbar → New Plan |
| Smart Plan (auto-detect) | Chat tab → "Smart Plan" starter button |
| Generate plan from PRD | Toolbar → Generate Plan from PRD |
| Generate plan from GitHub Issue | Toolbar → Plan from GitHub Issue |
| Generate plan from all open issues | Toolbar → Plan from Open Issues |
| Import plan from file or URL | Toolbar → Import Plan |
| Export plan | Toolbar → Export Plan |
| Share plan as GitHub Gist | Command palette → Share Plan as Gist |
| Switch between plans | Toolbar → Switch Plan (pinned, always visible) |
| Open plan file in editor | Toolbar → Open Plan |

### Playlist & Task Editing
| Capability | How to Access |
|-----------|--------------|
| Add playlist | Toolbar → Add Playlist |
| Add task to playlist | Right-click playlist → Add Task |
| Edit task (full editor) | Right-click task → Edit Task |
| Duplicate task | Right-click task → Duplicate |
| Split task into steps | Right-click task → Split Task |
| Add review step | Right-click task → Add Review Step |
| Move task up/down | Right-click task → Move Up/Down |
| Save task as template | Right-click task → Save as Template |
| Add from template | Right-click playlist → Add from Template |
| Set task status manually | Right-click task → Set Status |
| Mark test phase playlist | Right-click playlist → Toggle Test Phase |
| Bulk delete tasks | Select + Delete |

### Execution
| Capability | How to Access |
|-----------|--------------|
| Play full plan | Toolbar → Play ▶ (always pinned) |
| Play single playlist | Playlist row → ▶ button |
| Play single task | Task row → ▶ button (hover) |
| Pause between tasks | Toolbar → Pause ⏸ |
| Stop run | Toolbar → Stop ⏹ (always pinned) |
| Dry run (no execution) | Toolbar → Dry Run |
| Toggle full-auto mode | Toolbar → Toggle Full Auto ⚡ |
| Switch execution profile | Toolbar → Switch Profile |
| Switch AI engine | Toolbar → Switch Engine |
| Resume/restart when progress exists | Play → prompted with Resume or Restart |
| Retry failed task with fix context | Failed task card → 🔨 Smart Fix |
| Retry with custom note | Right-click task → Retry with Note |

### AI Rules (Prompt Rules)
| Capability | How to Access |
|-----------|--------------|
| Add custom rule | AI Rules section → + Add |
| Toggle rule on/off | AI Rules section → eye icon per rule |
| Use built-in rule library | AI Rules section → Open Library |
| Generate project rules with AI | AI Rules section → Ask AI for Rules |
| Edit/delete rules | AI Rules section → pencil / × per rule |
| Manage all rules | Toolbar → Manage AI Rules |

**Built-in library includes:** SOLID Principles, OWASP Top 10 Security, Clean Code, TDD (Test-Driven), Self-Documenting Code, Error Handling Best Practices, Performance Optimization, DRY Principle.

Rules are injected at the highest context priority — always included, never budget-trimmed.

### Sandbox & Visual Testing
| Capability | How to Access |
|-----------|--------------|
| Launch dev server (sandbox) | Sandbox section → Launch / Toolbar → Launch Sandbox |
| Stop sandbox | Sandbox section → Stop |
| Take screenshot | Sandbox section → 📷 / Toolbar → Take Screenshot |
| Configure monorepo targets | Plan JSON → `sandbox.targets` array |
| Run visual-test task | Task type = `visual-test` — uses Anthropic API + Playwright |
| Run Playwright spec | `visual-test` task with `spec_file` field |
| Auto-launch sandbox on test phase | Enabled automatically when test playlist runs |

### GitHub Integration
| Capability | How to Access |
|-----------|--------------|
| Plan from issue | Toolbar → Plan from GitHub Issue |
| Plan from open issues | Toolbar → Plan from Open Issues |
| Create PR | Toolbar → Create PR |
| Review all changes | Toolbar → Review Changes |
| Report MOAG bug | Toolbar → Report Bug (auto-includes friction data) |
| Share run feedback | Toolbar → Share Run Feedback / notification after failures |
| Review MOAG self-issues | Toolbar → Review Self-Issues |

### PRD Workflow
| Capability | How to Access |
|-----------|--------------|
| Generate PRD with AI (guided) | Chat tab → "Draft PRD with AI" / PRD editor → "Draft with AI" |
| Open/edit PRD | Toolbar → Open PRD |
| Save PRD to file | PRD editor → "Save as .md" |
| Generate plan from PRD | PRD editor → "Generate Plan →" |
| Link PRD to existing plan | PRD badge in plan header → Link PRD |
| Verify result against PRD | Toolbar → Verify Against PRD / TAV panel → Verify button |
| View PRD version history | PRD editor → version snapshots |
| Suggest commit message | Toolbar → Suggest Commit |

### History & Cost Tracking
| Capability | How to Access |
|-----------|--------------|
| View execution history | History tab |
| Filter by status | History tab → filter chips (All / ✓ / ✗) |
| Group by plan or playlist | History tab → Group dropdown |
| View per-task output + diff | History tab → click entry |
| View thread conversations | Toolbar → Show Threads |
| View cost summary | Toolbar → Cost Summary |
| Export results | Toolbar → Export Results (Markdown / JSON) |
| Clear history | Toolbar → Clear History |

### Run Friction Feedback
After any run with failures or escalations, MOAG silently records:
- Which tasks failed and how many retries they needed
- Which tasks were escalated (auto-fix exhausted)
- Error categories (compile, test, timeout, auth, rate-limit, cli-missing)
- Total duration and estimated cost
- Engine and project type

This is saved to `.moag/feedback.jsonl` (rolling 20-run window). The user then sees:
> *"2 tasks failed · 1 escalated — help MOAG improve? [Share ↗]"*

Clicking Share opens the **Share Feedback panel** with a structured Friction Points table and a notes field. One click files a labelled GitHub issue to the MOAG repo.

### Validation (Multi-Platform Quality Gates)
For projects requiring cross-platform testing, `validate` tasks run configurable test suites:

| Target | What Runs |
|--------|-----------|
| `web` | Lint → unit → integration → e2e (Playwright/Cypress) |
| `mobile` | Lint → unit → Detox/Appium/Expo |
| `desktop` | Lint → unit → Electron/Spectron/WinAppDriver |
| `all` | All three targets in sequence |

Profiles control depth: `quick` (lint + unit), `pr` (adds integration), `full` (adds e2e).
Flaky test detection: if a test fails then passes on retry, it's marked as flaky (not a failure).

---

## 7. Context Building — How MOAG Enriches Prompts

Every task prompt that goes to the AI is assembled by the Context Builder in priority order:

```
Priority -1 (highest, never trimmed):
  AI Rules (global + workspace + plan-level + playlist-level)

Priority 1:
  Plan overview (name, description, current progress)

Priority 2:
  Prior task outputs (relevance-ranked by topic overlap)
  — tasks in dependsOn get raw head+tail output
  — other prior tasks get compact ~250-char summaries

Priority 3:
  Changed files since last task (git diff)

Priority 4:
  Retrieved code spans (semantic search for relevant snippets)

Priority 5:
  Attached file contents

Priority 6 (lowest, first to be dropped):
  Task prompt + acceptance criteria contract
```

Context is budget-managed: if the total would exceed the engine's token limit, lower-priority sections are trimmed first. The AI Rules are always preserved.

---

## 8. Auto-Fix Loop

When a task fails, MOAG's auto-fix loop:

1. Classifies the error (`compile`, `test`, `timeout`, `auth`, `rate-limit`, `runtime`, `cli-missing`)
2. Builds a targeted fix prompt: task name + error category + up to 6 error lines + short directive
3. Runs the fix as a new turn (same session, so the agent has full context)
4. Re-runs the verify command if one exists
5. Repeats up to 3 times per task (configurable via `retryCount`)
6. If all attempts fail → escalates (fires `task-escalate` event, records in friction log)

The fix prompt is kept concise (~100 chars) — it does NOT re-send the full original prompt, which would waste context and confuse the model.

---

## 9. Multi-Turn Sessions

For the Anthropic API engine, MOAG maintains conversation history across all tasks in a playlist session:

- Task 1 runs → response added to session history
- Task 2 starts → session history prepended to prompt
- The model "remembers" what it did in Task 1 without MOAG re-sending all the output

Session history is capped at 20 turns to prevent unbounded context growth. Sessions are keyed by `sessionId` (one per playlist run).

---

## 10. Current UI State vs Planned Improvements

### What Is Fully Working Today (v0.9.9)

| Area | Status |
|------|--------|
| Chat tab (composer, message feed, live output) | ✅ Shipped |
| Plan tab (playlists, tasks, execution controls) | ✅ Shipped |
| History tab (timeline, filter, group) | ✅ Shipped |
| Dashboard panel (live streaming, minimap, tiles) | ✅ Shipped |
| Task Editor (all types except visual-test) | ✅ Shipped |
| PRD Editor (full-screen, AI draft, save, generate) | ✅ Shipped |
| AI Rules (toggle, library, AI-generate) | ✅ Shipped |
| Sandbox section (launch, stop, screenshot) | ✅ Shipped |
| Toolbar (all actions in promptView overflow) | ✅ Shipped |
| Auto-fix loop | ✅ Shipped |
| Fallback engine on rate limit | ✅ Shipped |
| GitHub integration (issue → plan, PR creation) | ✅ Shipped |
| Run friction feedback (capture + share) | ✅ Shipped |
| `visual-test` task type (engine + Playwright) | ✅ Shipped (engine only) |
| Per-criterion PRD verification | ✅ Shipped (raw text output) |

### Gaps Being Designed Now (v1.0 target)

| Gap | What's Missing |
|-----|---------------|
| TAV Panel — SETUP mode | Pre-run configuration screen for test tool, sandbox, PRD link, acceptance criteria checklist |
| TAV Panel — Verification Result card | Structured per-criterion pass/fail (currently raw text in Chat tab) |
| `visual-test` in Task Editor UI | Type dropdown doesn't include Visual Test; no URL or spec file fields |
| PRD badge in Plan header | No visual indicator that a PRD is linked to the plan |
| SDLC phase stepper | No `Chat → Plan → Execute → Test → Verify → Done` indicator |

---

## 11. File Structure

```
.moag/
  plan.json              ← Active plan (playlists + tasks + prdSource)
  feedback.jsonl         ← Rolling 20-run friction log
  rules.json             ← Workspace-scoped AI Rules
  prd.md                 ← Saved PRD text (optional)
  prd-ui-complete-flow.md← PRD for v1.0 UI improvements

src/
  extension.ts           ← Entry point, command registry, all event wiring
  adapters/              ← One adapter per engine (claude, anthropic, codex, gemini, ollama, copilot, custom)
  context/               ← Context builder, memory extractor, project analyzer
  history/               ← Execution history store
  models/                ← types.ts (Plan/Task/Playlist), plan.ts (hydrate/dehydrate)
  runner/                ← State machine, auto-fix loop, task dispatch
  sandbox/               ← Dev server manager, screenshot, browser-driver (Playwright)
  ui/                    ← Dashboard panel, prompt input view, task editor
  ai-rules/              ← Built-in rule library, rules store

docs/
  introduction.md        ← This file
  prd-workflow.md        ← PRD → Plan → Test → Ship guide
  architecture.md        ← Data flow and module responsibilities
```

---

## 12. Quick Start

1. Install MOAG from the VS Code Marketplace (search: "MOAG")
2. Open any project folder
3. Click the MOAG icon in the Activity Bar
4. If no AI engine is detected → Setup Guide opens automatically
5. Choose a starting point:
   - **Start from a GitHub Issue** → Toolbar → Plan from GitHub Issue
   - **Start from a PRD** → Toolbar → Generate Plan from PRD
   - **Start from scratch** → Chat tab → type your goal → Generate Plan
6. Review the generated plan in the Plan tab
7. Click **Play ▶** — dashboard opens, tasks run
8. If tasks fail → **🔨 Smart Fix** auto-repairs them
9. When development tasks finish → test playlist runs automatically
10. Click **Verify Against PRD** — see per-criterion pass/fail
11. Click **Create PR** — done

---

*MOAG is built with MOAG. The plan that produced this version is at `.moag/plan.json`.*
