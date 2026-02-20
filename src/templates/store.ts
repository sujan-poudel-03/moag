// ─── Template Store — manages reusable task templates ───

import * as vscode from 'vscode';

/** A reusable task template */
export interface TaskTemplate {
  id: string;
  name: string;
  prompt: string;
  engine?: string;
  files?: string[];
  verifyCommand?: string;
  retryCount?: number;
  /** Category for grouping templates */
  category: string;
}

const STORAGE_KEY = 'agentTaskPlayer.templates';

/** Default built-in templates for common development tasks */
const BUILT_IN_TEMPLATES: TaskTemplate[] = [
  {
    id: 'builtin-setup-project',
    name: 'Initialize project structure',
    prompt: 'Set up the project directory structure with best practices for this tech stack. Create necessary config files.',
    category: 'Setup',
  },
  {
    id: 'builtin-install-deps',
    name: 'Install dependencies',
    prompt: 'Review the project and install all required dependencies. Set up package manager config if needed.',
    category: 'Setup',
  },
  {
    id: 'builtin-rest-api',
    name: 'Create REST API endpoint',
    prompt: 'Create a REST API endpoint with proper request validation, error handling, and response formatting.',
    category: 'Feature',
  },
  {
    id: 'builtin-auth',
    name: 'Add authentication',
    prompt: 'Implement user authentication with login, signup, and token-based session management.',
    category: 'Feature',
  },
  {
    id: 'builtin-database-model',
    name: 'Create database model',
    prompt: 'Create a database model/schema with proper types, validation, indexes, and migration.',
    category: 'Feature',
  },
  {
    id: 'builtin-unit-tests',
    name: 'Write unit tests',
    prompt: 'Write comprehensive unit tests for the recent changes. Cover edge cases and error scenarios.',
    verifyCommand: 'npm test',
    category: 'Testing',
  },
  {
    id: 'builtin-integration-tests',
    name: 'Write integration tests',
    prompt: 'Write integration tests that verify the components work together correctly.',
    verifyCommand: 'npm test',
    category: 'Testing',
  },
  {
    id: 'builtin-fix-bug',
    name: 'Fix bug',
    prompt: 'Investigate and fix the reported bug. Add a regression test to prevent recurrence.',
    category: 'Bugfix',
  },
  {
    id: 'builtin-refactor',
    name: 'Refactor code',
    prompt: 'Refactor the specified code for better readability, maintainability, and performance.',
    category: 'Refactor',
  },
  {
    id: 'builtin-add-docs',
    name: 'Add documentation',
    prompt: 'Add comprehensive documentation including README updates, inline comments for complex logic, and API documentation.',
    category: 'Docs',
  },
];

export class TemplateStore {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly state: vscode.Memento) {}

  /** Get all templates (built-in + user-created) */
  getAll(): TaskTemplate[] {
    const userTemplates = this.state.get<TaskTemplate[]>(STORAGE_KEY, []);
    return [...BUILT_IN_TEMPLATES, ...userTemplates];
  }

  /** Get only user-created templates */
  getUserTemplates(): TaskTemplate[] {
    return this.state.get<TaskTemplate[]>(STORAGE_KEY, []);
  }

  /** Get unique categories */
  getCategories(): string[] {
    const all = this.getAll();
    return [...new Set(all.map(t => t.category))].sort();
  }

  /** Add a new user template */
  async add(template: TaskTemplate): Promise<void> {
    const templates = this.getUserTemplates();
    templates.push(template);
    await this.state.update(STORAGE_KEY, templates);
    this._onDidChange.fire();
  }

  /** Remove a user template by ID */
  async remove(id: string): Promise<void> {
    const templates = this.getUserTemplates().filter(t => t.id !== id);
    await this.state.update(STORAGE_KEY, templates);
    this._onDidChange.fire();
  }

  /** Clear all user templates */
  async clear(): Promise<void> {
    await this.state.update(STORAGE_KEY, []);
    this._onDidChange.fire();
  }
}