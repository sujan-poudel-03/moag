// ─── Built-in standards profiles, one per stack ───
//
// The starting point for a greenfield project and the fallback for every field
// brownfield detection could not prove. Declarative only: required directories
// and placement rules, never a scaffolder to execute. Rule text is referenced by
// `builtInRuleIds` and never copied here.
//
// Built-ins carry no commands. A command is a promise that a tool is installed;
// only detection (a config file that proves it) or a person proposing a version may add one
// — a product owner or an admin proposes, a reviewer approves.
//
// A built-in's layout is an ASSUMPTION — the stack's most common shape, not something
// this project agreed to. It still steers a greenfield plan (the planner is told which
// directories to create), but it does not stop a release: Vite, Create React App,
// Next.js, a flat Python package and a Gradle multi-project build are all ordinary and
// all different.
//
// Nothing in a built-in blocks. Every rule here is one MOAG decides itself, and those are
// advisory by default (see DEFAULT_RULE_SEVERITY), so a built-in carries no severity
// override: what stops a release is a command — a real linter, formatter, type-checker or
// test — and a built-in carries none. A rule becomes blocking only when a product owner or
// an admin proposes the promotion and a reviewer approves it.

import { STACK_IDS, StackId } from '../server/stacks';
import { StandardsProfile } from './profile';
import { rulebookDefaults } from './rulebook';

/** Default comment policy: at most 30% comment lines once a file gains 20 or more lines. */
export const DEFAULT_MAX_COMMENT_DENSITY_PCT = 30;
export const DEFAULT_MIN_ADDED_LINES = 20;

/**
 * Phrases that mark a TRUNCATION PLACEHOLDER: a comment standing where code was left out.
 *
 * Nothing else is listed. Assistant-voice phrases ("as an AI …") are gone: any codebase that
 * handles AI messages writes those words in honest prose ("label the message as an AI
 * response"), and a phrase that fires on prose teaches people to ignore the rule. So are the
 * bare two-word labels (`// existing code`, `// remaining code`), which are also how a
 * section of a file gets a heading.
 *
 * Each phrase is matched against ONE comment — a single `//` or `#` comment, or one whole
 * block comment — never against a line that holds several comments, and never against one
 * line of a longer comment. Two forms qualify:
 *
 *   - a placeholder that is the WHOLE comment (`// rest of the code`, `# TODO: your code
 *     here`, `// (existing code remains unchanged)`). The same words inside a sentence —
 *     "put your code here if you need a custom step", "the generated code goes here:
 *     out/" — are documentation and are left alone;
 *   - a placeholder set off by an ellipsis on BOTH sides, anywhere in a comment. One
 *     ellipsis is how people trail off ("keeps compatibility with existing code...").
 *
 * The rule is advisory unless a project promotes it. A project that wants a looser match
 * adds a plain phrase to its profile: proposed by a product owner or an admin, approved by
 * a reviewer, like every other change to the standards.
 */
const DEFAULT_BANNED_PHRASES = [
  // The whole comment and nothing else.
  '// rest of the code',
  '// rest of code',
  '// rest of the file',
  '// rest of the implementation',
  '// rest of the code goes here',
  '// rest of the code here',
  '// rest of the code remains',
  '// rest of the code unchanged',
  '// rest of the code remains unchanged',
  '// rest of the code remains the same',
  '// existing code here',
  '// existing code remains',
  '// existing code remains unchanged',
  '// existing code remains the same',
  '// implementation goes here',
  '// your implementation here',
  '// your code here',
  '// your code goes here',
  '// code goes here',
  // Between two ellipses, anywhere in a comment.
  '... rest of the code ...',
  '... existing code ...',
  '... remaining code ...',
];

/**
 * Top-level entries any repository may hold regardless of stack: documentation,
 * licence and ownership files, container and CI configuration (`docker-compose.yml`,
 * `mkdocs.yml`, `netlify.toml`) and lock files. On a greenfield repository every
 * top-level entry is new, so anything an ordinary scaffold creates has to be here
 * or in the stack's own list — otherwise a correct first run ends in `gaps`.
 */
const COMMON_TOP_LEVEL = [
  'docs', 'scripts', '.*', '*.md', 'LICENSE*', 'LICENCE*', 'NOTICE*', 'CHANGELOG*', 'CODEOWNERS',
  'Dockerfile*', 'Makefile', '*.yml', '*.yaml', '*.lock', '*.toml',
];

/** Where a Node/TypeScript project keeps code, across the scaffolds people actually start from. */
const NODE_CODE_DIRS = [
  'src', 'lib', 'app', 'pages', 'components', 'hooks', 'server', 'client', 'api', 'functions',
  'test', 'tests', '__tests__', 'e2e', 'packages', 'apps',
];

