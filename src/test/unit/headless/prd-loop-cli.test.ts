// ─── moag verify — argument parsing, PRD resolution, exit-code mapping ───
//
// These call the CLI's pure helpers only. The module is import-safe: `main()` is
// guarded by `require.main === module`, so nothing here can call process.exit.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Args,
  buildVerifyConfig,
  exitCodeForReport,
  parseArgs,
  resolvePrdTextHeadless,
  resolveVerifyStandards,
  verifyArgsError,
} from '../../../headless/cli';
import { writeLocalStandards } from '../../../standards/local-store';
import { profileHash, renderPlannerStandards, renderStandardsText } from '../../../standards/profile';
import { sampleProfile, sampleProvenance } from '../standards/fixtures';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('moag verify — parseArgs', () => {
  it('clamps --max-iterations 0 up to 1 so the loop is never a no-op', () => {
    const args = parseArgs(['verify', 'plan.json', '--max-iterations', '0']);
    assert.equal(args.maxIterations, 1);
  });

  it('clamps a negative or unparsable --max-iterations to 1 as well', () => {
    assert.equal(parseArgs(['verify', 'p.json', '--max-iterations', '-4']).maxIterations, 1);
    assert.equal(parseArgs(['verify', 'p.json', '--max-iterations', 'abc']).maxIterations, 1);
  });

  it('accumulates repeated --gate flags in order', () => {
    const args = parseArgs([
      'verify', 'plan.json',
      '--gate', 'npm run build',
      '--gate', 'npm run lint',
      '--gate', 'npm test',
    ]);
    assert.deepEqual(args.gates, ['npm run build', 'npm run lint', 'npm test']);
  });

  it('defaults verify/fix off and gates empty', () => {
    const args = parseArgs(['run', 'plan.json']);
    assert.equal(args.verify, false);
    assert.equal(args.fix, false);
    assert.deepEqual(args.gates, []);
    assert.equal(args.maxIterations, undefined);
  });

  it('sets verify and fix when the flags are present', () => {
    const args = parseArgs(['run', 'plan.json', '--verify', '--fix']);
    assert.equal(args.verify, true);
    assert.equal(args.fix, true);
  });
});

describe('moag verify — standards flags', () => {
  it('leaves all three undefined by default', () => {
    const args = parseArgs(['verify', 'plan.json']);
    assert.equal(args.standardsPath, undefined);
    assert.equal(args.noStandards, undefined);
    assert.equal(args.base, undefined);
  });

  it('--standards resolves against --cwd, --no-standards is a boolean, --base is kept verbatim', () => {
    const cwd = makeTempDir('moag-cli-stdflags-');
    const args = parseArgs(['verify', 'plan.json', '--cwd', cwd, '--standards', 'job/standards.json', '--no-standards', '--base', 'HEAD~2']);
    assert.equal(args.standardsPath, path.join(cwd, 'job', 'standards.json'));
    assert.equal(args.noStandards, true);
    assert.equal(args.base, 'HEAD~2');
  });

  it('a trailing --standards or --base with no value does not crash and sets nothing', () => {
    let args: Args | undefined;
    assert.doesNotThrow(() => { args = parseArgs(['verify', 'plan.json', '--base']); });
    assert.equal(args!.base, undefined);
    assert.doesNotThrow(() => { args = parseArgs(['verify', 'plan.json', '--standards']); });
    assert.equal(args!.standardsPath, undefined);
  });
});

