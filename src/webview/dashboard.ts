// ─── Dashboard webview script ───────────────────────────────────────────────
//
// Runs in the webview, not the extension host. Compiled by tsconfig.webview.json
// and loaded with <script src>. It used to live inside a template literal in
// ui/dashboard-panel.ts, where the compiler never saw it.
//
// The two values the host used to interpolate now arrive through a JSON block the
// page carries as DATA, so nothing executable is inlined back in.

/** Provided by the VS Code webview runtime. */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// Declaration merging rather than a cast at every call site — see webview/sidebar.ts.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the compiler uses this; eslint cannot see declaration merging
interface Document {
  getElementById(elementId: string): any;
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): any;
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- declaration merging, as above
interface Element {
  closest(selectors: string): any;
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): any;
}

/** The page stamps its own build id so a stale webview can be detected. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- declaration merging
interface Window { __moagHtmlVersion?: string; }

/** Values the host hands the page as data, read once at startup. */
const MOAG_BOOTSTRAP: { htmlVersion: string; stateBase64: string } = JSON.parse(
  document.getElementById('moag-bootstrap')?.textContent || '{}',
);
const vscode = acquireVsCodeApi();
window.__moagHtmlVersion = MOAG_BOOTSTRAP.htmlVersion;

function decodeBase64Utf8(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
  return new TextDecoder().decode(bytes);
}

// ─── State ───
const cardState = {};
let currentTaskId = null;
let completedOrder = [];
let completedTasks = [];
const completedExpandedState = {};
let showAllCompletedCards = false;
let totalTasks = 0;
let completedCount = 0;
let failedCount = 0;
let blockedCount = 0;
let totalFilesChanged = 0;
let runStartTime = null;
let taskStartTime = null;
let elapsedInterval = null;
let currentPlan = null;
let lastPlanHash = '';
let dashboardState = 'idle'; // 'idle' | 'executing' | 'complete'
let runnerState = 'idle';
let promptBusy = false;
let composerBusyAction = '';
let promptEngines = [];
let selectedPromptEngineId = '';
const taskStartTimes = {};
const promptComposerEl = document.getElementById('prompt-composer');
const promptInputEl = document.getElementById('prompt-input');
const promptEngineEl = document.getElementById('prompt-engine');
const promptSubmitEl = document.getElementById('prompt-submit');
const promptGeneratePlanEl = document.getElementById('prompt-generate-plan');
const promptAddTaskEl = document.getElementById('prompt-add-task');
const promptAddPlaylistEl = document.getElementById('prompt-add-playlist');
const promptContextPillEl = document.getElementById('prompt-context-pill');
const promptContextNoteEl = document.getElementById('prompt-context-note');
const promptCharCountEl = document.getElementById('prompt-char-count');

// ─── Toolbar ───
if (promptSubmitEl) { promptSubmitEl.onclick = submitPromptFromComposer; }
if (promptGeneratePlanEl) { promptGeneratePlanEl.onclick = generatePlanFromComposer; }
if (promptAddTaskEl) { promptAddTaskEl.onclick = function() { vscode.postMessage({ type: 'addTask' }); }; }
if (promptAddPlaylistEl) { promptAddPlaylistEl.onclick = function() { vscode.postMessage({ type: 'addPlaylist' }); }; }
if (promptInputEl) {
  promptInputEl.addEventListener('input', function() {
    autoResizePromptInput();
    updatePromptCharCount();
    renderPromptComposerState();
  });
  promptInputEl.addEventListener('keydown', function(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submitPromptFromComposer();
    }
  });
}
if (promptEngineEl) {
  promptEngineEl.addEventListener('change', function() {
    selectedPromptEngineId = promptEngineEl.value;
    renderPromptComposerState();
    renderEngineStatus();
  });
}
document.getElementById('btn-play').onclick = () => vscode.postMessage({ type: 'play' });
document.getElementById('btn-pause').onclick = () => vscode.postMessage({ type: 'pause' });
document.getElementById('btn-stop').onclick = () => vscode.postMessage({ type: 'stop' });
let summaryPlayBtn = document.getElementById('plan-summary-play');
if (summaryPlayBtn) { summaryPlayBtn.onclick = () => vscode.postMessage({ type: 'play' }); }
// ─── State Machine ───
function setDashboardState(newState) {
  if (newState !== 'idle' && newState !== 'executing' && newState !== 'complete') {
    newState = 'idle';
  }
  dashboardState = newState;
  document.body.dataset.dashboardState = newState;

  let progressSection = document.getElementById('progress-section');
  let activeTask = document.getElementById('active-task');
  let planSummary = document.getElementById('plan-summary');
  let noPlanMessage = document.getElementById('no-plan-message');
  let resultBanner = document.getElementById('result-banner');
  let completedSection = document.getElementById('completed-section');
  let errorBanner = document.getElementById('error-banner');
  let sandboxSection = document.getElementById('sandbox-section');
  let hasPlan = hasPlanLoaded();

  // Hide all dashboard sections first.
  if (progressSection) { progressSection.hidden = true; }
  if (activeTask) {
    activeTask.hidden = true;
    activeTask.classList.remove('visible');
  }
  if (planSummary) { planSummary.hidden = true; }
  if (noPlanMessage) { noPlanMessage.hidden = true; }
  if (resultBanner) { resultBanner.hidden = true; }
  if (completedSection) { completedSection.hidden = true; }
  if (errorBanner) { errorBanner.hidden = true; }
  if (sandboxSection) { sandboxSection.hidden = true; }

  if (newState === 'executing') {
    if (progressSection) { progressSection.hidden = false; }
    if (activeTask) {
      activeTask.hidden = false;
      activeTask.classList.add('visible');
    }
    return;
  }

  if (progressSection) { progressSection.hidden = false; }

  if (newState === 'complete') {
    renderResultBanner();
    if (completedSection) { completedSection.hidden = false; }
    if (resultBanner && resultBanner.style.display !== 'none') { resultBanner.hidden = false; }
    if (errorBanner && errorBanner.textContent && errorBanner.textContent.trim()) {
      errorBanner.hidden = false;
    }
    return;
  }

  let promptComposerSection = document.getElementById('prompt-composer');
  if (promptComposerSection) { promptComposerSection.hidden = true; }
  if (hasPlan) {
    if (planSummary) { planSummary.hidden = false; }
  } else {
    // Show quick composer when no plan is loaded
    if (promptComposerSection) { promptComposerSection.hidden = false; }
    if (noPlanMessage) { noPlanMessage.hidden = false; }
  }
  if (sandboxSection) { sandboxSection.hidden = false; }
  if (errorBanner && errorBanner.textContent && errorBanner.textContent.trim()) {
    errorBanner.hidden = false;
  }
}

// ─── Utilities ───

