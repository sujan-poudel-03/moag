const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'src', 'extension.ts');
let c = fs.readFileSync(filePath, 'utf-8');

const insert = `
// --- MOAG Self-Issue Collection ---

type SelfIssueType = 'engine-not-found' | 'spawn-error' | 'context-overflow' |
  'auth-failure' | 'parse-error' | 'timeout' | 'moag-crash' | 'other';

interface SelfIssue {
  id: string; type: SelfIssueType; message: string; detail: string;
  moagVersion: string; engine: string; platform: string;
  timestamp: string; fingerprint: string; filed: boolean;
}

function classifyMoagIssue(stderr: string, exitCode: number): SelfIssueType | null {
  const s = stderr.toLowerCase();
  if (s.includes('spawn') && s.includes('enoent')) { return 'engine-not-found'; }
  if (s.includes('spawn') && (s.includes('eperm') || s.includes('eacces'))) { return 'spawn-error'; }
  if (s.includes('context length') || s.includes('context window') || s.includes('too many tokens')) { return 'context-overflow'; }
  if (s.includes('authentication') || s.includes('unauthorized') || s.includes('api key') || s.includes('401')) { return 'auth-failure'; }
  if (s.includes('syntaxerror') && s.includes('json')) { return 'parse-error'; }
  if (exitCode === 124 || (s.includes('timed out') && !s.includes('task timed out'))) { return 'timeout'; }
  return null;
}

function getSelfIssueLogPath(): string | null {
  const d = getMoagDir(); return d ? path.join(d, 'self-issues.jsonl') : null;
}

function logMoagSelfIssue(type: SelfIssueType, message: string, detail: string): void {
  try {
    const logPath = getSelfIssueLogPath();
    if (!logPath) { return; }
    const moagDir = path.dirname(logPath);
    if (!fs.existsSync(moagDir)) { fs.mkdirSync(moagDir, { recursive: true }); }
    const fingerprint = type + ':' + detail.substring(0, 60).replace(/\\s+/g, ' ').trim();
    if (fs.existsSync(logPath)) {
      const cutoff = Date.now() - 86400000;
      const recent = fs.readFileSync(logPath, 'utf-8').trim().split('\\n').filter(Boolean)
        .map((l: string) => { try { return JSON.parse(l) as SelfIssue; } catch { return null; } })
        .filter((e: SelfIssue | null): e is SelfIssue => !!e && new Date(e.timestamp).getTime() > cutoff);
      if (recent.some((e: SelfIssue) => e.fingerprint === fingerprint)) { return; }
    }
    const extVersion = (vscode.extensions.getExtension('moag.agent-task-player')?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
    const issue: SelfIssue = {
      id: 'si-' + Date.now(), type, message, detail, moagVersion: extVersion,
      engine: vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('defaultEngine', 'claude'),
      platform: process.platform, timestamp: new Date().toISOString(), fingerprint, filed: false,
    };
    fs.appendFileSync(logPath, JSON.stringify(issue) + '\\n', 'utf-8');
    const all = fs.readFileSync(logPath, 'utf-8').trim().split('\\n').filter(Boolean);
    if (all.length > 50) { fs.writeFileSync(logPath, all.slice(-50).join('\\n') + '\\n', 'utf-8'); }
  } catch { /* best-effort */ }
}

function readUnfiledSelfIssues(): SelfIssue[] {
  try {
    const logPath = getSelfIssueLogPath();
    if (!logPath || !fs.existsSync(logPath)) { return []; }
    return fs.readFileSync(logPath, 'utf-8').trim().split('\\n').filter(Boolean)
      .map((l: string) => { try { return JSON.parse(l) as SelfIssue; } catch { return null; } })
      .filter((e: SelfIssue | null): e is SelfIssue => !!e && !e.filed);
  } catch { return []; }
}

function markSelfIssuesFiled(ids: string[]): void {
  try {
    const logPath = getSelfIssueLogPath();
    if (!logPath || !fs.existsSync(logPath)) { return; }
    const updated = fs.readFileSync(logPath, 'utf-8').trim().split('\\n').filter(Boolean)
      .map((l: string) => {
        try { const e = JSON.parse(l) as SelfIssue; if (ids.includes(e.id)) { e.filed = true; } return JSON.stringify(e); }
        catch { return l; }
      });
    fs.writeFileSync(logPath, updated.join('\\n') + '\\n', 'utf-8');
  } catch { /* best-effort */ }
}

async function cmdReviewSelfIssues(): Promise<void> {
  const issues = readUnfiledSelfIssues();
  if (issues.length === 0) {
    vscode.window.showInformationMessage('No unfiled MOAG self-issues collected yet.');
    return;
  }
  const items = issues.map(issue => ({
    label: '$(bug) ' + issue.message,
    description: new Date(issue.timestamp).toLocaleString(),
    detail: issue.type + ' · engine: ' + issue.engine + ' · v' + issue.moagVersion,
    issue, picked: true,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: issues.length + ' MOAG issue' + (issues.length > 1 ? 's' : '') + ' collected — select to file on GitHub',
    title: 'MOAG Self-Issues',
  });
  if (!selected || selected.length === 0) { return; }
  const { execSync } = require('child_process') as typeof import('child_process');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  try { execSync('gh --version', { cwd, timeout: 5000, stdio: 'ignore' }); }
  catch { vscode.window.showWarningMessage('Install GitHub CLI (gh) to file issues. https://cli.github.com'); return; }
  const repo = vscode.workspace.getConfiguration('agentTaskPlayer').get<string>('issueRepo', '').trim() || MOAG_REPO;
  const extVersion = (vscode.extensions.getExtension('moag.agent-task-player')?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
  const filedIds: string[] = [];
  for (const item of selected) {
    const { issue } = item;
    const title = '[auto] ' + issue.message + ' [v' + issue.moagVersion + ' / ' + issue.type + ']';
    const body = [
      '## Auto-collected MOAG Issue',
      '**Type:** \`' + issue.type + '\`  **Detected:** ' + new Date(issue.timestamp).toLocaleString(),
      '', '## Environment', '| | |', '|---|---|',
      '| **MOAG** | v' + issue.moagVersion + ' |',
      '| **Engine** | ' + issue.engine + ' |',
      '| **Platform** | ' + issue.platform + ' |',
      '', '## Detail', '\`\`\`', issue.detail.substring(0, 500), '\`\`\`',
      '---', '*Auto-collected by MOAG v' + extVersion + ' self-issue monitor*',
    ].join('\\n');
    try {
      const tmpPath = path.join(require('os').tmpdir(), 'moag-si-' + Date.now() + '.md');
      fs.writeFileSync(tmpPath, body, 'utf-8');
      const safeTitle = title.replace(/"/g, '\\\\"');
      const result = execSync(
        'gh issue create --repo "' + repo + '" --title "' + safeTitle + '" --body-file "' + tmpPath + '" --label bug',
        { cwd, timeout: 20000, encoding: 'utf-8' }
      ).trim();
      filedIds.push(issue.id);
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      const url = result.split('\\n').pop() || '';
      if (url) {
        vscode.window.showInformationMessage('Filed: ' + url, 'View').then((a: string | undefined) => {
          if (a === 'View') { vscode.env.openExternal(vscode.Uri.parse(url)); }
        });
      }
    } catch (err) {
      vscode.window.showErrorMessage('Failed: ' + (err instanceof Error ? err.message.substring(0, 150) : String(err)));
    }
  }
  if (filedIds.length > 0) { markSelfIssuesFiled(filedIds); }
}

`;

const target = 'async function cmdShareRunFeedback(): Promise<void> {';
const pos = c.indexOf(target);
if (pos === -1) { console.error('MARKER NOT FOUND'); process.exit(1); }
c = c.slice(0, pos) + insert + '\n' + c.slice(pos);
fs.writeFileSync(filePath, c, 'utf-8');
console.log('Inserted at char', pos);
