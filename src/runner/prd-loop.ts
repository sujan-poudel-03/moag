// ─── PRD verification / fix loop core ───
//
// The loop that answers "does the work actually satisfy the PRD?". Every gate it
// applies is deterministic and runs BEFORE any model call: if nothing changed, if
// a task failed, if the diff breaks the project standards, if a gate command exited
// non-zero, or if a declared artifact is missing, the verdict is already known and
// no model is asked. A model only ever
// gets to say "not yet" — it can never override a failed gate.
//
// Dependency-injected in the style of `headless/daemon.ts` and free of VS Code API
// imports, so the extension command and the headless CLI run the exact same loop.

import { DependencyEvent, EngineResult, Plan, Playlist, Task, TaskStatus } from '../models/types';
import { DependencyInstallSettings, ensureDependencies } from './dependency-install';
import * as nodeFs from 'fs';
import { recordGateResults, standardsGateCommand } from '../models/requirement-trace';
import { commandFactId, recordFact } from './knowledge';
import { decisionFor, park, ParkReason } from './park-queue';
import {
  captureBaseRef,
  checkArtifacts,
  collectDiffEvidence,
  collectStandardsInput,
  GateResult,
  resolveGateCommands,
  resolveUatGate,
  runGate,
  summarizeEvidence,
} from './evidence';
import {
  checkStandards, commandRow, groupStandardsRules, isBlockingNotChecked, isUnreadBlocking, NO_BLOCKING_RULES, promotedScannerRules,
  recountTotals, ruleOutcomeLabel, SCANNER_PROMOTION_WARNING, severityOf, skippedStandardsReport, standardsBlocked,
  standardsBlockingState, standardsCheckCounts, StandardsReport,
} from '../standards/checker';
import type { StandardsProfile } from '../standards/profile';

// ─── Types ───

/** Everything the loop needs to know that is not a callback. */
export interface PrdLoopConfig {
  cwd: string;
  maxFixIterations: number;
  /** Explicit gate commands from configuration. Empty means "auto-detect". */
  gateCommands: string[];
  gateTimeoutMs: number;
  maxDiffChars: number;
  onManualGate: 'halt' | 'skip';
  /** When false the loop reports the failure but generates no fix playlist. */
  fix: boolean;
  /** True for headless/daemon runs: an undetectable repo is then a hard failure. */
  unattended: boolean;
  /**
   * Browser UAT gate. Required — not optional — so every host surface has to make
   * an explicit decision rather than silently inheriting "off".
   */
  uat: {
    /** `off` never runs it, `auto` skips silently when it cannot, `required` fails. */
    mode: 'off' | 'auto' | 'required';
    /** Explicit command; overrides all detection when set. */
    command?: string;
    /** Spec file or directory filter folded into the generated command. */
    specPath?: string;
    timeoutMs: number;
  };
  /**
   * Spend ceiling in USD for this one loop run (agentTaskPlayer.prdLoop.versionBudgetUsd).
   * Counts every engine call made while the loop is running; 0 disables it. Required so
   * every host surface makes an explicit decision.
   */
  versionBudgetUsd: number;
  /**
   * The project standards this run is checked against, or null when the workspace has
   * none. Required — not optional — so every host surface decides explicitly instead of
   * silently running unchecked. `baseRef` is what the standards gate diffs against; null
   * means "no commits yet" and makes every file count as added.
   */
  standards: { profile: StandardsProfile; version: number | null; baseRef: string | null } | null;
  /**
   * Automatic dependency installs before the gate commands run. Required so every host
   * surface decides explicitly; `enabled: false` makes the install step a no-op.
   */
  dependencies: DependencyInstallSettings;
}

/** Why the loop stopped short of a verdict. */
export type HaltReason =
  | 'max-iterations'
  | 'no-progress'
  | 'manual-gate'
  | 'budget-exceeded'
  | 'aborted'
  | 'no-prd'
  | 'engine-error'
  | 'no-gates';

/** Which deterministic gate rejected the work, if any. */
export type FailedGate = 'change' | 'command' | 'artifact' | 'status' | 'standards' | null;

/** The single result object every terminal path produces. */
export interface PrdLoopReport {
  passed: boolean;
  score: number;
  iterations: number;
  haltReason: HaltReason | null;
  gates: GateResult[];
  changedFiles: string[];
  diffStat: string;
  gaps: string[];
  suggestion: string;
  failedGate: FailedGate;
  /** How many times a model was actually invoked. Deterministic failures keep this at 0. */
  modelCallsMade: number;
  /** True when no gate command could be resolved for the repository. */
  gateCommandsEmpty: boolean;
  /** True only when a browser UAT command actually executed. */
  uatRan: boolean;
  /** Why UAT did not run, or null when it ran (or was never asked for). */
  uatSkipReason: string | null;
  /**
   * Per-rule standards results for the last iteration, or null when the loop had no
   * standards (or stopped before reaching them). A `not-checked` rule is never a pass.
   */
  standards: StandardsReport | null;
}

/**
 * A running application the UAT gate can point a browser at.
 *
 * `startedByUs` tells the host whether it owns the server's lifetime; `dispose`
 * is always called exactly once, on pass, fail, abort and throw alike.
 */
export interface UatSession {
  baseUrl: string;
  startedByUs: boolean;
  dispose: () => Promise<void> | void;
}

