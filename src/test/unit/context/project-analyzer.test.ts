import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { analyzeProject, formatAnalysis, ProjectAnalysis } from '../../../context/project-analyzer';

// ─── Helpers ───

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moag-analyzer-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── Tests ───

describe('project-analyzer', () => {

  describe('analyzeProject — MOAG-like project (TS + mocha)', () => {
    let dir: string;

    before(() => {
      dir = makeTmpDir();
      // Simulate MOAG project structure
      writeJson(path.join(dir, 'package.json'), {
        devDependencies: {
          typescript: '^5.3.0',
          mocha: '^10.7.0',
          eslint: '^8.56.0',
        },
        scripts: { test: 'mocha' },
      });
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
      fs.writeFileSync(path.join(dir, '.eslintrc.json'), '{}');
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules');
      fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT');
      fs.writeFileSync(path.join(dir, 'README.md'), '# MOAG');
      fs.mkdirSync(path.join(dir, '.github'));
      fs.mkdirSync(path.join(dir, 'src'));
      fs.mkdirSync(path.join(dir, 'docs'));
    });

    after(() => cleanup(dir));

    it('detects TypeScript language', () => {
      const result = analyzeProject(dir);
      assert.equal(result.language, 'typescript');
    });

    it('detects mocha test framework', () => {
      const result = analyzeProject(dir);
      assert.equal(result.hasTests, true);
      assert.equal(result.testFramework, 'mocha');
    });

    it('detects npm as package manager', () => {
      const result = analyzeProject(dir);
      assert.equal(result.packageManager, 'npm');
    });

    it('detects linter', () => {
      const result = analyzeProject(dir);
      assert.equal(result.hasLinter, true);
    });

    it('detects CI', () => {
      const result = analyzeProject(dir);
      assert.equal(result.hasCI, true);
    });

    it('detects docs', () => {
      const result = analyzeProject(dir);
      assert.equal(result.hasDocs, true);
    });

    it('finds no missing files', () => {
      const result = analyzeProject(dir);
      assert.deepEqual(result.missingFiles, []);
    });

    it('lists top-level dirs (excluding hidden and node_modules)', () => {
      const result = analyzeProject(dir);
      assert.ok(result.topLevelDirs.includes('src'));
      assert.ok(result.topLevelDirs.includes('docs'));
      assert.ok(!result.topLevelDirs.includes('.github'));
    });
  });

  describe('analyzeProject — bare directory (missing files)', () => {
    let dir: string;

    before(() => {
      dir = makeTmpDir();
      // Only create a single file — no .gitignore, LICENSE, or README
      fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("hi")');
    });

    after(() => cleanup(dir));

    it('detects missing .gitignore, LICENSE, README.md', () => {
      const result = analyzeProject(dir);
      assert.ok(result.missingFiles.includes('.gitignore'));
      assert.ok(result.missingFiles.includes('LICENSE'));
      assert.ok(result.missingFiles.includes('README.md'));
    });

    it('language is unknown without package.json', () => {
      const result = analyzeProject(dir);
      assert.equal(result.language, 'unknown');
    });

    it('has no tests, linter, or CI', () => {
      const result = analyzeProject(dir);
      assert.equal(result.hasTests, false);
      assert.equal(result.hasLinter, false);
      assert.equal(result.hasCI, false);
    });

    it('counts files', () => {
      const result = analyzeProject(dir);
      assert.equal(result.fileCount, 1);
    });
  });

  describe('analyzeProject — React project from deps', () => {
    let dir: string;

    before(() => {
      dir = makeTmpDir();
      writeJson(path.join(dir, 'package.json'), {
        dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
        devDependencies: { jest: '^29.0.0' },
        scripts: { test: 'jest' },
      });
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules');
      fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT');
      fs.writeFileSync(path.join(dir, 'README.md'), '# App');
    });

    after(() => cleanup(dir));

    it('detects react framework', () => {
      const result = analyzeProject(dir);
      assert.equal(result.framework, 'react');
    });

    it('detects jest test framework', () => {
      const result = analyzeProject(dir);
      assert.equal(result.hasTests, true);
      assert.equal(result.testFramework, 'jest');
    });

    it('detects javascript language (no tsconfig)', () => {
      const result = analyzeProject(dir);
      assert.equal(result.language, 'javascript');
    });

    it('suggests TypeScript migration', () => {
      const result = analyzeProject(dir);
      assert.ok(result.suggestedImprovements.some(s => s.includes('TypeScript')));
    });
  });

  describe('analyzeProject — empty / nonexistent directory', () => {
    it('returns defaults for empty directory', () => {
      const dir = makeTmpDir();
      try {
        const result = analyzeProject(dir);
        assert.equal(result.language, 'unknown');
        assert.equal(result.framework, null);
        assert.equal(result.packageManager, null);
        assert.equal(result.fileCount, 0);
        assert.deepEqual(result.topLevelDirs, []);
      } finally {
        cleanup(dir);
      }
    });

    it('returns defaults for nonexistent path', () => {
      const result = analyzeProject('/nonexistent/path/that/does/not/exist');
      assert.equal(result.language, 'unknown');
      assert.equal(result.framework, null);
      assert.equal(result.fileCount, 0);
    });

    it('handles empty temp directory without crashing', () => {
      const dir = path.join(os.tmpdir(), `moag-empty-test-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(dir);
      try {
        const result = analyzeProject(dir);
        assert.equal(result.language, 'unknown');
        assert.equal(result.hasTests, false);
      } finally {
        cleanup(dir);
      }
    });
  });

  describe('generateSuggestions', () => {
    it('suggests adding tests when none detected', () => {
      const dir = makeTmpDir();
      try {
        writeJson(path.join(dir, 'package.json'), {
          dependencies: {},
          scripts: { test: 'echo "Error: no test specified" && exit 1' },
        });
        fs.writeFileSync(path.join(dir, '.gitignore'), '');
        fs.writeFileSync(path.join(dir, 'LICENSE'), '');
        fs.writeFileSync(path.join(dir, 'README.md'), '');
        const result = analyzeProject(dir);
        assert.ok(result.suggestedImprovements.some(s => s.includes('Add tests')));
      } finally {
        cleanup(dir);
      }
    });

    it('suggests adding CI when none detected', () => {
      const dir = makeTmpDir();
      try {
        fs.writeFileSync(path.join(dir, '.gitignore'), '');
        fs.writeFileSync(path.join(dir, 'LICENSE'), '');
        fs.writeFileSync(path.join(dir, 'README.md'), '');
        const result = analyzeProject(dir);
        assert.ok(result.suggestedImprovements.some(s => s.includes('CI')));
      } finally {
        cleanup(dir);
      }
    });

    it('suggests adding LICENSE when missing', () => {
      const dir = makeTmpDir();
      try {
        const result = analyzeProject(dir);
        assert.ok(result.suggestedImprovements.some(s => s.includes('LICENSE')));
      } finally {
        cleanup(dir);
      }
    });
  });

  describe('analyzeProject — real MOAG project (process.cwd())', () => {
    it('detects TypeScript language', () => {
      const result = analyzeProject(process.cwd());
      assert.equal(result.language, 'typescript');
    });

    it('detects hasTests is true', () => {
      const result = analyzeProject(process.cwd());
      assert.equal(result.hasTests, true);
    });

    it('detects mocha test framework', () => {
      const result = analyzeProject(process.cwd());
      assert.equal(result.testFramework, 'mocha');
    });

    it('detects npm as package manager', () => {
      const result = analyzeProject(process.cwd());
      assert.equal(result.packageManager, 'npm');
    });
  });

  describe('formatAnalysis', () => {
    it('includes language and key fields', () => {
      const analysis: ProjectAnalysis = {
        framework: 'react',
        language: 'typescript',
        packageManager: 'npm',
        hasTests: true,
        testFramework: 'mocha',
        hasLinter: true,
        hasCI: true,
        hasDocs: true,
        missingFiles: [],
        suggestedImprovements: [],
        fileCount: 42,
        topLevelDirs: ['src', 'docs'],
      };
      const text = formatAnalysis(analysis);
      assert.ok(text.includes('Language: typescript'));
      assert.ok(text.includes('Framework: react'));
      assert.ok(text.includes('Package manager: npm'));
      assert.ok(text.includes('Has tests: true (mocha)'));
      assert.ok(text.includes('Has linter: true'));
      assert.ok(text.includes('Has CI: true'));
      assert.ok(text.includes('Files: 42'));
      assert.ok(text.includes('src, docs'));
    });

    it('includes missing files when present', () => {
      const analysis: ProjectAnalysis = {
        framework: null,
        language: 'unknown',
        packageManager: null,
        hasTests: false,
        testFramework: null,
        hasLinter: false,
        hasCI: false,
        hasDocs: false,
        missingFiles: ['LICENSE', 'README.md'],
        suggestedImprovements: ['Add a LICENSE file'],
        fileCount: 0,
        topLevelDirs: [],
      };
      const text = formatAnalysis(analysis);
      assert.ok(text.includes('Missing: LICENSE, README.md'));
      assert.ok(text.includes('Improvements needed:'));
      assert.ok(text.includes('Add a LICENSE file'));
      // No framework line when null
      assert.ok(!text.includes('Framework:'));
    });

    it('formats python/django project with pytest', () => {
      const analysis: ProjectAnalysis = {
        framework: 'django',
        language: 'python',
        packageManager: 'pip',
        hasTests: true,
        testFramework: 'pytest',
        hasLinter: false,
        hasCI: false,
        hasDocs: false,
        missingFiles: [],
        suggestedImprovements: [],
        fileCount: 10,
        topLevelDirs: ['app'],
      };
      const text = formatAnalysis(analysis);
      assert.ok(text.includes('Language: python'));
      assert.ok(text.includes('Framework: django'));
      assert.ok(text.includes('Has tests: true'));
    });

    it('omits framework line when null', () => {
      const analysis: ProjectAnalysis = {
        framework: null,
        language: 'go',
        packageManager: 'go modules',
        hasTests: true,
        testFramework: 'go test',
        hasLinter: false,
        hasCI: false,
        hasDocs: false,
        missingFiles: [],
        suggestedImprovements: [],
        fileCount: 5,
        topLevelDirs: ['cmd'],
      };
      const text = formatAnalysis(analysis);
      assert.ok(!text.includes('Framework:'));
      assert.ok(text.includes('Language: go'));
    });
  });
});
