// ─── run-reporter: the event lines, cost lines, relay start and relay env shared by CLI and host ───

import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildRunMeta, HEADLESS_MANUAL_GATE_NOTE, RunLine, startRunRelay, subscribeRunCostLines, takeRelayEnv, tallyPlan, wireRunEventLines,
} from '../../../headless/run-reporter';
import type { RelayHttpClient } from '../../../headless/onosoo-relay';
import type { RelayEvent } from '../../../headless/onosoo-spool';
import { costLedger } from '../../../utils/cost-ledger';
import { TaskStatus } from '../../../models/types';

const KEY = 'onosoo_live_' + 'R'.repeat(43);

const EVENTS = [
  'state-changed', 'task-started', 'task-completed', 'task-failed', 'task-escalate', 'incident', 'error',
  'dependencies-installed', 'dependencies-install-failed', 'dependencies-not-installed', 'budget-exceeded', 'manual-gate',
];

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function fire(runner: EventEmitter): void {
  const t = { id: 't1', name: 'One', status: TaskStatus.Completed };
  const f = { id: 't2', name: 'Two', status: TaskStatus.Failed };
  runner.emit('state-changed', 'playing');
  runner.emit('task-started', t);
  runner.emit('task-completed', t, { stdout: '', stderr: '' });
  runner.emit('task-failed', f, { stdout: '', stderr: '' });
  runner.emit('task-escalate', f, 'auth');
  runner.emit('incident', f, 'broke', null);
  runner.emit('error', new Error('boom'));
  runner.emit('dependencies-installed', t, { event: 'dependencies-installed', manager: 'npm' });
  runner.emit('dependencies-install-failed', t, { event: 'dependencies-install-failed', manager: 'npm' });
  runner.emit('dependencies-not-installed', t, { event: 'dependencies-not-installed', reason: 'off' });
  runner.emit('budget-exceeded', { totalCost: 2, budget: 1 });
  runner.emit('manual-gate', t);
}

