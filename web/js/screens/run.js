// ─── /p/:id/run — live run, ship-gate card, halt banners (UX §2.7) ───
//
// The run view folds the same worker events the server folds (state,
// task-started/completed/failed, cost, manual-gate) as they arrive over SSE,
// updating rows in place so keyboard focus in the task tree is never lost.
// When the job ends the screen reloads the server's record, which is the
// source of truth for the exit code, the halt banner and allowed actions.

import { h, mount, clear, badge, glyph, toast, announce, confirmDialog, field, fmtTime, fmtUsd, fmtAgo } from '../dom.js';
import { STR, serverMessage } from '../strings.js';

const TASK_STATUS = {
  pending: { glyph: '○', label: 'Pending', badge: null },
  running: { glyph: '⟳', label: 'Running', badge: ['RUNNING', 'info'] },
  paused: { glyph: '⏸', label: 'Paused', badge: ['PAUSED', 'warning'] },
  completed: { glyph: '✓', label: 'Completed', badge: null },
  failed: { glyph: '✗', label: 'Failed', badge: ['FAILED', 'error'] },
  skipped: { glyph: '→', label: 'Skipped', badge: ['SKIPPED', 'muted'] },
  blocked: { glyph: '⊘', label: 'Blocked', badge: ['BLOCKED', 'warning'] },
};

const RUNNER_BADGE = {
  idle: ['IDLE', 'muted'],
  playing: ['● EXECUTING', 'info'],
  paused: ['⏸ PAUSED', 'warning'],
  stopping: ['STOPPING…', 'warning'],
};

const RUN_STATUS_BADGE = {
  'awaiting-approval': ['⏸ GATE', 'warning'],
  completed: ['✓ COMPLETE', 'success'],
  gaps: ['✗ GAPS', 'error'],
  error: ['✗ ERROR', 'error'],
  budget: ['⊘ COST CAP', 'warning'],
  stopped: ['STOPPED', 'muted'],
  'ship-rejected': ['SHIP REJECTED', 'muted'],
  interrupted: ['INTERRUPTED', 'warning'],
};

const TAIL_LINES = 6;

/** Fold one worker event into the live view (mirrors the server's foldRunEvent). */
export function foldEvent(view, ev) {
  switch (ev.event) {
    case 'state': return { ...view, runnerState: ev.state };
    case 'task-started': return { ...view, tasks: { ...view.tasks, [ev.id]: 'running' } };
    // task-completed also reports a skipped task, task-failed a blocked one.
    case 'task-completed': return { ...view, tasks: { ...view.tasks, [ev.id]: ev.status === 'skipped' ? 'skipped' : 'completed' } };
    case 'task-failed': return { ...view, tasks: { ...view.tasks, [ev.id]: ev.status === 'blocked' ? 'blocked' : 'failed' } };
    case 'cost': return { ...view, costUsd: view.costUsd + (Number(ev.usd) || 0) };
    case 'manual-gate': return { ...view, gate: { taskId: ev.id, name: ev.name }, haltReason: 'manual-gate' };
    case 'budget-exceeded': return { ...view, haltReason: view.haltReason || 'budget-exceeded' };
    default: return view;
  }
}

function lastLines(text, n) {
  const lines = String(text || '').split('\n');
  return lines.slice(-n).join('\n');
}