/** Seams the host surface (extension or CLI) must provide. */
export interface PrdLoopDeps {
  plan: Plan;
  resolvePrdText: () => Promise<string | null>;
  runPlan: (plan: Plan) => Promise<void>;
  runEngine: (prompt: string, signal: AbortSignal) => Promise<EngineResult>;
  savePlan: () => void;
  onProgress: (phase: string, detail: string) => void;
  emitReport: (r: PrdLoopReport) => void | Promise<void>;
  /** Every dependency-install event (installed, failed, not installed) the gates caused. */
  onDependencyEvent: (ev: DependencyEvent) => void;
  skipManualGate?: (taskId: string) => void;
  /**
   * Bring up (or adopt) an application the UAT gate can drive, or resolve null
   * when none can be prepared. Never called when the mode is `off`, and never
   * called after a repo gate has already failed.
   */
  prepareUat?: (signal: AbortSignal) => Promise<UatSession | null>;
  /**
   * Subscribe to per-call spend (USD) for the per-run budget; returns the unsubscribe.
   * Only called when `versionBudgetUsd > 0`. Without it the cap cannot be metered.
   */
  subscribeSpend?: (onCost: (usd: number) => void) => () => void;
  /** Stop the runner when the per-run budget is breached mid-run. Best effort. */
  stopRun?: () => void;
  signal: AbortSignal;
}

/** The controller returned by {@link createPrdLoop}. */
export interface PrdLoopController {
  run(): Promise<PrdLoopReport>;
  noteManualGate(taskId: string): void;
  noteBudgetExceeded(): void;
}

/** Shape the verification model is asked to return. */
interface ModelVerdict {
  passed: boolean;
  score: number;
  gaps: string[];
  suggestion: string;
}

// ─── Factory ───

/**
 * Build a PRD verification loop.
 *
 * All halt state lives in this closure, never at module scope: two loops can be
 * live at once (parallel playlists, or the user hitting Verify while the daemon
 * runs) and a shared flag would make each one halt the other.
 */
