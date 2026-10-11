// ─── Design system: parsing, contrast, rendering, diff, templates ───

import { strict as assert } from 'assert';
import {
  DesignSystem,
  MAX_DESIGN_PLANNER_CHARS,
  MAX_DESIGN_PROMPT_CHARS,
  MAX_DESIGN_TOKENS,
  colourHex,
  contrastRatio,
  designChangesBetween,
  designConfigFingerprint,
  designView,
  foreignKitImport,
  hasDesignUi,
  knownComponentKit,
  parseDesignTokens,
  renderDesignPlannerSummary,
  renderDesignPromptText,
  templateDesign,
} from '../../../standards/design';
import { TEMPLATE_TEXT_COLOUR_TOKENS } from '../../../standards/design-templates';
import { hasInvisibleChars, validateProfile } from '../../../standards/profile';

const css = (body: string): DesignSystem => ({ docPath: 'docs/design/DESIGN.md', tokensPath: 'src/styles/tokens.css', doc: '# Design\n\nText.\n', tokens: body });

describe('design system', () => {
  describe('parseDesignTokens', () => {
    it('lists custom properties of a CSS file with kind and resolved value', () => {
      const p = parseDesignTokens('a/tokens.css', ':root {\n  --color-bg: #FFF;\n  --space-2: 0.5rem;\n  --radius-md: 6px;\n  --color-fg: rgb(31, 35, 40);\n}\n');
      assert.equal(p.listable, true);
      assert.deepEqual(p.tokens.map((t) => [t.name, t.kind, t.resolved]), [
        ['--color-bg', 'colour', '#ffffff'],
        ['--space-2', 'length', 8],
        ['--radius-md', 'radius', 6],
        ['--color-fg', 'colour', '#1f2328'],
      ]);
    });

    it('a file that is not CSS is not listable', () => {
      const p = parseDesignTokens('tailwind.config.ts', 'export default { theme: {} };');
      assert.equal(p.listable, false);
      assert.equal(p.reason, 'not a CSS file');
      assert.deepEqual(p.tokens, []);
    });

    it('skips malformed lines', () => {
      const p = parseDesignTokens('t.css', ':root{\n--a #fff;\n--b: ;\ncolor: red;\n--ok: 1px;\n--no-semicolon: 2px\n}');
      assert.deepEqual(p.tokens.map((t) => t.name), ['--ok']);
    });

    it('stops at the token cap', () => {
      const body = Array.from({ length: MAX_DESIGN_TOKENS + 50 }, (_, i) => `--t-${i}: ${i}px;`).join('\n');
      assert.equal(parseDesignTokens('t.css', body).tokens.length, MAX_DESIGN_TOKENS);
    });

    it('follows var() references, and a cycle resolves to nothing', () => {
      const p = parseDesignTokens('t.css', '--base: #0969da;\n--link: var(--base);\n--a: var(--b);\n--b: var(--a);\n--missing: var(--nope);');
      const by = new Map(p.tokens.map((t) => [t.name, t]));
      assert.equal(by.get('--link')!.resolved, '#0969da');
      assert.equal(by.get('--link')!.kind, 'colour');
      assert.equal(by.get('--a')!.resolved, undefined);
      assert.equal(by.get('--missing')!.resolved, undefined);
    });

    it('a chain deeper than five levels is not resolved', () => {
      const chain = ['--c0: #000000;', ...Array.from({ length: 7 }, (_, i) => `--c${i + 1}: var(--c${i});`)].join('\n');
      const by = new Map(parseDesignTokens('t.css', chain).tokens.map((t) => [t.name, t]));
      assert.equal(by.get('--c5')!.resolved, '#000000');
      assert.equal(by.get('--c7')!.resolved, undefined);
    });

    it('colourHex reads short hex, rgba and rejects out-of-range values', () => {
      assert.equal(colourHex('#abc'), '#aabbcc');
      assert.equal(colourHex('rgba(0, 0, 0, 0.5)'), '#00000080');
      assert.equal(colourHex('rgb(300, 0, 0)'), null);
      assert.equal(colourHex('red'), null);
    });
  });

  describe('contrast', () => {
    it('black on white is 21:1 and a colour on itself is 1:1', () => {
      assert.equal(Math.round(contrastRatio('#000', '#fff')! * 100) / 100, 21);
      assert.equal(contrastRatio('#0969da', '#0969da'), 1);
      assert.equal(contrastRatio('red', '#fff'), null);
    });

    it('designView marks the background and computes contrast for every other colour', () => {
      const v = designView(css('--color-bg: #ffffff;\n--color-fg: #000000;\n--space-1: 4px;'));
      assert.equal(v.background, '#ffffff');
      assert.equal(v.tokens[0].role, 'background');
      assert.equal(v.tokens[1].contrast, 21);
      assert.equal(v.tokens[2].contrast, undefined);
    });

    it('designView without a background token computes no contrast', () => {
      const v = designView(css('--color-fg: #000000;'));
      assert.equal(v.background, null);
      assert.equal(v.tokens[0].contrast, undefined);
    });
  });

  describe('rendering', () => {
    const long = (): DesignSystem => css(Array.from({ length: 300 }, (_, i) => `--token-name-that-is-long-${i}: ${'x'.repeat(150)};`).join('\n'));

    it('the prompt text holds the paths, rules and tokens, and stays under the cap with 300 long tokens', () => {
      const t = renderDesignPromptText(long(), 'MUI', 7);
      assert.ok(t.length <= MAX_DESIGN_PROMPT_CHARS, `${t.length}`);
      assert.match(t, /^Design system v7 · DESIGN.md at docs\/design\/DESIGN.md · tokens in src\/styles\/tokens.css/);
      assert.match(t, /approved component kit, MUI/);
      assert.match(t, /…and \d+ more in src\/styles\/tokens.css$/);
    });

    it('the prompt text of a non-CSS tokens file says it is not listable; no kit line without a kit', () => {
      const t = renderDesignPromptText({ ...css(''), tokensPath: 'tailwind.config.ts' }, '', null);
      assert.match(t, /defined in tailwind.config.ts \(not listable\)/);
      assert.doesNotMatch(t, /component kit/);
    });

    it('the planner summary stays under its cap with 300 long tokens and long paths', () => {
      const d = { ...long(), docPath: 'd/'.repeat(95) + 'DESIGN.md', tokensPath: 't/'.repeat(95) + 'tokens.css' };
      const s = renderDesignPlannerSummary(d, 'k'.repeat(200));
      assert.ok(s.length <= MAX_DESIGN_PLANNER_CHARS, `${s.length}`);
      assert.match(s, /Plan every UI task against this design system/);
    });
  });

  describe('designChangesBetween', () => {
    const base = css('--color-bg: #ffffff;\n--color-fg: #000000;\n--space-1: 4px;');

    it('no change', () => {
      const c = designChangesBetween(base, { ...base, tokens: base.tokens.replace(/\n/g, '\r\n') });
      assert.equal(c.changed, false);
      assert.deepEqual(c.tokens, []);
      assert.equal(designChangesBetween(null, null).changed, false);
    });

    it('a changed, an added and a removed token', () => {
      const c = designChangesBetween(base, css('--color-bg: #ffffff;\n--color-fg: #111111;\n--color-accent: #bf3989;'));
      assert.equal(c.changed, true);
      assert.deepEqual(c.tokens.map((t) => [t.name, t.before, t.after]), [
        ['--color-fg', '#000000', '#111111'],
        ['--color-accent', null, '#bf3989'],
        ['--space-1', '4px', null],
      ]);
      assert.equal(c.docChanged, false);
      assert.equal(c.paths, null);
    });

    it('a path change', () => {
      const c = designChangesBetween(base, { ...base, tokensPath: 'css/tokens.css' });
      assert.equal(c.changed, true);
      assert.deepEqual(c.paths?.after, { docPath: 'docs/design/DESIGN.md', tokensPath: 'css/tokens.css' });
    });

    it('a DESIGN.md section change lists only that section', () => {
      const before = { ...base, doc: '# Design\n\nIntro\n\n## Colour\n\nOld\n\n## Forms\n\nSame\n' };
      const after = { ...base, doc: '# Design\n\nIntro\n\n## Colour\n\nNew\n\n## Forms\n\nSame\n' };
      const c = designChangesBetween(before, after);
      assert.equal(c.docChanged, true);
      assert.deepEqual(c.sections, [{ heading: 'Colour', before: 'Old', after: 'New' }]);
    });

    it('adding and removing the whole design are changes', () => {
      const added = designChangesBetween(null, base);
      assert.equal(added.changed, true);
      assert.equal(added.tokens.length, 3);
      const removed = designChangesBetween(base, null);
      assert.equal(removed.changed, true);
      assert.ok(removed.tokens.every((t) => t.after === null));
      assert.equal(removed.paths?.after, null);
    });

    it('raw is filled when a side is not listable', () => {
      const ts = { ...base, tokensPath: 'tailwind.config.ts', tokens: 'export default {a:1}' };
      const c = designChangesBetween(ts, { ...ts, tokens: 'export default {a:2}' });
      assert.deepEqual(c.raw, { before: 'export default {a:1}', after: 'export default {a:2}' });
      assert.equal(designChangesBetween(base, css('--x: 1px;')).raw, undefined);
    });

    it('the fingerprint carries hashes, not prose', () => {
      const f = designConfigFingerprint(base, 'MUI');
      assert.equal(JSON.stringify(f).includes('Text.'), false);
      assert.match(f.docSha256, /^[0-9a-f]{64}$/);
    });
  });

  describe('templates', () => {
    it('are byte-identical across calls and null for a stack without one', () => {
      assert.deepEqual(templateDesign('node-ts', 'MUI'), templateDesign('node-ts', 'MUI'));
      assert.deepEqual(templateDesign('static-web', ''), templateDesign('static-web', ''));
      assert.equal(templateDesign('python', ''), null);
      assert.equal(templateDesign('go', ''), null);
      assert.equal(templateDesign('static-web', '')!.tokensPath, 'css/tokens.css');
    });

    it('every text colour reaches 4.5:1 on the background, and primary-fg on primary', () => {
      const v = designView(templateDesign('node-ts', '')!);
      const by = new Map(v.tokens.map((t) => [t.name, t]));
      for (const name of TEMPLATE_TEXT_COLOUR_TOKENS) {
        assert.ok((by.get(name)!.contrast ?? 0) >= 4.5, `${name} ${by.get(name)!.contrast}`);
      }
      assert.ok(contrastRatio(by.get('--color-primary-fg')!.resolved as string, by.get('--color-primary')!.resolved as string)! >= 4.5);
    });

    it('DESIGN.md has every section in order, names the kit, and holds no invisible character', () => {
      const d = templateDesign('node-ts', 'Chakra UI')!;
      const headings = d.doc.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
      assert.deepEqual(headings, [
        'Colour palette', 'Typography', 'Spacing', 'Radii and elevation', 'Components', 'Page layout',
        'States: empty, loading, error', 'Forms', 'Accessibility', 'Writing tone', 'Changing the design system',
      ]);
      assert.match(d.doc, /Chakra UI/);
      assert.ok(d.doc.length < 6_000);
      assert.ok(d.doc.split('\n').every((l) => !hasInvisibleChars(l)));
      assert.ok(d.tokens.split('\n').every((l) => !hasInvisibleChars(l)));
    });

    it('a template design passes the profile validator', () => {
      const r = validateProfile({
        stackTemplateId: 'static-web', repoState: 'greenfield',
        structure: { requiredDirs: [], allowedTopLevel: [], placement: [] },
        frontend: { componentKit: '', styleSource: '', rawPatterns: [] },
        backend: { layers: [], forbiddenImports: [], importAliases: [] },
        naming: { files: [], notes: '' },
        comments: { maxDensityPct: 30, minAddedLines: 20, forbidCommentedOutCode: false, bannedPhrases: [] },
        testing: { runner: '', fileGlobs: [], notes: '' },
        commands: [], builtInRuleIds: [], freeText: '',
        design: templateDesign('static-web', ''),
      });
      assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    });
  });

  describe('UI signals and kits', () => {
    const none = { stack: { value: 'node-ts' }, framework: null, componentLibrary: null };
    it('hasDesignUi', () => {
      assert.equal(hasDesignUi(none), false);
      assert.equal(hasDesignUi({ ...none, stack: { value: 'static-web' } }), true);
      assert.equal(hasDesignUi({ ...none, framework: { value: 'React' } }), true);
      assert.equal(hasDesignUi({ ...none, framework: { value: 'Express' } }), false);
      assert.equal(hasDesignUi({ ...none, componentLibrary: { value: 'MUI' } }), true);
      assert.equal(hasDesignUi({ ...none, designSources: { ui: { value: 'index.html', evidence: 'index.html' } } }), true);
    });

    it('knownComponentKit and foreignKitImport', () => {
      const chakra = knownComponentKit('Chakra UI')!;
      assert.equal(knownComponentKit('my own kit'), null);
      assert.deepEqual(foreignKitImport('@mui/material/Button', chakra), { pkg: '@mui/material', label: 'MUI' });
      assert.equal(foreignKitImport('@chakra-ui/react', chakra), null);
      assert.equal(foreignKitImport('@mui/materials', chakra), null);
      assert.equal(foreignKitImport('bootstrap/dist/css/bootstrap.css', knownComponentKit('React Bootstrap')!), null);
    });
  });
});