function getTaskStats(tasks) {
  return tasks.reduce(function(stats, task) {
    switch (task.status) {
      case 'completed': stats.completed++; break;
      case 'failed': stats.failed++; break;
      case 'blocked': stats.blocked++; break;
      case 'running': stats.running++; break;
      case 'skipped': stats.skipped++; break;
      default: stats.pending++; break;
    }
    return stats;
  }, { total: tasks.length, pending: 0, running: 0, completed: 0, failed: 0, blocked: 0, skipped: 0 });
}

function hasPlanLoaded() { return !!(currentPlan && currentPlan.playlists && currentPlan.playlists.length > 0); }

function findRunningOrNextTask(plan) {
  if (!plan || !Array.isArray(plan.playlists)) {
    return null;
  }
  for (let i = 0; i < plan.playlists.length; i++) {
    let runningPlaylist = plan.playlists[i];
    let runningTasks = Array.isArray(runningPlaylist.tasks) ? runningPlaylist.tasks : [];
    for (let ri = 0; ri < runningTasks.length; ri++) {
      let rt = runningTasks[ri];
      if (String(rt && rt.status || '').toLowerCase() === 'running') {
        return {
          phase: 'running',
          playlistName: runningPlaylist.name || ('Playlist ' + (i + 1)),
          task: rt,
          playlist: runningPlaylist,
        };
      }
    }
  }

  for (let j = 0; j < plan.playlists.length; j++) {
    let pendingPlaylist = plan.playlists[j];
    let pendingTasks = Array.isArray(pendingPlaylist.tasks) ? pendingPlaylist.tasks : [];
    for (let pi = 0; pi < pendingTasks.length; pi++) {
      let pt = pendingTasks[pi];
      let s = String(pt && pt.status || '').toLowerCase();
      if (!s || s === 'pending' || s === 'queued' || s === 'todo') {
        return {
          phase: 'queued',
          playlistName: pendingPlaylist.name || ('Playlist ' + (j + 1)),
          task: pt,
          playlist: pendingPlaylist,
        };
      }
    }
  }
  return null;
}

function autoResizePromptInput() {
  if (!promptInputEl) { return; }
  promptInputEl.style.height = 'auto';
  const minHeight = 118;
  const maxHeight = 240;
  promptInputEl.style.height = Math.min(Math.max(promptInputEl.scrollHeight, minHeight), maxHeight) + 'px';
}

function updatePromptCharCount() {
  if (!promptInputEl || !promptCharCountEl) { return; }
  promptCharCountEl.textContent = promptInputEl.value.length + ' chars | Ctrl+Enter';
}

function syncPromptEngineOptions(engines, preferredId) {
  if (!promptEngineEl) {
    promptEngines = Array.isArray(engines) ? engines : [];
    renderEngineStatus();
    return;
  }
  promptEngines = Array.isArray(engines) ? engines : [];
  const currentValue = selectedPromptEngineId || promptEngineEl.value;
  const preferredValue = typeof preferredId === 'string' ? preferredId : '';
  const resolvedValue = promptEngines.some(function(engine) { return engine.id === currentValue; })
    ? currentValue
    : (promptEngines.some(function(engine) { return engine.id === preferredValue; })
      ? preferredValue
      : (promptEngines[0] ? promptEngines[0].id : ''));

  promptEngineEl.textContent = '';

  if (promptEngines.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No engines detected';
    promptEngineEl.appendChild(option);
    selectedPromptEngineId = '';
  } else {
    promptEngines.forEach(function(engine) {
      const option = document.createElement('option');
      option.value = engine.id;
      option.textContent = engine.label;
      promptEngineEl.appendChild(option);
    });
    selectedPromptEngineId = resolvedValue;
    promptEngineEl.value = resolvedValue;
  }

  renderPromptComposerState();
  renderEngineStatus();
}

function renderEngineStatus() {
  let el = document.getElementById('engine-status');
  if (!el) { return; }
  if (!promptEngines || promptEngines.length === 0) {
    el.innerHTML = '<span style="color:var(--dimmed)">No supported engines detected.</span>';
    return;
  }
  let selected = promptEngines.find(function(engine) { return engine.id === selectedPromptEngineId; }) || promptEngines[0];
  let otherEngines = promptEngines.filter(function(engine) { return engine.id !== selected.id; }).map(function(engine) { return engine.label; });
  let extra = otherEngines.length > 0 ? ' <span style="color:var(--dimmed)">(also available: ' + escHtml(otherEngines.join(', ')) + ')</span>' : '';
  el.innerHTML = '<span>Engine: <strong>' + escHtml(selected.label) + '</strong></span>' + extra;
}

function submitPromptFromComposer() {
  if (!promptInputEl || !promptSubmitEl) { return; }
  const prompt = promptInputEl.value.trim();
  if (!prompt || promptSubmitEl.disabled) {
    return;
  }

  promptBusy = true;
  composerBusyAction = 'run';
  renderPromptComposerState();
  vscode.postMessage({
    type: 'submit-prompt',
    prompt: prompt,
    engineId: selectedPromptEngineId || undefined,
  });
}

function generatePlanFromComposer() {
  if (!promptInputEl || !promptGeneratePlanEl) { return; }
  const prompt = promptInputEl.value.trim();
  if (!prompt || promptGeneratePlanEl.disabled) {
    return;
  }

  promptBusy = true;
  composerBusyAction = 'plan';
  renderPromptComposerState();
  vscode.postMessage({
    type: 'generate-plan',
    prompt: prompt,
  });
}

function clearPromptComposer() {
  if (!promptInputEl) { return; }
  promptInputEl.value = '';
  autoResizePromptInput();
  updatePromptCharCount();
  renderPromptComposerState();
  if (runnerState === 'idle' && promptEngines.length > 0) {
    promptInputEl.focus();
  }
}

function renderPromptComposerState() {
  if (
    !promptComposerEl ||
    !promptInputEl ||
    !promptEngineEl ||
    !promptSubmitEl ||
    !promptGeneratePlanEl ||
    !promptAddTaskEl ||
    !promptAddPlaylistEl ||
    !promptContextPillEl ||
    !promptContextNoteEl
  ) {
    return;
  }
  const hasEngines = promptEngines.length > 0;
  const isIdle = runnerState === 'idle';
  const hasPrompt = !!promptInputEl.value.trim();
  const canType = isIdle && !promptBusy;
  const canRunPrompt = canType && hasEngines && hasPrompt;
  const canGeneratePlan = canType && hasPrompt;
  const canManagePlan = canType && hasPlanLoaded();

  promptComposerEl.classList.toggle('compact', !isIdle);
  promptInputEl.disabled = !canType;
  promptEngineEl.disabled = !canType || !hasEngines;
  promptSubmitEl.disabled = !canRunPrompt;
  promptGeneratePlanEl.disabled = !canGeneratePlan;
  promptAddTaskEl.disabled = !canManagePlan;
  promptAddPlaylistEl.disabled = !canManagePlan;
  promptSubmitEl.textContent = composerBusyAction === 'run' ? 'Running...' : 'Run Prompt';
  promptGeneratePlanEl.innerHTML = composerBusyAction === 'plan' ? '&#128393; Generating...' : '&#128393; Generate Plan';
  promptContextPillEl.textContent = hasPlanLoaded() ? 'Current plan' : 'One-off run';

  if (!hasEngines) {
    promptContextNoteEl.textContent = 'No engines detected. Plan generation still works, but running a prompt needs an installed engine.';
  } else if (!isIdle) {
    promptContextNoteEl.textContent = 'Runner is active. Stop the current run to submit another prompt.';
  } else if (hasPlanLoaded()) {
    promptContextNoteEl.textContent = 'Run the prompt, generate a plan from this chat, or add tasks and playlists to the current plan.';
  } else {
    promptContextNoteEl.textContent = 'No plan loaded. You can still run a one-off prompt or generate a plan from this chat.';
  }
}

