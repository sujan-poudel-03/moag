// ─── Knowledge — what this repository has actually proven about itself ───────
//
// `.moag/` holds state: the plan, the rules, what failed. It has never held
// what was LEARNED. So agent number four hundred starts exactly as ignorant as
// agent number one, and so does every new engineer.
//
// The discipline that makes this safe is the same one that makes the
// verification loop trustworthy: RECORD ONLY FACTS WITH AN EXIT CODE BEHIND
// THEM. Never a model's opinion about the codebase. A knowledge base that
// accepts assertions rots into confident fiction, and because this block is
// injected at the same priority as AI Rules, it would rot every future run
// with it. Every entry here names the command that proved it.
//
// Dependency-injected and free of `vscode`, like evidence.ts and prd-loop.ts.

import * as path from 'path';

/**
 * What kind of thing was proven. Closed set — a new member needs a line in
 * `headingFor` so it renders in the injected block.
 */
export type FactKind = 'verified-command' | 'failing-command' | 'recurring-failure';

export interface VerifiedFact {
  /** Stable identity, so re-observing a fact updates it instead of duplicating. */
  id: string;
  kind: FactKind;
  /** What is true, in one line an engineer would recognise. */
  statement: string;
  /** What proves it. Required — a fact without proof is an opinion. */
  provenBy: string;
  /** ISO timestamp of the most recent observation. */
  observedAt: string;
  /** How many times this has been observed. Confidence, earned not asserted. */
  observations: number;
}

/** The minimum filesystem surface this module needs, so tests need no disk. */
export interface FsLike {
  existsSync(p: string): boolean;
  mkdirSync(p: string, opts: { recursive: boolean }): void;
  readFileSync(p: string, enc: 'utf-8'): string;
  writeFileSync(p: string, data: string, enc: 'utf-8'): void;
}

const KNOWLEDGE_DIR = 'knowledge';
const FACTS_FILE = 'facts.json';
const MAX_FACTS = 200;
const MAX_STATEMENT = 200;
const MAX_BLOCK_FACTS = 40;

/** Absolute path of the facts ledger for a workspace. */
export function factsPath(cwd: string): string {
  return path.join(cwd, '.moag', KNOWLEDGE_DIR, FACTS_FILE);
}

/** Stable id for a command-shaped fact, so repeats merge. */
export function commandFactId(kind: FactKind, command: string): string {
  return `${kind}:${command.trim().toLowerCase()}`;
}

export function readFacts(cwd: string, fs: FsLike): VerifiedFact[] {
  try {
    const p = factsPath(cwd);
    if (!fs.existsSync(p)) { return []; }
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!Array.isArray(parsed)) { return []; }
    return parsed.filter((f): f is VerifiedFact =>
      !!f && typeof f.id === 'string' && typeof f.statement === 'string' && typeof f.provenBy === 'string');
  } catch {
    return [];
  }
}

/**
 * Record or reinforce one fact.
 *
 * Rejects anything without proof — that guard is the whole safety property of
 * this module, so it is enforced here rather than trusted to callers.
 *
 * Re-observing an existing fact bumps its count and timestamp instead of
 * appending a duplicate, so the ledger converges rather than growing forever.
 * A fact of one kind supersedes the same command's opposite kind: a command
 * that starts passing must stop being listed as failing.
 */
export function recordFact(
  cwd: string,
  fact: Omit<VerifiedFact, 'observations'>,
  fs: FsLike,
): boolean {
  if (!fact.provenBy || !fact.provenBy.trim()) { return false; }
  if (!fact.statement || !fact.statement.trim()) { return false; }

  try {
    const facts = readFacts(cwd, fs);
    const clean: VerifiedFact = {
      ...fact,
      statement: fact.statement.slice(0, MAX_STATEMENT),
      observations: 1,
    };

    // Drop a contradicting record for the same subject before merging.
    const subject = fact.id.slice(fact.id.indexOf(':') + 1);
    const kept = facts.filter((f) => {
      const sameSubject = f.id.slice(f.id.indexOf(':') + 1) === subject;
      return !(sameSubject && f.id !== fact.id);
    });

    const existing = kept.find((f) => f.id === fact.id);
    if (existing) {
      existing.observations += 1;
      existing.observedAt = fact.observedAt;
      existing.statement = clean.statement;
      existing.provenBy = fact.provenBy;
    } else {
      kept.push(clean);
    }

    // Keep the most-recently-confirmed facts when the ledger is full.
    const trimmed = kept
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
      .slice(0, MAX_FACTS);

    const dir = path.dirname(factsPath(cwd));
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(factsPath(cwd), JSON.stringify(trimmed, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function headingFor(kind: FactKind): string {
  switch (kind) {
    case 'verified-command':  return 'Commands that verify this repository';
    case 'failing-command':   return 'Commands that do NOT work here';
    case 'recurring-failure': return 'Failures seen more than once';
  }
}

/**
 * Render the block injected into every task prompt.
 *
 * Returns an empty string when nothing has been proven yet, so a fresh
 * workspace injects nothing rather than an empty heading.
 */
export function renderKnowledgeBlock(facts: VerifiedFact[]): string {
  if (facts.length === 0) { return ''; }

  // Most-confirmed first: a fact seen twenty times outranks one seen once.
  const ranked = [...facts]
    .sort((a, b) => b.observations - a.observations || b.observedAt.localeCompare(a.observedAt))
    .slice(0, MAX_BLOCK_FACTS);

  const kinds: FactKind[] = ['verified-command', 'failing-command', 'recurring-failure'];
  const out: string[] = [
    'Established by running things in this repository, not by assumption.',
    'Prefer these over guessing; if one is wrong, the evidence is stale — say so.',
  ];

  for (const kind of kinds) {
    const group = ranked.filter((f) => f.kind === kind);
    if (group.length === 0) { continue; }
    out.push('', `**${headingFor(kind)}**`);
    for (const f of group) {
      const seen = f.observations > 1 ? ` _(seen ${f.observations}×)_` : '';
      out.push(`- ${f.statement} — proven by \`${f.provenBy}\`${seen}`);
    }
  }

  return out.join('\n');
}

/** Convenience: read and render in one step. */
export function knowledgeBlockFor(cwd: string, fs: FsLike): string {
  return renderKnowledgeBlock(readFacts(cwd, fs));
}
