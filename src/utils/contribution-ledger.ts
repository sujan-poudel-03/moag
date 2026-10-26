// ─── Contribution Ledger rollup ────────────────────────────────────────────────
//
// Aggregates raw usage-log.jsonl entries into the payload the dashboard's
// Contribution Ledger section renders: a rolling 7-day leaderboard, team-wide
// totals, and prompt-quality coaching cards. Pure — no fs/vscode imports —
// so it can be unit tested directly against arrays of UsageLogEntry.
//
// Policy notes (see task list acceptance criteria — do not relax these):
//  - Only a task whose terminal status is 'completed' AND has at least one
//    call with tokenUsageAvailable === true counts in the tokens/task
//    denominator. Everything else is excluded from BOTH numerator and
//    denominator — never counted as a zero.
//  - Team-wide totalTokens/totalCostUsd sum every entry in the window
//    regardless of status or token availability.
//  - `leads` is accepted for forward-compatibility but has zero effect on
//    any gating or visibility decision in v1 — do not wire it in here.
//  - `entry.prompt` is always the short, human-written task prompt (see
//    usage-log.ts) — never assembled buildContext() output. The 500-char cap
//    below is a defensive cap for a pathological one-line "prompt", not a
//    truncation of a large assembled-context blob (there is none here).

import { rateHeuristically } from './prompt-heuristics';
import { UsageLogEntry } from './usage-log';

const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const DEFAULT_VOLUME_THRESHOLD = 3;
/** Defensive cap for a pathological one-line "prompt" — not a truncation of assembled context. */
const PROMPT_DEFENSIVE_CAP = 500;
const TRUNCATION_NOTE = '\n\n[... truncated]';
const UNKNOWN_KEY = '__unknown__';

/** One row in the leaderboard, keyed by attributed developer. */
export interface ContributionLeaderboardRow {
  developerEmail: string | null;
  tasksCompleted: number;
  /** null ("—") when zero calls for this contributor have tokenUsageAvailable === true */
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  /** null ("—") when this contributor has no task qualifying for the tokens/task metric */
  tokensPerTask: number | null;
}

/** One coaching card — a distinct flagged task, status-agnostic. */
export interface ContributionCoachingCard {
  taskId: string;
  taskName: string;
  developerEmail: string | null;
  promptText: string;
  promptTruncated: boolean;
  score: number;
  flags: string[];
  ts: string;
}

/** Rollup payload posted to the dashboard webview. */
export interface ContributionLedgerPayload {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  totalTokens: number;
  totalCostUsd: number;
  /** Calls in the window whose engine reported no cost (costKnown === false); not in totalCostUsd. */
  unknownCostCalls: number;
  contributorCount: number;
  leaderboard: ContributionLeaderboardRow[];
  isTopThisWeek: boolean;
  volumeThreshold: number;
  coachingCards: ContributionCoachingCard[];
}

interface RollupOpts {
  now: Date;
  taskStatusById: Map<string, string>;
  /** Accepted for forward-compatibility only — has zero effect on gating in v1. */
  leads: string[];
  volumeThreshold?: number;
}

interface ContributorAcc {
  tasksCompleted: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  hasAvailableTokenUsage: boolean;
  tokensPerTaskNumerator: number;
  tokensPerTaskDenominator: number;
}

function capPromptText(text: string): { text: string; truncated: boolean } {
  if (text.length <= PROMPT_DEFENSIVE_CAP) { return { text, truncated: false }; }
  return { text: text.slice(0, PROMPT_DEFENSIVE_CAP) + TRUNCATION_NOTE, truncated: true };
}

function newAcc(): ContributorAcc {
  return {
    tasksCompleted: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    hasAvailableTokenUsage: false,
    tokensPerTaskNumerator: 0,
    tokensPerTaskDenominator: 0,
  };
}

/**
 * Roll a flat list of usage-log entries up into the Contribution Ledger
 * payload: a rolling 7-day leaderboard, team totals, and coaching cards.
 * @param entries        All usage-log entries (unfiltered — window applied here)
 * @param opts           Rollup context — see {@link RollupOpts}
 */