// ─── Result Banner ───
function renderResultBanner() {
  let el = document.getElementById('result-banner');
  if (!el || !currentPlan) { if (el) el.style.display = 'none'; return; }
  let tasks = currentPlan.playlists.flatMap(function(pl) { return pl.tasks || []; });
  let passed = tasks.filter(function(t) { return t.status === 'completed'; }).length;
  let failed = tasks.filter(function(t) { return t.status === 'failed'; }).length;
  if (passed === 0 && failed === 0) { el.style.display = 'none'; return; }

  let hasFailures = failed > 0;
  el.className = 'result-banner ' + (hasFailures ? 'has-failures' : 'success');
  el.style.display = '';
  el.innerHTML =
    '<div class="result-banner-title">' + passed + ' passed' + (failed > 0 ? ', ' + failed + ' failed' : '') + ' \u2014 ' + totalFilesChanged + ' files changed</div>' +
    '<div class="result-banner-actions">' +
      '<button class="result-banner-btn" onclick="vscode.postMessage({type:\'review-changes\'})" style="background:rgba(78,201,176,0.18);color:var(--success);border-color:rgba(78,201,176,0.4);">Review Changes</button>' +
      (hasFailures ? '<button class="result-banner-btn" onclick="vscode.postMessage({type:\'retry-failed\'})" style="background:rgba(220,160,50,0.18);color:#e8a838;border-color:rgba(220,160,50,0.4);">Retry Failed</button>' : '') +
      '<button class="result-banner-btn" onclick="vscode.postMessage({type:\'export-results\'})" style="background:rgba(128,128,128,0.1);color:var(--dimmed);border-color:var(--border);">Export</button>' +
    '</div>';
}

function renderIdleOverview(plan) {
  let summaryEl = document.getElementById('plan-summary');
  let noPlanEl = document.getElementById('no-plan-message');
  let nameEl = document.getElementById('plan-summary-name');
  let descEl = document.getElementById('plan-summary-desc');
  let playlistsEl = document.getElementById('plan-summary-playlists');
  let totalEl = document.getElementById('plan-summary-total');
  let playBtn = document.getElementById('plan-summary-play');
  if (!summaryEl || !noPlanEl || !nameEl || !descEl || !playlistsEl || !totalEl || !playBtn) { return; }

  if (!plan || !Array.isArray(plan.playlists) || plan.playlists.length === 0) {
    summaryEl.hidden = true;
    noPlanEl.hidden = false;
    return;
  }

  summaryEl.hidden = false;
  noPlanEl.hidden = true;

  nameEl.textContent = plan.name || 'Untitled Plan';
  let description = typeof plan.description === 'string' ? plan.description.trim() : '';
  if (description) {
    descEl.hidden = false;
    descEl.textContent = description;
  } else {
    descEl.hidden = true;
    descEl.textContent = '';
  }

  let totalTasksInPlan = 0;
  playlistsEl.innerHTML = plan.playlists.map(function(pl, idx) {
    let tasks = Array.isArray(pl.tasks) ? pl.tasks : [];
    totalTasksInPlan += tasks.length;
    let done = tasks.filter(function(t) {
      let status = String(t && t.status || '').toLowerCase();
      return status === 'completed' || status === 'failed' || status === 'blocked' || status === 'skipped';
    }).length;
    let playlistName = escHtml(pl.name || ('Playlist ' + (idx + 1)));
    return '<div class="plan-summary-pl"><span>' + playlistName + '</span><span>' + done + '/' + tasks.length + ' done</span></div>';
  }).join('');
  totalEl.textContent = totalTasksInPlan + ' tasks across ' + plan.playlists.length + ' playlists';
  playBtn.disabled = runnerState === 'playing';
}

// ─── Message Handler ───
window.addEventListener('message', function(event) {
  const msg = event.data;
  switch (msg.type) {
    case 'update': {
      try {
        let incomingPlan = msg.plan || null;
        if (incomingPlan) {
          currentPlan = incomingPlan;
        }
        let planForRender = currentPlan;
        let planPlaylists = (planForRender && planForRender.playlists) ? planForRender.playlists : [];
        let newHash = planForRender
          ? planForRender.name + '|' + planPlaylists.map(function(pl) {
            return [pl.name||'', pl.engine||'', pl.parallel?'parallel':'sequential',
              (pl.tasks||[]).map(function(t) { return [t.id||'',t.name||'',t.status||'pending'].join(':'); }).join(',')
            ].join('|');
          }).join('||') : '';
        let shouldRenderPlan = newHash !== lastPlanHash;
        syncPromptEngineOptions(msg.promptEngines || [], msg.selectedPromptEngineId);
        if (shouldRenderPlan) {
          lastPlanHash = newHash;
          renderPlan(planForRender);
        }
        renderPlaylistTiles(planForRender);
        renderPills(planForRender);
        syncActiveTaskFromPlan(planForRender);
        updateProgress();
        renderStatus(msg.runnerState);
      } catch(e) {
        console.error('[MOAG Dashboard] Update error:', e);
        const incomingPlan = msg.plan || null;
        if (incomingPlan) {
          currentPlan = incomingPlan;
        }
        syncPromptEngineOptions(msg.promptEngines || [], msg.selectedPromptEngineId);
        renderPlan(currentPlan);
        renderPlaylistTiles(currentPlan);
        renderPills(currentPlan);
        syncActiveTaskFromPlan(currentPlan);
        updateProgress();
        renderStatus(msg.runnerState || 'idle');
      }
      break;
    }
    case 'clear-output':
    case 'clear-timeline':
      resetExecution();
      break;
    case 'start-task-card':
      startTask(msg);
      break;
    case 'output': {
      const targetId = msg.taskId || currentTaskId;
      if (targetId) { appendOutput(targetId, msg.text, msg.stream); }
      break;
    }
    case 'complete-task-card':
      completeTask(msg);
      break;
    case 'composer-action-state':
      promptBusy = !!msg.busy;
      composerBusyAction = msg.busy ? (typeof msg.action === 'string' ? msg.action : '') : '';
      renderPromptComposerState();
      break;
    case 'composer-action-success':
      promptBusy = false;
      composerBusyAction = '';
      if (msg.action === 'run' || msg.action === 'plan') {
        clearPromptComposer();
      }
      break;
    case 'engine-fallback': {
      const targetId = currentTaskId;
      if (targetId) {
        const fallbackText = '[MOAG] Switching from ' + msg.fromEngine + ' to ' + msg.toEngine + ' due to rate limit';
        const st = cardState[targetId];
        if (st) { st.output += '\\n' + fallbackText + '\\n'; }
        const outputEl = document.getElementById('active-output');
        if (outputEl && targetId === currentTaskId) {
          clearActiveOutputPlaceholder();
          const span = document.createElement('span');
          span.style.color = 'var(--warning)';
          span.style.fontWeight = '600';
          span.textContent = '\\n' + fallbackText + '\\n';
          outputEl.appendChild(span);
          outputEl.scrollTop = outputEl.scrollHeight;
        }
      }
      break;
    }
    case 'context-memory':
      renderContextMemory(msg);
      break;
    case 'sandbox-state':
      renderSandboxPanel(msg.sandboxState);
      break;
    case 'sandbox-output': {
      let sbOut = document.getElementById('sandbox-output');
      let sbWrap = document.getElementById('sandbox-output-wrap');
      if (sbOut && sbWrap) {
        sbWrap.hidden = false;
        sbOut.textContent = (sbOut.textContent + msg.text).slice(-2000);
        sbOut.scrollTop = sbOut.scrollHeight;
      }
      break;
    }
  }
  // Also handle sandboxState in update messages
  if (msg.type === 'update' && msg.sandboxState) {
    renderSandboxPanel(msg.sandboxState);
  }
});

