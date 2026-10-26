// ─── .moag/ workspace paths ──────────────────────────────────────────────────
//
// Where the plan lives, how a legacy plan is migrated, and where a new one is
// saved. Extracted from extension.ts, which had grown past 9,000 lines: this is
// one cohesive concern with no dependency on extension state, so it belongs in
// its own module where it can be found and tested.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
const MOAG_DIR = '.moag';
export const MOAG_PLAN_FILE = '.agent-plan.json';
const MOAG_FALLBACK_PLAN_FILE = 'plan.json';

/** Get the .moag/ directory path for the current workspace */
export function getMoagDir(): string | null {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) { return null; }
  return path.join(workspaceFolder.uri.fsPath, MOAG_DIR);
}

/** Get preferred plan path: .moag/.agent-plan.json (fallback .moag/plan.json) */
export function getMoagPlanPath(): string | null {
  const dir = getMoagDir();
  if (!dir) { return null; }
  const canonical = path.join(dir, MOAG_PLAN_FILE);
  if (fs.existsSync(canonical)) {
    return canonical;
  }
  return path.join(dir, MOAG_FALLBACK_PLAN_FILE);
}

/**
 * Pure migration for .gitignore's `.moag/` entry so `.moag/usage-log.jsonl`
 * survives ignore rules. No longer called: MOAG edits .gitignore only with the
 * user's consent (gitignore-consent.ts), and the usage log is local by default.
 * Kept as tested pure logic.
 *  (a) an exact bare `.moag/` (or `.moag`) line is replaced in place with
 *      `.moag/*` followed by `!.moag/usage-log.jsonl` on the next line
 *  (b) `.moag/*` present without the negation gets the negation appended
 *  (c) neither present: both lines are appended
 *  (d) idempotent — running twice never duplicates a line
 * @param content Current .gitignore content (empty string if none)
 */
export function upgradeGitignoreForUsageLog(content: string): string {
  const STAR = '.moag/*';
  const NEGATION = '!.moag/usage-log.jsonl';

  const endsWithNewline = content.length === 0 || content.endsWith('\n');
  let lines = content.length === 0 ? [] : content.split('\n');
  if (lines.length > 0 && endsWithNewline && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1);
  }

  const bareIdx = lines.findIndex(l => {
    const t = l.trim();
    return t === '.moag/' || t === '.moag';
  });
  const hasStar = lines.some(l => l.trim() === STAR);
  const hasNegation = lines.some(l => l.trim() === NEGATION);

  if (bareIdx !== -1) {
    lines.splice(bareIdx, 1, STAR, NEGATION);
  } else if (hasStar && !hasNegation) {
    lines.push(NEGATION);
  } else if (!hasStar && !hasNegation) {
    lines.push(STAR, NEGATION);
  }
  // else: both already present — no-op, keeps this idempotent

  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

// ─── .gitignore: only with the user's consent ───
//
// MOAG used to edit .gitignore and .gitattributes the moment it created .moag/.
// It no longer touches either file on its own: creating .moag/ fires a listener,
// and src/ui/gitignore-consent.ts asks once per workspace what to ignore.

/** What the user chose to ignore. */
export type GitignoreChoice = 'share-plan' | 'ignore-all';

let dirCreatedListener: ((dir: string) => void) | null = null;

/** Called with the .moag/ path each time ensureMoagDir() actually creates it. Null clears it. */
export function setMoagDirCreatedListener(fn: ((dir: string) => void) | null): void {
  dirCreatedListener = fn;
}

/** The .gitignore lines for a choice. Pure. */
export function gitignoreLinesFor(choice: GitignoreChoice): string[] {
  return choice === 'share-plan'
    ? ['.moag/*', '!.moag/plan.json', '!.moag/.agent-plan.json']
    : ['.moag/'];
}

/**
 * Append the choice's lines that `root`/.gitignore does not already have (compared
 * trimmed). Existing lines are never changed or removed; running it twice changes
 * nothing. fs only. Returns true when the file was written. Throws on a write error.
 */