export function createPrdLoop(cfg: PrdLoopConfig, deps: PrdLoopDeps): PrdLoopController {
  // ── per-call state ──
  let manualGateHit = false;
  let manualGateTaskId: string | null = null;
  let budgetHit = false;
  /** Spend metered since this run() subscribed — its own baseline, never shared. */
  let versionSpendUsd = 0;
  let versionBudgetHit = false;
  let unsubscribeSpend: (() => void) | null = null;

  let iterations = 0;
  let modelCallsMade = 0;
  let gates: GateResult[] = [];
  let changedFiles: string[] = [];
  let diffStat = '';
  let gateCommandsEmpty = false;
  let uatRan = false;
  let uatSkipReason: string | null = null;
  /** Set when the gate could not run at all, which is a different fix from a gate that ran and failed. */
  let capabilityMissing = false;
  let lastFingerprint: string | null = null;
  /** Standards results of the current iteration. Closure state, like every other halt flag. */
  let standards: StandardsReport | null = null;

  const makeReport = (over: Partial<PrdLoopReport> = {}): PrdLoopReport => ({
    passed: false,
    score: 0,
    iterations,
    haltReason: null,
    gates,
    changedFiles,
    diffStat,
    gaps: [],
    suggestion: '',
    failedGate: null,
    modelCallsMade,
    gateCommandsEmpty,
    uatRan,
    uatSkipReason,
    standards,
    ...over,
  });

  /** All tasks across every playlist, in plan order. */
  const allTasks = (plan: Plan): Task[] => plan.playlists.flatMap((pl) => pl.tasks);

  /**
   * The budget-exceeded report when either ceiling was hit, else null. Checked at the top of
   * each iteration, before every engine call, and right after a fix playlist ran.
   */
  const budgetHalt = (over: Partial<PrdLoopReport> = {}): PrdLoopReport | null => {
    if (budgetHit) {
      return makeReport({
        ...over,
        haltReason: 'budget-exceeded',
        suggestion: 'The cost ceiling was reached. Raise agentTaskPlayer.costBudgetUsd to continue.',
      });
    }
    if (versionBudgetHit) {
      return makeReport({
        ...over,
        haltReason: 'budget-exceeded',
        suggestion: `Per-run PRD budget reached: spent $${versionSpendUsd.toFixed(2)} of ` +
          `agentTaskPlayer.prdLoop.versionBudgetUsd = $${cfg.versionBudgetUsd.toFixed(2)}.`,
      });
    }
    return null;
  };

  /**
   * Resolve a pending manual gate.
   * Returns true when the caller must halt, false when the gate was skipped.
   */
  const settleManualGate = (): boolean => {
    if (!manualGateHit) {
      return false;
    }
    if (cfg.onManualGate === 'skip' && manualGateTaskId && deps.skipManualGate) {
      deps.onProgress('manual-gate', `Skipping manual gate ${manualGateTaskId}`);
      deps.skipManualGate(manualGateTaskId);
      manualGateHit = false;
      manualGateTaskId = null;
      return false;
    }
    return true;
  };

  const execute = async (): Promise<PrdLoopReport> => {
    // ── 1. PRD text ──
    const prdText = await deps.resolvePrdText();
    if (!prdText || prdText.trim().length === 0) {
      deps.onProgress('halt', 'No PRD text could be resolved.');
      return makeReport({
        haltReason: 'no-prd',
        suggestion: 'No PRD was found. Point the plan at a PRD file before verifying.',
      });
    }

    // ── 2. A new PRD is a new goal — the fix budget starts over ──
    if (deps.plan.fixIterations === undefined || deps.plan.prdSource !== prdText) {
      deps.plan.fixIterations = 0;
      deps.plan.prdSource = prdText;
      deps.savePlan();
    }

    // ── 3. What "before the work" means ──
    const baseRef = await captureBaseRef(cfg.cwd);
    if (!baseRef) {
      deps.onProgress('warning', 'Git is unavailable — the change gate cannot see any work.');
    }

    // ── 4. Gate/fix iterations ──
    for (;;) {
      iterations++;

      // a. terminal flags — checked before anything is spent
      if (deps.signal.aborted) {
        return makeReport({ haltReason: 'aborted' });
      }
      const budgetStop = budgetHalt();
      if (budgetStop) {
        return budgetStop;
      }
      if (settleManualGate()) {
        return makeReport({
          haltReason: 'manual-gate',
          suggestion: 'A manual ship gate is waiting for human approval.',
        });
      }

      deps.onProgress('evidence', `Collecting diff evidence (iteration ${iterations})`);
      const evidence = await collectDiffEvidence(cfg.cwd, baseRef, { maxDiffChars: cfg.maxDiffChars });
      changedFiles = evidence.changedFiles;
      diffStat = evidence.diffStat;
      gates = [];
      uatRan = false;
      uatSkipReason = null;
      standards = null;

      let failedGate: FailedGate = null;
      let failureDetail = '';

      // b. G4 — task status. Blocked matters: markDependentsBlocked cascades it.
      const broken = allTasks(deps.plan).filter(
        (t) => t.status === TaskStatus.Failed || t.status === TaskStatus.Blocked,
      );
      if (broken.length > 0) {
        failedGate = 'status';
        failureDetail = 'These tasks did not complete:\n' +
          broken.map((t) => `- ${t.name} (${t.status})`).join('\n');
      }

      // c. G1 — something must have actually changed
      if (!failedGate && changedFiles.length === 0) {
        failedGate = 'change';
        failureDetail = baseRef
          ? `No files changed since ${baseRef}. The work was not performed.`
          : 'No changed files could be detected (git unavailable).';
      }

      // c2. Standards, static half — free, so it runs before any command: a diff that breaks
      //     the agreed conventions makes a ten-minute test suite pointless.
      let profileCommands: StandardsProfile['commands'] = [];
      /**
       * Where the standards row goes once the whole blocking set — the profile's commands and
       * any promoted rule — is known. Null while the static half never ran to an end.
       */
      let standardsRow: { index: number; durationMs: number } | null = null;
      if (cfg.standards) {
        const std = cfg.standards;
        if (failedGate) {
          standards = skippedStandardsReport(std.profile, std.version, std.baseRef, `The ${failedGate} gate failed first`);
        } else {
          if (deps.signal.aborted) {
            return makeReport({ haltReason: 'aborted' });
          }
          deps.onProgress('standards', `Checking the diff against ${standardsGateName(std.version)}`);
          const startedAt = Date.now();
          const input = await collectStandardsInput(cfg.cwd, std.baseRef, { probeDirs: std.profile.structure.requiredDirs });
          const checked = checkStandards(std.profile, input);
          checked.version = std.version;
          // "No base recorded" (null: a repository with no commits) is not the same as "a base
          // was recorded and cannot be used". The second must never read as nothing to check.
          const baseLost = std.baseRef !== null && input.baseRef !== std.baseRef;
          const baseUnusable = baseLost && input.baseRef === null;
          if (baseLost && !baseUnusable) {
            deps.onProgress(
              'warning',
              `The standards base ${std.baseRef} is not in this repository any more — every file is checked as if it were new.`,
            );
          }
          for (const cmd of std.profile.commands) {
            checked.rules.push(commandRow({ result: 'not-checked', reason: COMMAND_NOT_REACHED, command: cmd.run }));
          }
          checked.totals = recountTotals(checked);
          standards = checked;

          // Only a BLOCKING rule stops the run. An advisory rule's findings are in the report —
          // file, line and rule — for the reviewer and the approver, and go no further.
          const staticFailed = standardsBlocked(checked);
          const promoted = promotedScannerRules(checked);
          if (promoted.length > 0) {
            deps.onProgress('warning', `Standards: ${promoted.join(', ')} can stop this release. ${SCANNER_PROMOTION_WARNING}`);
          }
          const unread = checked.rules.filter(isUnreadBlocking);
          if (unread.length > 0) {
            // Not a pass and not a failure: said out loud so nobody reads silence as "checked".
            deps.onProgress(
              'warning',
              `Standards: ${unread.length} blocking rule${unread.length === 1 ? '' : 's'} could not be checked ` +
              `(${unread.map((r) => r.rule).join(', ')}) — ${unread[0].reason ?? 'no reason given'}`,
            );
          }
          if (staticFailed) {
            // A blocking rule was evaluated and it stops the release: that is a result, and it is recorded.
            gates.push({
              command: standardsGateName(std.version),
              exitCode: 1,
              passed: false,
              output: describeStandards(checked),
              durationMs: Date.now() - startedAt,
              timedOut: false,
            });
            failedGate = 'standards';
            failureDetail = describeStandards(checked);
            setCommandReason(checked, 'A standards rule failed first');
          } else if (baseUnusable) {
            // Fail closed: the run was started against a base, and no diff against it — or
            // against anything — could be taken. Shipping on "nothing was checked" is not an option.
            failedGate = 'standards';
            failureDetail = `Project standards could not be checked: no diff could be taken against the recorded base ${std.baseRef}.`;
            gates.push({
              command: standardsGateName(std.version),
              exitCode: 1,
              passed: false,
              output: failureDetail,
              durationMs: Date.now() - startedAt,
              timedOut: false,
            });
            setCommandReason(checked, 'The standards base could not be used');
            checked.totals = recountTotals(checked);
          } else {
            profileCommands = std.profile.commands;
            // The row is not written yet. What it says — checked, not checked, or no blocking
            // rules configured — is only known once the profile's commands, the other half of
            // the blocking set, have run too.
            standardsRow = { index: gates.length, durationMs: Date.now() - startedAt };
          }
        }
      }

      // d. G2 — the repository's own checks must pass
      if (!failedGate) {
        const commands = resolveGateCommands(cfg.cwd, cfg.gateCommands);
        gateCommandsEmpty = commands.length === 0;
        if (gateCommandsEmpty) {
          if (cfg.unattended) {
            deps.onProgress('halt', 'No gate commands could be resolved — refusing to judge unattended.');
            return makeReport({
              passed: false,
              haltReason: 'no-gates',
              suggestion: 'No build/lint/test command could be detected. Set agentTaskPlayer.prdLoop.gateCommands.',
            });
          }
          deps.onProgress(
            'warning',
            'No gate commands could be resolved — verification rests on model judgment alone.',
          );
        }
        const repoResults: GateResult[] = [];
        // Install dependencies first when a manifest changed or node_modules is missing —
        // once per iteration, from the fixed table, never by the model. A failed install
        // fails the command gate with that reason; it is not a gate result to learn from.
        if (commands.length > 0 || profileCommands.length > 0 || cfg.uat.mode !== 'off') {
          const install = await ensureDependencies(cfg.cwd, {
            settings: cfg.dependencies,
            signal: deps.signal,
            timeoutMs: cfg.gateTimeoutMs,
            stage: 'verify',
            onEvent: deps.onDependencyEvent,
          });
          if (install.aborted) {
            return makeReport({ haltReason: 'aborted' });
          }
          if (!install.ok) {
            const failed = install.failed;
            failedGate = 'command';
            gates.push({
              command: failed?.command ?? 'dependency install',
              exitCode: failed?.exitCode || 1,
              passed: false,
              output: failed?.tail ?? '',
              durationMs: failed?.durationMs ?? 0,
              timedOut: failed?.timedOut ?? false,
            });
            failureDetail = `Dependencies could not be installed: ${failed?.command ?? 'the install'}
`
              + `Exit code: ${failed?.exitCode ?? 1}${failed?.timedOut ? ' (timed out)' : ''}`
              + `
Output tail:
${tail(failed?.tail ?? '', 2_000)}`;
          }
        }
        for (const command of failedGate ? [] : commands) {
          if (deps.signal.aborted) {
            return makeReport({ haltReason: 'aborted' });
          }
          deps.onProgress('gate', command);
          const result = await runGate(command, {
            cwd: cfg.cwd,
            signal: deps.signal,
            timeoutMs: cfg.gateTimeoutMs,
          });
          gates.push(result);
          repoResults.push(result);
          // A gate that ran is proof about this repository, whichever way it
          // went. Recorded here because this is where a real exit code exists.
          // (The synthetic standards row never comes through here: it is not a command.)
          learnFromGate(cfg.cwd, result);
          if (!result.passed) {
            failedGate = 'command';
            failureDetail = `Gate command failed: ${result.command}\nExit code: ${result.exitCode}` +
              (result.timedOut ? ' (timed out)' : '') +
              `\nOutput tail:\n${tail(result.output, 2_000)}`;
            break;
          }
        }

        // ── G2a — standards, command half ──
        // The approved profile's own lint/format commands, after the repo gates and through
        // the same runGate. A command the repo gates already ran is not run a second time.
        if (standards) {
          const report: StandardsReport = standards;
          const firstCommandRow = report.rules.length - profileCommands.length;
          if (failedGate) {
            setCommandReason(report, `The ${failedGate} gate failed first`);
          } else {
            for (let i = 0; i < profileCommands.length; i++) {
              if (deps.signal.aborted) {
                return makeReport({ haltReason: 'aborted' });
              }
              const command = profileCommands[i].run;
              let result = repoResults.find((g) => g.command === command);
              if (!result) {
                deps.onProgress('standards-command', command);
                result = await runGate(command, {
                  cwd: cfg.cwd,
                  signal: deps.signal,
                  timeoutMs: cfg.gateTimeoutMs,
                });
                gates.push(result);
                learnFromGate(cfg.cwd, result);
              }
              report.rules[firstCommandRow + i] = commandRow({
                result: result.passed ? 'passed' : 'failed',
                command,
                exitCode: result.exitCode,
                tail: tail(result.output, 2_000),
              });
              if (!result.passed) {
                failedGate = 'standards';
                failureDetail = `Standards command failed: ${result.command}\nExit code: ${result.exitCode}` +
                  (result.timedOut ? ' (timed out)' : '') +
                  `\nOutput tail:\n${tail(result.output, 2_000)}`;
                setCommandReason(report, 'An earlier standards command failed');
                break;
              }
            }
          }
          report.totals = recountTotals(report);
          // Now, and only now, the blocking set is known. The row is put where the static
          // check ran, ahead of the commands; its text carries what was only advised and what
          // was not checked, so a reader of the trace sees those beside the result.
          const blockingState = standardsBlockingState(report);
          if (!failedGate && standardsRow && blockingState === 'not-checked') {
            // Unevaluated blocking evidence is not a pass: a promoted rule that could not read
            // what it had to, or a command that never ran, stops the release like a failure.
            const open = report.rules.filter(isBlockingNotChecked);
            failedGate = 'standards';
            failureDetail = `Project standards could not be checked: ${open.length} blocking rule${open.length === 1 ? ' was' : 's were'} not checked.\n` +
              open.map((r) => `- ${r.rule === 'command' ? `command: ${r.command ?? ''}` : r.rule} — ${r.reason ?? 'no reason given'}`).join('\n');
            gates.splice(standardsRow.index, 0, {
              command: standardsGateName(report.version),
              exitCode: 1,
              passed: false,
              output: `${failureDetail}\n${describeStandards(report)}`,
              durationMs: standardsRow.durationMs,
              timedOut: false,
            });
          } else if (standardsRow && blockingState !== 'not-checked' && !standardsBlocked(report)) {
            // Either the blocking set was evaluated and nothing in it stops the release, or the
            // profile has no blocking set at all — which the row says in so many words
            // (`describeStandards`, `standardsCounts.noBlockingRules`) and never calls a pass.
            gates.splice(standardsRow.index, 0, {
              command: standardsGateName(report.version),
              exitCode: 0,
              passed: true,
              output: describeStandards(report),
              durationMs: standardsRow.durationMs,
              timedOut: false,
              standardsCounts: standardsCheckCounts(report),
            });
          }
        }

        // ── G2b — browser UAT ──
        // Only reached when every repo gate already passed: bringing up a sandbox
        // costs real time, so a failing `npm test` must never get this far, and
        // `prepareUat` must never be called on that path.
        if (!failedGate && cfg.uat.mode !== 'off') {
          const cap = resolveUatGate(cfg.cwd, {
            explicitCommand: cfg.uat.command,
            specPath: cfg.uat.specPath,
          });

          /**
           * The gate could not run. Under `auto` this is a silent skip that pushes
           * NOTHING into `gates`; under `required` it is a failure.
           *
           * It must NEVER push a `passed: true` row. `adapters/validation/types.ts:84`
           * deliberately treats an unavailable validator as a pass — that is the
           * exact contract `required` exists to opt out of, and fabricating a
           * passing row here would quietly reinstate it.
           */
          const handleUnavailable = (reason: string): void => {
            uatRan = false;
            uatSkipReason = reason;
            if (cfg.uat.mode === 'required') {
              capabilityMissing = true;
              failedGate = 'command';
              failureDetail = `Browser UAT is required but could not run.\n${reason}`;
              gates.push({
                command: cap.command ?? '(uat)',
                exitCode: 1,
                passed: false,
                output: reason,
                durationMs: 0,
                timedOut: false,
              });
            } else {
              deps.onProgress('warning', `Browser UAT skipped — ${reason}`);
            }
          };

          if (!cap.command) {
            handleUnavailable(cap.reason);
          } else if (deps.signal.aborted) {
            return makeReport({ haltReason: 'aborted' });
          } else {
            const session = deps.prepareUat ? await deps.prepareUat(deps.signal) : null;
            if (!session) {
              handleUnavailable('No sandbox URL could be prepared for the UAT gate.');
            } else {
              try {
                if (deps.signal.aborted) {
                  return makeReport({ haltReason: 'aborted' });
                }
                deps.onProgress('uat', cap.command);
                const result = await runGate(cap.command, {
                  cwd: cfg.cwd,
                  signal: deps.signal,
                  timeoutMs: cfg.uat.timeoutMs,
                  env: {
                    MOAG_UAT_BASE_URL: session.baseUrl,
                    PLAYWRIGHT_TEST_BASE_URL: session.baseUrl,
                    CYPRESS_BASE_URL: session.baseUrl,
                  },
                });
                uatRan = true;
                gates.push(result);
                if (!result.passed) {
                  failedGate = 'command';
                  failureDetail = `Browser UAT failed: ${result.command}\nExit code: ${result.exitCode}` +
                    (result.timedOut ? ' (timed out)' : '') +
                    `\nOutput tail:\n${tail(result.output, 2_000)}`;
                }
              } finally {
                // Exactly once, on pass, fail, abort and throw alike.
                await session.dispose();
              }
            }
          }
        }
      }

      // ── Requirement trace evidence ──
      // Recorded here — after every gate command ran and BEFORE any model call — so the
      // trace only ever holds real exit codes. Nothing after the model call touches it.
      if (gates.length > 0 && recordGateResults(deps.plan, gates, new Date().toISOString()).length > 0) {
        deps.savePlan();
      }

      // e. G3 — every artifact a completed task promised must exist
      if (!failedGate) {
        const expected = allTasks(deps.plan)
          .filter((t) => t.status === TaskStatus.Completed)
          .flatMap((t) => t.expectedArtifacts ?? []);
        const missing = checkArtifacts(cfg.cwd, expected).filter((a) => !a.exists);
        if (missing.length > 0) {
          failedGate = 'artifact';
          failureDetail = 'Declared artifacts are missing:\n' +
            missing.map((a) => `- ${a.target}`).join('\n');
        }
      }

      let gaps: string[] = [];
      let suggestion = '';
      let score = 0;

      // f. Only once every gate passes does a model get a say
      if (!failedGate) {
        deps.onProgress('verify', 'All deterministic gates passed — asking the model for a verdict.');
        const prompt = buildVerifyPrompt(prdText, summarizeEvidence(evidence, gates, cfg.maxDiffChars));
        const verifyBudgetStop = budgetHalt();
        if (verifyBudgetStop) {
          return verifyBudgetStop;
        }
        modelCallsMade++;
        const result = await deps.runEngine(prompt, deps.signal);
        const verdict = parseVerdict(result);
        if (!verdict) {
          return makeReport({
            haltReason: 'engine-error',
            suggestion: 'The verification model did not return parsable JSON. No verdict was reached.',
          });
        }
        if (verdict.passed === true) {
          deps.plan.fixIterations = 0;
          deps.savePlan();
          return makeReport({
            passed: true,
            score: verdict.score,
            gaps: verdict.gaps,
            suggestion: verdict.suggestion,
          });
        }
        gaps = verdict.gaps;
        suggestion = verdict.suggestion;
        score = verdict.score;
      } else {
        deps.onProgress('gate-failed', `Failed at the ${failedGate} gate — no model judgment was needed.`);
        suggestion = failureDetail;
      }

      // h. No-progress guard — same failing gates over the same files twice
      const fingerprint = buildFingerprint(gates, changedFiles, standards);
      if (lastFingerprint !== null && fingerprint === lastFingerprint) {
        return makeReport({
          haltReason: 'no-progress',
          failedGate,
          gaps,
          suggestion: suggestion || 'The same failure recurred with no change in the working tree.',
          score,
        });
      }
      lastFingerprint = fingerprint;

      // i. Iteration ceiling
      const used: number = deps.plan.fixIterations ?? 0;
      if (used >= cfg.maxFixIterations) {
        return makeReport({
          haltReason: 'max-iterations',
          failedGate,
          gaps,
          suggestion: suggestion || `Reached the fix-iteration ceiling (${cfg.maxFixIterations}).`,
          score,
        });
      }

      // j. Verification-only mode stops at the first failure
      if (!cfg.fix) {
        return makeReport({ failedGate, gaps, suggestion, score });
      }

      // k. Generate a fix playlist from the failure
      const fixPrompt = failedGate
        ? buildDeterministicFixPrompt(failedGate, failureDetail)
        : buildGapFixPrompt(gaps, suggestion);
      const fixBudgetStop = budgetHalt({ failedGate, gaps, score });
      if (fixBudgetStop) {
        return fixBudgetStop;
      }
      deps.onProgress('fix', `Generating fix tasks (iteration ${used + 1})`);
      modelCallsMade++;
      const fixResult = await deps.runEngine(fixPrompt, deps.signal);
      const fixTasks = parseFixTasks(fixResult);
      if (fixTasks.length === 0) {
        return makeReport({
          haltReason: 'engine-error',
          failedGate,
          gaps,
          suggestion: 'The engine returned no usable fix tasks.',
          score,
        });
      }

      const stamp = Date.now();
      const iterationN: number = used + 1;
      const fixPlaylist: Playlist = {
        id: `pl-fix-${stamp}`,
        name: `Fix — Iteration ${iterationN}`,
        // Repair work, not review: the deterministic gates already rendered the verdict,
        // so the fix playlist runs as an engineer rather than re-litigating the failure.
        role: 'engineer',
        autoplay: true,
        testPhase: false,
        tasks: fixTasks.map((t, i) => ({
          id: `t-fix-${stamp}-${i}`,
          name: t.name,
          prompt: t.prompt,
          type: 'agent' as const,
          status: TaskStatus.Pending,
        })),
      };
      deps.plan.playlists.push(fixPlaylist);
      deps.plan.fixIterations = iterationN;
      deps.savePlan();

      // l. Run the fixes. A play() that returns without touching a single task
      //    means the runner's play lock was held — that is contention, not a run.
      try {
        await deps.runPlan(deps.plan);
      } catch (err) {
        return makeReport({
          haltReason: 'engine-error',
          failedGate,
          gaps,
          suggestion: `Running the fix playlist failed: ${err instanceof Error ? err.message : String(err)}`,
          score,
        });
      }
      // A breach while the fix playlist ran stopped the runner — report that, not contention.
      const runBudgetStop = budgetHalt({ failedGate, gaps, score });
      if (runBudgetStop) {
        return runBudgetStop;
      }
      const untouched = fixPlaylist.tasks.every((t) => t.status === TaskStatus.Pending);
      if (untouched) {
        return makeReport({
          haltReason: 'engine-error',
          failedGate,
          gaps,
          suggestion: 'The fix playlist never started — the runner was already busy (play lock held).',
          score,
        });
      }
    }
  };

  /** Park a terminal gate failure exactly once, on the single terminal path. */
  const parkIfGateFailed = (r: PrdLoopReport): void => {
    if (r.passed || !r.failedGate) { return; }
    const reason: ParkReason = capabilityMissing ? 'missing-capability' : 'gate-failure';
    parkGateFailure(cfg.cwd, r.failedGate, r.suggestion ?? '', reason);
  };

  const run = async (): Promise<PrdLoopReport> => {
    let report: PrdLoopReport | null = null;
    try {
      if (cfg.versionBudgetUsd > 0) {
        if (deps.subscribeSpend) {
          unsubscribeSpend = deps.subscribeSpend((usd) => {
            if (!Number.isFinite(usd) || usd < 0) { return; }
            versionSpendUsd += usd;
            if (!versionBudgetHit && versionSpendUsd > cfg.versionBudgetUsd) {
              versionBudgetHit = true;
              deps.onProgress('halt', `Per-run PRD budget reached ($${versionSpendUsd.toFixed(2)} of ` +
                `$${cfg.versionBudgetUsd.toFixed(2)}) — stopping the run.`);
              try { deps.stopRun?.(); } catch { /* best effort */ }
            }
          });
        } else {
          deps.onProgress('warning', 'per-version budget set but spend cannot be metered');
        }
      }
      report = await execute();
      return report;
    } finally {
      // Unsubscribed on every path — including a throw — before the report goes out.
      unsubscribeSpend?.();
      unsubscribeSpend = null;
      // Exactly one report on every terminal path, including a thrown error.
      const final = report ?? makeReport({
        haltReason: 'engine-error',
        suggestion: 'The verification loop ended unexpectedly.',
      });
      parkIfGateFailed(final);
      await deps.emitReport(final);
    }
  };

  return {
    run,
    noteManualGate(taskId: string): void {
      manualGateHit = true;
      manualGateTaskId = taskId;
    },
    noteBudgetExceeded(): void {
      budgetHit = true;
    },
  };
}