function elapsed(fromIso, toIso) {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) { return ''; }
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function render(app, params, view) {
  const pdto = app.project;
  const project = pdto.project;
  const base = `/p/${encodeURIComponent(project.id)}`;
  app.setTitle(`Run · ${project.name}`);
  const refresh = async () => { await app.refreshProject(project.id); app.rerender(); };

  if (!pdto.latestVersion) {
    mount(view, h('h1', null, 'Run'), h('div', { class: 'card empty' },
      h('p', null, STR.C2.text), h('a', { href: `${base}/prd`, dataset: { link: '' }, class: 'btn btn-primary' }, 'Open PRD')));
    return undefined;
  }

  const runs = pdto.runs || [];
  const run = runs.length > 0 ? runs[runs.length - 1] : null;
  const detail = pdto.currentRun;
  const runnable = (pdto.plans || []).find((p) => (p.allowedActions || []).includes('run.start'));

  if (!run) {
    mount(view, h('h1', null, 'Run'),
      pdto.runsDisabledReason ? h('div', { class: ['card', 'card-error'], role: 'alert' }, glyph('✗'), ' ', STR.C18.text) : null,
      h('div', { class: 'card' },
        h('p', null, badge('IDLE', 'muted'), ' No runs yet.'),
        runnable
          ? h('a', { href: `${base}/plan`, dataset: { link: '' }, class: 'btn btn-primary' }, 'Start run from the approved plan')
          : h('p', { class: 'muted' }, 'A run starts from a reviewer-approved plan.')));
    return undefined;
  }

  // ─── Live model ───
  const live = {
    view: run.view ? { ...run.view, tasks: { ...run.view.tasks } } : { runnerState: 'idle', tasks: {}, costUsd: 0, haltReason: null },
    spentUsd: run.cost ? run.cost.spentUsd : 0,
    warned: false,
  };
  const tasks = detail && detail.runId === run.id ? detail.tasks : [];
  const errorTails = detail && detail.runId === run.id ? { ...detail.errorTails } : {};
  const statusOf = (t) => live.view.tasks[t.id] || t.status || 'pending';
  const runNumber = runs.length;

  // ─── Header ───
  const stateBadgeHost = h('span');
  const stopHost = h('span');
  const renderHeaderState = () => {
    if (run.status === 'running') {
      const [label, kind] = RUNNER_BADGE[live.view.runnerState] || RUNNER_BADGE.playing;
      const b = badge(label, kind);
      if (live.view.runnerState === 'playing') { b.classList.add('pulse'); }
      mount(stateBadgeHost, b);
    } else {
      const [label, kind] = RUN_STATUS_BADGE[run.status] || [run.status.toUpperCase(), 'muted'];
      mount(stateBadgeHost, badge(label, kind));
    }
    clear(stopHost);
    const canStop = (run.allowedActions || []).includes('run.stop');
    if (run.status === 'running' && live.view.runnerState === 'stopping') {
      stopHost.appendChild(h('span', { class: 'muted' }, 'Stopping…'));
    } else if (canStop && ['playing', 'paused'].includes(live.view.runnerState)) {
      stopHost.appendChild(h('button', {
        type: 'button', class: 'btn btn-danger',
        title: live.view.runnerState === 'paused' ? 'Paused runs can be stopped here; resuming is not available in the web app.' : null,
        on: { click: stop },
      }, 'Stop'));
    }
  };

  const stop = async () => {
    const ok = await confirmDialog({ title: `Stop run #${runNumber}?`, text: STR.C16b.text, confirmLabel: 'Stop run', cancelLabel: 'Keep running', destructive: true });
    if (!ok) { return; }
    const r = await app.api('POST', `/api/projects/${encodeURIComponent(project.id)}/runs/${encodeURIComponent(run.id)}/stop`, {});
    if (!r.ok && r.status !== 403) { toast(serverMessage(r), 'error'); }
    await refresh();
  };

  // ─── Progress zone ───
  const progressHost = h('div', { class: 'progress-zone' });
  const renderProgress = () => {
    const total = tasks.length;
    const done = tasks.filter((t) => statusOf(t) === 'completed').length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const cost = run.cost || { noCap: true, capUsd: 0 };
    const parts = [
      h('span', null, `${done}/${total} tasks`),
      h('progress', { max: 100, value: pct, 'aria-label': 'Tasks completed' }),
      h('span', null, `${pct}%`),
    ];
    if (cost.noCap) {
      parts.push(h('span', null, `Cost ${fmtUsd(live.spentUsd)} · no cap set`));
    } else {
      const ratio = cost.capUsd > 0 ? live.spentUsd / cost.capUsd : 0;
      const bar = h('progress', { max: 100, value: Math.min(100, Math.round(ratio * 100)), 'aria-label': 'Cost cap used' });
      if (ratio >= 1) { bar.classList.add('cost-error'); } else if (ratio >= 0.8) { bar.classList.add('cost-warning'); }
      parts.push(h('span', null, `Cost ${fmtUsd(live.spentUsd)} of ${fmtUsd(cost.capUsd)} version cap`), bar, h('span', null, `${Math.round(ratio * 100)}%`));
      if (ratio >= 0.8 && !live.warned && run.status === 'running') { live.warned = true; announce('80% of the cost cap used.'); }
    }
    mount(progressHost, ...parts);
  };

  // ─── Task tree ───
  const rowEls = new Map();
  const tree = h('ul', { class: 'task-list', role: 'tree', 'aria-label': 'Run tasks' });
  const renderRow = (t) => {
    const s = statusOf(t);
    const info = TASK_STATUS[s] || TASK_STATUS.pending;
    const li = rowEls.get(t.id) || h('li', { role: 'treeitem', tabindex: '-1' });
    rowEls.set(t.id, li);
    li.className = `task-row task-${s}`;
    li.setAttribute('aria-label', `${t.name}: ${info.label}`);
    const tail = s === 'failed' && errorTails[t.id] ? lastLines(errorTails[t.id], TAIL_LINES) : null;
    if (tail) { li.setAttribute('aria-expanded', 'true'); } else { li.removeAttribute('aria-expanded'); }
    mount(li,
      glyph(info.glyph),
      h('span', { class: 'task-name', title: t.name }, t.name),
      h('span', null, info.badge ? badge(info.badge[0], info.badge[1]) : null, t.type === 'manual' ? [' ', badge('SHIP GATE', 'warning')] : null),
      h('span', { class: 'muted col-optional' }, t.type === 'agent' ? t.engine || '' : t.type),
      tail ? h('pre', { class: 'tail task-detail' }, tail) : null);
    return li;
  };
  const playlistExpanded = { value: true };
  const playlistHead = h('button', { type: 'button', class: 'playlist-head', 'aria-expanded': 'true' });
  const renderTree = () => {
    const done = tasks.filter((t) => statusOf(t) === 'completed').length;
    mount(playlistHead, glyph(playlistExpanded.value ? '▼' : '▸'), h('strong', null, (detail && detail.playlistName) || 'Plan'), h('span', { class: 'header-spacer' }), h('span', { class: 'muted' }, `${done}/${tasks.length}`));
    playlistHead.setAttribute('aria-expanded', String(playlistExpanded.value));
    clear(tree);
    tree.hidden = !playlistExpanded.value;
    tasks.forEach((t) => tree.appendChild(renderRow(t)));
    const items = [...tree.children];
    if (items.length > 0 && !items.some((x) => x.tabIndex === 0)) { items[0].tabIndex = 0; }
  };
  playlistHead.addEventListener('click', () => { playlistExpanded.value = !playlistExpanded.value; renderTree(); });
  tree.addEventListener('keydown', (e) => {
    const items = [...tree.children];
    const i = items.indexOf(document.activeElement);
    if (i < 0) { return; }
    let next = -1;
    if (e.key === 'ArrowDown') { next = Math.min(items.length - 1, i + 1); }
    else if (e.key === 'ArrowUp') { next = Math.max(0, i - 1); }
    else if (e.key === 'Home') { next = 0; }
    else if (e.key === 'End') { next = items.length - 1; }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); playlistExpanded.value = false; renderTree(); playlistHead.focus(); return; }
    else if (e.key === 'Enter' || e.key === 'ArrowRight') {
      const detailEl = items[i].querySelector('.task-detail');
      if (detailEl) { e.preventDefault(); detailEl.hidden = e.key === 'ArrowRight' ? false : !detailEl.hidden; items[i].setAttribute('aria-expanded', String(!detailEl.hidden)); }
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      items.forEach((x) => { x.tabIndex = -1; });
      items[next].tabIndex = 0;
      items[next].focus();
    }
  });

  // ─── Events log ───
  const events = detail && detail.runId === run.id ? [...detail.events] : [];
  const eventsSummary = h('summary', null, `Events  ${events.length}`);
  const eventsPre = h('pre', { class: 'events-log', 'aria-live': 'polite' });
  const renderEvents = () => {
    eventsSummary.textContent = `Events  ${events.length}`;
    eventsPre.textContent = events.slice(-200).map((e) => JSON.stringify(e)).join('\n');
  };

  // ─── Banners and the gate card ───
  const bannerHost = h('div');
  const renderBanner = () => mount(bannerHost, haltBanner(app, project, run, tasks, statusOf, live, runnable, base, refresh));

  const startedText = `started by ${run.startedByName || '—'} · ${fmtTime(run.startedAt)} · ${elapsed(run.startedAt, run.endedAt)}`;
  mount(view,
    h('div', { class: 'run-header' },
      h('h1', null, `Run #${runNumber} · PRD ${pdto.latestVersion.label} · ${project.defaultEngine}`),
      stateBadgeHost, h('span', { class: 'muted' }, startedText), h('span', { class: 'header-spacer' }), stopHost),
    progressHost,
    pdto.runsDisabledReason ? h('div', { class: ['card', 'card-error'], role: 'alert' }, glyph('✗'), ' ', STR.C18.text) : null,
    bannerHost,
    h('div', { class: 'card' }, playlistHead, tree,
      h('details', { class: 'diff-group' }, eventsSummary, eventsPre)));
  renderHeaderState();
  renderProgress();
  renderTree();
  renderEvents();
  renderBanner();
  const gateHeading = bannerHost.querySelector('[data-focus="gate"]');
  if (gateHeading) { gateHeading.focus(); }

  if (run.status !== 'running') { return undefined; }

  // ─── Live updates ───
  const onEvent = (n) => {
    const ev = n.event;
    if (!ev || typeof ev.event !== 'string') { return; }
    events.push(ev);
    renderEvents();
    if (ev.event === 'task-error-tail') { errorTails[ev.id] = ev.tail; }
    if (ev.event === 'cost') { live.spentUsd += Number(ev.usd) || 0; }
    live.view = foldEvent(live.view, ev);
    if (ev.event === 'task-completed' && ev.status === 'skipped') { announce(`${ev.name} skipped.`, { key: 'skipped', plural: (k) => `${k} tasks skipped.` }); }
    else if (ev.event === 'task-completed') { announce(`${ev.name} completed.`, { assertive: true, key: 'done', plural: (k) => `${k} tasks completed.` }); }
    if (ev.event === 'task-failed' && ev.status === 'blocked') { announce(`${ev.name} blocked.`, { assertive: true, key: 'blocked', plural: (k) => `${k} tasks blocked.` }); }
    else if (ev.event === 'task-failed') { announce(`${ev.name} failed.`, { assertive: true, key: 'failed', plural: (k) => `${k} tasks failed.` }); }
    if (ev.event === 'manual-gate') { announce(`Halted at the ship gate: ${ev.name}.`, { assertive: true }); }
    const t = tasks.find((x) => x.id === ev.id);
    if (t) { renderRow(t); }
    renderHeaderState();
    renderProgress();
    if (ev.event === 'state') { void refreshRunActions(); }
  };
  // Stop is offered from the server's allowedActions, which depend on the runner state.
  const refreshRunActions = async () => {
    const r = await app.api('GET', `/api/projects/${encodeURIComponent(project.id)}`);
    const fresh = r.ok && Array.isArray(r.body.runs) ? r.body.runs.find((x) => x.id === run.id) : null;
    if (fresh) { run.allowedActions = fresh.allowedActions; renderHeaderState(); }
  };
  return app.connectEvents(project.id, {
    snapshot: (d) => {
      if (d && d.view && d.activeJob === 'run') {
        // A resumed segment's snapshot covers only its own tasks: layer it over what we know.
        live.view = { ...d.view, tasks: { ...live.view.tasks, ...d.view.tasks } };
        renderTree();
        renderHeaderState();
      } else if (d && d.activeJob === null) {
        // The run ended while we were away: reload the record.
        void refresh();
      }
    },
    event: onEvent,
    end: () => { announce('The run ended.', { assertive: true }); void refresh(); },
  });
}

