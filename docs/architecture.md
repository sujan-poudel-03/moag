# MOAG — Architecture Overview

> Agent Task Player (extension ID: `moag.agent-task-player`)  
> Orchestrates AI coding agents (Claude Code, Codex, Gemini CLI, Copilot, Ollama) to run task playlists inside VS Code.

---

## High-Level Component Map

```mermaid
graph TD
    subgraph VSCode["VS Code Host"]
        EXT["extension.ts\n(activation / wiring)"]
    end

    subgraph UI["UI Layer"]
        SIDEBAR["PromptInputViewProvider\n(sidebar webview)\nTabs: PROMPT · PLAN · HISTORY"]
        DASHBOARD["DashboardPanel\n(webview panel)\nLive output · Completed cards · Diffs"]
        PLANTREE["PlanTreeProvider\n(tree view)"]
        TASKEDITOR["TaskEditorPanel\n(webview panel)"]
        HISTTREE["HistoryTreeProvider\n(tree view)"]
        SESTREE["SessionsTreeProvider\n(tree view)"]
    end

    subgraph Core["Core"]
        RUNNER["TaskRunner\n(state machine)\nIdle → Playing → Paused → Stopping"]
        CTX["ContextBuilder\n(prompt enrichment + token budget)"]
        HISTORY["HistoryStore\n(per-task run log)"]
        PLAN["plan.ts\n(load · save · hydrate · dehydrate)"]
    end

    subgraph Adapters["Engine Adapters"]
        BASE["runCli()\n(stdin pipe, abort, timeout)"]
        CLAUDE["ClaudeAdapter"]
        CODEX["CodexAdapter"]
        GEMINI["GeminiAdapter"]
        COPILOT["CopilotAdapter"]
        OLLAMA["OllamaAdapter"]
        CUSTOM["CustomAdapter"]
    end

    subgraph Sandbox["Sandbox"]
        SBMGR["SandboxManager\n(Docker / local)"]
        DETECT["ProjectDetector\n(framework probe)"]
        SHOT["Screenshot\n(puppeteer)"]
    end

    subgraph Models["Models / Types"]
        TYPES["types.ts\nPlan · Playlist · Task\nTaskStatus · RunnerState\nEngineResult · HistoryEntry"]
    end

    EXT -->|"creates & wires"| SIDEBAR
    EXT -->|"creates & wires"| DASHBOARD
    EXT -->|"creates & wires"| PLANTREE
    EXT -->|"creates & wires"| TASKEDITOR
    EXT -->|"creates & wires"| HISTTREE
    EXT -->|"creates & wires"| SESTREE
    EXT -->|"owns"| RUNNER
    EXT -->|"owns"| HISTORY
    EXT -->|"reads/writes"| PLAN

    RUNNER -->|"task-started\ntask-output\ntask-completed\ntask-failed"| EXT
    EXT -->|"forwards events"| DASHBOARD
    EXT -->|"forwards events"| SIDEBAR
    EXT -->|"forwards events"| PLANTREE

    RUNNER -->|"buildPrompt()"| CTX
    RUNNER -->|"executeTask()"| BASE
    BASE --> CLAUDE
    BASE --> CODEX
    BASE --> GEMINI
    BASE --> COPILOT
    BASE --> OLLAMA
    BASE --> CUSTOM

    RUNNER -->|"records result"| HISTORY
    RUNNER -->|"reads plan"| TYPES

    SIDEBAR -->|"postMessage: submit\nplayPlan · playTask\nsaveTaskEdit · generatePlan"| EXT
    DASHBOARD -->|"postMessage: retry\nstop · openTask"| EXT

    EXT -->|"sandbox commands"| SBMGR
    SBMGR --> DETECT
    SBMGR --> SHOT
```

---

## Data Flow — Task Execution

```mermaid
sequenceDiagram
    actor User
    participant Sidebar as Sidebar (PLAN tab)
    participant EXT as extension.ts
    participant Runner as TaskRunner
    participant CTX as ContextBuilder
    participant CLI as runCli()
    participant Agent as AI Agent (CLI)
    participant History as HistoryStore
    participant Dashboard as DashboardPanel

    User->>Sidebar: click Play
    Sidebar->>EXT: postMessage { type: 'playPlan' }
    EXT->>Runner: runner.play(plan)
    Runner->>Runner: detectAndMarkCycles(plan)

    loop each Playlist / Task
        Runner->>CTX: buildPrompt(task, plan)
        CTX->>CTX: runRetrievalCascade() — symbol hints → rg/glob → semantic
        CTX->>CTX: applyBudget() — drop lowest-priority sections to fit 12K chars
        CTX-->>Runner: enriched prompt (capped at 80K total)
        Runner->>CLI: runCli({ cmd, stdin: prompt, timeout })
        CLI->>Agent: spawn process, pipe prompt via stdin
        Agent-->>CLI: stdout / stderr chunks
        CLI-->>Runner: onOutput(chunk)
        Runner->>EXT: emit task-output
        EXT->>Dashboard: appendOutput(chunk)
        EXT->>Sidebar: postLiveOutputChunk(chunk)  [only if sidebar visible]
    end

    Agent-->>CLI: exit(0|1)
    CLI-->>Runner: EngineResult
    Runner->>Runner: captureGitDiff()
    Runner->>History: recordEntry(task, result, diff)
    Runner->>EXT: emit task-completed | task-failed
    EXT->>Dashboard: completeTaskCard(task, diff)
    EXT->>Sidebar: postLiveOutputEnd(taskId)
    EXT->>EXT: saveAndRefresh()
```

---

## State Machine — TaskRunner