// ─── Prompt + parsing helpers ───

/** Keep the last `maxChars` of text — where failures print. */
function tail(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(trimmed.length - maxChars);
}

/**
 * Stable identity of a failure: which gates failed, over which files, with which
 * BLOCKING standards findings. The findings matter: the standards row exits 1 while any
 * blocking finding remains, so without them a fix that cleared nine of ten would read as
 * no progress. Advisory findings are left out — they fail nothing, so they are not part
 * of what a fix has to change.
 */
function buildFingerprint(gates: GateResult[], changedFiles: string[], standards: StandardsReport | null): string {
  const failing = gates.filter((g) => !g.passed).map((g) => `${g.command}:${g.exitCode}`).sort();
  const files = [...changedFiles].sort();
  const findings = (standards?.findings ?? []).filter((f) => severityOf(f) === 'blocking')
    .map((f) => `${f.file}:${f.line}:${f.rule}`).sort();
  return JSON.stringify(findings.length > 0 ? { failing, files, findings } : { failing, files });
}

/** Why a profile command has no result yet. Replaced as soon as the command runs. */
const COMMAND_NOT_REACHED = 'Verification stopped before the standards commands ran';
/** Most findings spelled out in a failure message or fix prompt. */
const MAX_FINDINGS_DESCRIBED = 40;

