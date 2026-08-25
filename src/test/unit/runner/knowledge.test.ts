import * as assert from 'assert';
import * as path from 'path';
import {
  commandFactId,
  factsPath,
  knowledgeBlockFor,
  readFacts,
  recordFact,
  renderKnowledgeBlock,
  FsLike,
  VerifiedFact,
} from '../../../runner/knowledge';

function memFs(seed: Record<string, string> = {}): FsLike & { files: Record<string, string> } {
  const files: Record<string, string> = { ...seed };
  const dirs = new Set<string>();
  return {
    files,
    existsSync: (p) => p in files || dirs.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    readFileSync: (p) => {
      if (!(p in files)) { throw new Error('ENOENT'); }
      return files[p];
    },
    writeFileSync: (p, d) => { files[p] = d; },
  };
}

const fact = (over: Partial<VerifiedFact> = {}): Omit<VerifiedFact, 'observations'> => ({
  id: commandFactId('verified-command', 'npm test'),
  kind: 'verified-command',
  statement: '`npm test` passes here',
  provenBy: 'npm test -> exit 0',
  observedAt: '2026-08-25T01:00:00.000Z',
  ...over,
});

describe('knowledge — proof is mandatory', () => {
  it('refuses a fact with no evidence behind it', () => {
    const fs = memFs();
    assert.strictEqual(recordFact('/r', fact({ provenBy: '' }), fs), false);
    assert.strictEqual(recordFact('/r', fact({ provenBy: '   ' }), fs), false);
    assert.deepStrictEqual(readFacts('/r', fs), [], 'nothing unproven may be stored');
  });

  it('refuses an empty statement', () => {
    const fs = memFs();
    assert.strictEqual(recordFact('/r', fact({ statement: '' }), fs), false);
  });

  it('accepts a fact that names what proved it', () => {
    const fs = memFs();
    assert.strictEqual(recordFact('/r', fact(), fs), true);
    assert.strictEqual(readFacts('/r', fs)[0].provenBy, 'npm test -> exit 0');
  });
});

describe('knowledge — the ledger converges', () => {
  it('reinforces a repeat observation instead of duplicating it', () => {
    const fs = memFs();
    recordFact('/r', fact(), fs);
    recordFact('/r', fact({ observedAt: '2026-08-26T01:00:00.000Z' }), fs);
    const all = readFacts('/r', fs);
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].observations, 2);
    assert.strictEqual(all[0].observedAt, '2026-08-26T01:00:00.000Z');
  });

  it('supersedes the opposite verdict for the same command', () => {
    const fs = memFs();
    recordFact('/r', fact({
      id: commandFactId('failing-command', 'npm test'),
      kind: 'failing-command',
      statement: '`npm test` fails here (exit 1)',
      provenBy: 'npm test -> exit 1',
    }), fs);
    recordFact('/r', fact(), fs);

    const all = readFacts('/r', fs);
    assert.strictEqual(all.length, 1, 'a command cannot be both passing and failing');
    assert.strictEqual(all[0].kind, 'verified-command');
  });

  it('is case- and whitespace-insensitive when identifying a command', () => {
    assert.strictEqual(
      commandFactId('verified-command', '  NPM Test '),
      commandFactId('verified-command', 'npm test'),
    );
  });

  it('survives a corrupt ledger rather than throwing', () => {
    const fs = memFs({ [factsPath('/r')]: 'not json at all' });
    assert.deepStrictEqual(readFacts('/r', fs), []);
    assert.strictEqual(recordFact('/r', fact(), fs), true);
  });

  it('stores the ledger under .moag/knowledge', () => {
    assert.strictEqual(factsPath('/r'), path.join('/r', '.moag', 'knowledge', 'facts.json'));
  });
});

describe('knowledge — the injected block', () => {
  it('is empty for a workspace that has proven nothing', () => {
    assert.strictEqual(renderKnowledgeBlock([]), '');
    assert.strictEqual(knowledgeBlockFor('/r', memFs()), '');
  });

  it('separates what works from what does not', () => {
    const fs = memFs();
    recordFact('/r', fact(), fs);
    recordFact('/r', fact({
      id: commandFactId('failing-command', 'yarn build'),
      kind: 'failing-command',
      statement: '`yarn build` fails here (exit 127)',
      provenBy: 'yarn build -> exit 127',
    }), fs);

    const block = knowledgeBlockFor('/r', fs);
    assert.ok(block.includes('Commands that verify this repository'));
    assert.ok(block.includes('Commands that do NOT work here'));
    assert.ok(block.includes('npm test'));
    assert.ok(block.includes('yarn build'));
  });

  it('names the evidence for every claim it makes', () => {
    const fs = memFs();
    recordFact('/r', fact(), fs);
    const lines = knowledgeBlockFor('/r', fs).split('\n').filter((l) => l.startsWith('- '));
    assert.ok(lines.length > 0);
    for (const l of lines) {
      assert.ok(l.includes('proven by'), `unproven claim rendered: ${l}`);
    }
  });

  it('ranks a well-confirmed fact above a one-off', () => {
    const facts: VerifiedFact[] = [
      { ...fact({ id: 'a', statement: 'rare' }), observations: 1 },
      { ...fact({ id: 'b', statement: 'common' }), observations: 12 },
    ];
    const block = renderKnowledgeBlock(facts);
    assert.ok(block.indexOf('common') < block.indexOf('rare'));
    assert.ok(block.includes('seen 12'));
  });

  it('tells the agent the evidence may be stale rather than treating it as gospel', () => {
    const fs = memFs();
    recordFact('/r', fact(), fs);
    assert.ok(/stale/.test(knowledgeBlockFor('/r', fs)));
  });
});