// ─── Context Memory Panel ───

function renderContextMemory(msg) {
  let section = document.getElementById('ctx-mem-section');
  let body = document.getElementById('ctx-mem-body');
  let count = document.getElementById('ctx-mem-count');
  if (!section || !body) { return; }

  let sections = msg.sections || [];
  let totalUsed = msg.totalCharsUsed || 0;
  let totalBudget = msg.totalCharsBudget || 1;
  let pct = Math.round((totalUsed / totalBudget) * 100);
  let dropped = msg.sectionsDropped || 0;
  let files = msg.retrievedFiles || [];

  section.hidden = false;
  if (count) { count.textContent = pct + '% used'; }

  let isStale = runnerState !== 'playing' && runnerState !== 'stopping';
  let staleLabel = isStale ? ' <span class="ctx-mem-stale">(last run)</span>' : '';
  let html = '<div class="ctx-mem-task">' + (msg.taskName || '') + staleLabel + '</div>';
  sections.forEach(function(s) {
    let sPct = Math.round((s.chars / totalBudget) * 100);
    html += '<div class="ctx-mem-row">' +
      '<span class="ctx-mem-name">' + s.name + '</span>' +
      '<div class="ctx-mem-bar-wrap"><div class="ctx-mem-bar" style="width:' + sPct + '%"></div></div>' +
      '<span class="ctx-mem-chars">' + s.chars.toLocaleString() + '</span>' +
      '</div>';
  });
  html += '<div class="ctx-mem-total">' +
    '<span>Total</span>' +
    '<span class="ctx-mem-total-pct">' + totalUsed.toLocaleString() + ' / ' + totalBudget.toLocaleString() + ' chars (' + pct + '%)</span>' +
    '</div>';
  if (dropped > 0) {
    html += '<div class="ctx-mem-dropped">&#9888; ' + dropped + ' section' + (dropped > 1 ? 's' : '') + ' dropped (budget exceeded)</div>';
  }
  if (files.length > 0) {
    html += '<div class="ctx-mem-files">Retrieved: ' + files.map(function(f) {
      return f.split(/[/\\]/).pop();
    }).join(', ') + '</div>';
  }
  body.innerHTML = html;
}

// ─── Sandbox Panel ───

function renderSandboxPanel(state) {
  if (!state) { return; }
  let dot = document.getElementById('sandbox-dot');
  let label = document.getElementById('sandbox-status-label');
  let badge = document.getElementById('sandbox-status-badge');
  let framework = document.getElementById('sandbox-framework');
  let urlEl = document.getElementById('sandbox-url');
  let btnLaunch = document.getElementById('sandbox-btn-launch');
  let btnStop = document.getElementById('sandbox-btn-stop');
  let screenshotWrap = document.getElementById('sandbox-screenshot-wrap');
  let screenshotImg = document.getElementById('sandbox-screenshot-img');
  let errorBannerEl = document.getElementById('sandbox-error-banner');
  let errorMsgEl = document.getElementById('sandbox-error-msg');
  let errorHintEl = document.getElementById('sandbox-error-hint');
  let sectionBody = document.getElementById('body-sandbox');

  if (!dot) { return; }

  let isError = state.status === 'error';

  // Auto-expand section on error so user always sees the failure
  if (isError && sectionBody && sectionBody.classList.contains('collapsed')) {
    sectionBody.classList.remove('collapsed');
    let icon = sectionBody.previousElementSibling && sectionBody.previousElementSibling.querySelector('.section-toggle-icon');
    if (icon) { icon.textContent = '▼'; }
  }

  // Status dot
  dot.className = 'sandbox-status-dot ' + (state.status || 'stopped');

  // Status label — show 'Error' text in header row, full message in banner
  let labelMap = { stopped: 'Stopped', starting: 'Starting…', running: 'Running', error: 'Error' };
  label.textContent = labelMap[state.status] || state.status;
  badge.textContent = state.status === 'running' ? '●' : (isError ? '!' : '');

  // Error banner
  if (isError && state.error) {
    errorBannerEl.classList.add('visible');
    errorMsgEl.textContent = state.error;
    // Generate an actionable hint based on the error text
    let hint = '';
    if (/detect|package\.json|pubspec/i.test(state.error)) {
      hint = 'Fix: add "sandbox": {"command": "npm run dev"} to your plan JSON, or run from a project folder with a package.json.';
    } else if (/timed out/i.test(state.error)) {
      hint = 'Fix: verify the command runs manually in terminal. Set a custom "sandbox.command" in your plan JSON if the default detection is wrong.';
    } else if (/exited with code/i.test(state.error)) {
      hint = 'Fix: check the sandbox output log above for the crash reason. The server process started but failed immediately.';
    } else if (/ENOENT|not found|Cannot find/i.test(state.error)) {
      hint = 'Fix: the command was not found. Make sure the tool is installed (e.g. npm install) and available in PATH.';
    }
    errorHintEl.textContent = hint;
    errorHintEl.hidden = !hint;
  } else {
    errorBannerEl.classList.remove('visible');
  }

  // Framework label
  if (state.projectInfo) {
    framework.textContent = state.projectInfo.framework || '';
  }

  // URL link
  if (state.url) {
    urlEl.textContent = state.url;
    urlEl.dataset.url = state.url;
    urlEl.hidden = false;
    urlEl.title = 'Open in VS Code Simple Browser: ' + state.url;
  } else {
    urlEl.hidden = true;
  }

  // Buttons
  let running = state.status === 'running' || state.status === 'starting';
  btnLaunch.hidden = running;
  btnStop.hidden = !running;

  // Screenshot
  if (state.lastScreenshotPath) {
    screenshotImg.src = state.lastScreenshotPath;
    screenshotImg.alt = 'Last screenshot';
    screenshotWrap.hidden = false;
  } else {
    screenshotWrap.hidden = true;
  }
}

