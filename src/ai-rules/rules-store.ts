import * as fs from 'fs';
import * as path from 'path';

export type RuleScope = 'global' | 'workspace';

export type RuleCategory = 'code-quality' | 'security' | 'architecture' | 'testing' | 'performance' | 'custom';

export interface AiRule {
  id: string;
  name: string;
  category: RuleCategory;
  scope: RuleScope;
  text: string;
  enabled: boolean;
}

export class AiRulesStore {
  constructor(private readonly _globalStoragePath: string) {}

  private _globalPath(): string {
    return path.join(this._globalStoragePath, 'ai-rules.json');
  }

  private _workspacePath(cwd: string): string {
    return path.join(cwd, '.moag', 'rules.json');
  }

  getGlobalRules(): AiRule[] {
    try {
      return JSON.parse(fs.readFileSync(this._globalPath(), 'utf8')) as AiRule[];
    } catch {
      return [];
    }
  }

  getWorkspaceRules(cwd: string): AiRule[] {
    try {
      return JSON.parse(fs.readFileSync(this._workspacePath(cwd), 'utf8')) as AiRule[];
    } catch {
      return [];
    }
  }

  getAllRules(cwd: string): AiRule[] {
    return [...this.getGlobalRules(), ...this.getWorkspaceRules(cwd)];
  }

  getEnabledText(cwd: string): string {
    const enabled = this.getAllRules(cwd).filter(r => r.enabled);
    if (enabled.length === 0) { return ''; }
    return enabled.map(r => `### ${r.name}\n${r.text.trim()}`).join('\n\n');
  }

  private _saveGlobal(rules: AiRule[]): void {
    try {
      fs.mkdirSync(path.dirname(this._globalPath()), { recursive: true });
      fs.writeFileSync(this._globalPath(), JSON.stringify(rules, null, 2), 'utf8');
    } catch { /* no-op */ }
  }

  private _saveWorkspace(rules: AiRule[], cwd: string): void {
    try {
      fs.mkdirSync(path.join(cwd, '.moag'), { recursive: true });
      fs.writeFileSync(this._workspacePath(cwd), JSON.stringify(rules, null, 2), 'utf8');
    } catch { /* no-op */ }
  }

  addRule(rule: AiRule, cwd: string): void {
    if (rule.scope === 'global') {
      this._saveGlobal([...this.getGlobalRules(), rule]);
    } else {
      this._saveWorkspace([...this.getWorkspaceRules(cwd), rule], cwd);
    }
  }

  updateRule(rule: AiRule, cwd: string): void {
    const patch = (rules: AiRule[]) => rules.map(r => (r.id === rule.id ? rule : r));
    if (rule.scope === 'global') {
      this._saveGlobal(patch(this.getGlobalRules()));
    } else {
      this._saveWorkspace(patch(this.getWorkspaceRules(cwd)), cwd);
    }
  }

  deleteRule(id: string, scope: RuleScope, cwd: string): void {
    if (scope === 'global') {
      this._saveGlobal(this.getGlobalRules().filter(r => r.id !== id));
    } else {
      this._saveWorkspace(this.getWorkspaceRules(cwd).filter(r => r.id !== id), cwd);
    }
  }

  toggleRule(id: string, scope: RuleScope, cwd: string): void {
    const patch = (rules: AiRule[]) => rules.map(r => (r.id === id ? { ...r, enabled: !r.enabled } : r));
    if (scope === 'global') {
      this._saveGlobal(patch(this.getGlobalRules()));
    } else {
      this._saveWorkspace(patch(this.getWorkspaceRules(cwd)), cwd);
    }
  }
}