describe('moag verify — resolveVerifyStandards', () => {
  function argsFor(cwd: string, extra: string[] = []): Args {
    return parseArgs(['verify', 'plan.json', '--cwd', cwd, ...extra]);
  }

  function writeLocal(cwd: string, version = 4): void {
    writeLocalStandards(cwd, { schemaVersion: 1, version, profile: sampleProfile(), provenance: sampleProvenance() });
  }

  function writeJobFile(dir: string, over: Record<string, unknown> = {}): string {
    const profile = sampleProfile();
    profile.commands = [{ label: 'Approved', run: 'npm run approved' }];
    const file = path.join(dir, 'standards.json');
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1, version: 9, contentHash: profileHash(profile), baseRef: 'c'.repeat(40), profile,
      promptText: renderStandardsText(profile, 9), plannerText: renderPlannerStandards(profile, 9), ...over,
    }));
    return file;
  }

  it('is null for a workspace with no standards file', () => {
    assert.equal(resolveVerifyStandards(argsFor(makeTempDir('moag-cli-nostd-'))), null);
  });

  it('reads the workspace file, with the base from --base (null when absent)', () => {
    const cwd = makeTempDir('moag-cli-localstd-');
    writeLocal(cwd, 4);
    const plain = resolveVerifyStandards(argsFor(cwd));
    assert.equal(plain?.version, 4);
    assert.equal(plain?.baseRef, null);
    assert.deepEqual(plain?.profile, sampleProfile());
    assert.equal(resolveVerifyStandards(argsFor(cwd, ['--base', 'abc1234']))?.baseRef, 'abc1234');
  });

  it('--no-standards returns null without reading the workspace file at all', () => {
    const cwd = makeTempDir('moag-cli-nostdflag-');
    fs.mkdirSync(path.join(cwd, '.moag'));
    fs.writeFileSync(path.join(cwd, '.moag', 'standards.json'), '{ broken');
    assert.equal(resolveVerifyStandards(argsFor(cwd, ['--no-standards'])), null);
  });

  it('--standards reads the job file — profile, version and base — and never the workspace file', () => {
    const cwd = makeTempDir('moag-cli-jobstd-');
    fs.mkdirSync(path.join(cwd, '.moag'));
    fs.writeFileSync(path.join(cwd, '.moag', 'standards.json'), '{ broken, and hostile');
    const job = writeJobFile(makeTempDir('moag-cli-jobdir-'));
    const resolved = resolveVerifyStandards(argsFor(cwd, ['--standards', job, '--base', 'ignored-for-job-files']));
    assert.equal(resolved?.version, 9);
    assert.equal(resolved?.baseRef, 'c'.repeat(40));
    assert.deepEqual(resolved?.profile.commands, [{ label: 'Approved', run: 'npm run approved' }]);
  });

  it('--standards wins over --no-standards', () => {
    const job = writeJobFile(makeTempDir('moag-cli-jobwin-'));
    assert.equal(resolveVerifyStandards(argsFor(makeTempDir('moag-cli-jobwin-cwd-'), ['--no-standards', '--standards', job]))?.version, 9);
  });

  it('throws naming the file for an invalid workspace file, a missing job file and a tampered job file', () => {
    const cwd = makeTempDir('moag-cli-badstd-');
    fs.mkdirSync(path.join(cwd, '.moag'));
    fs.writeFileSync(path.join(cwd, '.moag', 'standards.json'), '{ broken');
    assert.throws(() => resolveVerifyStandards(argsFor(cwd)), /"\.moag\/standards\.json" contains invalid JSON/);

    const jobDir = makeTempDir('moag-cli-badjob-');
    assert.throws(() => resolveVerifyStandards(argsFor(cwd, ['--standards', path.join(jobDir, 'standards.json')])),
      /Cannot read "standards\.json"/);
    const tampered = writeJobFile(jobDir, { contentHash: 'f'.repeat(64) });
    assert.throws(() => resolveVerifyStandards(argsFor(cwd, ['--standards', tampered])), /does not match its content hash/);
  });

  it('buildVerifyConfig carries the resolved standards and propagates a broken file as a throw', () => {
    const ctx = { vscode: { workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) } } };
    const cwd = makeTempDir('moag-cli-cfgstd-');
    assert.equal(buildVerifyConfig(argsFor(cwd), ctx as never).standards, null);
    writeLocal(cwd, 2);
    assert.equal(buildVerifyConfig(argsFor(cwd), ctx as never).standards?.version, 2);
    fs.writeFileSync(path.join(cwd, '.moag', 'standards.json'), '[]');
    assert.throws(() => buildVerifyConfig(argsFor(cwd), ctx as never), /"\.moag\/standards\.json" is not a valid standards file/);
  });
});

describe('moag verify — usage', () => {
  it('reports exit code 2 when no plan path was given', () => {
    assert.equal(verifyArgsError(parseArgs(['verify'])), 2);
  });

  it('reports no usage error when a plan path is present', () => {
    assert.equal(verifyArgsError(parseArgs(['verify', 'plan.json'])), null);
  });
});