/** Name of the synthetic gate row that carries the static standards result. */
function standardsGateName(version: number | null): string {
  return standardsGateCommand(version);
}

/** Give every profile command that has not run yet the same not-checked reason. */
function setCommandReason(report: StandardsReport, reason: string): void {
  for (const row of report.rules) {
    if (row.rule === 'command' && row.result === 'not-checked') { row.reason = reason; }
  }
}

/** One group of findings as text: a heading, then one line per finding, capped. */
function describeFindings(heading: string, findings: StandardsReport['findings']): string[] {
  if (findings.length === 0) { return []; }
  const lines = findings.slice(0, MAX_FINDINGS_DESCRIBED).map((f) => `- ${f.file}:${f.line} ${f.rule} — ${f.message}`);
  if (findings.length > MAX_FINDINGS_DESCRIBED) { lines.push(`…and ${findings.length - MAX_FINDINGS_DESCRIBED} more`); }
  return [heading, ...lines];
}

/** `n thing` / `n things`. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The static standards result as text, in the groups every surface shows: what BLOCKS (the
 * only part a fix must change), what is ADVISORY (reported, never blocking), and what was
 * NOT CHECKED — rules and files — never a pass, with blocking rules that could not read a
 * changed file named first.
 *
 * The words follow the rule: a scanner rule has "findings" or "no findings" and is never
 * said to have passed; "passed" and "failed" are kept for commands. A profile with no blocking
 * set says "no blocking rules configured".
 * The first line carries the counts a trace reader needs beside the result: advisory
 * findings, rules not checked and files not checked.
 */
