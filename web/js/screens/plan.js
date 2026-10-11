// ─── /p/:id/plan — plan review and the approved-plan card (UX §2.6) ───
//
// A generated playlist is shown to the reviewer exactly as it would run: every
// task, every non-agent command verbatim (from the server's
// validatePendingPlaylist), and every task the validator dropped. Approve
// echoes the `contentHash` the reviewer saw, so a plan that changed underneath
// them is refused (409) rather than approved.

import { h, mount, badge, glyph, toast, announce, confirmDialog, fmtTime, fmtUsd, field } from '../dom.js';
import { STR, serverMessage } from '../strings.js';
import { standardsBlockedCard } from './version-panel.js';
import { tokenTable, designDoc } from './design-view.js';

const STATUS_BADGE = {
  generating: ['GENERATING', 'info'],
  pending: ['PENDING REVIEW', 'warning'],
  approved: ['APPROVED', 'success'],
  ran: ['APPROVED · RAN', 'success'],
  rejected: ['REJECTED', 'muted'],
  cancelled: ['CANCELLED', 'muted'],
  interrupted: ['INTERRUPTED', 'warning'],
  'no-delta': ['NOTHING TO PLAN', 'muted'],
  'engine-failed': ['ENGINE FAILED', 'error'],
  'parse-failed': ['UNREADABLE', 'error'],
  'all-rejected': ['ALL DROPPED', 'warning'],
};

const TYPE_LABEL = { manual: 'manual', command: 'command', check: 'check', release: 'release', deploy: 'deploy' };

function planName(p) {
  return (p.playlist && p.playlist.name) || `PRD ${p.forVersionLabel ? `v${String(p.forVersionLabel).replace(/^v/, '')}` : ''} ${p.mode}`.trim();
}

function taskRows(tasks) {
  return h('ul', { class: 'task-list' }, tasks.map((t) => h('li', { class: 'task-row' },
    glyph(t.type === 'manual' ? '⏸' : '○'),
    h('span', { class: 'task-name', title: t.name }, t.name),
    h('span', { class: 'muted diff-id' }, (t.requirementIds || []).join(', ')),
    h('span', null, h('span', { class: 'muted' }, t.type ? TYPE_LABEL[t.type] || t.type : 'agent'),
      t.type === 'manual' ? [' ', badge('SHIP GATE', 'warning')] : null))));
}

/** The server's dependency-install rule, so the reviewer sees it before approving (null when the server sent none). */
function dependencyInstallNote(p) {
  return p.dependencyInstall ? h('p', { class: 'muted', role: 'note' }, glyph('ⓘ'), ' ', p.dependencyInstall.text) : null;
}

/** Warning shown when the repo ships engine config that an approved run would load (null when none). */
function repoConfigWarning(entries) {
  if (!Array.isArray(entries) || entries.length === 0) { return null; }
  const names = entries.map((e) => (e.endsWith('.json') ? e : `${e}/`)).join(', ');
  return h('div', { class: ['card', 'card-warning'], role: 'note' }, glyph('⚠'), ' ', STR.C29(names).text);
}

function blockedText(app, reason, engine) {
  if (reason === 'runs-disabled') { return STR.C18.text; }
  if (reason === 'job-active') { return STR.C19.text; }
  if (reason === 'engine-unavailable') { return STR.C17(engine, app.can('users.manage')).text; }
  if (reason === 'engine-changed') { return STR.C30(engine).text; }
  if (reason === 'standards-not-approved') { return STR.C46.text; }
  if (reason === 'review-errors') { return STR.C60.text; }
  if (reason === 'budget-exhausted') { return 'The cost cap for this PRD version is used up. A product owner or admin can raise it in Settings.'; }
  return 'Ready to run. Waiting for a reviewer or admin to start it.';
}

