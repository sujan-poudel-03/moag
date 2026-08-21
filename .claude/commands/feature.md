---
description: Run the four-stage MOAG development pipeline (scope → design → implement → review) on a feature, fix, or issue.
argument-hint: <feature, bug, or issue description>
---

Run the full MOAG development pipeline on this request:

**$ARGUMENTS**

Run the four stages **sequentially**, using the Agent tool once per stage. Each stage must receive the previous stage's output verbatim in its prompt — that handoff is the point of the pipeline. Do not run stages in parallel, and do not skip a stage because the request looks small.

### Stage 1 — `product-owner` (scope)
Pass the request above. Get back: goal, primary action, secondary actions (each tagged as depending on primary state or independent), non-goals, acceptance criteria, open questions.

**Stop here and ask the user** if the scope comes back with open questions that are real product decisions — which MOAG surface owns the change, setting vs. plan-field vs. task-field, which of the seven engines are in scope, whether existing `.moag/plan.json` files need migration. Those are the user's call, not yours. Report the scope, ask, and wait.

### Stage 1.5 — `product-designer` (surface) — only when the change is user-facing
Skip this stage entirely for pure backend work. Run it whenever the request touches anything a user sees or clicks, and *always* when a feature turns out to have no reachable control at all.

Pass the scope output. Get back: placement decision, ASCII layout spec at real width, a state matrix covering the full `TaskStatus`/`RunnerState` sets, exact copy, accessibility requirements, and responsive behaviour. Feed this to the architect alongside the scope.

If the designer reports that a control cannot work inside the 280–400px sidebar, take the panel alternative seriously rather than pushing for the cramped version.

### Stage 2 — `principal-architect` (design)
Pass the full scope output. Get back: approach with rejected alternatives, a numbered task list with verified file paths, this project's verification commands in order, and named risks.

Read the task list before continuing. If it contradicts the scope or invents a member of a closed enumeration, send it back to the architect rather than passing it on.

### Stage 3 — `senior-engineer` (implement)
Pass the scope **and** the full task list. The engineer implements the tasks in order and runs `npm run compile` / `npm run lint` / `npm test` after **each** task, not batched at the end.

If the engineer stops mid-list and reports a deviation, do not paper over it — surface the deviation to the user with the engineer's reasoning, and route it back to `principal-architect` if the fix changes a layer boundary, a data contract, or a public runner event.

### Stage 4 — `qa-reviewer` (verify)
Pass the scope's acceptance criteria and the engineer's final report. The reviewer runs the suite itself rather than trusting the reported pass, and ends with an explicit verdict.

- **SHIP** → report it and stop.
- **SHIP-WITH-FOLLOWUPS** → report the findings as tracked follow-ups; do not silently fix them.
- **BACK-TO-ENGINEERING** → return to Stage 3 with the findings. After two failed review rounds, stop and bring the user in rather than looping.

### Rules for you as orchestrator

- Relay what matters from each stage to the user — subagent reports are not shown to them.
- Never fabricate a stage's output or predict a pending agent's result.
- Never run `npm run test:live` at any stage; it calls real AI APIs and spends the user's money.
- If this request will fan out multiple agents over the same area of the codebase (an audit sweep, a convention migration, a repeated defect class), call `product-domain-expert` **first** and paste its brief verbatim into every agent you spawn.