describe('moag verify — PRD resolution', () => {
  function argsFor(cwd: string, over: Partial<Args> = {}): Args {
    return { ...parseArgs(['verify', 'plan.json', '--cwd', cwd]), ...over };
  }

  it('returns null instead of prompting when nothing is resolvable', () => {
    const dir = makeTempDir('moag-cli-noprd-');
    const plan = { name: 'p', playlists: [{ id: 'a', name: 'a', tasks: [] }] };
    assert.equal(resolvePrdTextHeadless(plan, argsFor(dir), dir), null);
  });

  it('prefers plan.prdSource over every other source', () => {
    const dir = makeTempDir('moag-cli-prdsource-');
    fs.writeFileSync(path.join(dir, 'PRD.md'), 'FROM DISK', 'utf-8');
    const plan = { prdSource: 'FROM PLAN', playlists: [{ prdContext: 'FROM PLAYLIST', tasks: [] }] };
    assert.equal(resolvePrdTextHeadless(plan, argsFor(dir), dir), 'FROM PLAN');
  });

  it('falls back to the first playlist prdContext, then --prd, then the detected file', () => {
    const dir = makeTempDir('moag-cli-chain-');
    fs.writeFileSync(path.join(dir, 'PRD.md'), 'FROM DISK', 'utf-8');
    const explicit = path.join(dir, 'other-prd.md');
    fs.writeFileSync(explicit, 'FROM FLAG', 'utf-8');

    const withContext = { playlists: [{ tasks: [] }, { prdContext: 'FROM PLAYLIST', tasks: [] }] };
    assert.equal(resolvePrdTextHeadless(withContext, argsFor(dir), dir), 'FROM PLAYLIST');

    const bare = { playlists: [{ tasks: [] }] };
    assert.equal(resolvePrdTextHeadless(bare, argsFor(dir, { prdPath: explicit }), dir), 'FROM FLAG');
    assert.equal(resolvePrdTextHeadless(bare, argsFor(dir), dir), 'FROM DISK');
  });

  it('returns null when --prd points at a file that cannot be read', () => {
    const dir = makeTempDir('moag-cli-badprd-');
    const missing = path.join(dir, 'nope.md');
    const bare = { playlists: [] };
    assert.equal(resolvePrdTextHeadless(bare, argsFor(dir, { prdPath: missing }), dir), null);
  });
});

describe('moag verify — exit-code mapping', () => {
  it('maps halt reasons and verdicts onto the documented codes', () => {
    assert.equal(exitCodeForReport({ passed: true, haltReason: null }), 0);
    assert.equal(exitCodeForReport({ passed: false, haltReason: null }), 1);
    assert.equal(exitCodeForReport({ passed: false, haltReason: 'manual-gate' }), 3);
    assert.equal(exitCodeForReport({ passed: false, haltReason: 'budget-exceeded' }), 4);
    assert.equal(exitCodeForReport({ passed: false, haltReason: 'engine-error' }), 2);
    assert.equal(exitCodeForReport({ passed: false, haltReason: 'no-prd' }), 2);
  });

  it('treats every other halt reason as "gaps remain" (1)', () => {
    assert.equal(exitCodeForReport({ passed: false, haltReason: 'no-gates' }), 1);
    assert.equal(exitCodeForReport({ passed: false, haltReason: 'max-iterations' }), 1);
    assert.equal(exitCodeForReport({ passed: false, haltReason: 'no-progress' }), 1);
    assert.equal(exitCodeForReport({ passed: false, haltReason: 'aborted' }), 1);
  });
});

