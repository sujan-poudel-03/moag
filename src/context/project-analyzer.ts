// ─── Project Analyzer — detects project type, stack, and gaps ───

import * as fs from 'fs';
import * as path from 'path';

export interface ProjectAnalysis {
  framework: string | null;
  language: string;
  packageManager: string | null;
  hasTests: boolean;
  testFramework: string | null;
  hasLinter: boolean;
  hasCI: boolean;
  hasDocs: boolean;
  missingFiles: string[];
  suggestedImprovements: string[];
  fileCount: number;
  topLevelDirs: string[];
}

const EXPECTED_FILES = ['.gitignore', 'LICENSE', 'README.md'];

export function analyzeProject(cwd: string): ProjectAnalysis {
  const result: ProjectAnalysis = {
    framework: null,
    language: 'unknown',
    packageManager: null,
    hasTests: false,
    testFramework: null,
    hasLinter: false,
    hasCI: false,
    hasDocs: false,
    missingFiles: [],
    suggestedImprovements: [],
    fileCount: 0,
    topLevelDirs: [],
  };

  // Scan top-level directory
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return result;
  }

  const fileNames = new Set<string>();
  const dirs: string[] = [];
  for (const entry of entries) {
    fileNames.add(entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      dirs.push(entry.name);
    }
    if (entry.isFile()) { result.fileCount++; }
  }
  result.topLevelDirs = dirs;

  // Check for missing expected files
  for (const expected of EXPECTED_FILES) {
    if (!fileNames.has(expected) && !fileNames.has(expected.toLowerCase())) {
      result.missingFiles.push(expected);
    }
  }

  // Detect language and package manager
  if (fileNames.has('package.json')) {
    result.packageManager = detectNodePM(cwd, fileNames);
    const pkg = readJson(path.join(cwd, 'package.json'));
    if (pkg) {
      analyzePackageJson(pkg, result);
    }
  }

  if (fileNames.has('tsconfig.json') || fileNames.has('tsconfig.base.json')) {
    result.language = 'typescript';
  } else if (result.packageManager && result.language === 'unknown') {
    result.language = 'javascript';
  }

  // Python
  if (fileNames.has('pyproject.toml') || fileNames.has('setup.py') || fileNames.has('requirements.txt')) {
    result.language = 'python';
    result.packageManager = fileNames.has('pyproject.toml') ? 'pip/poetry' : 'pip';
    if (fileNames.has('pytest.ini') || fileNames.has('conftest.py') || dirs.includes('tests') || dirs.includes('test')) {
      result.hasTests = true;
      result.testFramework = 'pytest';
    }
  }

  // Go
  if (fileNames.has('go.mod')) {
    result.language = 'go';
    result.packageManager = 'go modules';
    if (hasFilePattern(cwd, '_test.go')) { result.hasTests = true; result.testFramework = 'go test'; }
  }

  // Rust
  if (fileNames.has('Cargo.toml')) {
    result.language = 'rust';
    result.packageManager = 'cargo';
    result.hasTests = true; // Rust has built-in test support
    result.testFramework = 'cargo test';
  }

  // CI detection
  result.hasCI = fileNames.has('.github') || fileNames.has('.gitlab-ci.yml') || fileNames.has('.circleci') || fileNames.has('Jenkinsfile');

  // Linter detection
  result.hasLinter = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs', '.prettierrc', '.prettierrc.json', 'biome.json']
    .some(f => fileNames.has(f));

  // Docs detection
  result.hasDocs = fileNames.has('docs') || fileNames.has('documentation') || (fileNames.has('README.md') && !result.missingFiles.includes('README.md'));

  // Test directory detection (generic)
  if (!result.hasTests) {
    result.hasTests = dirs.includes('test') || dirs.includes('tests') || dirs.includes('__tests__') || dirs.includes('spec');
  }

  // Generate suggestions
  generateSuggestions(result);

  return result;
}

