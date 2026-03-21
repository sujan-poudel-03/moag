// ─── Prompt Library — reusable prompt snippets that auto-inject into task prompts ───

import * as vscode from 'vscode';

export interface PromptSnippet {
  id: string;
  name: string;
  category: string;
  text: string;
  autoInject: boolean;
}

const BUILT_IN_SNIPPETS: PromptSnippet[] = [
  {
    id: 'builtin-typescript-strict',
    name: 'typescript-strict',
    category: 'Language',
    text: 'Use TypeScript with strict mode. Prefer interfaces over types. Use proper error handling with typed errors.',
    autoInject: false,
  },
  {
    id: 'builtin-test-driven',
    name: 'test-driven',
    category: 'Methodology',
    text: 'Write tests first, then implement. Ensure all tests pass before completing.',
    autoInject: false,
  },
  {
    id: 'builtin-git-commits',
    name: 'git-commits',
    category: 'Workflow',
    text: 'Make atomic git commits after each logical change with descriptive messages.',
    autoInject: false,
  },
  {
    id: 'builtin-no-overwrite',
    name: 'no-overwrite',
    category: 'Safety',
    text: 'Do not delete or overwrite existing files unless explicitly instructed. Prefer editing over creating.',
    autoInject: false,
  },
  {
    id: 'builtin-security-first',
    name: 'security-first',
    category: 'Safety',
    text: 'Validate all inputs. Sanitize user data. Use parameterized queries. Never log secrets.',
    autoInject: false,
  },
  {
    id: 'builtin-performance',
    name: 'performance',
    category: 'Quality',
    text: 'Optimize for performance. Use lazy loading, memoization, and efficient algorithms.',
    autoInject: false,
  },
];

const STORAGE_KEY = 'agentTaskPlayer.promptSnippets';
const OVERRIDES_KEY = 'agentTaskPlayer.promptSnippetOverrides';

export class PromptLibraryStore {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly state: vscode.Memento) {}

  /** Get all snippets (built-in with overrides applied + user-created) */
  getAll(): PromptSnippet[] {
    const overrides = this.state.get<Record<string, boolean>>(OVERRIDES_KEY, {});
    const builtIns = BUILT_IN_SNIPPETS.map(s => ({
      ...s,
      autoInject: overrides[s.id] !== undefined ? overrides[s.id] : s.autoInject,
    }));
    const userSnippets = this.state.get<PromptSnippet[]>(STORAGE_KEY, []);
    return [...builtIns, ...userSnippets];
  }

  /** Get only snippets with autoInject enabled */
  getAutoInject(): PromptSnippet[] {
    return this.getAll().filter(s => s.autoInject);
  }

  /** Toggle autoInject for a snippet by ID */
  async toggleAutoInject(id: string): Promise<void> {
    // Check if it's a user snippet
    const userSnippets = this.state.get<PromptSnippet[]>(STORAGE_KEY, []);
    const userIdx = userSnippets.findIndex(s => s.id === id);
    if (userIdx >= 0) {
      userSnippets[userIdx].autoInject = !userSnippets[userIdx].autoInject;
      await this.state.update(STORAGE_KEY, userSnippets);
    } else {
      // Built-in: store override
      const overrides = this.state.get<Record<string, boolean>>(OVERRIDES_KEY, {});
      const builtIn = BUILT_IN_SNIPPETS.find(s => s.id === id);
      if (builtIn) {
        const currentValue = overrides[id] !== undefined ? overrides[id] : builtIn.autoInject;
        overrides[id] = !currentValue;
        await this.state.update(OVERRIDES_KEY, overrides);
      }
    }
    this._onDidChange.fire();
  }

  /** Add a new user snippet */
  async add(snippet: PromptSnippet): Promise<void> {
    const snippets = this.state.get<PromptSnippet[]>(STORAGE_KEY, []);
    snippets.push(snippet);
    await this.state.update(STORAGE_KEY, snippets);
    this._onDidChange.fire();
  }

  /** Remove a user snippet by ID */
  async remove(id: string): Promise<void> {
    const snippets = this.state.get<PromptSnippet[]>(STORAGE_KEY, []).filter(s => s.id !== id);
    await this.state.update(STORAGE_KEY, snippets);
    this._onDidChange.fire();
  }
}