function haltBanner(app, project, run, tasks, statusOf, live, runnable, base, refresh) {
  const failed = tasks.filter((t) => ['failed', 'blocked'].includes(statusOf(t)));
  const notRun = tasks.filter((t) => ['pending', 'blocked', 'skipped'].includes(statusOf(t))).length;
  const canEditCap = (project.allowedActions || []).includes('project.update');
  const lastDecision = (run.gateDecisions || []).slice(-1)[0];
  switch (run.status) {
    case 'awaiting-approval':
      return gateCard(app, project, run, tasks, statusOf, live, refresh);
    case 'budget':
      return h('div', { class: ['card', 'card-warning'], role: 'status' },
        h('h2', null, glyph('⊘'), ' Run stopped: cost cap reached'),
        h('p', null, `${fmtUsd(live.spentUsd)} of ${fmtUsd(run.cost ? run.cost.capUsd : 0)} spent on this PRD version. ${notRun} task${notRun === 1 ? '' : 's'} did not run.`),
        h('div', { class: 'inline-row' },
          canEditCap ? h('a', { href: `${base}/settings`, dataset: { link: '' }, class: 'btn btn-secondary' }, 'Edit cost cap') : null,
          runnable ? h('a', { href: `${base}/plan`, dataset: { link: '' }, class: 'btn btn-primary' }, 'Start run') : null));
    case 'gaps':
      return h('div', { class: ['card', 'card-error'], role: 'status' },
        h('h2', null, glyph('✗'), ' Run finished with gaps'),
        failed.length > 0 ? h('ul', { class: 'diff-list' }, failed.map((t) => h('li', null, `${t.name} — ${(TASK_STATUS[statusOf(t)] || TASK_STATUS.pending).label}`))) : null);
    case 'error':
      return h('div', { class: ['card', 'card-error'], role: 'status' },
        h('h2', null, glyph('✗'), ' Run could not continue'),
        run.errorTail ? h('pre', { class: 'tail' }, run.errorTail) : null);
    case 'completed':
      return h('div', { class: ['card', 'card-success'], role: 'status' },
        h('h2', null, glyph('✓'), ' Run complete'),
        h('p', null, 'See ', h('a', { href: `${base}/trace`, dataset: { link: '' } }, 'Trace'), ' for what shipped.'));
    case 'stopped':
      return h('div', { class: 'card', role: 'status' }, h('p', null, `Run stopped${run.stoppedByName ? ` by ${run.stoppedByName}` : ''}. Completed tasks stay completed.`));
    case 'ship-rejected':
      return h('div', { class: 'card', role: 'status' },
        h('p', null, STR.C16d.text),
        lastDecision ? h('p', { class: 'muted' }, `Rejected by ${lastDecision.byName || '—'} · ${fmtTime(lastDecision.at)}${lastDecision.note ? ` · "${lastDecision.note}"` : ''}`) : null);
    case 'interrupted':
      return h('div', { class: ['card', 'card-warning'], role: 'status' }, h('p', null, 'This run was interrupted by a server restart. Start it again from the plan.'));
    default:
      return null;
  }
}