export function render(app, params, view) {
  const pdto = app.project;
  const project = pdto.project;
  app.setTitle(`Plan · ${project.name}`);
  const base = `/p/${encodeURIComponent(project.id)}`;
  const refresh = async () => { await app.refreshProject(project.id); app.rerender(); };

  if (!pdto.latestVersion) {
    mount(view, h('h1', null, 'Plan'), h('div', { class: 'card empty' },
      h('p', null, STR.C2.text), h('a', { href: `${base}/prd`, dataset: { link: '' }, class: 'btn btn-primary' }, 'Open PRD')));
    return;
  }

  const plans = [...(pdto.plans || [])].reverse();
  const current = plans[0] || null;
  const parts = [h('h1', null, 'Plan')];
  if (pdto.runsDisabledReason) { parts.push(h('div', { class: ['card', 'card-error'], role: 'alert' }, glyph('✗'), ' ', STR.C18.text)); }

  if (!current) {
    parts.push(h('div', { class: 'card' }, h('p', null, 'No plan has been requested yet. '),
      // Without approved standards the PRD screen offers no request: show why, here too.
      project.standards && !project.standards.effectiveVersion
        ? standardsBlockedCard(project.id, project.standards)
        : h('a', { href: `${base}/prd`, dataset: { link: '' } }, 'Request one from the PRD screen')));
  } else {
    parts.push(planCard(app, project, current, refresh));
  }

  if (plans.length > 1) {
    parts.push(h('details', { class: 'card' },
      h('summary', null, `Earlier plans (${plans.length - 1})`),
      h('ul', { class: 'diff-list' }, plans.slice(1).map((p) => {
        const [label, kind] = STATUS_BADGE[p.status] || [p.status.toUpperCase(), 'muted'];
        return h('li', null, badge(label, kind), ' ', planName(p), h('span', { class: 'muted' }, ` · requested by ${p.requestedByName || '—'} · ${fmtTime(p.requestedAt)}`),
          p.reason ? h('span', { class: 'muted' }, ` · "${p.reason}"`) : null);
      }))));
  }

  const cp = pdto.currentPlan || { playlists: [] };
  const taskCount = cp.playlists.reduce((n, pl) => n + pl.tasks.length, 0);
  parts.push(h('details', { class: 'card' },
    h('summary', null, `Current plan (${cp.playlists.length} playlist${cp.playlists.length === 1 ? '' : 's'} · ${taskCount} task${taskCount === 1 ? '' : 's'})`),
    cp.playlists.map((pl) => h('div', null, h('h3', null, pl.name), taskRows(pl.tasks)))));

  mount(view, ...parts);

  // While a plan generates, refresh when the job ends.
  if (current && current.status === 'generating') {
    return app.connectEvents(project.id, { end: () => { void refresh(); } });
  }
  return undefined;
}

