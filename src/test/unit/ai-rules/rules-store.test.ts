// ─── AI rules store — the global tier is optional ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AiRule, AiRulesStore } from '../../../ai-rules/rules-store';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rule(id: string, scope: AiRule['scope'], enabled = true): AiRule {
  return { id, name: `Rule ${id}`, category: 'custom', scope, text: `text of ${id}`, enabled };
}

describe('AiRulesStore', () => {
  it('with a global path: merges the global and workspace tiers, global first', () => {
    const globalDir = tempDir('moag-rules-global-');
    const cwd = tempDir('moag-rules-ws-');
    const store = new AiRulesStore(globalDir);
    store.addRule(rule('g1', 'global'), cwd);
    store.addRule(rule('w1', 'workspace'), cwd);
    store.addRule(rule('w2', 'workspace', false), cwd);

    assert.deepEqual(store.getAllRules(cwd).map((r) => r.id), ['g1', 'w1', 'w2']);
    assert.equal(store.getEnabledText(cwd), '### Rule g1\ntext of g1\n\n### Rule w1\ntext of w1');
    assert.ok(fs.existsSync(path.join(globalDir, 'ai-rules.json')));
    assert.ok(fs.existsSync(path.join(cwd, '.moag', 'rules.json')));
  });

  it('with null: the workspace tier only — no global reads, and global writes are no-ops', () => {
    const cwd = tempDir('moag-rules-null-');
    const store = new AiRulesStore(null);
    store.addRule(rule('w1', 'workspace'), cwd);

    assert.deepEqual(store.getGlobalRules(), []);
    assert.doesNotThrow(() => store.addRule(rule('g1', 'global'), cwd));
    assert.doesNotThrow(() => store.updateRule(rule('g1', 'global'), cwd));
    assert.doesNotThrow(() => store.toggleRule('g1', 'global', cwd));
    assert.doesNotThrow(() => store.deleteRule('g1', 'global', cwd));
    assert.deepEqual(store.getAllRules(cwd).map((r) => r.id), ['w1']);
    assert.equal(store.getEnabledText(cwd), '### Rule w1\ntext of w1');
  });

  it('with null: workspace rules can still be toggled, updated and deleted', () => {
    const cwd = tempDir('moag-rules-null-ws-');
    const store = new AiRulesStore(null);
    store.addRule(rule('w1', 'workspace'), cwd);
    store.toggleRule('w1', 'workspace', cwd);
    assert.equal(store.getEnabledText(cwd), '');
    store.updateRule({ ...rule('w1', 'workspace'), text: 'changed' }, cwd);
    assert.equal(store.getEnabledText(cwd), '### Rule w1\nchanged');
    store.deleteRule('w1', 'workspace', cwd);
    assert.deepEqual(store.getAllRules(cwd), []);
  });

  it('treats a malformed workspace file as no rules rather than throwing', () => {
    const cwd = tempDir('moag-rules-bad-');
    fs.mkdirSync(path.join(cwd, '.moag'));
    fs.writeFileSync(path.join(cwd, '.moag', 'rules.json'), '{ not json');
    assert.deepEqual(new AiRulesStore(null).getAllRules(cwd), []);
    assert.equal(new AiRulesStore(null).getEnabledText(cwd), '');
  });
});
