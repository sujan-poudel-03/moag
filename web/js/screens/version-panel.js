// ─── Version diff panel (UX §2.5) ───
//
// One panel per PRD version: added / changed / removed requirement IDs, the
// recommended bump with its rationale (verbatim from the core), the override
// selector (latest version only, options from the server-sent SEMVER_BUMPS),
// and the plan request — "Request delta plan" for a version with a scope, or
// "Generate initial plan" for the first version. Each control renders only
// when its action is in the DTO's `allowedActions`.

import { h, badge, glyph, confirmDialog, toast, announce, fmtTime, fmtUsd } from '../dom.js';
import { STR, serverMessage } from '../strings.js';

const LIST_CAP = 50;

/** Next label after `prev` for `bump` (mirrors the core's semver rule, for confirm copy only). */
export function bumpLabel(prev, bump) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(prev || ''));
  if (!m) { return null; }
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === 'major') { maj += 1; min = 0; pat = 0; }
  else if (bump === 'minor') { min += 1; pat = 0; }
  else { pat += 1; }
  return `v${maj}.${min}.${pat}`;
}

const BUMP_KIND = { major: 'error', minor: 'info', patch: 'muted' };

function capText(spend) {
  return spend && !spend.noCap ? `${fmtUsd(spend.capUsd)} cost cap` : 'project spend (no cost cap is set)';
}

/** A capped list with "Show all N". */
function cappedList(items, renderItem) {
  const ul = h('ul', { class: 'diff-list' });
  const renderUpTo = (n) => {
    while (ul.firstChild) { ul.removeChild(ul.firstChild); }
    for (const it of items.slice(0, n)) { ul.appendChild(renderItem(it)); }
    if (items.length > n) {
      ul.appendChild(h('li', null, h('button', { type: 'button', class: 'btn-link', on: { click: () => renderUpTo(items.length) } }, `Show all ${items.length}`)));
    }
  };
  renderUpTo(LIST_CAP);
  return ul;
}

function diffGroup(title, items, renderItem) {
  return h('details', { class: 'diff-group', open: items.length > 0 },
    h('summary', null, `${title}  ${items.length}`),
    items.length > 0 ? cappedList(items, renderItem) : null);
}

function diffBlock(diff) {
  return h('div', null,
    diffGroup('Added', diff.added, (a) => h('li', null,
      h('span', { class: 'text-success', 'aria-hidden': 'true' }, '+ '), h('span', { class: 'sr-only' }, 'Added: '),
      h('span', { class: 'diff-id' }, a.id), a.text)),
    diffGroup('Changed', diff.changed, (c) => h('li', null,
      h('span', { class: 'text-info', 'aria-hidden': 'true' }, '~ '), h('span', { class: 'sr-only' }, 'Changed: '),
      h('span', { class: 'diff-id' }, c.id), c.after,
      h('details', null, h('summary', null, 'show before/after'),
        h('div', { class: 'before-after' },
          h('pre', { class: 'before', 'aria-label': 'Before' }, c.before),
          h('pre', { class: 'after', 'aria-label': 'After' }, c.after))))),
    diffGroup('Removed', diff.removed, (r) => h('li', null,
      h('span', { class: 'text-error', 'aria-hidden': 'true' }, '− '), h('span', { class: 'sr-only' }, 'Removed: '),
      h('span', { class: 'diff-id removed-id' }, r.id), r.text)));
}

/**
 * Render the panel for `versions[index]`.
 * @param {object} app
 * @param {{ projectId: string, dto: object, index: number, onChanged: () => void }} ctx
 * @returns {{ el: HTMLElement, heading: HTMLElement }}
 */
export function renderVersionPanel(app, ctx) {
  const { dto, index, projectId } = ctx;
  const versions = dto.versions;
  const v = versions[index];
  const isLatest = index === versions.length - 1;
  const allowed = new Set(dto.allowedActions || []);
  const heading = h('h2', { tabindex: '-1', class: 'version-heading' }, v.label);
  const parts = [];

  parts.push(h('div', { class: 'card-head' }, heading, h('span', { class: 'header-spacer' }),
    h('span', { class: 'muted' }, v.savedBy ? `saved by ${v.savedBy.by} · ${fmtTime(v.savedBy.at)}` : fmtTime(v.createdAt))));

  if (!v.diff) {
    parts.push(h('p', { class: 'muted' }, 'First version. No previous version to compare.'));
  } else {
    if (v.recommendedBump) {
      parts.push(h('p', null, badge(v.recommendedBump.toUpperCase(), BUMP_KIND[v.recommendedBump] || 'muted'), ' recommended'));
    }
    if (v.rationale) { parts.push(h('p', null, v.rationale)); }
    parts.push(diffBlock(v.diff));
  }

  if (v.override) {
    const after = v.override.after || {};
    parts.push(h('p', { class: 'muted' },
      `Overridden: chosen ${String(after.chosenBump || '').toUpperCase()}, recommended ${String(after.recommended || '').toUpperCase()} · ${v.override.by} · ${fmtTime(v.override.at)}`));
  }

  // ─── Override (latest only) ───
  if (isLatest && v.recommendedBump && index > 0) {
    if (allowed.has('prd.bump-override')) {
      parts.push(h('hr', { class: 'panel-divider' }));
      parts.push(overrideRow(app, ctx, v, versions[index - 1]));
    } else if (dto.overrideLocked) {
      parts.push(h('p', { class: 'muted' }, STR.C9.text));
    }
  }

  // ─── Plan request (latest only) ───
  if (isLatest) {
    parts.push(h('hr', { class: 'panel-divider' }));
    parts.push(planRow(app, ctx, v));
  }

  return { el: h('section', { class: 'card version-panel', 'aria-label': `Version ${v.label}` }, parts), heading };
}

