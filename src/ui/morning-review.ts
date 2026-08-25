// ─── Morning review — the digest, reachable from the IDE ─────────────────────
//
// `moag digest` and `moag queue` gave the headless side a morning review while
// the person most likely to want one — the developer sitting in VS Code — had
// no way to reach it. Same data, same ordering, same decisions; this is only a
// second surface onto runner/digest.ts and runner/park-queue.ts.
//
// Rendered as a markdown document rather than a webview on purpose: the sidebar
// webview has already shipped two runtime errors to users because its script
// lives in a template literal that tsc never parses. A generated document has
// no such failure mode, and VS Code renders it well.

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as nodeFs from 'fs';
import { buildDigest, collectCommits, Digest, GitRunner } from '../runner/digest';
import { describeParkReason, openItems, resolveItem, ParkedItem } from '../runner/park-queue';

/** Spawn-based git, matching the runner's own contract: null when git fails. */
const git: GitRunner = (args, cwd) => new Promise((resolve) => {
  const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
  proc.on('error', () => resolve(null));
  proc.on('close', (code) => resolve(code === 0 ? out : null));
});

function workspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function branchPrefix(): string {
  return vscode.workspace.getConfiguration('agentTaskPlayer')
    .get<string>('git.branchPrefix', 'moag/') || 'moag/';
}

/** Render the digest as markdown. Pure, so the layout is assertable in a test. */
export function renderReviewMarkdown(d: Digest, now: string): string {
  const out: string[] = ['# MOAG morning review', '', `_Generated ${now}_`, ''];

  // Decisions first. A commit log is context; a blocked decision is the reason
  // the operator opened this at all.
  if (d.needsDecision.length === 0) {
    out.push('## Nothing is waiting on you', '');
  } else {
    out.push(`## ${d.needsDecision.length} item(s) need a decision`, '');
    for (const item of d.needsDecision) {
      out.push(`### ${item.taskName}`);
      out.push('');
      out.push(`- **What happened:** ${describeParkReason(item.reason)}`);
      if (item.playlistName) { out.push(`- **Playlist:** ${item.playlistName}`); }
      out.push(`- **Parked:** ${item.parkedAt}`);
      out.push(`- **Your call:** ${item.decision}`);
      if (item.evidence?.gate) { out.push(`- **Gate:** \`${item.evidence.gate}\``); }
      if (item.evidence?.lastError) {
        out.push('', '```', item.evidence.lastError.slice(0, 600), '```');
      }
      out.push('', `<sub>id: \`${item.id}\` — clear it with **MOAG: Resolve Parked Item**</sub>`, '');
    }
  }

  out.push('## Shipped', '');
  if (d.shipped.length === 0) {
    out.push('Nothing shipped.', '');
  } else {
    out.push('| Commit | Task | Cost |', '| --- | --- | --- |');
    for (const c of d.shipped) {
      const cost = typeof c.costUsd === 'number' ? `$${c.costUsd.toFixed(4)}` : '—';
      out.push(`| \`${c.sha}\` | ${c.subject.replace(/\|/g, '\\|')} | ${cost} |`);
    }
    out.push('');
    out.push('**Branches**', '');
    for (const b of d.branches) { out.push(`- \`${b}\``); }
    out.push('');
  }

  out.push(`## Total cost: $${d.totalCostUsd.toFixed(4)}`);
  // Never let an unknown read as free.
  if (d.shipped.length > 0 && d.totalCostUsd === 0) {
    out.push('', '_No cost was recorded on these commits._');
  }
  return out.join('\n');
}

/** Build the digest for the open workspace. */
export async function buildWorkspaceDigest(cwd: string, since?: string): Promise<Digest> {
  const commits = await collectCommits(cwd, branchPrefix(), since, git);
  return buildDigest(openItems(cwd, nodeFs), commits, since);
}

/** `MOAG: Morning Review` — render the digest into a markdown document. */
export async function cmdShowMorningReview(): Promise<void> {
  const cwd = workspaceRoot();
  if (!cwd) {
    vscode.window.showWarningMessage('Open a folder first — the review reads this workspace.');
    return;
  }

  const digest = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'MOAG: building review…' },
    () => buildWorkspaceDigest(cwd),
  );

  const doc = await vscode.workspace.openTextDocument({
    content: renderReviewMarkdown(digest, new Date().toISOString()),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: true });
  await vscode.commands.executeCommand('markdown.showPreview');
}

/** `MOAG: Resolve Parked Item` — clear one thing the run stopped on. */
export async function cmdResolveParkedItem(): Promise<void> {
  const cwd = workspaceRoot();
  if (!cwd) {
    vscode.window.showWarningMessage('Open a folder first — parked work is per workspace.');
    return;
  }

  const open = openItems(cwd, nodeFs);
  if (open.length === 0) {
    vscode.window.showInformationMessage('Nothing is parked — no decisions are waiting.');
    return;
  }

  const pick = await vscode.window.showQuickPick(
    open.map((item: ParkedItem) => ({
      label: item.taskName,
      description: describeParkReason(item.reason),
      detail: item.decision,
      item,
    })),
    { placeHolder: 'Which parked item have you dealt with?' },
  );
  if (!pick) { return; }

  const ok = resolveItem(cwd, pick.item.id, new Date().toISOString(), nodeFs);
  if (ok) {
    vscode.window.showInformationMessage(`Resolved: ${pick.item.taskName}`);
  } else {
    // The queue is append-only and shared with the daemon, so it can change
    // underneath a picker that has been open for a while.
    vscode.window.showWarningMessage('That item was already resolved — reopen the review for the current list.');
  }
}