function describeStandards(report: StandardsReport): string {
  const statics: StandardsReport = { ...report, rules: report.rules.filter((r) => r.rule !== 'command') };
  const groups = groupStandardsRules(statics);
  const stopping = groups.blocking.filter((r) => r.result === 'failed');
  const blockingFindings = report.findings.filter((f) => severityOf(f) === 'blocking');
  const advisoryFindings = report.findings.filter((f) => severityOf(f) === 'advisory');
  const unread = groups.notChecked.filter(isUnreadBlocking);
  const files = report.notCheckedFiles ?? [];
  const t = report.totals;
  // The same three numbers the trace records beside the row (`standardsCheckCounts`).
  const open = standardsCheckCounts(statics);

  const counts = `${plural(open.advisoryFindings, 'advisory finding')}, ${plural(open.notCheckedRules, 'rule')} not checked, ` +
    `${plural(open.notCheckedFiles, 'file')} not checked`;
  const head = stopping.length > 0
    ? `Project standards stop this release: ${stopping.map((r) => `${r.rule} (${ruleOutcomeLabel(r)})`).join(', ')} — ` +
      `${plural(blockingFindings.length, 'blocking finding')}; ${counts}.`
    : standardsBlockingState(report) === 'none-configured' ? `Project standards: ${NO_BLOCKING_RULES} (${counts}).`
      : `Project standards: nothing blocking (${counts}).`;
  const out = [
    head,
    ...describeFindings('Blocking — these must be fixed:', blockingFindings),
    ...describeFindings('Advisory — reported by a heuristic scan, not blocking:', advisoryFindings),
  ];
  const promoted = promotedScannerRules(statics);
  if (promoted.length > 0) { out.push(`Promoted to blocking: ${promoted.join(', ')}. ${SCANNER_PROMOTION_WARNING}`); }
  if (unread.length > 0) {
    out.push('Not checked — blocking rules that could not read a changed file (not a pass):');
    for (const r of unread) { out.push(`- ${r.rule} — ${r.reason ?? 'no reason given'}`); }
  }
  if (files.length > 0) {
    out.push(`Files not checked (${t.notCheckedFiles}) — nothing in them counts towards "no findings":`);
    for (const f of files.slice(0, MAX_FINDINGS_DESCRIBED)) { out.push(`- ${f.file} — not checked (${f.reason})`); }
    if (t.notCheckedFiles > Math.min(files.length, MAX_FINDINGS_DESCRIBED)) {
      out.push(`…and ${t.notCheckedFiles - Math.min(files.length, MAX_FINDINGS_DESCRIBED)} more`);
    }
  }
  return out.join('\n');
}

