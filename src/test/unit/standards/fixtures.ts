// ─── Shared fixtures for the standards tests ───

import { PROVENANCE_FIELDS, StandardsProfile, StandardsProvenance, StandardsRuleId } from '../../../standards/profile';
import type { StandardsTotals } from '../../../standards/checker';

/** A complete provenance record with every area assumed. */
export function sampleProvenance(): StandardsProvenance {
  return Object.fromEntries(
    PROVENANCE_FIELDS.map((f) => [f, { tag: 'assumed', evidence: 'node-ts default' }]),
  ) as StandardsProvenance;
}

/** A valid, fully populated profile. Every test mutates a fresh copy. */
export function sampleProfile(): StandardsProfile {
  return {
    stackTemplateId: 'node-ts',
    repoState: 'brownfield',
    structure: {
      requiredDirs: ['src', 'src/test'],
      allowedTopLevel: ['src', 'docs', 'package.json'],
      placement: [{ id: 'components', files: '**/*.tsx', under: ['src/ui'] }],
    },
    frontend: {
      componentKit: 'none',
      styleSource: 'src/ui/design-system.ts',
      rawPatterns: [
        { id: 'no-hex', kind: 'builtin', value: 'hex-color', globs: ['src/ui/**'], message: 'Use design tokens, not hex colours' },
      ],
    },
    backend: {
      layers: [{ name: 'models', globs: ['src/models/**'] }, { name: 'ui', globs: ['src/ui/**'] }],
      forbiddenImports: [{ from: 'models', to: 'ui' }],
      importAliases: [{ prefix: '@/', path: 'src/' }],
    },
    naming: { files: [{ globs: ['src/**/*.ts'], style: 'kebab-case' }], notes: 'Tests end in .test.ts' },
    comments: { maxDensityPct: 30, minAddedLines: 20, forbidCommentedOutCode: true, bannedPhrases: ['as an AI'] },
    testing: { runner: 'mocha', fileGlobs: ['src/test/**/*.test.ts'], notes: '' },
    commands: [{ label: 'Lint', run: 'npm run lint' }],
    builtInRuleIds: ['builtin-clean-code', 'builtin-tdd'],
    freeText: 'Prefer small modules.',
  };
}

/**
 * `profile` with `rules` promoted to blocking. Every scanner rule is advisory by default;
 * a test of what a BLOCKING scanner rule does says so by promoting it, as a project would.
 */
export function promote(profile: StandardsProfile, ...rules: StandardsRuleId[]): StandardsProfile {
  const severity = { ...(profile.severity ?? {}) };
  for (const rule of rules) { severity[rule] = 'blocking'; }
  return { ...profile, severity };
}

/** A totals object with every count zero except the ones given. */
export function totalsOf(over: Partial<StandardsTotals>): StandardsTotals {
  return {
    passed: 0, noFindings: 0, failed: 0, advisory: 0, notChecked: 0, blockingNotChecked: 0,
    findings: 0, advisoryFindings: 0, notCheckedFiles: 0, ...over,
  };
}