function detectNodePM(cwd: string, fileNames: Set<string>): string {
  if (fileNames.has('pnpm-lock.yaml')) { return 'pnpm'; }
  if (fileNames.has('yarn.lock')) { return 'yarn'; }
  if (fileNames.has('bun.lockb')) { return 'bun'; }
  return 'npm';
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function analyzePackageJson(pkg: Record<string, unknown>, result: ProjectAnalysis): void {
  const allDeps = {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {}),
  };

  // Framework detection
  if (allDeps['next']) { result.framework = 'next'; }
  else if (allDeps['nuxt']) { result.framework = 'nuxt'; }
  else if (allDeps['react']) { result.framework = 'react'; }
  else if (allDeps['vue']) { result.framework = 'vue'; }
  else if (allDeps['@angular/core']) { result.framework = 'angular'; }
  else if (allDeps['svelte']) { result.framework = 'svelte'; }
  else if (allDeps['express']) { result.framework = 'express'; }
  else if (allDeps['fastify']) { result.framework = 'fastify'; }
  else if (allDeps['hono']) { result.framework = 'hono'; }
  else if (allDeps['koa']) { result.framework = 'koa'; }
  else if (allDeps['electron']) { result.framework = 'electron'; }

  // Test detection
  if (allDeps['jest'] || allDeps['@jest/core']) { result.hasTests = true; result.testFramework = 'jest'; }
  else if (allDeps['vitest']) { result.hasTests = true; result.testFramework = 'vitest'; }
  else if (allDeps['mocha']) { result.hasTests = true; result.testFramework = 'mocha'; }
  else if (allDeps['ava']) { result.hasTests = true; result.testFramework = 'ava'; }

  // Test script detection (backup)
  const scripts = pkg.scripts as Record<string, string> | undefined;
  if (scripts?.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
    result.hasTests = true;
  }

  // Linter from deps
  if (allDeps['eslint'] || allDeps['@biomejs/biome'] || allDeps['prettier']) {
    result.hasLinter = true;
  }

  // TypeScript from deps
  if (allDeps['typescript']) {
    result.language = 'typescript';
  }
}

function hasFilePattern(cwd: string, suffix: string): boolean {
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    return entries.some(e => e.isFile() && e.name.endsWith(suffix));
  } catch {
    return false;
  }
}

function generateSuggestions(result: ProjectAnalysis): void {
  if (!result.hasTests) {
    result.suggestedImprovements.push('Add tests — no test framework detected');
  }
  if (!result.hasLinter) {
    result.suggestedImprovements.push('Add a linter (ESLint, Biome) for code quality');
  }
  if (!result.hasCI) {
    result.suggestedImprovements.push('Add CI/CD pipeline (GitHub Actions)');
  }
  if (result.missingFiles.includes('.gitignore')) {
    result.suggestedImprovements.push('Add .gitignore');
  }
  if (result.missingFiles.includes('LICENSE')) {
    result.suggestedImprovements.push('Add a LICENSE file');
  }
  if (result.missingFiles.includes('README.md')) {
    result.suggestedImprovements.push('Add README.md documentation');
  }
  if (result.language === 'javascript' && result.packageManager) {
    result.suggestedImprovements.push('Consider migrating to TypeScript for type safety');
  }
}

/** Format analysis as a concise text block for AI prompt injection */
export function formatAnalysis(analysis: ProjectAnalysis): string {
  const lines: string[] = [];
  lines.push(`Language: ${analysis.language}`);
  if (analysis.framework) { lines.push(`Framework: ${analysis.framework}`); }
  if (analysis.packageManager) { lines.push(`Package manager: ${analysis.packageManager}`); }
  lines.push(`Has tests: ${analysis.hasTests}${analysis.testFramework ? ' (' + analysis.testFramework + ')' : ''}`);
  lines.push(`Has linter: ${analysis.hasLinter}`);
  lines.push(`Has CI: ${analysis.hasCI}`);
  lines.push(`Files: ${analysis.fileCount}, Directories: ${analysis.topLevelDirs.join(', ') || 'none'}`);
  if (analysis.missingFiles.length > 0) {
    lines.push(`Missing: ${analysis.missingFiles.join(', ')}`);
  }
  if (analysis.suggestedImprovements.length > 0) {
    lines.push(`Improvements needed:`);
    for (const s of analysis.suggestedImprovements) {
      lines.push(`  - ${s}`);
    }
  }
  return lines.join('\n');
}