describe('moag verify — UAT flags', () => {
  it('--no-uat selects off', () => {
    assert.equal(parseArgs(['verify', 'plan.json', '--no-uat']).uatMode, 'off');
  });

  it('--uat selects required', () => {
    assert.equal(parseArgs(['verify', 'plan.json', '--uat']).uatMode, 'required');
  });

  it('--uat and --no-uat together is deterministic last-wins', () => {
    assert.equal(parseArgs(['verify', 'p.json', '--uat', '--no-uat']).uatMode, 'off');
    assert.equal(parseArgs(['verify', 'p.json', '--no-uat', '--uat']).uatMode, 'required');
  });

  it('leaves uatMode undefined when neither flag is given, so the setting decides', () => {
    assert.equal(parseArgs(['verify', 'plan.json']).uatMode, undefined);
    assert.equal(parseArgs(['verify', 'plan.json']).uatSpec, undefined);
  });

  it('--uat-spec with no following token does not crash and leaves the spec undefined', () => {
    let args: Args | undefined;
    assert.doesNotThrow(() => { args = parseArgs(['verify', 'plan.json', '--uat-spec']); });
    assert.equal(args!.uatSpec, undefined);
  });

  it('--uat-spec captures the following token', () => {
    assert.equal(
      parseArgs(['verify', 'p.json', '--uat-spec', 'e2e/login.spec.ts']).uatSpec,
      'e2e/login.spec.ts',
    );
  });
});

describe('moag verify — buildVerifyConfig', () => {
  /** A stand-in for the headless shim's configuration surface. */
  function makeCtx(values: Record<string, unknown> = {}): { vscode: unknown } {
    return {
      vscode: {
        workspace: {
          getConfiguration: () => ({
            get: (key: string, fallback: unknown) =>
              (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback),
          }),
        },
      },
    };
  }

  it('takes the mode from the setting default when no flag is given, and stays unattended', () => {
    const cfg = buildVerifyConfig(parseArgs(['verify', 'plan.json']), makeCtx() as never);
    assert.equal(cfg.uat.mode, 'auto');
    assert.equal(cfg.uat.timeoutMs, 900_000);
    assert.equal(cfg.unattended, true, 'the headless surface must stay unattended');
  });

  it('lets --uat override the setting', () => {
    const ctx = makeCtx({ 'prdLoop.uat.mode': 'off' });
    const cfg = buildVerifyConfig(parseArgs(['verify', 'p.json', '--uat']), ctx as never);
    assert.equal(cfg.uat.mode, 'required');
  });

  it('reads the mode from the setting when no flag overrides it', () => {
    const ctx = makeCtx({ 'prdLoop.uat.mode': 'required' });
    const cfg = buildVerifyConfig(parseArgs(['verify', 'p.json']), ctx as never);
    assert.equal(cfg.uat.mode, 'required');
  });

  it('degrades an unrecognised setting value to auto instead of throwing', () => {
    const ctx = makeCtx({ 'prdLoop.uat.mode': 'nonsense' });
    let cfg;
    assert.doesNotThrow(() => { cfg = buildVerifyConfig(parseArgs(['verify', 'p.json']), ctx as never); });
    assert.equal(cfg!.uat.mode, 'auto');
  });

  it('lets --uat-spec override the configured spec path', () => {
    const ctx = makeCtx({ 'prdLoop.uat.specPath': 'from/settings.spec.ts' });
    const cfg = buildVerifyConfig(
      parseArgs(['verify', 'p.json', '--uat-spec', 'from/cli.spec.ts']),
      ctx as never,
    );
    assert.equal(cfg.uat.specPath, 'from/cli.spec.ts');
  });

  it('reads the per-run PRD budget from prdLoop.versionBudgetUsd, defaulting to 0 (off)', () => {
    assert.equal(buildVerifyConfig(parseArgs(['verify', 'p.json']), makeCtx() as never).versionBudgetUsd, 0);
    const ctx = makeCtx({ 'prdLoop.versionBudgetUsd': 2.5 });
    assert.equal(buildVerifyConfig(parseArgs(['verify', 'p.json']), ctx as never).versionBudgetUsd, 2.5);
  });

  it('coerces a negative or non-numeric budget to 0 instead of throwing', () => {
    for (const bad of [-1, 'x', NaN, Infinity, null]) {
      const ctx = makeCtx({ 'prdLoop.versionBudgetUsd': bad });
      assert.equal(buildVerifyConfig(parseArgs(['verify', 'p.json']), ctx as never).versionBudgetUsd, 0, String(bad));
    }
  });

  it('a budget halt maps to exit code 4', () => {
    assert.equal(exitCodeForReport({ passed: false, haltReason: 'budget-exceeded' }), 4);
  });
});