// ─── Execution Logic ───

function resetExecution() {
  Object.keys(cardState).forEach(function(k) { delete cardState[k]; });
  Object.keys(taskStartTimes).forEach(function(k) { delete taskStartTimes[k]; });
  currentTaskId = null;
  completedOrder = [];
  completedTasks = [];
  Object.keys(completedExpandedState).forEach(function(k) { delete completedExpandedState[k]; });
  showAllCompletedCards = false;
  completedCount = 0;
  failedCount = 0;
  blockedCount = 0;
  totalFilesChanged = 0;
  runStartTime = null;
  taskStartTime = null;
  stopTimer();
  document.getElementById('active-task-name').textContent = '';
  document.getElementById('active-output').textContent = '';
  document.getElementById('active-engine').textContent = '';
  document.getElementById('active-engine').className = 'engine-badge engine-custom';
  document.getElementById('active-timer').textContent = '0s';
  let detailsEl = document.getElementById('active-task-details');
  if (detailsEl) { detailsEl.open = false; }
  let detailsContent = document.getElementById('active-task-details-content');
  if (detailsContent) { detailsContent.textContent = ''; }
  renderCompletedCards();
  updateProgress();
  renderResultBanner();
  updateStatusSummary('Ready');
  updateStatusRight('');
  setDashboardState('idle');
}

function getActiveRuntimeLabel(task) {
  if (task.engine) { return task.engine; }
  if (task.taskType && task.taskType !== 'agent') { return task.taskType; }
  return 'agent';
}

function getExecutionEtaText(effectiveCompleted) {
  if (!runStartTime || totalTasks === 0) { return ''; }
  const processedTasks = effectiveCompleted > 0 ? effectiveCompleted : (currentTaskId ? 1 : 0);
  if (processedTasks === 0) { return 'ETA --'; }
  const remainingTasks = Math.max(totalTasks - effectiveCompleted, 0);
  const elapsedMs = Date.now() - runStartTime;
  const etaMs = Math.round((elapsedMs / processedTasks) * remainingTasks);
  return 'ETA ~' + formatDuration(Math.max(etaMs, 0));
}

function showActiveOutputPlaceholder(text) {
  const outputEl = document.getElementById('active-output');
  outputEl.textContent = '';
  const hint = document.createElement('div');
  hint.className = 'active-output-empty';
  hint.textContent = text;
  outputEl.appendChild(hint);
}

function updateStatusSummary(text) {
  let el = document.getElementById('status-summary');
  if (el) { el.textContent = text || 'Ready'; }
}
function updateStatusRight(text) {
  let el = document.getElementById('status-right');
  if (el) { el.textContent = text || ''; }
}

function clearActiveOutputPlaceholder() {
  const hint = document.querySelector('#active-output .active-output-empty');
  if (hint) { hint.remove(); }
}

function startTask(msg) {
  if (!runStartTime) { runStartTime = Date.now(); startTimer(); }
  taskStartTime = Date.now();
  taskStartTimes[msg.taskId] = Date.now();
  currentTaskId = msg.taskId;
  cardState[msg.taskId] = {
    output: '', engine: msg.engine || '', taskType: msg.taskType || 'agent',
    command: msg.command || '', playlistName: msg.playlistName || '',
    durationMs: 0, exitCode: null, status: 'running',
    changedFiles: null, codeChanges: null, verification: null, artifacts: null, validationTargetResults: null, summary: '',
  };
  document.getElementById('active-task-name').textContent = msg.taskName;
  const engineEl = document.getElementById('active-engine');
  engineEl.textContent = getActiveRuntimeLabel(msg);
  engineEl.className = 'engine-badge engine-' + (msg.engine || 'custom');
  document.getElementById('active-timer').textContent = '0s';
  let detailsParts = [];
  if (msg.playlistName) { detailsParts.push('Playlist: ' + msg.playlistName); }
  detailsParts.push('Type: ' + (msg.taskType || 'agent'));
  if (msg.command) { detailsParts.push('Command: ' + msg.command); }
  if (Array.isArray(msg.acceptanceCriteria) && msg.acceptanceCriteria.length > 0) {
    detailsParts.push('Acceptance Criteria:');
    for (let i = 0; i < msg.acceptanceCriteria.length; i++) {
      detailsParts.push('- ' + msg.acceptanceCriteria[i]);
    }
  }
  let detailsContent = document.getElementById('active-task-details-content');
  if (detailsContent) { detailsContent.textContent = detailsParts.join('\n'); }
  let detailsEl = document.getElementById('active-task-details');
  if (detailsEl) { detailsEl.open = false; }
  showActiveOutputPlaceholder('Waiting for terminal output...');
  updateStatusSummary('Running: ' + msg.taskName);
  setDashboardState('executing');
}

function syncActiveTaskFromPlan(plan) {
  if (runnerState !== 'playing') {
    return;
  }
  if (currentTaskId && cardState[currentTaskId]) {
    return;
  }
  const candidate = findRunningOrNextTask(plan);
  if (!candidate || !candidate.task) {
    updateStatusSummary('Running: preparing next task...');
    return;
  }

  const taskName = candidate.task.name || 'Untitled task';
  const playlistName = candidate.playlistName || 'Playlist';

  document.getElementById('active-task-name').textContent = taskName;

  const engineEl = document.getElementById('active-engine');
  const engineId = candidate.task.engine || (candidate.playlist && candidate.playlist.engine) || 'custom';
  engineEl.textContent = candidate.phase === 'queued'
    ? ('QUEUED - ' + getActiveRuntimeLabel(candidate.task))
    : getActiveRuntimeLabel(candidate.task);
  engineEl.className = 'engine-badge engine-' + engineId;
  document.getElementById('active-timer').textContent = candidate.phase === 'queued' ? '--' : '0s';

  if (candidate.phase === 'queued') {
    showActiveOutputPlaceholder('Task is queued. Runner will start it next.');
  } else {
    showActiveOutputPlaceholder('Waiting for terminal output...');
  }
  let queuedDetails = document.getElementById('active-task-details-content');
  if (queuedDetails) {
    queuedDetails.textContent = [
      'Playlist: ' + playlistName,
      'Type: ' + (candidate.task.taskType || 'agent'),
      candidate.task.command ? ('Command: ' + candidate.task.command) : ''
    ].filter(Boolean).join('\n');
  }
  let detailsEl = document.getElementById('active-task-details');
  if (detailsEl) { detailsEl.open = false; }

  updateStatusSummary('Running: ' + taskName);
  setDashboardState('executing');
}