function comments(): StandardsProfile['comments'] {
  return {
    maxDensityPct: DEFAULT_MAX_COMMENT_DENSITY_PCT,
    minAddedLines: DEFAULT_MIN_ADDED_LINES,
    forbidCommentedOutCode: true,
    bannedPhrases: [...DEFAULT_BANNED_PHRASES],
  };
}

function base(stack: StackId): StandardsProfile {
  return {
    stackTemplateId: stack,
    repoState: 'greenfield',
    structure: { requiredDirs: [], allowedTopLevel: [], placement: [] },
    frontend: { componentKit: '', styleSource: '', rawPatterns: [] },
    backend: { layers: [], forbiddenImports: [], importAliases: [] },
    naming: { files: [], notes: '' },
    comments: comments(),
    testing: { runner: '', fileGlobs: [], notes: '' },
    commands: [],
    builtInRuleIds: [],
    freeText: '',
    // The Project Rulebook: what MOAG checks and the guidance agents follow (see rulebook.ts).
    ...rulebookDefaults(stack),
  };
}

export const BUILT_IN_PROFILES: Record<StackId, StandardsProfile> = {
  'node-ts': {
    ...base('node-ts'),
    structure: {
      requiredDirs: ['src'],
      // Vite keeps index.html at the root; Next.js keeps app/ or pages/ there; both use public/.
      allowedTopLevel: [
        ...NODE_CODE_DIRS, 'bin', 'public', 'static', 'assets', 'styles', 'prisma', 'config', 'types',
        ...COMMON_TOP_LEVEL, '*.json', '*.js', '*.cjs', '*.mjs', '*.ts', '*.mts', '*.html',
      ],
      placement: [
        { id: 'tests', files: '**/*.test.ts', under: NODE_CODE_DIRS },
        { id: 'specs', files: '**/*.spec.ts', under: NODE_CODE_DIRS },
      ],
    },
    naming: {
      files: [{ globs: ['src/**/*.ts'], style: 'kebab-case' }],
      notes: 'Test files sit beside or mirror the module they cover and end in .test.ts',
    },
    testing: {
      runner: 'npm test',
      fileGlobs: ['**/*.test.ts', '**/*.spec.ts'],
      notes: 'Every new module ships with a test file covering its failure paths',
    },
    builtInRuleIds: ['builtin-clean-code', 'builtin-self-documenting', 'builtin-tdd', 'builtin-error-handling'],
  },
  'python': {
    ...base('python'),
    structure: {
      requiredDirs: ['src', 'tests'],
      allowedTopLevel: ['src', 'app', 'tests', 'test', 'examples', ...COMMON_TOP_LEVEL, '*.txt', '*.cfg', '*.ini', '*.py', '*.in', 'Pipfile'],
      // Tests sit in tests/ or beside the package they cover (src/app/tests/test_x.py), never at the root.
      placement: [{ id: 'tests', files: '**/test_*.py', under: ['tests', 'src', 'app'] }],
    },
    naming: {
      files: [{ globs: ['**/*.py'], style: 'snake_case' }],
      notes: 'Modules and packages are lowercase with underscores',
    },
    testing: {
      runner: 'pytest',
      fileGlobs: ['**/test_*.py'],
      notes: 'Every new module ships with a test module, under tests/ or beside the package',
    },
    builtInRuleIds: ['builtin-clean-code', 'builtin-tdd', 'builtin-error-handling'],
  },
  'go': {
    ...base('go'),
    structure: {
      requiredDirs: ['cmd', 'internal'],
      allowedTopLevel: [
        'cmd', 'internal', 'pkg', 'api', 'vendor', 'testdata', 'examples', 'tools', 'web', 'configs', 'build', 'test',
        ...COMMON_TOP_LEVEL, 'go.mod', 'go.sum', 'go.work', 'go.work.sum', '*.go',
      ],
      // A program's entry point is cmd/<name>/main.go or a single main.go at the root; generators
      // and examples have their own. A main.go inside a library package is the misplaced one.
      placement: [{ id: 'entrypoints', files: '**/main.go', under: ['cmd', 'main.go', 'tools', 'internal/tools', 'examples', 'scripts'] }],
    },
    backend: {
      layers: [
        { name: 'cmd', globs: ['cmd/**'] },
        { name: 'internal', globs: ['internal/**'] },
      ],
      forbiddenImports: [{ from: 'internal', to: 'cmd' }],
      importAliases: [],
    },
    naming: {
      files: [{ globs: ['**/*.go'], style: 'snake_case' }],
      notes: 'Package directories are short, lowercase, single words',
    },
    testing: {
      runner: 'go test ./...',
      fileGlobs: ['**/*_test.go'],
      notes: 'Tests live beside the package they cover',
    },
    builtInRuleIds: ['builtin-clean-code', 'builtin-self-documenting', 'builtin-tdd', 'builtin-error-handling'],
  },
  'java': {
    ...base('java'),
    structure: {
      requiredDirs: ['src/main/java', 'src/test/java'],
      allowedTopLevel: [
        'src', 'app', 'lib', 'gradle', 'config', 'buildSrc', ...COMMON_TOP_LEVEL,
        'pom.xml', 'build.gradle*', 'settings.gradle*', 'gradle.properties', 'gradlew*', 'mvnw*', 'lombok.config',
      ],
      placement: [
        { id: 'tests', files: '**/*Test.java', under: ['src/test/java'] },
        { id: 'sources', files: '**/*.java', under: ['src/main/java', 'src/test/java', 'buildSrc'] },
      ],
    },
    naming: {
      files: [{ globs: ['**/*.java'], style: 'PascalCase' }],
      notes: 'One public type per file, named after the type',
    },
    testing: {
      runner: 'JUnit',
      fileGlobs: ['src/test/java/**/*Test.java'],
      notes: 'Every new class ships with a test class in the mirrored package',
    },
    builtInRuleIds: ['builtin-solid', 'builtin-clean-code', 'builtin-self-documenting', 'builtin-tdd'],
  },
  'dotnet': {
    ...base('dotnet'),
    structure: {
      requiredDirs: ['src', 'tests'],
      // Globs are case-sensitive, and the tooling writes both `nuget.config` and `NuGet.Config`.
      allowedTopLevel: ['src', 'tests', 'test', ...COMMON_TOP_LEVEL, '*.sln', '*.slnx', '*.props', '*.targets', '*.json', '*.config', '*.Config'],
      placement: [{ id: 'tests', files: '**/*Tests.cs', under: ['tests'] }],
    },
    naming: {
      files: [{ globs: ['**/*.cs'], style: 'PascalCase' }],
      notes: 'One public type per file, named after the type',
    },
    testing: {
      runner: 'dotnet test',
      fileGlobs: ['tests/**/*Tests.cs'],
      notes: 'Every new class ships with a test class in the matching tests project',
    },
    builtInRuleIds: ['builtin-solid', 'builtin-clean-code', 'builtin-self-documenting', 'builtin-tdd'],
  },
  'static-web': {
    ...base('static-web'),
    structure: {
      requiredDirs: ['css', 'js'],
      allowedTopLevel: [
        'css', 'js', 'assets', 'img', 'images', 'fonts', 'tests', 'src', 'public', ...COMMON_TOP_LEVEL,
        '*.html', '*.css', '*.js', '*.json', '*.txt', '*.xml', '*.ico', '*.svg', '*.png', '*.webmanifest',
        'CNAME', '_redirects', '_headers',
      ],
      placement: [
        { id: 'stylesheets', files: '**/*.css', under: ['css'] },
        // A service worker only controls the pages below it, so it has to sit at the root.
        { id: 'scripts', files: '**/*.js', under: ['js', 'tests', 'sw.js', 'service-worker.js'] },
      ],
    },
    frontend: {
      componentKit: '',
      styleSource: 'css/',
      rawPatterns: [
        {
          id: 'no-inline-style',
          kind: 'builtin',
          value: 'inline-style',
          globs: ['**/*.html'],
          message: 'Keep styling in a stylesheet; do not use inline style attributes',
        },
      ],
    },
    naming: {
      files: [{ globs: ['**/*.html', '**/*.css', '**/*.js'], style: 'kebab-case' }],
      notes: 'Asset file names are lowercase',
    },
    testing: {
      runner: '',
      fileGlobs: ['tests/**/*.test.js'],
      notes: 'Pages must load with no console errors',
    },
    builtInRuleIds: ['builtin-clean-code', 'builtin-self-documenting'],
  },
  // Nothing is known about an unlisted stack, so only the comment policy applies.
  'other': base('other'),
};

/** A deep copy of the stack's built-in profile, safe for the caller to mutate. */
export function builtInProfile(stack: StackId): StandardsProfile {
  return JSON.parse(JSON.stringify(BUILT_IN_PROFILES[stack])) as StandardsProfile;
}

/** Every stack that has a built-in profile — always exactly {@link STACK_IDS}. */
export const BUILT_IN_PROFILE_STACKS: readonly StackId[] = STACK_IDS;