```mermaid
stateDiagram-v2
    [*] --> Idle

    Idle --> Playing : play()
    Playing --> Paused : pause()
    Playing --> Stopping : stop()
    Playing --> Idle : all tasks done
    Paused --> Playing : play()  [resume]
    Paused --> Stopping : stop()
    Stopping --> Idle : abort settled
```

---

## Context Builder — Token Budget Pipeline

```mermaid
flowchart TD
    A[task prompt] --> B[runRetrievalCascade]
    B --> B1[Stage 1: symbol hint spans\ncamelCase / PascalCase — 30 files]
    B --> B2[Stage 2: rg/glob keyword spans\n50 files, expanded stop-word filter]
    B --> B3[Stage 3: semantic provider\noptional, highest confidence]
    B1 & B2 & B3 --> C[mergeSpans — higher confidence wins]

    C --> D[buildContext — assemble sections]
    D --> S0[Screenshots · priority 0]
    D --> S1[Plan overview · priority 1\ncurrent + completed + next 2 only]
    D --> S2[Progress + changed files · priority 2\nmerged section, capped at 8 entries]
    D --> S3[Code spans or Relevant files · priority 3\nconditioned on retrieval results]
    D --> S4[Prior task output · priority 4\ndeps: head+tail · incidental: tail only]
    D --> S5[Project state · priority 5\noff by default]

    S0 & S1 & S2 & S3 & S4 & S5 --> E[applyBudget\nmaxContextChars: 12 000]
    E --> F[drop lowest-priority sections\nuntil total fits]
    F --> G[prepend to task prompt\ncapped at 80K total chars]
```

---

## Plan File Structure

```mermaid
erDiagram
    Plan {
        string id
        string name
        string engine
        string version
    }
    Playlist {
        string id
        string name
        string engine
        string status
        bool parallel
    }
    Task {
        string id
        string name
        string prompt
        string type
        string status
        string engine
        string failureReason
        string verifyCommand
        string[] dependsOn
        number retryCount
        TokenUsage tokenUsage
    }
    Plan ||--o{ Playlist : contains
    Playlist ||--o{ Task : contains
    Task ||--o{ Task : dependsOn
```

---

## Engine Adapter Hierarchy

```mermaid
classDiagram
    class EngineAdapter {
        <<interface>>
        +id: EngineId
        +label: string
        +run(options) EngineResult
        +version() string
    }
    class runCli {
        +spawn(cmd, args)
        +pipeStdin(prompt)
        +abortSignal handling
        +30s git timeout
    }
    class ClaudeAdapter
    class CodexAdapter
    class GeminiAdapter
    class CopilotAdapter
    class OllamaAdapter
    class CustomAdapter

    EngineAdapter <|.. ClaudeAdapter
    EngineAdapter <|.. CodexAdapter
    EngineAdapter <|.. GeminiAdapter
    EngineAdapter <|.. CopilotAdapter
    EngineAdapter <|.. OllamaAdapter
    EngineAdapter <|.. CustomAdapter
    ClaudeAdapter --> runCli
    CodexAdapter --> runCli
    GeminiAdapter --> runCli
    CopilotAdapter --> runCli
    OllamaAdapter --> runCli
    CustomAdapter --> runCli
```

---

## UI Layer — Sidebar Tabs

```mermaid
graph LR
    subgraph Sidebar["PromptInputViewProvider (WebviewView)"]
        PROMPT["PROMPT tab\n─────────\nChat feed\nLive output blocks\nComposer + active file pill\n✦ Plan button"]
        PLAN["PLAN tab\n─────────\nOverview bar\nPlaylist groups\nTask rows (inline edit ✏)\nBulk run tools"]
        HISTORY["HISTORY tab\n─────────\nRun sessions\nPer-task entries"]
    end
```

---

## Key Conventions

| Convention | Detail |
|---|---|
| Prompt delivery | All adapters pipe via **stdin** (not CLI args) — avoids Windows 8K cmd limit |
| Prompt size cap | Trimmed to **80K chars** — task part preserved, prefix truncated |
| Task timeout | Configurable via `agentTaskPlayer.taskTimeoutMs` (default 10 min) |
| Git timeout | 30s hard kill on all `git` subprocesses |
| Play lock | `_playLock` mutex prevents concurrent `play()` calls |
| Status persistence | `dehydrateTask` saves non-pending status to plan JSON after each task |
| Dashboard safety | `safePostMessage()` guards against disposed panel crashes |
| Live output | Buffered at 120ms, **skipped entirely when sidebar is not visible** |
| Cycle detection | DFS (white/gray/black) marks cyclic `dependsOn` tasks as Blocked before execution |
| Failure classification | `classifyFailure()` → drives retry delay (rate-limit: 30s, auth: no retry) |

---

## Token Efficiency — What Gets Sent Per Task

| Section | Size control | Key optimisation |
|---|---|---|
| **Plan overview** | Scales with plan size | Only current + completed + next 2 shown; all other future tasks omitted with count |
| **Progress + files** | Capped at 8 entries | Merged into one section (was two); file list capped at 4 per task |
| **Code spans** | `maxFileContextChars` (6K) | Retrieval cascade: symbol hints → rg/glob → semantic; spans replace whole-file dumps |
| **Config files** | Conditional | `package.json` / `tsconfig.json` only on first task or when prompt mentions build keywords |
| **Prior output** | `maxOutputPerTask` (1.5K) | Explicit `dependsOn` deps: head+tail; incidental tasks: tail only |
| **Stop words** | ~80 blocked terms | Generic verbs/nouns (`create`, `file`, `function`, `class`…) excluded from keyword extraction |
| **Total budget** | `maxContextChars` (12K) | `applyBudget()` drops lowest-priority sections; never truncates high-priority ones |
