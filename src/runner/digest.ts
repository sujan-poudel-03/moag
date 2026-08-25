// ─── Digest — the fifteen minutes that decide whether any of this worked ─────
//
// A human comes back after eight hours. If reviewing the night takes two
// hours, the system has failed regardless of how good the code is.
//
// So this is ordered by WHAT NEEDS A DECISION, not chronologically and not by
// what the agent found interesting. Parked work comes first because it is the
// only part that is actually blocked on a person; everything shipped is
// reported underneath as context.
//
// Cost is read back out of the commit bodies that git-delivery.ts writes, so a
// digest works across process restarts — the in-process ledger does not
// survive the night, but the commits do.
//
// Dependency-injected and free of `vscode`, like evidence.ts and prd-loop.ts.

import { ParkedItem, ParkReason } from './park-queue';

/** Runs a git subcommand and resolves stdout, or null when git fails. */
export type GitRunner = (args: string[], cwd: string) => Promise<string | null>;

export interface DigestCommit {
  sha: string;
  subject: string;
  at: string;
  branch: string;
  playlist?: string;
  engine?: string;
  costUsd?: number;
}

export interface Digest {
  /** Parked work, most urgent first. This is what the operator acts on. */
  needsDecision: ParkedItem[];
  shipped: DigestCommit[];
  branches: string[];
  totalCostUsd: number;
  since?: string;
}

/**
 * How urgently each reason wants a person, lowest number first.
 *
 * manual-gate outranks everything because the work is finished and only
 * approval is missing — that is the cheapest decision available and unblocks
 * the most. A failure needs diagnosis, which is slower, so it ranks below.
 */
const URGENCY: Record<ParkReason, number> = {
  'manual-gate': 0,
  'budget-exceeded': 1,
  'missing-capability': 2,
  'repeated-failure': 3,
  'gate-failure': 4,
};

// ASCII unit/record separators. Spelled with fromCharCode rather than as raw
// bytes so an editor cannot silently strip them out of the source.
const SEP = String.fromCharCode(31);
const COMMIT_SEP = String.fromCharCode(30);

/** Pull the structured trailers git-delivery.ts writes into a commit body. */
export function parseCommitBody(body: string): Pick<DigestCommit, 'playlist' | 'engine' | 'costUsd'> {
  const find = (label: string): string | undefined => {
    const m = body.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : undefined;
  };
  const rawCost = find('Cost');
  const cost = rawCost ? Number(rawCost.replace(/^\$/, '')) : undefined;
  return {
    playlist: find('Playlist'),
    engine: find('Engine'),
    costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined,
  };
}

/**
 * Read commits MOAG made, across every branch it owns.
 *
 * Scoped to `branchPrefix` so a digest never reports a human's own commits as
 * agent output.
 */
export async function collectCommits(
  repoRoot: string,
  branchPrefix: string,
  since: string | undefined,
  git: GitRunner,
): Promise<DigestCommit[]> {
  const ns = branchPrefix.endsWith('/') ? branchPrefix : `${branchPrefix}/`;
  const listed = await git(['branch', '--list', `${ns}*`, '--format=%(refname:short)'], repoRoot);
  if (listed === null) { return []; }

  const branches = listed.split('\n').map((b) => b.trim()).filter(Boolean);
  const commits: DigestCommit[] = [];
  const seen = new Set<string>();

  for (const branch of branches) {
    const args = [
      'log', branch, '--no-merges',
      // Everything reachable from a NON-MOAG branch is pre-existing history that
      // the run branched off. Without this the digest reports the human's own
      // commits as agent output, because a MOAG branch contains all of them.
      '--not', `--exclude=${ns}*`, '--branches',
      `--format=%H${SEP}%s${SEP}%cI${SEP}%b${COMMIT_SEP}`,
    ];
    if (since) { args.push(`--since=${since}`); }

    const out = await git(args, repoRoot);
    if (out === null) { continue; }

    for (const chunk of out.split(COMMIT_SEP)) {
      const line = chunk.trim();
      if (!line) { continue; }
      const [sha, subject, at, ...rest] = line.split(SEP);
      if (!sha || !subject) { continue; }
      // The same commit is reachable from several branches; report it once.
      if (seen.has(sha)) { continue; }
      seen.add(sha);
      commits.push({
        sha: sha.slice(0, 8),
        subject,
        at: at ?? '',
        branch,
        ...parseCommitBody(rest.join(SEP)),
      });
    }
  }

  return commits.sort((a, b) => b.at.localeCompare(a.at));
}

/** Assemble the digest. Pure, so the ordering is assertable in a test. */
export function buildDigest(
  parked: ParkedItem[],
  commits: DigestCommit[],
  since?: string,
): Digest {
  const needsDecision = parked
    .filter((p) => !p.resolvedAt)
    .sort((a, b) =>
      (URGENCY[a.reason] ?? 99) - (URGENCY[b.reason] ?? 99) ||
      b.parkedAt.localeCompare(a.parkedAt));

  return {
    needsDecision,
    shipped: commits,
    branches: [...new Set(commits.map((c) => c.branch))].sort(),
    totalCostUsd: commits.reduce((sum, c) => sum + (c.costUsd ?? 0), 0),
    since,
  };
}

/** Render the digest as plain text for a terminal. */
export function renderDigest(d: Digest): string {
  const out: string[] = [];
  const window = d.since ? ` since ${d.since}` : '';

  out.push(`MOAG digest${window}`);
  out.push('');

  if (d.needsDecision.length === 0) {
    out.push('Nothing is waiting on you.');
  } else {
    out.push(`${d.needsDecision.length} item(s) need a decision:`);
    out.push('');
    for (const item of d.needsDecision) {
      out.push(`  [${item.id}] ${item.taskName}`);
      if (item.playlistName) { out.push(`      playlist: ${item.playlistName}`); }
      out.push(`      ${item.decision}`);
      out.push('');
    }
  }

  out.push('');
  if (d.shipped.length === 0) {
    out.push('Nothing shipped.');
  } else {
    out.push(`Shipped ${d.shipped.length} commit(s) across ${d.branches.length} branch(es):`);
    for (const c of d.shipped) {
      const cost = typeof c.costUsd === 'number' ? ` ($${c.costUsd.toFixed(4)})` : '';
      out.push(`  ${c.sha}  ${c.subject}${cost}`);
    }
    out.push('');
    for (const b of d.branches) { out.push(`  branch: ${b}`); }
  }

  out.push('');
  out.push(`Total cost: $${d.totalCostUsd.toFixed(4)}`);
  // Say when cost is unknown rather than implying the night was free.
  if (d.shipped.length > 0 && d.totalCostUsd === 0) {
    out.push('  (no cost recorded on these commits)');
  }

  return out.join('\n');
}