describe('run-reporter', () => {
  describe('wireRunEventLines', () => {
    it('maps every runner event to its exact protocol line, in key order', () => {
      const runner = new EventEmitter();
      const lines: RunLine[] = [];
      wireRunEventLines(runner, (l) => lines.push(l));
      fire(runner);
      const expected: RunLine[] = [
        { event: 'state', state: 'playing' },
        { event: 'task-started', id: 't1', name: 'One' },
        { event: 'task-completed', id: 't1', name: 'One', status: TaskStatus.Completed },
        { event: 'task-failed', id: 't2', name: 'Two', status: TaskStatus.Failed },
        { event: 'task-escalate', id: 't2', name: 'Two', category: 'auth' },
        { event: 'incident', id: 't2', name: 'Two', summary: 'broke', issueUrl: null },
        { event: 'error', message: 'boom' },
        { event: 'dependencies-installed', manager: 'npm' },
        { event: 'dependencies-install-failed', manager: 'npm' },
        { event: 'dependencies-not-installed', reason: 'off' },
        { event: 'budget-exceeded', totalCost: 2, budget: 1 },
        { event: 'manual-gate', id: 't1', name: 'One', note: HEADLESS_MANUAL_GATE_NOTE },
      ];
      assert.deepEqual(lines, expected);
      // Key order is part of the byte-identical stdout contract.
      assert.deepEqual(lines.map((l) => JSON.stringify(l)), expected.map((l) => JSON.stringify(l)));
      for (const e of EVENTS) { assert.equal(runner.listenerCount(e), 1, e); }
    });

    it('manualGateNote overrides the headless note', () => {
      const runner = new EventEmitter();
      const lines: RunLine[] = [];
      wireRunEventLines(runner, (l) => lines.push(l), { manualGateNote: 'Waiting.' });
      runner.emit('manual-gate', { id: 'g', name: 'Gate' });
      assert.deepEqual(lines, [{ event: 'manual-gate', id: 'g', name: 'Gate', note: 'Waiting.' }]);
    });

    it('unwire removes every listener, and nothing is emitted after it', () => {
      const runner = new EventEmitter();
      const lines: RunLine[] = [];
      const unwire = wireRunEventLines(runner, (l) => lines.push(l));
      unwire();
      for (const e of EVENTS) { assert.equal(runner.listenerCount(e), 0, e); }
      runner.on('error', () => undefined); // an unhandled 'error' emit would throw
      fire(runner);
      assert.deepEqual(lines, []);
    });

    it('applies no policy: a budget breach or a gate never calls stop()', () => {
      const runner = Object.assign(new EventEmitter(), { stops: 0, stop(): void { this.stops++; } });
      wireRunEventLines(runner, () => undefined);
      runner.emit('budget-exceeded', { totalCost: 2, budget: 1 });
      runner.emit('manual-gate', { id: 'g', name: 'G' });
      assert.equal(runner.stops, 0);
    });
  });

  describe('subscribeRunCostLines', () => {
    it('emits a cost line per recorded and per unreported call', () => {
      const lines: RunLine[] = [];
      const off = subscribeRunCostLines((l) => lines.push(l));
      costLedger.record({ estimatedCost: 0.5, costSource: 'reported' }, { engineId: 'claude', label: 'task' });
      costLedger.record({ estimatedCost: 0.25 }, { engineId: 'claude', label: 'task' });
      costLedger.recordUnreported({ engineId: 'gemini', label: 'task' });
      off();
      assert.deepEqual(lines, [
        { event: 'cost', usd: 0.5, source: 'reported' },
        { event: 'cost', usd: 0.25, source: 'estimated' },
        { event: 'cost', usd: 0, source: 'none' },
      ]);
    });

    it('accept filters by label: a prd-chat call produces no line', () => {
      const lines: RunLine[] = [];
      const off = subscribeRunCostLines((l) => lines.push(l), (l) => l === 'task');
      costLedger.record({ estimatedCost: 0.5 }, { engineId: 'claude', label: 'prd-chat' });
      costLedger.recordUnreported({ engineId: 'claude', label: 'prd-chat' });
      costLedger.record({ estimatedCost: 0.1 }, { engineId: 'claude', label: 'task' });
      off();
      assert.deepEqual(lines, [{ event: 'cost', usd: 0.1, source: 'estimated' }]);
    });

    it('the unsubscribe stops lines', () => {
      const lines: RunLine[] = [];
      const off = subscribeRunCostLines((l) => lines.push(l));
      off();
      costLedger.record({ estimatedCost: 1 }, { engineId: 'claude', label: 'task' });
      costLedger.recordUnreported({ engineId: 'claude' });
      assert.deepEqual(lines, []);
    });
  });

  describe('tallyPlan', () => {
    it('counts total, completed and failed', () => {
      const plan = { playlists: [{ tasks: [{ status: TaskStatus.Completed }, { status: TaskStatus.Failed }] }, { tasks: [{ status: TaskStatus.Skipped }] }] };
      assert.deepEqual(tallyPlan(plan), { total: 3, completed: 1, failed: 1 });
    });
  });

  describe('startRunRelay', () => {
    let configDir: string;
    let cwd: string;
    beforeEach(() => {
      configDir = tmp('moag-rr-config-');
      cwd = tmp('moag-rr-cwd-');
    });

    function recording() {
      const bodies: Array<{ events: RelayEvent[] }> = [];
      const http: RelayHttpClient = async (req) => {
        const body = JSON.parse(req.body) as { events: RelayEvent[] };
        bodies.push(body);
        const acked: Record<string, number> = {};
        for (const e of body.events) { acked[e.run_id] = Math.max(acked[e.run_id] ?? 0, e.seq); }
        return { status: 200, body: JSON.stringify({ acked }) };
      };
      return { bodies, http };
    }
    const plan = { name: 'P', playlists: [{ tasks: [{ id: 'a', name: 'A' }] }] };
    const env = (): NodeJS.ProcessEnv => ({ MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: 'http://127.0.0.1:9', APPDATA: configDir, XDG_CONFIG_HOME: configDir });

    it('no key: returns null and never calls http', () => {
      let calls = 0;
      const started = startRunRelay({
        cwd, plan, env: { APPDATA: configDir, XDG_CONFIG_HOME: configDir }, buildRedactor: () => ({ redact: (s: string) => ({ text: s, count: 0 }) }),
        stderr: () => undefined, http: async () => { calls++; return { status: 200, body: '{}' }; },
      });
      assert.equal(started, null);
      assert.equal(calls, 0);
    });

    it('a key and URL: the first POST carries run-meta at seq 1', async () => {
      const rec = recording();
      const started = startRunRelay({
        cwd, plan, env: env(), buildRedactor: () => ({ redact: (s: string) => ({ text: s, count: 0 }) }), stderr: () => undefined,
        http: rec.http, closeDeadlineMs: 500,
      });
      assert.ok(started);
      assert.equal(started.key, KEY);
      await started.relay.close();
      assert.ok(rec.bodies.length > 0);
      const first = rec.bodies[0].events[0];
      assert.equal(first.type, 'run-meta');
      assert.equal(first.seq, 1);
      assert.deepEqual(first.data.tasks, [{ id: 'a', name: 'A' }]);
    });

    it('a throwing buildRedactor still starts, and run-meta carries redaction_failed', async () => {
      const rec = recording();
      const started = startRunRelay({
        cwd, plan, env: env(), buildRedactor: () => { throw new Error('no redactor'); }, stderr: () => undefined,
        http: rec.http, closeDeadlineMs: 500,
      });
      assert.ok(started);
      await started.relay.close();
      const first = rec.bodies[0].events[0];
      assert.equal(first.type, 'run-meta');
      assert.equal(first.data.redaction_failed, true);
    });
  });

  describe('takeRelayEnv', () => {
    it('returns both variables, removes them, and leaves the rest', () => {
      const env: NodeJS.ProcessEnv = { MOAG_ONOSOO_KEY: 'k', MOAG_ONOSOO_URL: 'u', PATH: '/bin' };
      assert.deepEqual(takeRelayEnv(env), { MOAG_ONOSOO_KEY: 'k', MOAG_ONOSOO_URL: 'u' });
      assert.deepEqual(env, { PATH: '/bin' });
    });

    it('is {} when neither is set', () => {
      const env: NodeJS.ProcessEnv = { PATH: '/bin' };
      assert.deepEqual(takeRelayEnv(env), {});
      assert.deepEqual(env, { PATH: '/bin' });
    });
  });

  describe('buildRunMeta', () => {
    it('package.json name, else the folder name; tasks flattened in plan order', () => {
      const dir = tmp('moag-rr-meta-');
      const plan = { name: 'P', playlists: [{ tasks: [{ id: 'a', name: 'A', prompt: 'x' }] }, { tasks: [{ id: 'b' }] }] };
      assert.deepEqual(buildRunMeta(plan, dir), { plan_name: 'P', project: path.basename(dir), tasks: [{ id: 'a', name: 'A' }, { id: 'b', name: '' }] });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@acme/app' }));
      assert.equal(buildRunMeta(plan, dir).project, '@acme/app');
      fs.writeFileSync(path.join(dir, 'package.json'), '{broken');
      assert.equal(buildRunMeta(plan, dir).project, path.basename(dir));
    });
  });
});
