# Local-First Product Roadmap

## Positioning

Agent Task Player should become a local-first development automation cockpit for one operator.

Primary user:
- A single developer running work on one machine

Secondary user:
- A product manager reviewing progress, blockers, and outcomes on that same machine

This means the product should optimize for:
- Reliable local execution
- Safe automation around code, services, tests, and environments
- Strong status reporting for both technical and non-technical review

It should not optimize for team collaboration first. Shared workflows can come later, after the local loop is strong.

## Product Goal

The core loop should be:

1. Paste a roadmap, backlog, or spec.
2. Convert it into structured playlists and tasks.
3. Execute work locally with clear verification steps.
4. Run supporting commands like dev servers, tests, migrations, and health checks.
5. Capture evidence automatically.
6. Show a clear summary of what is done, blocked, changed, and next.
7. Resume safely after failure.

## Product Principles

- Local-first: everything should work well on a single developer machine.
- Execution before collaboration: trust and reliability matter more than sharing features.
- Evidence over claims: every task should produce artifacts, checks, and outcomes.
- Safe automation: checkpoints, rollback, and approval points should exist before broad autonomy.
- PM visibility: a non-technical stakeholder should be able to understand progress without reading raw logs.

## What This Product Becomes

At maturity, Agent Task Player should act as:
- Planner: turn roadmap text into structured execution plans
- Executor: run task sequences and orchestration steps
- Verifier: run tests, health checks, and acceptance criteria
- Reporter: summarize progress, failures, changed files, and risk
- Recovery tool: retry, resume, rollback, or mark blockers without losing state

## Version Roadmap

## v0.6.0 - Execution Contracts

Theme:
- Make task execution reliable enough for real development automation

Goals:
- Move from prompt-only tasks to structured task contracts
- Add better execution primitives for local development work
- Make failure handling and evidence collection first-class

Features:
- Task contracts
  - `prompt`
  - `acceptanceCriteria`
  - `verifyCommand`
  - `expectedArtifacts`
  - `failurePolicy`
  - `ownerNote`
- Task types
  - `agent`
  - `command`
  - `service`
  - `check`
- Rich run artifacts
  - changed files
  - command executed
  - stdout/stderr summaries
  - verification result
  - artifact list
- Failure recovery actions
  - retry
  - retry with revised prompt
  - skip
  - mark blocked
  - open evidence
- Better resume behavior
  - keep last known run state
  - resume from failed or blocked point

Definition of done:
- A developer can run a roadmap with a mix of agent tasks and local commands
- Each task shows whether it passed because criteria were met, not just because a process exited

## v0.7.0 - Local Automation Cockpit

Theme:
- Expand from task runner into a local development operations console

Goals:
- Handle local services and app verification cleanly
- Provide stronger dashboard views for dev and PM usage

Features:
- Service orchestration
  - start dev servers
  - stop services
  - port checks
  - health checks
  - env var injection
  - startup timeout handling
- Checkpoints and rollback
  - checkpoint before risky playlists
  - restore selected task changes
  - rollback failed automation step
- PM summary mode
  - current phase
  - tasks complete / total
  - blocked tasks
  - latest outcome
  - files changed
  - services running
  - pending review points
- Dry-run improvements
  - show required tools
  - required ports
  - required env vars
  - estimated run flow
- Approval gates
  - continue to next playlist only after local approval
  - mark phase approved or blocked

Definition of done:
- The dashboard is useful to a developer during execution and understandable to a PM during review

## v0.8.0 - Reusable Development Workflows

Theme:
- Turn one-off plans into reusable execution systems

Goals:
- Make roadmap-to-execution faster and more repeatable
- Reduce prompt rewriting for common workflows

Features:
- Plan templates with variables
  - bug fix
  - feature delivery
  - refactor
  - release prep
  - QA sweep
  - documentation pass
- Spec-to-plan improvements
  - dependency suggestions
  - verification suggestions
  - service/task detection
  - acceptance criteria suggestions
- Workflow packs
  - frontend app
  - backend service
  - monorepo feature
  - release hardening
- Better export formats
  - PM status report
  - execution report
  - release summary

Definition of done:
- A developer can start from a roadmap and reach a runnable structured plan much faster