function overrideRow(app, ctx, v, prev) {
  const { dto, projectId } = ctx;
  const select = h('select', { id: 'bump-select', 'aria-label': 'Version bump' },
    (dto.bumps || []).map((b) => h('option', { value: b, selected: b === (v.chosenBump || v.recommendedBump) }, b)));
  const apply = async () => {
    const bump = select.value;
    if (bump === (v.chosenBump || v.recommendedBump)) { toast(`${v.label} already uses ${bump}.`, 'info'); return; }
    const to = bumpLabel(prev.version, bump) || 'the new label';
    const ok = await confirmDialog({
      title: 'Change the version bump?',
      text: STR.C6(v.label, to, bump, v.recommendedBump).text,
      confirmLabel: `Change to ${bump}`,
    });
    if (!ok) { return; }
    const r = await app.api('POST', `/api/projects/${encodeURIComponent(projectId)}/prd/versions/latest/bump`, { bump, expectedCreatedAt: v.createdAt });
    if (!r.ok) {
      toast(r.body.error === 'locked' ? STR.C9.text : serverMessage(r), 'error');
      ctx.onChanged();
      return;
    }
    const msg = STR.C7(v.label, r.body.label).text;
    toast(msg, 'success');
    announce(msg);
    ctx.onChanged();
  };
  return h('div', { class: 'inline-row' },
    h('label', { for: 'bump-select' }, 'Version bump'), select,
    h('span', { class: 'muted' }, `Recommended: ${v.recommendedBump}`),
    h('button', { type: 'button', class: 'btn btn-secondary', on: { click: apply } }, 'Apply'));
}

function planRow(app, ctx, v) {
  const { dto, projectId } = ctx;
  const allowed = new Set(dto.allowedActions || []);
  const planLink = h('a', { href: `/p/${encodeURIComponent(projectId)}/plan`, dataset: { link: '' } }, 'Open plan');

  if (dto.openPlan) {
    return h('p', null, glyph('○'), ` A plan for this version is ${dto.openPlan.status}. `, planLink);
  }

  const generate = async (mode, ids, count) => {
    const ok = await confirmDialog({
      title: mode === 'initial' ? 'Generate the initial plan?' : 'Request a delta plan?',
      text: STR.C8(count, ids, dto.engine, capText(dto.spend)).text,
      confirmLabel: 'Generate plan',
    });
    if (!ok) { return; }
    const r = await app.api('POST', `/api/projects/${encodeURIComponent(projectId)}/plans`, { mode });
    if (!r.ok) { toast(serverMessage(r), 'error'); ctx.onChanged(); return; }
    toast('Plan generation started. A reviewer approves it before it can run.', 'success');
    app.navigate(`/p/${encodeURIComponent(projectId)}/plan`);
  };

  if (dto.versions.length === 1) {
    const reqCount = dto.requirementCount || 0;
    if (allowed.has('plan.generate-initial')) {
      return h('div', null,
        h('p', null, 'This is the first version. Generate a plan covering every requirement in it.'),
        h('div', { class: 'inline-row' },
          h('span', { class: 'muted' }, `Uses ${dto.engine} (project default)`), h('span', { class: 'header-spacer' }),
          h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => generate('initial', reqCount > 0 ? `all ${reqCount}` : 'all requirements', reqCount) } }, 'Generate initial plan')));
    }
    return h('p', { class: 'muted' }, dto.runsDisabledReason ? STR.C18.text : STR.C14.text);
  }

  const scope = dto.deltaScope;
  if (!scope) {
    if (v.diff && v.diff.added.length + v.diff.changed.length === 0) {
      return h('p', { class: 'muted' }, 'No added or changed requirements. Removed requirements don\'t create tasks.');
    }
    return h('p', { class: 'muted' }, STR.C10.text);
  }
  const added = scope.added.map((a) => a.id);
  const changed = scope.changed.map((c) => c.id);
  const ids = [...added, ...changed];
  const summary = [added.length ? `${added.join(', ')} added` : '', changed.length ? `${changed.join(', ')} changed` : ''].filter(Boolean).join(' · ');
  return h('div', null,
    h('p', null, `${ids.length} requirement${ids.length === 1 ? '' : 's'} in scope (${summary})`),
    h('div', { class: 'inline-row' },
      h('span', { class: 'muted' }, `Uses ${dto.engine} (project default)`), h('span', { class: 'header-spacer' }),
      allowed.has('plan.generate')
        ? h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => generate('delta', ids.join(', '), ids.length) } }, 'Request delta plan')
        : h('span', { class: 'muted' }, dto.runsDisabledReason ? STR.C18.text : 'Waiting for a product owner to request a plan.')));
}