function buildVerifyPrompt(prdText: string, evidenceSummary: string): string {
  return `Given this PRD:\n${prdText}\n\n` +
    `And this VERIFIED evidence from the working tree (every gate below already passed):\n` +
    `${evidenceSummary}\n\n` +
    'Does the implementation satisfy the PRD acceptance criteria? Judge only from the evidence above. ' +
    'Reply with JSON only: { "passed": boolean, "score": number (0-100), "gaps": string[], "suggestion": string }';
}

function buildDeterministicFixPrompt(failedGate: Exclude<FailedGate, null>, detail: string): string {
  return `A deterministic ${failedGate} gate failed during PRD verification.\n\n${detail}\n\n` +
    'Generate the tasks needed to make this gate pass. Reply with JSON only: ' +
    'an array of { "name": string, "prompt": string }.';
}

function buildGapFixPrompt(gaps: string[], suggestion: string): string {
  return 'Given these PRD gaps found during verification:\n' +
    gaps.map((g, i) => `${i + 1}. ${g}`).join('\n') +
    `\n\nReviewer suggestion: ${suggestion}\n\n` +
    'Generate fix tasks as JSON only: an array of { "name": string, "prompt": string }.';
}

/** Strip a fenced code block, if present, and parse. Returns null on any failure. */
function parseJsonPayload(result: EngineResult): unknown {
  if (result.exitCode !== 0) {
    return null;
  }
  const text = result.stdout.trim();
  if (!text) {
    return null;
  }
  const raw = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Parse a model verdict. Anything unparsable is a halt, never a pass. */
function parseVerdict(result: EngineResult): ModelVerdict | null {
  const parsed = parseJsonPayload(result);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.passed !== 'boolean') {
    return null;
  }
  return {
    passed: obj.passed,
    score: typeof obj.score === 'number' ? obj.score : 0,
    gaps: Array.isArray(obj.gaps) ? obj.gaps.filter((g): g is string => typeof g === 'string') : [],
    suggestion: typeof obj.suggestion === 'string' ? obj.suggestion : '',
  };
}