## v1.0.0 - Local Development Automation Platform

Theme:
- Stable local-first platform for roadmap-driven development automation

Goals:
- Lock in the core schema, UX, and execution model
- Ship a polished experience that is dependable day to day

Features:
- Stable plan schema for task contracts and execution evidence
- Safe execution profiles
  - conservative
  - balanced
  - aggressive
- Production-quality run history
  - searchable runs
  - artifact retention
  - failure analysis
- Review-ready reporting
  - developer report
  - PM report
  - release report
- Onboarding flow for local environment setup
- Documentation for common automation patterns

Definition of done:
- A single developer can use the extension daily to execute and verify roadmap-driven work locally
- A PM can review outcome summaries without digging through raw logs

## Not Now

Defer until the local-first loop is solid:
- Multi-user collaboration
- Cloud sync
- Team dashboards
- Hosted orchestration
- PR review workflows as a primary feature

## Execution Plan

## Phase 1 - Schema and Runner Foundation

Deliver first:
- task contracts
- task types
- failure policy support
- artifact model

Files likely affected:
- `src/models/types.ts`
- `src/models/plan.ts`
- `src/runner/runner.ts`
- `src/ui/dashboard-panel.ts`
- `src/test/unit/models/*.test.ts`
- `src/test/unit/runner/*.test.ts`

Why first:
- Everything else depends on a stronger task model

## Phase 2 - Service and Command Automation

Deliver next:
- command tasks
- service tasks
- port checks
- health checks
- env var support

Files likely affected:
- `src/runner/runner.ts`
- `src/adapters/*`
- `src/ui/dashboard-panel.ts`
- `src/extension.ts`
- new runner tests

Why next:
- Local development automation is not just agent prompts; it includes starting and validating the local stack

## Phase 3 - Evidence and Recovery

Deliver next:
- richer artifacts
- retry variants
- blocked state
- rollback and checkpoint UX

Files likely affected:
- `src/history/store.ts`
- `src/ui/dashboard-panel.ts`
- `src/ui/history-tree.ts`
- `src/extension.ts`
- `src/runner/runner.ts`

Why next:
- Trust comes from recoverability and proof of work

## Phase 4 - PM Summary and Review Flow

Deliver next:
- PM summary panel or dashboard mode
- playlist approval gates
- better exports

Files likely affected:
- `src/ui/dashboard-panel.ts`
- `src/ui/execution-detail-panel.ts`
- `src/extension.ts`
- export/report code

Why next:
- Once execution is reliable, visibility becomes the differentiator

## Phase 5 - Templates and Roadmap Acceleration

Deliver next:
- workflow templates
- variable substitution
- smarter roadmap-to-plan generation

Why next:
- This multiplies usage after the execution model is dependable

## Deployment Plan

## Local Developer Deployment

For day-to-day development:

1. Implement feature
2. Run `npm run compile`
3. Run targeted tests
4. Run `npm run package`
5. Install local `.vsix` with `code --install-extension ... --force`
6. Reload VS Code and verify in a real workspace

## Release Checklist

Before shipping a version:

1. Update feature docs
2. Add or update unit tests
3. Run lint and tests
4. Validate dashboard behavior in a live workspace
5. Update `CHANGELOG.md`
6. Bump `package.json` version
7. Build `.vsix`
8. Smoke test local install
9. Publish release

## Suggested Release Cadence

- v0.6.0: execution contracts and command/service task support
- v0.7.0: automation cockpit, PM summary, approval gates
- v0.8.0: templates and reusable workflows
- v1.0.0: schema stability, polished reporting, safe execution profiles

## Success Metrics

Track these locally before worrying about team metrics:

- Time from roadmap paste to first runnable plan
- Percentage of tasks with verification evidence
- Number of manual interventions per run
- Retry success rate
- Time to recover from a failed task
- PM readability of summary output

## Immediate Next Build

If work starts now, the highest-value implementation order is:

1. Add task contracts to the schema
2. Add `command` and `service` task types to the runner
3. Extend dashboard cards with acceptance criteria and artifact summaries
4. Add blocked/retry/rollback actions
5. Add a PM summary section to the dashboard
