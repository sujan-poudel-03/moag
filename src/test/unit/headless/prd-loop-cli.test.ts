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
  verifyArgsError,
} from '../../../headless/cli';

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
});
