import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// ─── Get Started walkthrough contributions ───────────────────────────────────

const ROOT = path.resolve(__dirname, '..', '..', '..');

interface WalkthroughStep {
  id: string;
  title: string;
  description: string;
  media?: { altText?: string; markdown?: string; image?: string };
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
  repository: { url: string };
  contributes: { walkthroughs: Array<{ id: string; steps: WalkthroughStep[] }> };
};
const vscodeignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf-8')
  .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

const getStarted = pkg.contributes.walkthroughs.find(w => w.id === 'agentTaskPlayer.getStarted');

describe('walkthrough — agentTaskPlayer.getStarted', () => {
  it('exists', () => {
    assert.ok(getStarted, 'agentTaskPlayer.getStarted is contributed');
  });

  it('has unique step ids', () => {
    const ids = getStarted!.steps.map(s => s.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate step id in ${ids.join(', ')}`);
  });

  it('points every step at a media markdown file that exists and is not excluded from the VSIX', () => {
    for (const step of getStarted!.steps) {
      const md = step.media?.markdown;
      assert.ok(md, `${step.id} has media markdown`);
      assert.ok(fs.existsSync(path.join(ROOT, md!)), `${md} exists`);
      assert.ok(!vscodeignore.includes(md!), `${md} is not in .vscodeignore`);
    }
  });

  it('adds connectOnosoo as the step after advancedFeatures', () => {
    const ids = getStarted!.steps.map(s => s.id);
    assert.equal(ids[ids.indexOf('advancedFeatures') + 1], 'connectOnosoo');
    const step = getStarted!.steps.find(s => s.id === 'connectOnosoo')!;
    assert.equal(step.title, 'Connect to ONOSOO Builds (optional)');
    assert.equal(step.media?.markdown, 'media/walkthrough-onosoo.md');
  });

  it('links the ONOSOO guide on GitHub, because docs/ is not shipped', () => {
    assert.ok(vscodeignore.includes('docs/**'), 'premise: docs/ is excluded from the VSIX');
    const step = getStarted!.steps.find(s => s.id === 'connectOnosoo')!;
    const repo = pkg.repository.url.replace(/\.git$/, '');
    const guide = `${repo}/blob/master/docs/onosoo-builds.md`;
    assert.equal(guide, 'https://github.com/sujan-poudel-03/moag/blob/master/docs/onosoo-builds.md');
    assert.ok(step.description.includes(`](${guide})`), 'description links the guide');
    assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'onosoo-builds.md')), 'the linked guide exists in the repo');
    const media = fs.readFileSync(path.join(ROOT, 'media', 'walkthrough-onosoo.md'), 'utf-8');
    assert.ok(media.includes(guide), 'media links the guide');
  });

  it('pairs through the Connect command (and moag pair after Install Command-Line Tool)', () => {
    const step = getStarted!.steps.find(s => s.id === 'connectOnosoo')!;
    assert.ok(step.description.includes('](command:agentTaskPlayer.connectOnosoo)'));
    assert.ok(step.description.includes('](command:agentTaskPlayer.installCli)'));
    assert.ok(step.description.includes('moag pair'));
  });

  it('no media page points at a developer checkout path', () => {
    for (const f of fs.readdirSync(path.join(ROOT, 'media')).filter(n => n.endsWith('.md'))) {
      assert.ok(!fs.readFileSync(path.join(ROOT, 'media', f), 'utf-8').includes('Projects'), `${f} mentions a Projects path`);
    }
  });

  it('names both key file locations and warns against setx and in-project keys', () => {
    const step = getStarted!.steps.find(s => s.id === 'connectOnosoo')!;
    assert.ok(step.description.includes('%APPDATA%\\moag\\onosoo.json'));
    assert.ok(step.description.includes('~/.config/moag/onosoo.json'));
    assert.ok(step.description.includes('setx'));
    assert.match(step.description, /[Nn]ever inside a project/);
  });
});
