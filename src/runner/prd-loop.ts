// ─── PRD verification / fix loop core ───
//
// The loop that answers "does the work actually satisfy the PRD?". Every gate it
// applies is deterministic and runs BEFORE any model call: if nothing changed, if
// a task failed, if a gate command exited non-zero, or if a declared artifact is
// missing, the verdict is already known and no model is asked. A model only ever
// gets to say "not yet" — it can never override a failed gate.
//
// Dependency-injected in the style of `headless/daemon.ts` and free of VS Code API
// imports, so the extension command and the headless CLI run the exact same loop.

import { EngineResult, Plan, Playlist, Task, TaskStatus } from '../models/types';
import {
  captureBaseRef,
  checkArtifacts,
  collectDiffEvidence,
  GateResult,
  resolveGateCommands,
  resolveUatGate,
  runGate,
  summarizeEvidence,
} from './evidence';

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
export type FailedGate = 'change' | 'command' | 'artifact' | 'status' | null;

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
  skipManualGate?: (taskId: string) => void;
  /**
   * Bring up (or adopt) an application the UAT gate can drive, or resolve null
   * when none can be prepared. Never called when the mode is `off`, and never
   * called after a repo gate has already failed.
   */
  prepareUat?: (signal: AbortSignal) => Promise<UatSession | null>;
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

  let iterations = 0;
  let modelCallsMade = 0;
  let gates: GateResult[] = [];
  let changedFiles: string[] = [];
  let diffStat = '';
  let gateCommandsEmpty = false;
  let uatRan = false;
  let uatSkipReason: string | null = null;
  let lastFingerprint: string | null = null;

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
    ...over,
  });

  /** All tasks across every playlist, in plan order. */
  const allTasks = (plan: Plan): Task[] => plan.playlists.flatMap((pl) => pl.tasks);

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
      if (budgetHit) {
        return makeReport({
          haltReason: 'budget-exceeded',
          suggestion: 'The cost ceiling was reached. Raise agentTaskPlayer.costBudgetUsd to continue.',
        });
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
        for (const command of commands) {
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
          if (!result.passed) {
            failedGate = 'command';
            failureDetail = `Gate command failed: ${result.command}\nExit code: ${result.exitCode}` +
              (result.timedOut ? ' (timed out)' : '') +
              `\nOutput tail:\n${tail(result.output, 2_000)}`;
            break;
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
      const fingerprint = buildFingerprint(gates, changedFiles);
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

  const run = async (): Promise<PrdLoopReport> => {
    let report: PrdLoopReport | null = null;
    try {
      report = await execute();
      return report;
    } finally {
      // Exactly one report on every terminal path, including a thrown error.
      await deps.emitReport(report ?? makeReport({
        haltReason: 'engine-error',
        suggestion: 'The verification loop ended unexpectedly.',
      }));
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

/** Stable identity of a failure: which gates failed, over which files. */
function buildFingerprint(gates: GateResult[], changedFiles: string[]): string {
  const failing = gates.filter((g) => !g.passed).map((g) => `${g.command}:${g.exitCode}`).sort();
  const files = [...changedFiles].sort();
  return JSON.stringify({ failing, files });
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