function planCard(app, project, p, refresh) {
  const allowed = new Set(p.allowedActions || []);
  const [label, kind] = STATUS_BADGE[p.status] || [p.status.toUpperCase(), 'muted'];
  const name = planName(p);
  const tasks = p.playlist && Array.isArray(p.playlist.tasks) ? p.playlist.tasks : [];
  const head = h('div', { class: 'card-head' }, h('h2', null, name), h('span', { class: 'header-spacer' }), badge(label, kind));
  const meta = h('p', { class: 'muted' }, `Requested by ${p.requestedByName || '—'} · ${fmtTime(p.requestedAt)} · ${p.engine}${tasks.length ? ` · ${tasks.length} tasks` : ''}`);
  const projectPath = `/p/${encodeURIComponent(project.id)}`;
  const isPo = (app.session.user.roles || []).includes('product-owner');

  /** The standards version the plan was generated under, and a notice when a newer one is in effect. */
  const standardsLines = () => {
    const link = h('a', { href: `${projectPath}/standards`, dataset: { link: '' } }, 'Open standards');
    if (!p.standardsVersion) {
      return h('p', { class: 'muted' }, 'Standards: none. This plan was generated before the project had standards.');
    }
    const who = h('span');
    // The version's design system, shown inline (the router has no deep link into a version).
    const designHost = h('div');
    // Who approved it is on the standards resource; fill it in when it arrives.
    void app.api('GET', `/api/projects/${encodeURIComponent(project.id)}/standards`, undefined, { quiet: true }).then((r) => {
      const all = r.ok && r.body.standards && Array.isArray(r.body.standards.versions) ? r.body.standards.versions : [];
      const v = all.find((x) => x.version === p.standardsVersion);
      if (v && v.status === 'approved') {
        who.textContent = ` · ${v.decision === 'accepted-defaults' ? 'defaults accepted' : 'approved'} by ${v.decidedByName || '—'} · ${fmtTime(v.decidedAt)}`;
      }
      // The card may have been replaced while the request ran: fill only a placeholder still on screen.
      const d = v && v.design;
      if (!d || !designHost.isConnected) { return; }
      const tokens = Array.isArray(d.tokens) ? d.tokens : [];
      const kit = v.profile && v.profile.frontend && v.profile.frontend.componentKit;
      mount(designHost,
        h('p', null, `Design system: ${tokens.length} token${tokens.length === 1 ? '' : 's'} · `, h('span', { class: 'mono' }, d.tokensPath || '—'), kit ? ` · kit ${kit}` : ''),
        h('details', { class: 'diff-group' },
          h('summary', null, 'Show design system'),
          tokenTable(tokens, { caption: `Standards v${v.version} design tokens` }),
          designDoc(d.doc, `DESIGN.md, standards v${v.version}`)));
    });
    const now = project.standards ? project.standards.effectiveVersion : null;
    return [
      h('p', null, `Standards v${p.standardsVersion}`, who, ' ', link),
      designHost,
      now && now !== p.standardsVersion
        ? h('p', { class: 'text-warning' }, glyph('⚠'), ' ', STR.C38(p.standardsVersion, now).text) : null,
    ];
  };

  const tryAgain = isPo ? h('button', { type: 'button', class: 'btn btn-secondary', on: { click: async () => {
    const r = await app.api('POST', `/api/projects/${encodeURIComponent(project.id)}/plans`, { mode: p.mode });
    if (!r.ok) {
      // "Try again" is offered by role, so it can meet the standards gate: explain it (C31), not the raw refusal.
      const blocked = r.status === 409 && r.body.error === 'standards-not-approved';
      toast(blocked ? STR.C31(r.body.pendingVersion, r.body.pendingVersion && r.body.state === 'pending' ? 'pending' : 'none').text : serverMessage(r), 'error');
      return;
    }
    toast('Plan generation started again.', 'success');
    await refresh();
  } } }, 'Try again') : null;

  const cancelBtn = allowed.has('plan.cancel') ? h('button', { type: 'button', class: 'btn btn-secondary', on: { click: async () => {
    const r = await app.api('POST', `/api/projects/${encodeURIComponent(project.id)}/plans/${encodeURIComponent(p.id)}/cancel`, {});
    if (!r.ok) { toast(serverMessage(r), 'error'); }
    await refresh();
  } } }, 'Cancel') : null;

  switch (p.status) {
    case 'generating':
      return h('section', { class: ['card', 'card-info'], 'aria-live': 'polite' },
        h('div', { class: 'card-head' }, h('h2', null, glyph('⟳'), ` Generating ${p.mode} plan with ${p.engine}…`)),
        h('p', null, `Started ${fmtTime(p.requestedAt)} by ${p.requestedByName || '—'}. This usually takes a few minutes. You can leave this page.`),
        cancelBtn ? h('div', { class: 'form-actions' }, cancelBtn) : null);

    case 'pending': {
      const review = p.review || { ok: true, errors: [], commands: [] };
      const reason = field({ label: 'Rejection reason', input: h('input', { type: 'text', maxlength: 2000 }) });
      const canDecide = allowed.has('plan.approve') || allowed.has('plan.reject');
      const approve = async () => {
        const ok = await confirmDialog({ title: 'Approve this plan?', text: STR.C15(name, tasks.length).text, confirmLabel: 'Approve plan' });
        if (!ok) { return; }
        const r = await app.api('POST', `/api/projects/${encodeURIComponent(project.id)}/plans/${encodeURIComponent(p.id)}/approve`, { contentHash: p.contentHash });
        if (!r.ok) {
          if (r.status === 409 && r.body.error === 'already-decided') {
            toast(STR.C22(r.body.status || 'decided', '', r.body.decidedAt ? fmtTime(r.body.decidedAt) : '').text, 'warning');
          } else if (r.status === 409 && r.body.error === 'standards-not-approved') {
            toast(STR.C46.text, 'error');
          } else if (r.status !== 403) { toast(serverMessage(r), 'error'); }
          await refresh();
          return;
        }
        announce('Plan approved.');
        toast('Plan approved.', 'success');
        await refresh();
      };
      const reject = async () => {
        reason.setError('');
        const text = reason.input.value.trim();
        if (!text) { reason.setError('A reason is required to reject.'); reason.input.focus(); return; }
        const r = await app.api('POST', `/api/projects/${encodeURIComponent(project.id)}/plans/${encodeURIComponent(p.id)}/reject`, { reason: text });
        if (!r.ok) { if (r.status !== 403) { toast(serverMessage(r), 'error'); } await refresh(); return; }
        toast(STR.C16.text, 'success');
        await refresh();
      };
      return h('section', { class: ['card', 'card-warning'] },
        head, meta,
        standardsLines(),
        repoConfigWarning(app.project.repoEngineConfig),
        taskRows(tasks),
        dependencyInstallNote(p),
        review.commands && review.commands.length > 0 ? h('div', null,
          h('h3', { class: 'section-header' }, `Commands and side effects (${review.commands.length})`),
          h('p', { class: 'muted' }, 'Shown exactly as written. Review them: commands run in the project workspace; health-check URLs are fetched; skip conditions and failure policies change what runs; an incident repo receives the GitHub issues a monitor task files.'),
          h('ul', { class: 'diff-list' }, review.commands.map((c) => h('li', null,
            h('span', null, `${c.taskName} (${c.taskType}) · ${c.field}`),
            h('pre', { class: 'tail' }, c.value))))) : null,
        review.stripped && review.stripped.length > 0 ? h('details', { class: 'diff-group' },
          h('summary', null, `Removed by the server  ${review.stripped.length}`),
          h('p', { class: 'muted' }, 'Generated plans may not set environment variables, inherit env files, or create and push release tags.'),
          h('ul', { class: 'diff-list' }, review.stripped.map((s) => h('li', null, `${s.taskName} · ${s.field}`)))) : null,
        !review.ok ? h('div', { class: ['card', 'card-error'], role: 'alert' },
          h('p', null, 'This plan cannot be approved:'),
          h('ul', { class: 'diff-list' }, review.errors.map((e) => h('li', null, e)))) : null,
        p.rejected && p.rejected.length > 0 ? h('details', { class: 'diff-group' },
          h('summary', null, `Dropped by validation  ${p.rejected.length}`),
          h('ul', { class: 'diff-list' }, p.rejected.map((r) => h('li', null, `"${r.taskName}" — ${r.reason}`)))) : null,
        canDecide ? h('div', null, reason.wrap,
          h('div', { class: 'form-actions' },
            cancelBtn,
            allowed.has('plan.reject') ? h('button', { type: 'button', class: 'btn btn-danger', on: { click: reject } }, 'Reject plan') : null,
            allowed.has('plan.approve') && review.ok ? h('button', { type: 'button', class: 'btn btn-primary', on: { click: approve } }, 'Approve plan') : null))
          : h('p', { class: 'muted' }, 'Waiting for a reviewer to approve.', cancelBtn ? ' ' : '', cancelBtn));
    }

    case 'approved':
    case 'ran': {
      const start = async () => {
        const capLeft = app.project.spend && !app.project.spend.noCap
          ? `Cost cap left: ${fmtUsd(app.project.spend.remainingUsd)}.`
          : 'No cost cap is set.';
        const ok = await confirmDialog({
          title: 'Start the run?', text: STR.C16a(tasks.length, project.defaultEngine, project.name, capLeft).text, confirmLabel: 'Start run',
        });
        if (!ok) { return; }
        const r = await app.api('POST', `/api/projects/${encodeURIComponent(project.id)}/runs`, { planId: p.id });
        if (!r.ok) {
          if (r.status === 409 && r.body.error === 'standards-not-approved') { toast(STR.C46.text, 'error'); }
          else if (r.status !== 403) { toast(serverMessage(r), 'error'); }
          await refresh();
          return;
        }
        toast('Run started.', 'success');
        app.navigate(`${projectPath}/run`);
      };
      return h('section', { class: ['card', 'card-success'] },
        head,
        h('p', { class: 'muted' }, `Approved by ${p.decidedByName || '—'} · ${fmtTime(p.decidedAt)}`),
        standardsLines(),
        allowed.has('run.start') ? repoConfigWarning(app.project.repoEngineConfig) : null,
        taskRows(tasks),
        dependencyInstallNote(p),
        allowed.has('run.start')
          ? h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn btn-primary', on: { click: start } }, 'Start run'))
          : h('p', { class: p.startBlockedReason && p.startBlockedReason !== 'job-active' ? 'text-warning' : 'muted' },
            blockedText(app, p.startBlockedReason, project.defaultEngine),
            p.startBlockedReason === 'job-active' ? [' ', h('a', { href: `${projectPath}/run`, dataset: { link: '' } }, 'Open run')] : null,
            p.startBlockedReason === 'standards-not-approved' ? [' ', h('a', { href: `${projectPath}/standards`, dataset: { link: '' } }, 'Open standards')] : null,
            p.startBlockedReason === 'engine-unavailable' && app.can('users.manage') ? [' ', h('span', { class: 'muted' }, 'Check the engine on the server.')] : null),
        // What the review rules say today, one per line: the reason no Start run is offered.
        !allowed.has('run.start') && p.startBlockedReason === 'review-errors' && Array.isArray(p.startBlockedErrors) && p.startBlockedErrors.length > 0
          ? h('ul', { class: 'diff-list', role: 'alert' }, p.startBlockedErrors.map((e) => h('li', null, e))) : null);
    }

    case 'rejected':
      return h('section', { class: 'card' }, head,
        h('p', null, `Rejected by ${p.decidedByName || '—'} · ${fmtTime(p.decidedAt)}`),
        p.reason ? h('p', null, `Reason: ${p.reason}`) : null,
        isPo ? h('a', { href: `${projectPath}/prd`, dataset: { link: '' }, class: 'btn btn-secondary' }, 'Request a new delta plan') : null);

    case 'no-delta':
      return h('section', { class: 'card' }, head, h('p', null, glyph('○'), ' ', STR.C10.text));
    case 'engine-failed':
    case 'parse-failed':
      return h('section', { class: ['card', 'card-error'] }, head,
        h('p', null, glyph('✗'), ' ', p.status === 'engine-failed' ? STR.C11.text : STR.C12.text),
        p.error ? h('pre', { class: 'tail' }, p.error) : null,
        tryAgain ? h('div', { class: 'form-actions' }, tryAgain) : null);
    case 'all-rejected':
      return h('section', { class: ['card', 'card-warning'] }, head,
        h('p', null, glyph('⊘'), ' ', STR.C13.text),
        h('ul', { class: 'diff-list' }, (p.rejected || []).map((r) => h('li', null, `"${r.taskName}" — ${r.reason}`))),
        tryAgain ? h('div', { class: 'form-actions' }, tryAgain) : null);
    default:
      return h('section', { class: 'card' }, head,
        h('p', { class: 'muted' }, p.status === 'cancelled' ? 'Plan generation was cancelled.' : 'Plan generation was interrupted by a server restart.'),
        tryAgain ? h('div', { class: 'form-actions' }, tryAgain) : null);
  }
}