function appendOutput(taskId, text, _stream) {
  const state = cardState[taskId];
  if (state) {
    state.output += text;
    if (state.output.length > 50000) { state.output = '... (truncated) ...\\n' + state.output.slice(-40000); }
  }
  if (taskId === currentTaskId) {
    const outputEl = document.getElementById('active-output');
    clearActiveOutputPlaceholder();
    outputEl.appendChild(document.createTextNode(text));
    while (outputEl.childNodes.length > 500) { outputEl.removeChild(outputEl.firstChild); }
    outputEl.scrollTop = outputEl.scrollHeight;
  }
}

function completeTask(msg) {
  const state = cardState[msg.taskId];
  if (state) {
    state.durationMs = msg.durationMs;
    state.exitCode = msg.exitCode;
    state.status = msg.status;
    state.changedFiles = msg.changedFiles;
    state.codeChanges = msg.codeChanges;
    state.stderr = msg.stderr || '';
    state.stdoutTail = msg.stdoutTail || '';
    state.command = msg.command || '';
    state.summary = msg.summary || '';
    state.verification = msg.verification || null;
    state.artifacts = msg.artifacts || null;
    state.validationTargetResults = msg.validationTargetResults || null;
  }
  const passed = msg.status === 'completed';
  const blocked = msg.status === 'blocked';
  const failed = !passed && !blocked && msg.status !== 'skipped';

  // BUG 3 fix: autoFix calls executeTask a second time, which fires task-completed again.
  // Guard against re-counting and duplicate cards — update the existing entry instead.
  const alreadyCompleted = completedOrder.includes(msg.taskId);
  if (alreadyCompleted) {
    // Undo the prior counters for this task, then re-apply with updated status
    const prior = completedTasks.find(function(t) { return t.taskId === msg.taskId; });
    if (prior) {
      const priorFailed = prior.status === 'failed' || prior.status === 'blocked';
      if (priorFailed && !failed) { failedCount = Math.max(0, failedCount - 1); }
      if (prior.status === 'blocked' && !blocked) { blockedCount = Math.max(0, blockedCount - 1); }
      // Update existing entry in-place
      prior.status = msg.status;
      prior.filesCount = Array.isArray(msg.changedFiles) ? msg.changedFiles.length : prior.filesCount;
      prior.changedFiles = Array.isArray(msg.changedFiles) ? msg.changedFiles : prior.changedFiles;
      prior.stderr = msg.stderr || '';
      prior.output = (state && state.output) ? state.output : (msg.stdoutTail || '');
      if (!priorFailed && failed) { failedCount++; }
      if (!prior.status.includes('blocked') && blocked) { blockedCount++; }
    }
    renderCompletedCards();
    updateProgress();
    renderResultBanner();
    renderPlaylistTiles(currentPlan);
    return;
  }

  completedCount++;
  if (failed) { failedCount++; }
  if (blocked) { blockedCount++; }
  if (msg.changedFiles) { totalFilesChanged += msg.changedFiles.length; }
  completedOrder.push(msg.taskId);
  addCompletedCard(msg.taskId, msg.taskName, msg);
  if (msg.taskId === currentTaskId) { currentTaskId = null; }
  updateProgress();
  renderResultBanner();
  renderPlaylistTiles(currentPlan);
}

function addCompletedCard(taskId, taskName, msg) {
  let state = cardState[taskId] || {};
  let failed = msg.status === 'failed' || msg.status === 'blocked';
  if (typeof completedExpandedState[taskId] !== 'boolean') {
    completedExpandedState[taskId] = failed;
  }
  completedTasks.push({
    taskId: taskId,
    taskName: taskName,
    status: msg.status,
    engine: state.engine || '',
    durationMs: msg.durationMs || 0,
    filesCount: Array.isArray(msg.changedFiles) ? msg.changedFiles.length : 0,
    changedFiles: Array.isArray(msg.changedFiles) ? msg.changedFiles : [],
    codeChanges: state.codeChanges || '',
    stderr: msg.stderr || '',
    output: state.output || msg.stdoutTail || '',
    exitCode: msg.exitCode,
  });
  renderCompletedCards();
}

function firstNonEmptyLine(text) {
  if (!text) { return ''; }
  let lines = String(text).split('\\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line) { return line; }
  }
  return '';
}

function getOutputTail(output, limit) {
  if (!output) { return '(no output captured)'; }
  let lines = String(output).split('\\n');
  return lines.length > limit ? lines.slice(-limit).join('\\n') : lines.join('\\n');
}