/** Parse a generated fix-task array, dropping anything malformed. */
function parseFixTasks(result: EngineResult): Array<{ name: string; prompt: string }> {
  const parsed = parseJsonPayload(result);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: Array<{ name: string; prompt: string }> = [];
  for (const entry of parsed) {
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      if (typeof obj.name === 'string' && typeof obj.prompt === 'string' && obj.name.trim().length > 0) {
        out.push({ name: obj.name, prompt: obj.prompt });
      }
    }
  }
  return out;
}

/**
 * Record a verification that ended on a failed gate, so the operator finds it
 * in the morning instead of only in a log line.
 *
 * A gate that could not RUN is a different problem from a gate that ran and
 * failed — one needs a tool installed, the other needs code changed — so the
 * two get different reasons and different decisions.
 */
function parkGateFailure(
  cwd: string,
  gate: string,
  detail: string,
  reason: ParkReason,
): void {
  const evidence = { gate, lastError: detail };
  park(cwd, {
    id: 'prd-' + Date.now().toString(36),
    parkedAt: new Date().toISOString(),
    reason,
    planName: '',
    playlistName: '',
    taskId: '',
    taskName: 'PRD verification',
    decision: decisionFor(reason, evidence),
    evidence,
  }, nodeFs);
}

/**
 * Turn one gate result into a durable fact.
 *
 * Only ever called where a command actually ran, so every fact it writes has
 * a real exit code behind it — the invariant the knowledge base depends on.
 */
function learnFromGate(cwd: string, result: { command: string; passed: boolean; exitCode: number; timedOut: boolean }): void {
  // A timeout says nothing about the command, only about how long we waited.
  if (result.timedOut) { return; }
  const kind = result.passed ? 'verified-command' : 'failing-command';
  recordFact(cwd, {
    id: commandFactId(kind, result.command),
    kind,
    statement: result.passed
      ? '`' + result.command + '` passes here'
      : '`' + result.command + '` fails here (exit ' + result.exitCode + ')',
    provenBy: `${result.command} -> exit ${result.exitCode}`,
    observedAt: new Date().toISOString(),
  }, nodeFs);
}