export function applyGitignoreChoice(root: string, choice: GitignoreChoice): boolean {
  const file = path.join(root, '.gitignore');
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const have = new Set(content.split(/\r?\n/).map((l) => l.trim()));
  const missing = gitignoreLinesFor(choice).filter((l) => !have.has(l));
  if (missing.length === 0) { return false; }
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const sep = content.length > 0 && !content.endsWith('\n') ? eol : '';
  fs.writeFileSync(file, content + sep + missing.join(eol) + eol, 'utf-8');
  return true;
}

/** Ensure .moag/ directory exists. Never touches .gitignore or .gitattributes. */
export function ensureMoagDir(): string | null {
  const dir = getMoagDir();
  if (!dir) { return null; }
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return null; // read-only FS or permission denied
    }
    try { dirCreatedListener?.(dir); } catch { /* a listener never breaks the caller */ }
  }
  return dir;
}

/** Resolve the plan path: prefer .moag/.agent-plan.json, then .moag/plan.json */
export async function resolvePlanPath(): Promise<string | null> {
  const moagDir = getMoagDir();
  const canonicalMoagPath = moagDir ? path.join(moagDir, MOAG_PLAN_FILE) : null;
  const fallbackMoagPath = moagDir ? path.join(moagDir, MOAG_FALLBACK_PLAN_FILE) : null;
  const moagPath = getMoagPlanPath();

  // 1. If .moag/.agent-plan.json exists, use it
  if (canonicalMoagPath && fs.existsSync(canonicalMoagPath)) {
    // Still check for stray legacy files and clean them up
    migrateLegacyPlans();
    return canonicalMoagPath;
  }

  // 2. If .moag/plan.json exists, use it
  if (fallbackMoagPath && fs.existsSync(fallbackMoagPath)) {
    migrateLegacyPlans();
    return fallbackMoagPath;
  }

  // 3. Find any legacy *.agent-plan.json files and auto-migrate the first one
  let files: vscode.Uri[];
  try {
    const findPromise = vscode.workspace.findFiles('*.agent-plan.json', '**/node_modules/**', 10);
    const timeoutPromise = new Promise<vscode.Uri[]>((_, reject) =>
      setTimeout(() => reject(new Error('findFiles timeout')), 1000),
    );
    files = await Promise.race([findPromise, timeoutPromise]);
  } catch {
    return null; // timed out or errored — huge workspace, bail gracefully
  }
  if (files.length === 0) {
    return null;
  }

  // Auto-migrate: move to .moag/plan.json, no questions asked
  const dir = ensureMoagDir();
  if (dir && moagPath) {
    try {
      // Move the first (most relevant) plan file
      fs.copyFileSync(files[0].fsPath, moagPath);
      fs.unlinkSync(files[0].fsPath);

      // Clean up any remaining legacy plan files — move them to .moag/ as backups
      for (let i = 1; i < files.length; i++) {
        const basename = path.basename(files[i].fsPath);
        const backupPath = path.join(dir, basename);
        try {
          fs.renameSync(files[i].fsPath, backupPath);
        } catch { /* ignore */ }
      }

      return moagPath;
    } catch {
      // Migration failed, use legacy path directly
      return files[0].fsPath;
    }
  }

  return files[0].fsPath;
}

/** Silently clean up any stray *.agent-plan.json files from workspace root into .moag/ */
function migrateLegacyPlans(): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const moagDir = getMoagDir();
  if (!workspaceRoot || !moagDir) { return; }

  try {
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.agent-plan.json')) {
        const src = path.join(workspaceRoot, entry.name);
        let dest = path.join(moagDir, entry.name);
        // If destination already exists, use a numbered suffix
        if (fs.existsSync(dest)) {
          const base = entry.name.replace(/\.agent-plan\.json$/, '');
          let counter = 2;
          while (fs.existsSync(path.join(moagDir, `${base}-${counter}.agent-plan.json`))) {
            counter++;
          }
          dest = path.join(moagDir, `${base}-${counter}.agent-plan.json`);
        }
        try {
          fs.renameSync(src, dest);
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/** Get the save path for a new plan — always .moag/plan.json */
export function getNewPlanSavePath(): string | null {
  ensureMoagDir();
  return getMoagPlanPath();
}