function renderCompletedCards() {
  let section = document.getElementById('completed-section');
  if (!section) { return; }
  section.innerHTML = '';
  if (completedTasks.length === 0) { return; }

  let headerWrap = document.createElement('div');
  headerWrap.className = 'completed-section-header';
  let header = document.createElement('button');
  header.className = 'section-toggle' + (collapsedSections.completed ? ' collapsed' : '');
  header.dataset.section = 'completed';
  header.onclick = function() { toggleSection('completed'); };
  header.innerHTML = '<span class="section-toggle-icon">\\u25BC</span>' +
    '<span class="section-toggle-label">Completed Tasks</span>' +
    '<span class="section-toggle-count" id="completed-count">' + completedTasks.length + '</span>';
  let showAllBtn = document.createElement('button');
  showAllBtn.className = 'completed-show-all';
  showAllBtn.hidden = completedTasks.length <= 10;
  showAllBtn.textContent = showAllCompletedCards ? 'Show less' : ('Show all (' + completedTasks.length + ')');
  showAllBtn.onclick = function() {
    showAllCompletedCards = !showAllCompletedCards;
    renderCompletedCards();
  };
  headerWrap.appendChild(header);
  headerWrap.appendChild(showAllBtn);
  section.appendChild(headerWrap);

  let body = document.createElement('div');
  body.id = 'body-completed';
  body.className = 'section-body' + (collapsedSections.completed ? ' collapsed' : '');
  section.appendChild(body);

  let visibleCards = showAllCompletedCards ? completedTasks : completedTasks.slice(-10);
  visibleCards.forEach(function(entry) {
    let passed = entry.status === 'completed';
    let failed = entry.status === 'failed' || entry.status === 'blocked';
    let card = document.createElement('div');
    card.className = 'completed-card' + (failed ? ' failed' : '') +
      (completedExpandedState[entry.taskId] ? ' expanded' : '');
    card.dataset.taskId = entry.taskId;

    let row = document.createElement('div');
    row.className = 'completed-card-row';
    let duration = formatDuration(entry.durationMs || 0);
    let files = entry.filesCount || 0;
    row.innerHTML =
      '<span class="cc-icon ' + (passed ? 'pass' : 'fail') + '">' +
      (passed ? '\\u2713' : '\\u2717') +
      '</span>' +
      '<span class="cc-name">' + escHtml(entry.taskName) + '</span>' +
      (entry.engine ? '<span class="cc-meta">' + escHtml(entry.engine) + '</span>' : '') +
      '<span class="cc-meta">' + duration + '</span>' +
      (files > 0 ? '<span class="cc-meta">' + files + 'f</span>' : '') +
      '<span class="cc-chevron">&#x25BA;</span>';
    row.title = 'Click to expand';
    row.onclick = function() {
      completedExpandedState[entry.taskId] = !completedExpandedState[entry.taskId];
      card.classList.toggle('expanded', completedExpandedState[entry.taskId]);
    };
    card.appendChild(row);

    if (failed) {
      let errLine = document.createElement('div');
      errLine.className = 'cc-error';
      let firstErrLine = firstNonEmptyLine(entry.stderr);
      errLine.textContent = (firstErrLine || ('exit ' + (entry.exitCode || 1))).substring(0, 120);
      errLine.title = entry.stderr || '';
      card.appendChild(errLine);
    }

    let detail = document.createElement('div');
    detail.className = 'cc-detail';

    // ─── Action buttons (previously missing — handlers existed but no HTML) ───
    let actions = document.createElement('div');
    actions.className = 'cc-actions';
    if (failed) {
      let retryBtn = document.createElement('button');
      retryBtn.className = 'cc-btn';
      retryBtn.textContent = '↺ Retry';
      retryBtn.title = 'Re-run this task unchanged';
      retryBtn.onclick = function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'retryTask', taskId: entry.taskId });
      };
      actions.appendChild(retryBtn);
    }
    let viewBtn = document.createElement('button');
    viewBtn.className = 'cc-btn ghost';
    viewBtn.textContent = '⊞ Full Output';
    viewBtn.title = 'Open complete stdout/stderr in editor';
    viewBtn.onclick = function(e) {
      e.stopPropagation();
      vscode.postMessage({ type: 'viewTaskOutput', taskId: entry.taskId });
    };
    actions.appendChild(viewBtn);
    if (entry.changedFiles && entry.changedFiles.length > 0) {
      let diffBtn = document.createElement('button');
      diffBtn.className = 'cc-btn ghost';
      diffBtn.textContent = '± Diff';
      diffBtn.title = 'Open code diff in editor (' + entry.changedFiles.length + ' files)';
      diffBtn.onclick = function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'open-diff', taskId: entry.taskId });
      };
      actions.appendChild(diffBtn);
    }
    detail.appendChild(actions);

    if (entry.output) {
      let outputDiv = document.createElement('pre');
      outputDiv.className = 'terminal-output';
      outputDiv.style.maxHeight = '200px';
      outputDiv.style.padding = '6px 8px';
      outputDiv.textContent = getOutputTail(entry.output || entry.stderr, 50);
      detail.appendChild(outputDiv);
    }

    card.appendChild(detail);
    body.appendChild(card);
  });
}

// ─── Progress + Stats ───

function renderPills(plan) {
  let minimap = document.getElementById('minimap');
  if (!minimap || !plan || !plan.playlists) { if (minimap) minimap.innerHTML = ''; return; }
  let html = '';
  let count = 0;
  plan.playlists.forEach(function(pl) {
    pl.tasks.forEach(function(task) {
      count++;
      let isCurrent = task.id === currentTaskId || task.status === 'running';
      let status = isCurrent ? 'running' : (task.status || 'pending');
      html += '<div class="dot ' + status + '" data-task-id="' + task.id + '" title="' + count + '. ' + escHtml(task.name) + '"></div>';
    });
  });
  totalTasks = count;
  minimap.innerHTML = html;
  updateProgress();
}

function updateProgress() {
  const fill = document.getElementById('progress-fill');
  const tasks = currentPlan ? currentPlan.playlists.flatMap(function(pl) { return pl.tasks || []; }) : [];
  const passedTasks = tasks.filter(function(t) { return t.status === 'completed'; }).length;
  const failedTasks = tasks.filter(function(t) { return t.status === 'failed'; }).length;
  const blockedTasks = tasks.filter(function(t) { return t.status === 'blocked'; }).length;
  const effectiveCompleted = Math.max(completedCount, passedTasks + failedTasks + blockedTasks +
    tasks.filter(function(t) { return t.status === 'skipped'; }).length);
  const effectiveFailed = Math.max(failedCount, failedTasks);

  if (totalTasks === 0) {
    fill.style.width = '0%';
    fill.classList.remove('has-errors');
    document.getElementById('stats-tasks').textContent = '0/0';
    document.getElementById('stats-elapsed').textContent = '';
    return;
  }

  const pct = Math.round((effectiveCompleted / totalTasks) * 100);
  fill.style.width = pct + '%';

  if (effectiveFailed > 0) {
    const passPct = effectiveCompleted > 0
      ? Math.round(((effectiveCompleted - effectiveFailed) / effectiveCompleted) * 100)
      : 0;
    fill.classList.add('has-errors');
    fill.style.setProperty('--pass-pct', passPct + '%');
  } else {
    fill.classList.remove('has-errors');
  }

  const isExecuting = currentTaskId !== null;
  let failureCount = failedTasks + blockedTasks;
  if (isExecuting) {
    document.getElementById('stats-tasks').textContent = effectiveCompleted + '/' + totalTasks;
    document.getElementById('stats-elapsed').textContent = getExecutionEtaText(effectiveCompleted);
  } else {
    document.getElementById('stats-tasks').textContent = effectiveCompleted + '/' + totalTasks + ' tasks (' + failureCount + ' failed)';
    document.getElementById('stats-elapsed').textContent = runStartTime ? formatDuration(Date.now() - runStartTime) : '';
  }
}

function startTimer() { stopTimer(); elapsedInterval = setInterval(updateTimers, 1000); }
function stopTimer() { if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; } }

function updateTimers() {
  updateProgress();
  if (taskStartTime && currentTaskId) {
    document.getElementById('active-timer').textContent = formatDuration(Date.now() - taskStartTime);
  }
  if (runStartTime && (runnerState === 'playing' || runnerState === 'paused' || runnerState === 'stopping')) {
    updateStatusRight(formatDuration(Date.now() - runStartTime));
  } else {
    updateStatusRight('');
  }
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return secs + 's';
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return mins + 'm ' + remSecs + 's';
  const hrs = Math.floor(mins / 60);
  return hrs + 'h ' + (mins % 60) + 'm';
}

// ─── Playlist Tiles ───

function getPlaylistTileStatus(stats) {
  if (stats.running > 0) { return 'running'; }
  if ((stats.failed + stats.blocked) > 0) { return 'failed'; }
  if (stats.total > 0 && (stats.completed + stats.skipped) === stats.total) { return 'done'; }
  return 'pending';
}