export function rollupContributionLedger(
  entries: UsageLogEntry[],
  opts: RollupOpts,
): ContributionLedgerPayload {
  const volumeThreshold = opts.volumeThreshold ?? DEFAULT_VOLUME_THRESHOLD;
  const nowMs = opts.now.getTime();
  const windowStartMs = nowMs - WINDOW_MS;

  const windowEntries = entries.filter(e => {
    const t = Date.parse(e.ts);
    return !Number.isNaN(t) && t >= windowStartMs && t <= nowMs;
  });

  // Team-wide totals: every entry in the window, regardless of status/availability.
  let totalTokens = 0;
  let totalCostUsd = 0;
  let unknownCostCalls = 0;
  for (const e of windowEntries) {
    totalTokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
    totalCostUsd += e.estimatedCostUsd ?? 0;
    if (e.costKnown === false) { unknownCostCalls++; }
  }

  // Group by taskId so multiple calls (retry / fallback / consensus) sum
  // together and independent tasks never bleed into each other.
  const byTask = new Map<string, UsageLogEntry[]>();
  for (const e of windowEntries) {
    const list = byTask.get(e.taskId);
    if (list) { list.push(e); } else { byTask.set(e.taskId, [e]); }
  }

  const acc = new Map<string, ContributorAcc>();
  const emailForKey = new Map<string, string | null>();
  const coachingCards: ContributionCoachingCard[] = [];

  for (const [taskId, calls] of byTask) {
    const sorted = [...calls].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const latest = sorted[sorted.length - 1];

    // Attribute the whole task to the developer of its most-recent call.
    const email = latest.developerEmail;
    const key = email ?? UNKNOWN_KEY;
    emailForKey.set(key, email);
    let a = acc.get(key);
    if (!a) { a = newAcc(); acc.set(key, a); }

    let taskInput = 0;
    let taskOutput = 0;
    let taskCost = 0;
    let anyTokenAvailable = false;
    for (const c of calls) {
      taskInput += c.inputTokens ?? 0;
      taskOutput += c.outputTokens ?? 0;
      taskCost += c.estimatedCostUsd ?? 0;
      if (c.tokenUsageAvailable) { anyTokenAvailable = true; }
    }
    a.inputTokens += taskInput;
    a.outputTokens += taskOutput;
    a.totalTokens += taskInput + taskOutput;
    a.estimatedCostUsd += taskCost;
    if (anyTokenAvailable) { a.hasAvailableTokenUsage = true; }

    const completed = opts.taskStatusById.get(taskId) === 'completed';
    if (completed) { a.tasksCompleted++; }
    // Only a completed task with at least one token-available call counts —
    // any other outcome is excluded from BOTH numerator and denominator.
    if (completed && anyTokenAvailable) {
      a.tokensPerTaskNumerator += taskInput + taskOutput;
      a.tokensPerTaskDenominator += 1;
    }

    // Coaching cards are status-agnostic — a retried weak prompt is one card,
    // represented by its latest entry.
    const { score, flags } = rateHeuristically(latest.prompt);
    if (flags.length > 0) {
      const { text, truncated } = capPromptText(latest.prompt);
      coachingCards.push({
        taskId,
        taskName: latest.taskName,
        developerEmail: latest.developerEmail,
        promptText: text,
        promptTruncated: truncated,
        score,
        flags,
        ts: latest.ts,
      });
    }
  }

  const leaderboard: ContributionLeaderboardRow[] = [...acc.entries()].map(([key, a]) => ({
    developerEmail: emailForKey.get(key) ?? null,
    tasksCompleted: a.tasksCompleted,
    inputTokens: a.hasAvailableTokenUsage ? a.inputTokens : null,
    outputTokens: a.hasAvailableTokenUsage ? a.outputTokens : null,
    totalTokens: a.hasAvailableTokenUsage ? a.totalTokens : null,
    estimatedCostUsd: a.hasAvailableTokenUsage ? a.estimatedCostUsd : null,
    tokensPerTask: a.tokensPerTaskDenominator > 0
      ? a.tokensPerTaskNumerator / a.tokensPerTaskDenominator
      : null,
  }));

  // ONLY sort: tasks-completed desc, then name asc. No cost/tokens-per-task
  // sort option exists — do not add one; this is a deliberate non-goal.
  leaderboard.sort((r1, r2) => {
    if (r2.tasksCompleted !== r1.tasksCompleted) { return r2.tasksCompleted - r1.tasksCompleted; }
    return (r1.developerEmail ?? '').localeCompare(r2.developerEmail ?? '');
  });

  // Badge only the top sorted row, and only if it clears the volume floor —
  // never fall back to badging a non-qualifying leader.
  const isTopThisWeek = leaderboard.length > 0 && leaderboard[0].tasksCompleted >= volumeThreshold;

  return {
    windowDays: WINDOW_DAYS,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: opts.now.toISOString(),
    totalTokens,
    totalCostUsd,
    unknownCostCalls,
    contributorCount: acc.size,
    leaderboard,
    isTopThisWeek,
    volumeThreshold,
    coachingCards,
  };
}