function gateCard(app, project, run, tasks, statusOf, live, refresh) {
  const allowed = new Set(run.allowedActions || []);
  const gate = run.gate || { name: 'Ship gate', taskId: '' };
  const gateIndex = tasks.findIndex((t) => t.id === gate.taskId);
  const before = gateIndex >= 0 ? tasks.slice(0, gateIndex) : [];
  const beforeDone = before.filter((t) => statusOf(t) === 'completed').length;
  const after = (app.project.currentRun && app.project.currentRun.afterGate) || [];
  const heading = h('h2', { tabindex: '-1', dataset: { focus: 'gate' } }, glyph('⏸'), ' Awaiting ship approval');
  const note = field({ label: 'Note', hint: 'Required to reject.', input: h('input', { type: 'text', maxlength: 2000 }) });
  const me = (app.session.user.displayName || app.session.user.username);
  const url = (action) => `/api/projects/${encodeURIComponent(project.id)}/runs/${encodeURIComponent(run.id)}/gate/${action}`;

  const conflict = async (r) => {
    if (r.status === 409 && r.body.lastDecision) {
      const d = r.body.lastDecision;
      const verb = d.action === 'approve' ? 'approved' : d.action === 'reject' ? 'rejected' : 'skipped';
      toast(STR.C22(verb, '', fmtTime(d.at)).text, 'warning');
    } else if (r.status !== 403) {
      toast(serverMessage(r), 'error');
    }
    await refresh();
  };

  const approve = async () => {
    const ok = await confirmDialog({ title: 'Approve and ship?', text: STR.C16c(gate.name, me).text, confirmLabel: 'Approve and ship' });
    if (!ok) { return; }
    const text = note.input.value.trim();
    const r = await app.api('POST', url('approve'), text ? { note: text } : {});
    if (!r.ok) { await conflict(r); return; }
    toast('Approved. The run is resuming.', 'success');
    await refresh();
  };
  const reject = async () => {
    note.setError('');
    const text = note.input.value.trim();
    if (!text) { note.setError('A note is required to reject.'); note.input.focus(); return; }
    const ok = await confirmDialog({ title: 'Reject the ship?', text: STR.C16d.text, confirmLabel: 'Reject', destructive: true });
    if (!ok) { return; }
    const r = await app.api('POST', url('reject'), { note: text });
    if (!r.ok) { await conflict(r); return; }
    toast(STR.C16d.text, 'success');
    await refresh();
  };
  const skip = async () => {
    const res = await confirmDialog({
      title: 'Skip the ship gate?', text: STR.C16e.text, confirmLabel: 'Skip gate', destructive: true,
      field: { label: 'Reason', required: true, multiline: true },
    });
    if (!res) { return; }
    const r = await app.api('POST', url('skip'), { reason: res.value });
    if (!r.ok) { await conflict(r); return; }
    toast('Gate skipped. The run is resuming.', 'warning');
    await refresh();
  };

  const canDecide = allowed.has('gate.approve') || allowed.has('gate.reject');
  const approversLine = h('p', { class: 'muted' }, 'Waiting for an approver.');
  if (!canDecide) {
    void app.api('GET', '/api/users/approvers').then((r) => {
      if (r.ok && Array.isArray(r.body.approvers)) {
        approversLine.textContent = `Waiting for an approver. Approvers: ${r.body.approvers.map((a) => a.username).join(', ') || 'none — ask an admin to assign one'}.`;
      }
    });
  }
  const cost = run.cost || { noCap: true };
  return h('section', { class: ['card', 'card-warning'] },
    h('div', { class: 'card-head' }, heading, h('span', { class: 'header-spacer' }), badge('GATE', 'warning')),
    h('p', null, `"${gate.name}" is waiting for an approver. Halted ${run.endedAt ? fmtAgo(run.endedAt) : 'just now'}.`),
    h('p', null, `${beforeDone}/${before.length} tasks before the gate completed.`),
    h('p', null, cost.noCap ? `Cost so far ${fmtUsd(live.spentUsd)} · no cap set` : `Cost so far ${fmtUsd(live.spentUsd)} of ${fmtUsd(cost.capUsd)}`),
    after.length > 0 ? h('p', null, `Tasks that run after approval: ${after.join(', ')}`) : null,
    canDecide ? [note.wrap,
      h('div', { class: 'form-actions gate-actions' },
        allowed.has('gate.reject') ? h('button', { type: 'button', class: 'btn btn-danger', on: { click: reject } }, 'Reject') : null,
        allowed.has('gate.approve') ? h('button', { type: 'button', class: 'btn btn-primary', on: { click: approve } }, 'Approve and ship') : null)]
      : approversLine,
    allowed.has('gate.skip') ? [h('hr', { class: 'panel-divider' }),
      h('button', { type: 'button', class: 'btn-link', on: { click: skip } }, 'Skip gate without approval…')] : null);
}