function renderPlaylistTiles(plan) {
  const container = document.getElementById('playlist-tiles');
  if (!container) { return; }
  if (!plan || !plan.playlists || plan.playlists.length === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  let activePlaylistName = currentTaskId && cardState[currentTaskId] ? cardState[currentTaskId].playlistName : null;

  container.innerHTML = plan.playlists.map(function(pl) {
    const tasks = pl.tasks || [];
    const stats = getTaskStats(tasks);
    const statusKey = getPlaylistTileStatus(stats);
    const doneCount = stats.completed + stats.failed + stats.blocked + stats.skipped;
    const fraction = doneCount + '/' + stats.total;
    const isActive = pl.name === activePlaylistName || stats.running > 0;
    const classes = ['playlist-tile'];
    if (isActive) { classes.push('is-active'); }
    if ((stats.failed + stats.blocked) > 0) { classes.push('has-failure'); }
    if (statusKey === 'done') { classes.push('is-done'); }
    return '<button class="' + classes.join(' ') + '" onclick="vscode.postMessage({type:\\x27switch-plan\\x27})" title="' + escHtml(pl.name || 'Playlist') + '">' +
      '<span class="tile-name">' + escHtml(pl.name || 'Playlist') + '</span>' +
      '<span class="tile-meta">' +
        '<span class="tile-status ' + statusKey + '">' + statusKey + '</span>' +
        '<span class="tile-fraction">' + fraction + '</span>' +
      '</span>' +
    '</button>';
  }).join('');
}

// ─── Render Functions ───

function renderStatus(state) {
  runnerState = state;
  const el = document.getElementById('runner-status');
  const stateLabels = { playing: 'Executing', paused: 'Paused', stopping: 'Stopping', idle: 'Idle' };
  el.textContent = stateLabels[state] || (state.charAt(0).toUpperCase() + state.slice(1));
  el.className = 'status-badge status-' + state;
  const playBtn = document.getElementById('btn-play');
  const pauseBtn = document.getElementById('btn-pause');
  const stopBtn = document.getElementById('btn-stop');
  playBtn.disabled = state === 'playing';
  pauseBtn.disabled = state !== 'playing';
  stopBtn.disabled = state === 'idle';
  playBtn.className = playBtn.disabled ? 'icon-btn' : 'icon-btn primary';
  renderResultBanner();
  renderPromptComposerState();
  if (state === 'playing') {
    syncActiveTaskFromPlan(currentPlan);
  }
  if (state === 'playing') {
    setDashboardState('executing');
  } else if (state === 'idle' && completedCount > 0 && completedCount >= totalTasks) {
    setDashboardState('complete');
  } else {
    setDashboardState('idle');
  }
  if (state === 'idle') {
    updateStatusSummary('Ready');
    updateStatusRight('');
    stopTimer();
  } else if (state === 'paused') {
    updateStatusSummary('Paused');
  } else if (state === 'stopping') {
    updateStatusSummary('Stopping...');
  }
  updateTimers();
}

const collapsedSections = { completed: false, sandbox: true, 'ctx-mem': false };

function toggleSection(sectionId) {
  collapsedSections[sectionId] = !collapsedSections[sectionId];
  const toggle = document.querySelector('[data-section="' + sectionId + '"]');
  const body = document.getElementById('body-' + sectionId);
  if (toggle && body) {
    toggle.classList.toggle('collapsed', !!collapsedSections[sectionId]);
    body.classList.toggle('collapsed', !!collapsedSections[sectionId]);
  }
}

// ─── Plan Tab: Tree View ───

function renderPlan(plan) {
  const planName = document.getElementById('plan-name');
  if (!plan || !plan.playlists || plan.playlists.length === 0) {
    if (planName) { planName.textContent = plan && plan.name ? plan.name : 'MOAG'; }
    totalTasks = 0;
    renderPills(null);
    renderIdleOverview(null);
    renderPromptComposerState();
    setDashboardState(runnerState === 'playing' ? 'executing' : 'idle');
    return;
  }

  if (planName) { planName.textContent = plan.name || 'Untitled Plan'; }
  let taskCount = 0;
  plan.playlists.forEach(function(pl) { taskCount += (pl.tasks || []).length; });
  totalTasks = taskCount;
  renderIdleOverview(plan);
  setDashboardState(runnerState === 'playing' ? 'executing' : dashboardState);
  renderPromptComposerState();
}

// ─── Utilities ───

function escHtml(s) {
  const div = document.createElement('div');
  div.textContent = s || '';
  return div.innerHTML;
}

// ─── Init ───

(function() {
  try {
    console.log('[MOAG] Init: decoding base64');
    const rawState = decodeBase64Utf8(MOAG_BOOTSTRAP.stateBase64);
    let initState = JSON.parse(rawState);
    console.log('[MOAG] Init: plan=' + (initState.plan ? initState.plan.name : 'null'));
    syncPromptEngineOptions(initState.promptEngines || [], initState.selectedPromptEngineId);
    autoResizePromptInput();
    updatePromptCharCount();
    if (initState && initState.plan) {
      currentPlan = initState.plan;
      renderPlan(initState.plan);
      renderEngineStatus();
      renderPlaylistTiles(initState.plan);
      renderPills(initState.plan);
      updateProgress();
      renderStatus(initState.runnerState || 'idle');
    } else {
      currentPlan = null;
      renderPlan(null);
      renderEngineStatus();
      renderPlaylistTiles(null);
      renderPills(null);
      updateProgress();
      renderStatus('idle');
    }
  } catch(initErr) {
    console.error('[MOAG Dashboard] Init error:', initErr);
    currentPlan = null;
    syncPromptEngineOptions([], '');
    autoResizePromptInput();
    updatePromptCharCount();
    renderPlan(null);
    renderEngineStatus();
    renderPlaylistTiles(null);
    renderPills(null);
    updateProgress();
    renderStatus('idle');
  }
})();

function notifyWebviewReady() { vscode.postMessage({ type: 'webview-ready', htmlVersion: window.__moagHtmlVersion }); }

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', notifyWebviewReady, { once: true });
} else {
  notifyWebviewReady();
}

// Retry polling: if no plan loaded after init, keep asking the extension
// for up to 5 seconds (covers async plan loading race condition)
(function() {
  let retries = 0;
  const maxRetries = 10;
  const interval = setInterval(function() {
    retries++;
    let hasRenderedPlan = !!currentPlan;
    if ((currentPlan && hasRenderedPlan) || retries >= maxRetries) {
      clearInterval(interval);
      if (currentPlan && !hasRenderedPlan) { vscode.postMessage({ type: 'refresh' }); }
      return;
    }
    if (!currentPlan || !hasRenderedPlan) { vscode.postMessage({ type: 'refresh' }); }
  }, 500);
})();
