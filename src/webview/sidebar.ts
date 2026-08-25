// ─── Sidebar webview script ─────────────────────────────────────────────────
//
// Runs in the webview, not the extension host. Compiled by tsconfig.webview.json
// to a plain browser script and loaded with <script src>. It used to live inside
// a template literal in ui/prompt-input-view.ts, where the compiler never saw it.

/** Provided by the VS Code webview runtime. */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// Declaration merging, not a cast at every call site. The DOM lib types these as
// HTMLElement, so reading .value or .disabled off a known <input> is an error at
// ~100 places. Widening the return here keeps this a move rather than a typing
// project, and costs nothing that matters: the checks worth having — a syntax
// error, and a reference to a name that does not exist — still fail the build.
// Narrow these back per-element when the file is split into modules.
interface Document {
  getElementById(elementId: string): any;
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): any;
}
interface Element {
  closest(selectors: string): any;
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): any;
}
const vscode = acquireVsCodeApi();
const promptEl = document.getElementById('prompt');
const sendEl = document.getElementById('send');
const addToPlanBtnEl = document.getElementById('addToPlanBtn');
const generatePlanBtnEl = document.getElementById('generatePlanBtn');
const engineEl = document.getElementById('engine');
const attachBtnEl = document.getElementById('attachBtn');
const dashboardBtnEl = document.getElementById('dashboardBtn');
const settingsBtnEl = document.getElementById('settingsBtn');
const newChatBtnEl = document.getElementById('newChatBtn');
const inputWrapEl = document.getElementById('inputWrap');
const imagePreviewBarEl = document.getElementById('imagePreviewBar');
const imagePreviewThumbEl = document.getElementById('imagePreviewThumb');
const imageRemoveBtnEl = document.getElementById('imageRemoveBtn');
const filePillRowEl = document.getElementById('filePillRow');
const filePillNameEl = document.getElementById('filePillName');
const filePillDismissEl = document.getElementById('filePillDismiss');
let attachedImage = null;
let activeFile = null; // { name, path } | null
let activeFileDismissed = false;
let pendingFixRef = null; // { playlistIndex, taskIndex } — set when Fix fills composer; routes Execute to task retry
// PRD draft mode state
var prdMode = false;
var prdStep = 0; // 1 = waiting for feature description, 2 = waiting for follow-up answer
var prdAnswers = []; // collected answers from user

function appendPrdMessage(role, text) {
  if (!chatFeedEl) { return; }
  var wrap = document.createElement('div');
  wrap.className = 'prd-msg ' + (role === 'bot' ? 'prd-bot' : 'prd-user');
  var author = document.createElement('div');
  author.className = 'prd-msg-author';
  author.textContent = role === 'bot' ? 'MOAG' : 'You';
  var msg = document.createElement('div');
  msg.className = 'prd-msg-text';
  msg.textContent = text;
  wrap.appendChild(author);
  wrap.appendChild(msg);
  chatFeedEl.appendChild(wrap);
  chatFeedEl.scrollTop = chatFeedEl.scrollHeight;
}

function showPrdTyping() {
  if (!chatFeedEl) { return null; }
  var el = document.createElement('div');
  el.className = 'prd-typing';
  el.innerHTML = '<span></span><span></span><span></span>';
  chatFeedEl.appendChild(el);
  chatFeedEl.scrollTop = chatFeedEl.scrollHeight;
  return el;
}

function startPrdMode() {
  prdMode = true;
  prdStep = 1;
  prdAnswers = [];
  if (prdModeHeaderEl) { prdModeHeaderEl.classList.add('active'); }
  if (sendEl) { sendEl.innerHTML = 'Answer <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" style="flex-shrink:0"><path d="M3 2l10 6-10 6V2z"/></svg>'; }
  if (chatEmptyEl) { chatEmptyEl.style.display = 'none'; }
  if (chatFeedEl) { chatFeedEl.textContent = ''; }
  appendPrdMessage('bot', 'What are you building? Describe the feature in plain terms — what it does, who uses it, and what problem it solves.');
  promptEl.placeholder = 'Describe your feature...';
  promptEl.focus();
}

function exitPrdMode() {
  prdMode = false;
  prdStep = 0;
  prdAnswers = [];
  if (prdModeHeaderEl) { prdModeHeaderEl.classList.remove('active'); }
  if (sendEl) { sendEl.innerHTML = 'Execute <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" style="flex-shrink:0"><path d="M3 2l10 6-10 6V2z"/></svg>'; }
  promptEl.placeholder = 'Describe a task for the AI agent...';
  renderChat(chatTitleEl ? chatTitleEl.textContent || 'New Chat' : 'New Chat', chatMessages);
}
function updateComposerHint() {
  if (!composerHintEl) { return; }
  if (pendingFixRef) {
    composerHintEl.textContent = 'Execute will retry the task with this fix context';
    composerHintEl.classList.add('fix-mode');
  } else {
    composerHintEl.textContent = 'Ctrl+Enter execute · Shift+Enter queue';
    composerHintEl.classList.remove('fix-mode');
  }
}
const tabEls: any[] = Array.from(document.querySelectorAll('.tab'));
const chatScreenEl = document.getElementById('chatScreen');
const chatTitleEl = document.getElementById('chatTitle');
const chatFeedEl = document.getElementById('chatFeed');
const chatEmptyEl = document.getElementById('chatEmpty');
const planToolsEl = document.getElementById('planTools');
const planActiveNameEl = document.getElementById('planActiveName');
const planExecCounterEl = document.getElementById('planExecCounter');
const planRunnerBadgeEl = document.getElementById('planRunnerBadge');
const planOpenPrdBtnEl = document.getElementById('planOpenPrdBtn');
const planFilterBtnEl = null; // removed — filter now always visible in status bar
const planFilterMenuEl = null; // removed
const planSelectModeCbEl = document.getElementById('planSelectModeCb');
const planFilterChipsEl = document.getElementById('planFilterChips');
const planRunSelectedBtnEl = document.getElementById('planRunSelectedBtn');
const planRunPendingBtnEl = document.getElementById('planRunPendingBtn');
const planFixAllBtnEl = document.getElementById('planFixAllBtn');
const planFixBarEl = null; // removed — merged into planStatusBar
const planFixLabelEl = null; // removed
const planFixAllBarBtnEl = document.getElementById('planFixAllBarBtn');
const reportIssueBtnEl = document.getElementById('reportIssueBtn');
const composerHintEl = document.getElementById('composerHint');
const planSearchBtnEl = document.getElementById('planSearchBtn');
const planSearchBarEl = document.getElementById('planSearchBar');
const planSearchInputEl = document.getElementById('planSearchInput');
const planSearchClearBtnEl = document.getElementById('planSearchClearBtn');
const planSwitchQuickBtnEl = document.getElementById('planSwitchQuickBtn');
const planStopBtnEl = document.getElementById('planStopBtn');
const planManageBtnEl = document.getElementById('planManageBtn');
const planManageMenuEl = document.getElementById('planManageMenu');
const planPlayBtnEl = document.getElementById('planPlayBtn');
const planAddTaskBtnEl = document.getElementById('planAddTaskBtn');
const planNewBtnEl = document.getElementById('planNewBtn');
const planFromPrdBtnEl = document.getElementById('planFromPrdBtn');
const planFromTemplateBtnEl = document.getElementById('planFromTemplateBtn');
const chatEmptyPrdBtnEl = document.getElementById('chatEmptyPrdBtn');
const chatEmptyTemplateBtnEl = document.getElementById('chatEmptyTemplateBtn');
const chatStartPrdBtnEl = document.getElementById('chatStartPrdBtn');
const prdModeHeaderEl = document.getElementById('prdModeHeader');
const prdModeCancelBtnEl = document.getElementById('prdModeCancelBtn');
const prdInputScreenEl = document.getElementById('prdInputScreen');
const prdBackBtnEl = document.getElementById('prdBackBtn');
const prdInputTitleEl = document.getElementById('prdInputTitle');
const prdInputHintEl = document.getElementById('prdInputHint');
const prdTextareaEl = document.getElementById('prdTextarea');
const prdBrowseBtnEl = document.getElementById('prdBrowseBtn');
const prdGenerateBtnEl = document.getElementById('prdGenerateBtn');
const prdCharCountEl = document.getElementById('prdCharCount');
const prdVersionBarEl = document.getElementById('prdVersionBar');
const prdVersionSelectEl = document.getElementById('prdVersionSelect');
const prdVersionSaveBtnEl = document.getElementById('prdVersionSaveBtn');
const prdAiBtnEl = document.getElementById('prdAiBtn');
const prdProjectCardEl = document.getElementById('prdProjectCard');
const prdProjectNameEl = document.getElementById('prdProjectName');
const prdProjectStackEl = document.getElementById('prdProjectStack');
const prdChipsRowEl = document.getElementById('prdChipsRow');
var prdVersions = [];
const composerPrdBtnEl = document.getElementById('composerPrdBtn');
const planToggleTasksBtnEl = document.getElementById('planToggleTasksBtn');
const planToggleExpandBtnEl = document.getElementById('planToggleExpandBtn');
const planSwitchBtnEl = document.getElementById('planSwitchBtn');
const planOverviewEl = document.getElementById('planOverview');
const planOverviewTitleEl = document.getElementById('planOverviewTitle');
const planOverviewMetaEl = document.getElementById('planOverviewMeta');
const planOverviewFailedMetaEl = document.getElementById('planOverviewFailedMeta');
const planOverviewFillEl = document.getElementById('planOverviewFill');
const planOverviewRunningEl = document.getElementById('planOverviewRunning');
const planOverviewRunningTextEl = document.getElementById('planOverviewRunningText');
const planQueueEl = document.getElementById('planQueue');
const planQueueMetaEl = document.getElementById('planQueueMeta');
const planQueueNextTaskEl = document.getElementById('planQueueNextTask');
const planQueueDotsEl = document.getElementById('planQueueDots');
const planLivePanelEl = document.getElementById('planLivePanel');
const planRulesSectionEl = document.getElementById('planRulesSection');
const tttCriteriaSectionEl = document.getElementById('tttCriteriaSection');
const tttCriteriaListEl = document.getElementById('tttCriteriaList');
const tttVerifyBtnEl = document.getElementById('tttVerifyBtn');
const planListHeadingEl = document.getElementById('planListHeading');
const planListSelectModeCbEl = document.getElementById('planListSelectModeCb');
const planHeadingCollapseBtnEl = document.getElementById('planHeadingCollapseBtn');
const planListEl = document.getElementById('planList');
const historyToolsEl = document.getElementById('historyTools');
const historyGroupByEl = document.getElementById('historyGroupBy');
const historyStatusChipsEl = document.getElementById('historyStatusChips');
const historyListEl = document.getElementById('historyList');
const listEmptyEl = document.getElementById('listEmpty');
const ctxPlanEl = document.getElementById('ctxPlan');
const ctxRunnerEl = document.getElementById('ctxRunner');
const ctxCostEl = document.getElementById('ctxCost');
const promptCharCountEl = document.getElementById('promptCharCount');
let busy = false;
let activeTab = 'chat';
let chatItems = [];
let planItems = [];
let planGroups = [];
let planAiRules = '';
let planPrdSource = '';
let detectedPrdFilePath = '';
let testTool = 'manual';
let planFixIterations = 0;
let prdProjectMeta = { name: '', stack: '' };
let tttCriteriaChecked = [];
let historyItems = [];
let activeThreadId = '';
let chatMessages = [];
let runnerState = 'idle';
let historyGroupBy = 'none';
let historyStatusFilter = 'all';
let collapsedHistoryGroups = {};
let collapsedPlanGroups = {};
let planTasksVisible = true;
let planFilterMode = 'all';
let planListScrollTop = 0;
let planListScrollInitialized = false;
let planSearchQuery = '';
let selectionMode = false;
let selectedPlaylists = {};
let selectedTasks = {};
let activePlanName = '';
let activePlaylistName = '';
let actionMenuHandlersBound = false;
let liveTaskId = '';
let liveTaskName = '';
let liveOutputLines = [];
const ICON_COLLAPSED = '\u25B6';
const ICON_EXPANDED = '\u25BC';
const ICON_COMPLETED = '\u2713';
const ICON_RUNNING = '\u25B6';
const ICON_FAILED = '\u2715';
const ICON_BLOCKED = '!';
const ICON_SKIPPED = '\u21BB';
const ICON_PENDING = '\u25CB';
const ICON_PLAY = '\u23F5';
const ICON_PAUSE = '\u23F8';
const ICON_RUN_PENDING = '\u25F7';
const ICON_STOP = '\u23F9';
const ICON_MENU = '\u22EF';
const ICON_FILTER = '\u25BE';
const ICON_LAYOUT = '\u21F5';
const ICON_ARROW_RIGHT = '\u2192';
const ICON_DOT = '\u2022';

function autoResize() {
  promptEl.style.height = 'auto';
  const h = Math.min(Math.max(promptEl.scrollHeight + 1, 36), 200);
  promptEl.style.height = h + 'px';
  promptEl.style.overflowY = h >= 200 ? 'auto' : 'hidden';
}

function updateActionState() {
  const charCount = promptEl.value.length;
  promptCharCountEl.textContent = charCount === 0 ? '' : charCount === 1 ? '1 char' : charCount + ' chars';
  promptCharCountEl.style.display = charCount === 0 ? 'none' : '';
  const hasText = !!promptEl.value.trim();
  sendEl.disabled = busy || !hasText;
  if (generatePlanBtnEl) { generatePlanBtnEl.disabled = busy || !hasText; }
  if (addToPlanBtnEl) { addToPlanBtnEl.disabled = !hasText; }
}

function renderEngines(engines, selectedEngineId) {
  engineEl.textContent = '';
  if (!engines || engines.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No engines';
    engineEl.appendChild(option);
    engineEl.disabled = true;
    return;
  }

  const fallbackId = engines[0].id;
  const nextSelected = engines.some((engine) => engine.id === selectedEngineId) ? selectedEngineId : fallbackId;
  for (const engine of engines) {
    const option = document.createElement('option');
    option.value = engine.id;
    option.textContent = engine.label;
    option.selected = engine.id === nextSelected;
    engineEl.appendChild(option);
  }
  engineEl.disabled = busy;
  renderContextBar();
}

function itemDotClass(item, index) {
  const s = String(item.status || '').toLowerCase();
  if (s === 'running') { return 'active'; }
  if (s === 'failed') { return 'failed'; }
  return index < 3 ? 'recent' : '';
}

function renderItemList(targetEl, items) {
  targetEl.textContent = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item';
    const dc = itemDotClass(item, i);
    btn.innerHTML =
      '<span class="item-title"><span class="item-dot' + (dc ? ' ' + dc : '') + '"></span>' + escHtml(item.title || 'Untitled') + '</span>' +
      (item.subtitle ? '<span class="item-meta">' + escHtml(item.subtitle) + '</span>' : '');
    btn.addEventListener('click', () => {
      if (item.id) {
        vscode.postMessage({ type: 'openItem', id: item.id, kind: item.kind || 'thread' });
      }
    });
    targetEl.appendChild(btn);
  }
}

function buildHistoryGroups(items) {
  const groups = new Map();
  for (const item of items) {
    let key = 'All History';
    if (historyGroupBy === 'plan') {
      key = item.planName || 'Unplanned';
    } else if (historyGroupBy === 'playlist') {
      key = item.playlistName || 'Unassigned playlist';
    }
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }
  return groups;
}

function normalizeStatus(item) {
  return String(item.status || '').toLowerCase();
}

function isPendingLikeStatus(status) {
  return status === '' || status === 'pending' || status === 'queued' || status === 'todo';
}

function statusMatchesFilter(item) {
  const status = normalizeStatus(item);
  if (historyStatusFilter === 'all') {
    return true;
  }
  if (historyStatusFilter === 'completed') {
    return status === 'completed';
  }
  if (historyStatusFilter === 'failed') {
    return status === 'failed' || status === 'blocked';
  }
  return true;
}

function historyStatusIcon(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') {
    return { cls: 'completed', svg: '<svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor"><path d="M13.5 3.5l-7 7-3-3-.7.7 3.7 3.7 7.7-7.7z"/></svg>' };
  }
  if (s === 'failed' || s === 'blocked') {
    return { cls: 'failed', svg: '<svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor"><path d="M9 1H7v8h2zm-1 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>' };
  }
  if (s === 'running') {
    return { cls: 'running', svg: '<svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor"><path d="M3 2l10 6-10 6V2z"/></svg>' };
  }
  return { cls: 'default', svg: '<svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor"><circle cx="8" cy="8" r="3"/></svg>' };
}

function renderHistoryList() {
  historyListEl.textContent = '';
  const base = Array.isArray(historyItems) ? historyItems : [];
  const filtered = base.filter(statusMatchesFilter);
  const groups = buildHistoryGroups(filtered);

  groups.forEach((items, label) => {
    if (historyGroupBy !== 'none') {
      const head = document.createElement('button');
      const collapsed = !!collapsedHistoryGroups[label];
      const groupKind = historyGroupBy === 'plan' ? 'plan' : historyGroupBy === 'playlist' ? 'playlist' : '';
      head.className = 'group-head' + (groupKind ? (' ' + groupKind) : '');
      head.type = 'button';
      const badge = historyGroupBy === 'plan' ? 'Plan' : 'Playlist';
      head.innerHTML =
        '<span class="group-head-label">' + escHtml(badge) + '</span>' +
        escHtml((collapsed ? (ICON_COLLAPSED + ' ') : (ICON_EXPANDED + ' ')) + label + ' (' + items.length + ')');
      head.addEventListener('click', () => {
        collapsedHistoryGroups[label] = !collapsedHistoryGroups[label];
        renderHistoryList();
      });
      historyListEl.appendChild(head);
      if (collapsed) {
        return;
      }
    }
    for (let hi = 0; hi < items.length; hi++) {
      const item = items[hi];
      const btn = document.createElement('button');
      btn.type = 'button';
      const subParts = (item.subtitle || '').split('  -  ');
      const breadcrumb = subParts[0] || '';
      const age = subParts.length >= 2 ? subParts[subParts.length - 1].trim() : '';
      const hIcon = historyStatusIcon(item.status);
      const isFailed = item.status === 'failed' || item.status === 'blocked';
      btn.className = 'history-item' + (isFailed ? ' failed' : '');
      btn.innerHTML =
        '<span class="history-icon ' + hIcon.cls + '">' + hIcon.svg + '</span>' +
        '<span class="history-body">' +
          '<span class="history-title">' + escHtml(item.title || 'Untitled') + '</span>' +
          (breadcrumb ? '<span class="history-breadcrumb">' + escHtml(breadcrumb) + '</span>' : '') +
          (isFailed && item.failureReason ? '<span class="history-failure-reason">' + escHtml(item.failureReason) + '</span>' : '') +
          (item.filesChanged ? '<span class="history-files-changed">' + item.filesChanged + 'f changed</span>' : '') +
        '</span>' +
        (age ? '<span class="history-age">' + escHtml(age) + '</span>' : '') +
        (isFailed && item.taskId ? '<button class="history-retry-btn" type="button" title="Retry this task">↺</button>' : '');
      btn.addEventListener('click', (e) => {
        // Retry button inside the row — don't open the item
        if (e.target && (e.target as HTMLElement).classList.contains('history-retry-btn')) {
          e.stopPropagation();
          if (item.taskId) { vscode.postMessage({ type: 'retryTask', taskId: item.taskId }); }
          return;
        }
        if (item.id) {
          vscode.postMessage({ type: 'openItem', id: item.id, kind: item.kind || 'history' });
        }
      });
      historyListEl.appendChild(btn);
    }
  });

  if (activeTab === 'history') {
    listEmptyEl.textContent = 'No history entries yet.';
    listEmptyEl.classList.toggle('active', filtered.length === 0);
  }
}

function renderLivePanel() {
  if (!planLivePanelEl) { return; }
  if (!liveTaskId) {
    planLivePanelEl.style.display = 'none';
    return;
  }
  planLivePanelEl.style.display = '';
  const linesHtml = liveOutputLines.map((l, i) => {
    const cls = i < liveOutputLines.length - 2 ? ' old' : i < liveOutputLines.length - 1 ? ' mid' : '';
    return '<div class="plan-live-line' + cls + '">' + escHtml(l) + '</div>';
  }).join('');
  planLivePanelEl.innerHTML =
    '<div class="plan-live-header">' +
      '<span class="plan-live-pulse"></span>' +
      '<span class="plan-live-task">' + escHtml(liveTaskName || 'Executing…') + '</span>' +
      '<span class="plan-live-dash-link" data-action="showDashboard">Open Dashboard ↗</span>' +
    '</div>' +
    (liveOutputLines.length > 0
      ? '<div class="plan-live-output">' + linesHtml + '</div>'
      : '');
  planLivePanelEl.querySelector('[data-action="showDashboard"]')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'showDashboard' });
  });
}

function renderPlanRulesSection() {
  if (!planRulesSectionEl) { return; }
  planRulesSectionEl.textContent = '';
  if (!activePlanName) { return; }
  const hasRules = planAiRules.trim().length > 0;
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'padding:4px 8px 2px;';

  const headerRow = document.createElement('div');
  headerRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:2px;';

  const label = document.createElement('span');
  label.style.cssText = 'font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground);flex:1;';
  label.textContent = 'Plan Rules';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'plan-group-rules-btn' + (hasRules ? ' has-rules' : '');
  editBtn.innerHTML = hasRules
    ? '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M4 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm0 3h8V4H4v1zm0 3h8V7H4v1zm0 3h5v-1H4v1z"/></svg>'
    : '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>';
  editBtn.title = hasRules ? 'Plan rules active — click to edit' : 'Add rules for all tasks in this plan';

  headerRow.appendChild(label);
  headerRow.appendChild(editBtn);
  wrapper.appendChild(headerRow);

  const panel = document.createElement('div');
  panel.className = 'rules-edit-panel';
  panel.style.display = 'none';
  panel.style.padding = '0';
  panel.innerHTML =
    '<label>Plan rules — injected before every task in this plan</label>' +
    '<textarea rows="5" placeholder="e.g. Security: always validate user inputs. Architecture: follow the existing service layer pattern.">' + escHtml(planAiRules) + '</textarea>' +
    '<div class="rules-edit-btns">' +
      '<button type="button" class="rules-cancel-btn">Cancel</button>' +
      '<button type="button" class="rules-save-btn">Save</button>' +
    '</div>';

  editBtn.addEventListener('click', () => {
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
    if (!open) { panel.querySelector('textarea')?.focus(); }
  });
  panel.querySelector('.rules-save-btn')?.addEventListener('click', () => {
    const val = panel.querySelector('textarea')?.value ?? '';
    vscode.postMessage({ type: 'savePlanRules', rules: val });
    panel.style.display = 'none';
  });
  panel.querySelector('.rules-cancel-btn')?.addEventListener('click', () => {
    panel.style.display = 'none';
  });

  wrapper.appendChild(panel);
  planRulesSectionEl.appendChild(wrapper);
}

function parsePrdCriteria(prdText) {
  if (!prdText) { return []; }
  var lines = prdText.split('\\n');
  var criteria = [];
  var inCriteriaBlock = false;
  for (var li = 0; li < lines.length; li++) {
    var trimmed = lines[li].trim();
    if (trimmed.toLowerCase().indexOf('acceptance criteria') !== -1 || trimmed.toLowerCase().indexOf('## criteria') !== -1) { inCriteriaBlock = true; continue; }
    if (inCriteriaBlock && /^#{1,3} /.test(trimmed) && trimmed.toLowerCase().indexOf('criteria') === -1) { inCriteriaBlock = false; }
    var cbm = trimmed.match(/^-[ ]*\\[[ x]\\][ ]*(.+)/i);
    if (cbm) { criteria.push(cbm[1].trim()); continue; }
    var acm = trimmed.match(/^ac[0-9]*[:.] *(.+)/i);
    if (acm) { criteria.push(acm[1].trim()); continue; }
    if (inCriteriaBlock && (trimmed.charAt(0) === '-' || trimmed.charAt(0) === '*' || /^[0-9]/.test(trimmed)) && trimmed.length > 8) {
      criteria.push(trimmed.replace(/^[-*0-9.]+[ ]*/, '').trim());
    }
  }
  return criteria.filter(Boolean).slice(0, 20);
}

function renderTttCriteria() {
  if (!tttCriteriaSectionEl || !tttCriteriaListEl || !tttVerifyBtnEl) { return; }
  const hasTestPhase = Array.isArray(planGroups) && planGroups.some(function(g) {
    return g.testPhase && (g.playlistStatus === 'running' || g.playlistStatus === 'paused');
  });
  if (!hasTestPhase || !planPrdSource) {
    tttCriteriaSectionEl.classList.remove('active');
    return;
  }
  const criteria = parsePrdCriteria(planPrdSource);
  if (criteria.length === 0) {
    tttCriteriaSectionEl.classList.remove('active');
    return;
  }
  if (tttCriteriaChecked.length !== criteria.length) {
    tttCriteriaChecked = new Array(criteria.length).fill(false);
  }
  tttCriteriaSectionEl.classList.add('active');
  tttCriteriaListEl.textContent = '';
  criteria.forEach(function(text, i) {
    var row = document.createElement('label');
    row.className = 'ttt-criterion' + (tttCriteriaChecked[i] ? ' checked' : '');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!tttCriteriaChecked[i];
    cb.addEventListener('change', function() {
      tttCriteriaChecked[i] = cb.checked;
      row.classList.toggle('checked', cb.checked);
      vscode.postMessage({ type: 'tttCriterionChecked', index: i, checked: cb.checked });
      var allDone = tttCriteriaChecked.length > 0 && tttCriteriaChecked.every(Boolean);
      tttVerifyBtnEl.style.display = allDone ? 'block' : 'none';
    });
    var span = document.createElement('span');
    span.textContent = text;
    row.appendChild(cb);
    row.appendChild(span);
    tttCriteriaListEl.appendChild(row);
  });
  var allDone = tttCriteriaChecked.length > 0 && tttCriteriaChecked.every(Boolean);
  tttVerifyBtnEl.style.display = allDone ? 'block' : 'none';
}

function renderPlanGroups(targetEl, groups) {
  renderPlanRulesSection();
  renderTttCriteria();
  const savedScrollTop = planListScrollTop;
  targetEl.textContent = '';
  targetEl.classList.toggle('plan-selection-mode', selectionMode);
  const list = Array.isArray(groups) ? groups : [];
  let renderedAny = false;
  for (let i = 0; i < list.length; i++) {
    const group = list[i];
    const groupKey = group.id || ('playlist-' + i);
    const hasSavedCollapse = Object.prototype.hasOwnProperty.call(collapsedPlanGroups, groupKey);
    const defaultCollapsed = String(group.playlistStatus || '').toLowerCase() !== 'running';
    const activeQuery = planSearchQuery.trim();
    const collapsed = activeQuery
      ? false
      : (!planTasksVisible || (hasSavedCollapse ? !!collapsedPlanGroups[groupKey] : defaultCollapsed));
    const allTasks = Array.isArray(group.tasks) ? group.tasks : [];
    if (selectedPlaylists[groupKey]) {
      for (let ti = 0; ti < allTasks.length; ti++) {
        selectedTasks[groupKey + ':' + ti] = true;
      }
    }
    const tasks = allTasks.filter((task) => {
      const status = String(task.status || '').toLowerCase();
      const query = planSearchQuery.trim().toLowerCase();
      const taskName = String(task.name || '').toLowerCase();
      const groupName = String(group.name || '').toLowerCase();
      if (query && !taskName.includes(query) && !groupName.includes(query)) {
        return false;
      }
      if (planFilterMode === 'pending') {
        return status === '' || status === 'pending' || status === 'queued' || status === 'todo';
      }
      if (planFilterMode === 'completed') {
        return status === 'completed';
      }
      if (planFilterMode === 'failed') {
        return status === 'failed' || status === 'blocked';
      }
      return true;
    });
    // Hide a playlist only when a filter is narrowing the view. An
    // unfiltered playlist with no tasks must still render, otherwise
    // deleting its last task makes the playlist unreachable forever.
    const filterIsNarrowing = planFilterMode === 'completed'
      || planFilterMode === 'failed'
      || planFilterMode === 'pending';
    if (tasks.length === 0 && filterIsNarrowing) {
      continue;
    }
    const header = document.createElement('div');
    header.className = 'item';
    const row = document.createElement('div');
    row.className = 'plan-group-row';

    const select = document.createElement('input');
    select.type = 'checkbox';
    const checkedTaskCount = allTasks.filter((_t, ti) => !!selectedTasks[groupKey + ':' + ti]).length;
    const allTaskChecked = allTasks.length > 0 && checkedTaskCount === allTasks.length;
    const anyTaskChecked = checkedTaskCount > 0;
    const playlistChecked = !!selectedPlaylists[groupKey] || allTaskChecked;
    select.checked = playlistChecked;
    select.indeterminate = !playlistChecked && anyTaskChecked;
    select.addEventListener('change', () => {
      selectedPlaylists[groupKey] = select.checked;
      const tasks = Array.isArray(group.tasks) ? group.tasks : [];
      for (let ti = 0; ti < tasks.length; ti++) {
        const taskKey = groupKey + ':' + ti;
        selectedTasks[taskKey] = select.checked;
      }
      renderPlanTools();
      renderPlanGroups(targetEl, list);
    });

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'plan-group-toggle';

    const groupStatus = String(group.playlistStatus || 'pending').toLowerCase();
    if (groupStatus === 'running') {
      header.classList.add('running-item');
    }
    const groupIcon = groupStatus === 'completed'
      ? ICON_COMPLETED
      : groupStatus === 'running'
        ? ICON_RUNNING
        : groupStatus === 'failed'
          ? ICON_FAILED
          : groupStatus === 'blocked'
            ? ICON_BLOCKED
            : groupStatus === 'skipped'
              ? ICON_SKIPPED
              : groupStatus === 'paused'
                ? ICON_PAUSE
                : ICON_PENDING;
    const groupLabel = (collapsed ? (ICON_COLLAPSED + ' ') : (ICON_EXPANDED + ' ')) + (group.name || 'Playlist');
    const totalCount = allTasks.length;
    const doneCount = allTasks.filter((t) => {
      const s = String(t.status || '').toLowerCase();
      return s === 'completed' || s === 'skipped';
    }).length;
    const failedCount = allTasks.filter((t) => {
      const s = String(t.status || '').toLowerCase();
      return s === 'failed' || s === 'blocked';
    }).length;
    const pendingCount = allTasks.filter((t) => {
      const s = String(t.status || '').toLowerCase();
      return isPendingLikeStatus(s);
    }).length;
    const groupSubLabel = groupStatus === 'running'
      ? 'EXECUTING'
      : doneCount === totalCount && totalCount > 0
        ? (String(totalCount) + '/' + String(totalCount) + ' done')
        : pendingCount === totalCount
          ? (totalCount === 1 ? '1 pending' : String(totalCount) + ' pending')
          : failedCount > 0
            ? (String(failedCount) + ' failed · ' + String(doneCount) + '/' + String(totalCount) + ' done')
            : (String(doneCount) + '/' + String(totalCount) + ' done');
    toggle.innerHTML =
      '<span class="item-title">' +
        '<span class="state-icon ' + escHtml(groupStatus) + '">' + escHtml(groupIcon) + '</span>' +
        escHtml(groupLabel) +
      '</span>' +
      '<span class="item-subtitle">' + escHtml(groupSubLabel) + '</span>' +
      (groupStatus === 'running' ? '<span class="run-badge">Running</span>' : '');
    toggle.addEventListener('click', () => {
      collapsedPlanGroups[groupKey] = !collapsedPlanGroups[groupKey];
      renderPlanGroups(targetEl, list);
    });
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'plan-group-play';
    play.title = groupStatus === 'running' ? 'Pause entire run (not just this playlist)' : groupStatus === 'completed' ? 'Re-execute' : 'Execute';
    play.innerHTML = groupStatus === 'running'
      ? '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><rect x="3.5" y="2.5" width="3.5" height="11" rx="1"/><rect x="9" y="2.5" width="3.5" height="11" rx="1"/></svg>'
      : groupStatus === 'completed'
        ? '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5"/><polyline points="10.5 2.5 13.5 2.5 13.5 5.5"/></svg>'
        : '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M4.5 2.5l8 5.5-8 5.5V2.5z"/></svg>';
    if (groupStatus === 'running') {
      play.classList.add('running');
    }
    play.addEventListener('click', () => {
      if (groupStatus === 'running') {
        vscode.postMessage({ type: 'pauseRun' });
      } else {
        vscode.postMessage({ type: 'playPlaylist', playlistIndex: i });
      }
    });

    const playlistRules = group.aiRules || '';
    const rulesBtn = document.createElement('button');
    rulesBtn.type = 'button';
    rulesBtn.className = 'plan-group-rules-btn' + (playlistRules ? ' has-rules' : '');
    rulesBtn.title = playlistRules ? 'Playlist rules active — click to edit' : 'Add playlist rules';
    rulesBtn.title = playlistRules ? 'Playlist rules active — click to edit' : 'Add playlist rules';
    rulesBtn.innerHTML = playlistRules
      ? '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M4 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm0 3h8V4H4v1zm0 3h8V7H4v1zm0 3h5v-1H4v1z"/></svg>'
      : '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>';

    const rulesPanel = document.createElement('div');
    rulesPanel.className = 'rules-edit-panel';
    rulesPanel.style.display = 'none';
    rulesPanel.innerHTML =
      '<label>Playlist rules — injected before every task in this playlist</label>' +
      '<textarea rows="5" placeholder="e.g. Always use TypeScript strict mode. Check for existing utilities before creating new ones.">' + escHtml(playlistRules) + '</textarea>' +
      '<div class="rules-edit-btns">' +
        '<button type="button" class="rules-cancel-btn">Cancel</button>' +
        '<button type="button" class="rules-save-btn">Save</button>' +
      '</div>';

    rulesBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = rulesPanel.style.display !== 'none';
      rulesPanel.style.display = open ? 'none' : 'block';
      if (!open) { rulesPanel.querySelector('textarea')?.focus(); }
    });
    rulesPanel.querySelector('.rules-save-btn')?.addEventListener('click', () => {
      const val = rulesPanel.querySelector('textarea')?.value ?? '';
      vscode.postMessage({ type: 'savePlaylistRules', playlistIndex: i, rules: val });
      rulesPanel.style.display = 'none';
    });
    rulesPanel.querySelector('.rules-cancel-btn')?.addEventListener('click', () => {
      rulesPanel.style.display = 'none';
    });

    row.appendChild(select);
    row.appendChild(toggle);
    if (group.prdContext) {
      const prdBtn = document.createElement('button');
      prdBtn.type = 'button';
      prdBtn.className = 'prd-pill-btn';
      prdBtn.title = 'View PRD slice for this playlist';
      prdBtn.innerHTML = '&#128196; PRD';
      prdBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'showPlaylistPrdContext', prdContext: group.prdContext });
      });
      row.appendChild(prdBtn);
    }
    row.appendChild(rulesBtn);
    row.appendChild(play);
    header.appendChild(row);
    header.appendChild(rulesPanel);
    targetEl.appendChild(header);
    renderedAny = true;
    if (collapsed) {
      continue;
    }

    for (let ti = 0; ti < tasks.length; ti++) {
      const task = tasks[ti];
      const originalIndex = allTasks.indexOf(task);
      const taskKey = groupKey + ':' + originalIndex;
      const taskBtn = document.createElement('button');
      taskBtn.type = 'button';
      taskBtn.className = 'item';
      taskBtn.style.paddingLeft = '20px';
      const status = String(task.status || 'pending').toLowerCase();
      taskBtn.dataset.status = status;
      const failureReason = (status === 'failed' || status === 'blocked')
        ? String(task.failureReason || '').trim()
        : '';
      const statusLabel = status === 'running'
        ? 'EXECUTING'
        : status === 'completed'
          ? 'done'
          : isPendingLikeStatus(status)
            ? ''
            : (task.status || '');
      if (status === 'running') {
        taskBtn.classList.add('running-item');
      }
      const taskIcon = status === 'completed'
        ? ICON_COMPLETED
        : status === 'running'
          ? ICON_RUNNING
          : status === 'failed'
            ? ICON_FAILED
            : status === 'blocked'
              ? ICON_BLOCKED
              : status === 'skipped'
                ? ICON_SKIPPED
                : status === 'paused'
                  ? ICON_PAUSE
                  : ICON_PENDING;
      const isFailedLike = status === 'failed' || status === 'blocked';
      const SVG_PLAY = '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M4.5 2.5l8 5.5-8 5.5V2.5z"/></svg>';
      const SVG_PAUSE = '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><rect x="3.5" y="2.5" width="3.5" height="11" rx="1"/><rect x="9" y="2.5" width="3.5" height="11" rx="1"/></svg>';
      const SVG_RETRY = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5"/><polyline points="10.5 2.5 13.5 2.5 13.5 5.5"/></svg>';
      const SVG_EDIT = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z"/></svg>';
      const SVG_EYE = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="8" rx="6" ry="3.5"/><circle cx="8" cy="8" r="1.5"/></svg>';
      const editBtnHtml = status !== 'running' ? '<button type="button" class="task-act-btn task-edit-btn" title="Edit task">' + SVG_EDIT + '</button>' : '';
      const previewBtnHtml = '<button type="button" class="task-act-btn task-preview-btn" title="Preview prompt">' + SVG_EYE + '</button>';
      const actionButtons = isFailedLike
        ? '<button type="button" class="task-act-btn task-retry" title="Re-execute unchanged">' + SVG_RETRY + '</button>' +
          '<button type="button" class="smart-fix-btn task-fix" title="Pre-fill composer with error context for guided fix">Fix</button>' +
          editBtnHtml + previewBtnHtml
        : '<button type="button" class="task-act-btn task-toggle" title="' + (status === 'running' ? 'Pause entire run (not just this task)' : 'Execute') + '">' + (status === 'running' ? SVG_PAUSE : SVG_PLAY) + '</button>' +
          editBtnHtml + previewBtnHtml;
      const tokenMeta = (() => {
        const u = task.tokenUsage;
        if (!u || (!u.totalTokens && !u.estimatedCost)) { return ''; }
        const parts = [];
        if (u.totalTokens) { parts.push((u.totalTokens >= 1000 ? (u.totalTokens / 1000).toFixed(1) + 'K' : String(u.totalTokens)) + ' tok'); }
        if (u.estimatedCost) { parts.push('$' + u.estimatedCost.toFixed(u.estimatedCost < 0.01 ? 4 : 2)); }
        return parts.length ? '<span class="item-subtitle token-meta">' + escHtml(parts.join(' · ')) + '</span>' : '';
      })();
      const errorCat = task.errorCategory || '';
      const errorCatBadge = errorCat
        ? '<span class="error-cat ' + escHtml(errorCat) + '">' + escHtml(errorCat) + '</span>'
        : '';
      const attemptBadge = (task.attemptCount && task.attemptCount > 1)
        ? '<span class="attempt-badge">(' + task.attemptCount + ' attempts)</span>'
        : '';
      const issueBadge = task.sourceIssueNumber
        ? '<span class="issue-badge" data-repo="' + escHtml(task.sourceIssueRepo || '') + '" data-number="' + escHtml(String(task.sourceIssueNumber)) + '" title="GitHub issue #' + task.sourceIssueNumber + '">#' + task.sourceIssueNumber + '</span>'
        : '';
      const errLines = Array.isArray(task.errorLines) ? task.errorLines : [];
      const errorLinesHtml = isFailedLike && errLines.length > 0
        ? '<div class="error-lines">' + errLines.slice(0, 3).map((l) => '<div class="error-line">' + escHtml(l) + '</div>').join('') + '</div>'
        : '';
      taskBtn.innerHTML =
        '<div class="task-row">' +
          '<input type="checkbox" class="task-check"' + (selectedTasks[taskKey] ? ' checked' : '') + '>' +
          '<button type="button" class="task-main">' +
            '<span class="item-title"><span class="item-dot"></span>' + escHtml(task.name || 'Untitled task') + issueBadge + errorCatBadge + attemptBadge + '</span>' +
            '<span class="item-subtitle">' + escHtml(statusLabel) + '</span>' +
            (failureReason ? '<span class="item-subtitle error" title="' + escHtml(failureReason) + '">' + escHtml(failureReason) + '</span>' : '') +
            errorLinesHtml +
            tokenMeta +
            (status === 'running' ? '<span class="run-badge">Executing</span>' : '') +
          '</button>' +
          '<span class="task-actions' + (status === 'running' || isFailedLike ? ' always-visible' : '') + '">' +
            actionButtons +
          '</span>' +
        '</div>';
      const baseTaskTitle = '<span class="item-title"><span class="item-dot"></span>' + escHtml(task.name || 'Untitled task') + '</span>';
      const richTaskTitle =
        '<span class="item-title">' +
          '<span class="state-icon ' + escHtml(status) + '">' + escHtml(taskIcon) + '</span>' +
          '<span class="' + (status === 'completed' ? 'task-title-completed' : '') + '">' + escHtml(task.name || 'Untitled task') + '</span>' +
        '</span>';
      taskBtn.innerHTML = taskBtn.innerHTML.replace(baseTaskTitle, richTaskTitle);
      const mainBtn = taskBtn.querySelector('.task-main');
      mainBtn?.addEventListener('click', () => {
        if (task.id) {
          vscode.postMessage({ type: 'openItem', id: task.id, kind: 'plan' });
        }
      });
      const issueBadgeEl = taskBtn.querySelector('.issue-badge');
      issueBadgeEl?.addEventListener('click', (event) => {
        event.stopPropagation();
        const repo = issueBadgeEl.getAttribute('data-repo') || '';
        const num = issueBadgeEl.getAttribute('data-number') || '';
        if (repo && num) {
          vscode.postMessage({ type: 'openExternalUrl', url: 'https://github.com/' + repo + '/issues/' + num });
        }
      });
      const check = taskBtn.querySelector('.task-check');
      check?.addEventListener('click', (event) => event.stopPropagation());
      check?.addEventListener('change', () => {
        const checked = !!check.checked;
        selectedTasks[taskKey] = checked;
        const allTaskKeys = allTasks.map((_t, idx) => groupKey + ':' + idx);
        const allChecked = allTaskKeys.length > 0 && allTaskKeys.every((k) => !!selectedTasks[k]);
        selectedPlaylists[groupKey] = allChecked;
        renderPlanTools();
        renderPlanGroups(targetEl, list);
      });
      const toggleBtn = taskBtn.querySelector('.task-toggle');
      toggleBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        if (status === 'running') {
          vscode.postMessage({ type: 'pauseRun' });
        } else {
          vscode.postMessage({ type: 'playTask', playlistIndex: i, taskIndex: originalIndex });
        }
      });
      if (status === 'running' && toggleBtn) {
        toggleBtn.classList.add('running');
      }
      const retryBtn = taskBtn.querySelector('.task-retry');
      retryBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: 'retryTask', playlistIndex: i, taskIndex: originalIndex });
      });
      const fixBtn = taskBtn.querySelector('.task-fix');
      fixBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: 'showSmartFix', playlistIndex: i, taskIndex: originalIndex });
      });

      const editPanel = document.createElement('div');
      editPanel.className = 'task-edit-panel';
      editPanel.style.display = 'none';
      editPanel.innerHTML =
        '<div class="task-edit-form">' +
          '<input class="task-edit-name" type="text" value="' + escHtml(task.name || '') + '" placeholder="Task name">' +
          '<textarea class="task-edit-prompt" rows="5" placeholder="Task prompt">' + escHtml(task.prompt || '') + '</textarea>' +
          '<div class="task-edit-btns">' +
            '<button type="button" class="task-edit-cancel">Cancel</button>' +
            '<button type="button" class="task-edit-save">Save</button>' +
          '</div>' +
        '</div>';

      const editBtnEl = taskBtn.querySelector('.task-edit-btn');
      editBtnEl?.addEventListener('click', (event) => {
        event.stopPropagation();
        const open = editPanel.style.display !== 'none';
        editPanel.style.display = open ? 'none' : 'block';
        if (!open) { (editPanel.querySelector('.task-edit-name'))?.focus(); }
      });

      const previewBtnEl = taskBtn.querySelector('.task-preview-btn');
      previewBtnEl?.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: 'previewTask', playlistIndex: i, taskIndex: originalIndex });
      });

      editPanel.querySelector('.task-edit-save')?.addEventListener('click', () => {
        const nameVal = ((editPanel.querySelector('.task-edit-name'))?.value || '').trim();
        const promptVal = (editPanel.querySelector('.task-edit-prompt'))?.value || '';
        if (!nameVal) { (editPanel.querySelector('.task-edit-name'))?.focus(); return; }
        vscode.postMessage({ type: 'saveTaskEdit', playlistIndex: i, taskIndex: originalIndex, name: nameVal, prompt: promptVal });
        editPanel.style.display = 'none';
      });

      editPanel.querySelector('.task-edit-cancel')?.addEventListener('click', () => {
        editPanel.style.display = 'none';
      });

      targetEl.appendChild(taskBtn);
      targetEl.appendChild(editPanel);
    }
  }
  if (!renderedAny) {
    const empty = document.createElement('div');
    empty.className = 'empty active';
    empty.textContent = planSearchQuery
      ? 'No tasks match this search.'
      : 'No tasks to display.';
    targetEl.appendChild(empty);
  }
  // Restore scroll: on first load auto-scroll to first active/pending task; otherwise restore saved position
  if (!planListScrollInitialized) {
    planListScrollInitialized = true;
    requestAnimationFrame(() => {
      const activeEl = targetEl.querySelector('.item[data-status="running"]')
        || targetEl.querySelector('.item[data-status="failed"]')
        || targetEl.querySelector('.item[data-status="pending"]');
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'center' });
      }
    });
  } else if (savedScrollTop > 0) {
    requestAnimationFrame(() => { targetEl.scrollTop = savedScrollTop; });
  }
}

function renderPlanOverview(groups) {
  const list = Array.isArray(groups) ? groups : [];
  if (list.length === 0) {
    planOverviewEl.classList.remove('active');
    planOverviewRunningEl.classList.remove('active');
    planOverviewRunningTextEl.textContent = '';
    return;
  }
  const playlistTotal = list.length;
  const playlistDone = list.filter((group) => {
    const s = String(group.playlistStatus || '').toLowerCase();
    return s === 'completed' || s === 'failed';
  }).length;
  const taskTotal = list.reduce((sum, group) => sum + (group.progress?.total || 0), 0);
  // completed = truly completed (or skipped), failed = failed/blocked
  const taskCompleted = list.reduce((sum, group) => {
    const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
    return sum + tasks.filter((t) => { const s = String(t?.status || '').toLowerCase(); return s === 'completed' || s === 'skipped'; }).length;
  }, 0);
  const taskFailed = list.reduce((sum, group) => {
    const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
    return sum + tasks.filter((t) => { const s = String(t?.status || '').toLowerCase(); return s === 'failed' || s === 'blocked'; }).length;
  }, 0);
  const pct = taskTotal > 0 ? Math.round(((taskCompleted + taskFailed) / taskTotal) * 100) : 0;

  const planLabel = (activePlanName || '').replace(/^MOAG\s*[-:]\s*/i, '').trim() || 'Plan';
  const allDone = taskTotal > 0 && taskFailed === 0 && (taskCompleted >= taskTotal);

  if (allDone) {
    // Auto-collapse sandbox + AI rules sections — they're irrelevant for a completed plan
    if (!sbCollapsed) {
      sbCollapsed = true;
      sbToggleEl?.classList.add('collapsed');
      sbBodyEl?.classList.add('collapsed');
    }
    // ─── Completion ceremony: replace progress bar with done banner ───
    planOverviewTitleEl.textContent = planLabel;
    planOverviewMetaEl.textContent = taskTotal + ' tasks · ' + playlistTotal + ' playlists — all done';
    planOverviewFillEl.style.width = '100%';
    planOverviewFillEl.classList.remove('has-failed');
    planOverviewEl.classList.add('done');
    if (planOverviewFailedMetaEl) { planOverviewFailedMetaEl.style.display = 'none'; }
    // Show done action row (Create PR / New Sprint)
    var doneBannerEl = document.getElementById('planDoneBanner');
    if (!doneBannerEl) {
      doneBannerEl = document.createElement('div');
      doneBannerEl.id = 'planDoneBanner';
      doneBannerEl.className = 'plan-done-banner';
      doneBannerEl.innerHTML =
        '<span class="plan-done-check">✓ Plan complete</span>' +
        '<div class="plan-done-actions">' +
          // These attributes are built as strings, so the quote is escaped once.
          // It used to be escaped twice, to survive the template literal this file
          // was quoted inside; that hazard is gone now the script is a real file.
          '<button class="plan-done-btn" onclick="vscode.postMessage({type:\'createPR\'})">Create PR</button>' +
          '<button class="plan-done-btn ghost" onclick="vscode.postMessage({type:\'switchPlan\'})">New Sprint</button>' +
        '</div>';
      planOverviewEl.appendChild(doneBannerEl);
    }
    doneBannerEl.style.display = 'flex';
  } else {
    planOverviewTitleEl.textContent = planLabel + ' Progress';
    planOverviewMetaEl.textContent = playlistDone + '/' + playlistTotal + ' playlists, ' + taskCompleted + '/' + taskTotal + ' tasks completed';
    planOverviewFillEl.style.width = pct + '%';
    planOverviewFillEl.classList.toggle('has-failed', taskFailed > 0);
    planOverviewEl.classList.remove('done');
    var existingBanner = document.getElementById('planDoneBanner');
    if (existingBanner) { existingBanner.style.display = 'none'; }
    if (planOverviewFailedMetaEl) {
      if (taskFailed > 0) {
        planOverviewFailedMetaEl.textContent = '⚠ ' + taskFailed + ' task' + (taskFailed === 1 ? '' : 's') + ' failed — use "Fix All" to retry';
        planOverviewFailedMetaEl.style.display = '';
      } else {
        planOverviewFailedMetaEl.style.display = 'none';
      }
    }
  }

  let runningPlaylistName = '';
  let runningTaskName = '';
  let queuedPlaylistName = '';
  let queuedTaskName = '';
  for (let i = 0; i < list.length; i++) {
    const group = list[i];
    const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
    const runningTask = tasks.find((task) => String(task?.status || '').toLowerCase() === 'running');
    if (runningTask) {
      runningPlaylistName = group?.name || ('Playlist ' + (i + 1));
      runningTaskName = runningTask?.name || 'Untitled task';
      break;
    }
    if (!runningPlaylistName && String(group?.playlistStatus || '').toLowerCase() === 'running') {
      runningPlaylistName = group?.name || ('Playlist ' + (i + 1));
    }
    if (!queuedTaskName) {
      const queuedTask = tasks.find((task) => {
        const s = String(task?.status || '').toLowerCase();
        return !s || s === 'pending' || s === 'queued' || s === 'todo';
      });
      if (queuedTask) {
        queuedPlaylistName = group?.name || ('Playlist ' + (i + 1));
        queuedTaskName = queuedTask?.name || 'Untitled task';
      }
    }
  }
  if (runningPlaylistName || runnerState === 'playing') {
    const runningLabel = runningTaskName
      ? ('Running: ' + runningPlaylistName + ' ' + ICON_ARROW_RIGHT + ' ' + runningTaskName)
      : queuedTaskName
        ? ('Queued next: ' + queuedPlaylistName + ' ' + ICON_ARROW_RIGHT + ' ' + queuedTaskName)
        : runningPlaylistName
          ? ('Running: ' + runningPlaylistName)
          : 'Running: preparing next task...';
    planOverviewRunningTextEl.textContent = runningLabel;
    planOverviewRunningEl.classList.add('active');
  } else {
    planOverviewRunningEl.classList.remove('active');
    planOverviewRunningTextEl.textContent = '';
  }
  planOverviewEl.classList.add('active');
}

function renderPlanQueue(groups) {
  const list = Array.isArray(groups) ? groups : [];
  const pending = [];
  for (let i = 0; i < list.length; i++) {
    const group = list[i];
    const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
    for (let ti = 0; ti < tasks.length; ti++) {
      const task = tasks[ti];
      const status = String(task?.status || '').toLowerCase();
      if (isPendingLikeStatus(status)) {
        pending.push({ groupName: group?.name || ('Playlist ' + (i + 1)), taskName: task?.name || 'Untitled task' });
      }
    }
  }

  if (pending.length === 0) {
    planQueueMetaEl.textContent = '0 tasks pending';
    planQueueNextTaskEl.textContent = 'Next: all tasks complete';
    planQueueDotsEl.textContent = '';
    planQueueEl.classList.remove('active');
    return;
  }

  planQueueMetaEl.textContent = pending.length + ' task' + (pending.length === 1 ? '' : 's') + ' pending';
  const next = pending[0];
  planQueueNextTaskEl.textContent = 'Next: ' + next.groupName + ' ' + ICON_ARROW_RIGHT + ' ' + next.taskName;
  planQueueDotsEl.textContent = '';
  const dotCount = Math.min(4, pending.length);
  for (let i = 0; i < dotCount; i++) {
    const dot = document.createElement('span');
    dot.className = 'plan-queue-dot' + (i === 0 ? ' active' : '');
    planQueueDotsEl.appendChild(dot);
  }
  planQueueEl.classList.add('active');
}

function renderPlanListHeading() {
  if (activeTab !== 'plan') {
    planListHeadingEl.classList.remove('active');
    return;
  }
  planListHeadingEl.classList.add('active');
}

function renderPlanTools() {
  const iconMarkup = (kind) => {
    if (kind === 'play') {
      return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5l7 4.5-7 4.5z"></path></svg>';
    }
    if (kind === 'pause') {
      return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5v9"></path><path d="M10.5 3.5v9"></path></svg>';
    }
    if (kind === 'pending') {
      return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v4.5l3 1.5"></path><path d="M8 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z"></path></svg>';
    }
    if (kind === 'search') {
      return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.5 11.5l2 2"></path><path d="M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10z"></path></svg>';
    }
    if (kind === 'switch') {
      return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5h9"></path><path d="M10 3l2 2-2 2"></path><path d="M13 11H4"></path><path d="M6 9l-2 2 2 2"></path></svg>';
    }
    if (kind === 'menu') {
      return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="8" r="1"></circle><circle cx="8" cy="8" r="1"></circle><circle cx="12" cy="8" r="1"></circle></svg>';
    }
    if (kind === 'filter') {
      return '<svg class="plan-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11l-4.5 5v3l-2 1v-4l-4.5-5z"></path></svg>';
    }
    return '';
  };
  const setIconButton = (el, icon, label) => {
    el.textContent = icon;
    el.title = label;
    el.setAttribute('aria-label', label);
  };
  const label = activePlanName || 'Ad hoc';
  planActiveNameEl.textContent = label;
  planPlayBtnEl.innerHTML = runnerState === 'playing' ? iconMarkup('pause') : iconMarkup('play');
  planPlayBtnEl.title = runnerState === 'playing' ? 'Pause Plan' : 'Execute Plan';
  planPlayBtnEl.setAttribute('aria-label', planPlayBtnEl.title);
  planPlayBtnEl.classList.toggle('active', runnerState === 'playing');
  planRunPendingBtnEl.innerHTML = iconMarkup('pending');
  planRunPendingBtnEl.title = 'Run Pending';
  planRunPendingBtnEl.setAttribute('aria-label', 'Run Pending');
  planSearchBtnEl.innerHTML = iconMarkup('search');
  planSearchBtnEl.setAttribute('aria-label', 'Search tasks');
  planSwitchQuickBtnEl.innerHTML = iconMarkup('switch');
  planSwitchQuickBtnEl.title = 'Switch Plan';
  planSwitchQuickBtnEl.setAttribute('aria-label', 'Switch Plan');
  planManageBtnEl.innerHTML = iconMarkup('menu');
  planManageBtnEl.title = 'More Actions';
  planManageBtnEl.setAttribute('aria-label', 'More Actions');
  const searchLabel = planSearchQuery ? ('Search: ' + planSearchQuery) : 'Search tasks';
  planSearchBtnEl.title = searchLabel;
  planSearchBtnEl.classList.toggle('active', !!planSearchQuery);
  planSearchBarEl.classList.toggle('active', !!planSearchQuery || planSearchInputEl === document.activeElement);
  if (planSearchInputEl.value !== planSearchQuery) {
    planSearchInputEl.value = planSearchQuery;
  }
  const keys = (planGroups || []).map((g, i) => g.id || ('playlist-' + i));
  const taskTotal = (planGroups || []).reduce((sum, group) => sum + ((group?.tasks || []).length), 0);
  const taskDone = (planGroups || []).reduce((sum, group) => {
    const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
    return sum + tasks.filter((t) => String(t?.status || '').toLowerCase() === 'completed').length;
  }, 0);
  planExecCounterEl.textContent = taskDone + '/' + taskTotal;
  const runnerLabel = runnerState === 'playing'
    ? 'EXECUTING'
    : runnerState === 'paused'
      ? 'PAUSED'
      : runnerState === 'stopping'
        ? 'STOPPING'
        : 'IDLE';
  planRunnerBadgeEl.textContent = runnerLabel;
  planRunnerBadgeEl.classList.remove('running', 'paused', 'stopping');
  if (runnerState === 'playing') {
    planRunnerBadgeEl.classList.add('running');
  } else if (runnerState === 'paused') {
    planRunnerBadgeEl.classList.add('paused');
  } else if (runnerState === 'stopping') {
    planRunnerBadgeEl.classList.add('stopping');
  }
  const selectedCount = keys.filter((k) => !!selectedPlaylists[k]).length;
  const selectedTaskCount = Object.keys(selectedTasks).filter((k) => !!selectedTasks[k]).length;
  const selectedTotal = selectedCount + selectedTaskCount;
  const collapsedCount = keys.filter((k) => !!collapsedPlanGroups[k]).length;
  const collapseLabel = collapsedCount > 0 || !planTasksVisible ? 'Expand All' : 'Collapse All';
  planHeadingCollapseBtnEl.textContent = collapseLabel;
  planHeadingCollapseBtnEl.title = collapseLabel;
  planHeadingCollapseBtnEl.setAttribute('aria-label', collapseLabel);
  if (planSelectModeCbEl) {
    planSelectModeCbEl.checked = selectionMode;
    planSelectModeCbEl.title = selectionMode ? 'Selection mode enabled' : 'Selection mode disabled';
    planSelectModeCbEl.setAttribute('aria-label', planSelectModeCbEl.title);
  }
  if (planListSelectModeCbEl) {
    planListSelectModeCbEl.checked = selectionMode;
  }
  const runSelectedLabel = selectedTotal > 0 ? ('Run Selected (' + selectedTotal + ')') : 'Run Selected';
  planRunSelectedBtnEl.textContent = runSelectedLabel;
  planRunSelectedBtnEl.title = runSelectedLabel;
  planRunSelectedBtnEl.setAttribute('aria-label', runSelectedLabel);
  planRunSelectedBtnEl.disabled = !selectionMode || selectedTotal === 0 || runnerState === 'playing';
  const pendingTaskCount = (planGroups || []).reduce((sum, group) => {
    const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
    return sum + tasks.filter((t) => {
      const s = String(t?.status || '').toLowerCase();
      return isPendingLikeStatus(s);
    }).length;
  }, 0);
  planRunPendingBtnEl.setAttribute('data-badge', String(pendingTaskCount));
  const pendingLabel = pendingTaskCount > 0
    ? ('Run Pending (' + pendingTaskCount + ')')
    : 'Run Pending';
  planRunPendingBtnEl.title = pendingLabel;
  planRunPendingBtnEl.setAttribute('aria-label', pendingLabel);
  planRunPendingBtnEl.disabled = pendingTaskCount === 0 || runnerState === 'playing';
  const failedTaskCount = (planGroups || []).reduce((sum, group) => {
    const tasks = Array.isArray(group?.tasks) ? group.tasks : [];
    return sum + tasks.filter((t) => {
      const s = String(t?.status || '').toLowerCase();
      return s === 'failed' || s === 'blocked';
    }).length;
  }, 0);
  const planState = runnerState === 'playing' ? 'running'
    : runnerState === 'paused' ? 'paused'
    : runnerState === 'stopping' ? 'stopping'
    : failedTaskCount > 0 ? 'failed'
    : (taskDone === taskTotal && taskTotal > 0) ? 'completed'
    : 'idle';
  planToolsEl.classList.remove('plan-state-idle', 'plan-state-running', 'plan-state-paused', 'plan-state-stopping', 'plan-state-failed', 'plan-state-completed');
  planToolsEl.classList.add('plan-state-' + planState);
  const workflowOrder = ['chat', 'plan', 'review', 'execute', 'fix', 'done'];
  const workflowStep = planState === 'running' || planState === 'paused' || planState === 'stopping' ? 'execute'
    : planState === 'failed' ? 'fix'
    : planState === 'completed' ? 'done'
    : taskTotal > 0 ? 'review'
    : 'plan';
  const workflowStepperEl = document.getElementById('workflowStepper');
  if (workflowStepperEl) {
    const activeIdx = workflowOrder.indexOf(workflowStep);
    workflowStepperEl.querySelectorAll('[data-step]').forEach((el) => {
      const idx = workflowOrder.indexOf(el.getAttribute('data-step') || '');
      el.classList.remove('active', 'done');
      if (idx === activeIdx) { el.classList.add('active'); }
      else if (idx < activeIdx) { el.classList.add('done'); }
    });
  }
  if (planFixAllBtnEl) {
    planFixAllBtnEl.style.display = 'none';
  }
  // Fix All button in the status bar
  if (planFixAllBarBtnEl) {
    if (failedTaskCount > 0) {
      planFixAllBarBtnEl.textContent = 'Fix All (' + failedTaskCount + ')';
      planFixAllBarBtnEl.style.display = '';
      planFixAllBarBtnEl.disabled = runnerState === 'playing';
    } else {
      planFixAllBarBtnEl.style.display = 'none';
    }
  }
  planStopBtnEl.disabled = runnerState !== 'playing';
  if (planOpenPrdBtnEl) {
    const hasPrd = !!(planPrdSource || detectedPrdFilePath);
    planOpenPrdBtnEl.classList.toggle('visible', hasPrd);
    const prdLabel = detectedPrdFilePath
      ? ('&#128196; ' + detectedPrdFilePath.split(/[\\/]/).pop())
      : '&#128196; PRD';
    planOpenPrdBtnEl.innerHTML = prdLabel;
    planOpenPrdBtnEl.title = detectedPrdFilePath
      ? ('Open PRD: ' + detectedPrdFilePath)
      : (planPrdSource ? 'Open source PRD' : '');
  }
  planFilterChipsEl.querySelectorAll('[data-plan-filter]').forEach((chip) => {
    const on = (chip.getAttribute('data-plan-filter') || 'all') === planFilterMode;
    chip.classList.toggle('active', on);
  });
}

function statusBadge(status) {
  const normalized = typeof status === 'string' ? status.toLowerCase() : '';
  if (!normalized || normalized === 'pending') { return ''; }
  if (normalized === 'completed') {
    return '<svg class="msg-status-icon completed" viewBox="0 0 16 16"><polyline points="2,9 6,13 14,4"/></svg>';
  }
  if (normalized === 'failed' || normalized === 'blocked') {
    return '<svg class="msg-status-icon ' + normalized + '" viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
  }
  if (normalized === 'running') {
    return '<svg class="msg-status-icon running" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" stroke-dasharray="8 24" stroke-dashoffset="0"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/></circle></svg>';
  }
  return '';
}

function messageTypeBadge(msg, displayText) {
  if (!msg || msg.role !== 'assistant') {
    return '';
  }
  const status = String(msg.status || '').toLowerCase();
  const changedFiles = typeof msg.changedFilesCount === 'number' ? msg.changedFilesCount : 0;
  if (status === 'running' || status === 'pending' || status === 'paused' || status === 'stopping') {
    return '<span class="msg-type-dot run-status"></span>';
  }
  if (changedFiles > 0) {
    return '<span class="msg-type-dot code-change"></span>';
  }
  const text = String(displayText || '').trim();
  const looksLikeRunStatus = /^done\./i.test(text) || /^run failed\./i.test(text) || /^task failed\./i.test(text);
  if (looksLikeRunStatus) {
    return '<span class="msg-type-dot run-status"></span>';
  }
  return '<span class="msg-type-dot answer"></span>';
}

function isDoneStatus(status) {
  const normalized = typeof status === 'string' ? status.toLowerCase() : '';
  return normalized === 'completed' || normalized === 'failed' || normalized === 'blocked' || normalized === 'skipped';
}

function formatDuration(durationMs) {
  const ms = typeof durationMs === 'number' ? durationMs : 0;
  if (!ms || ms < 1000) {
    return '-';
  }
  const secs = Math.floor(ms / 1000);
  if (secs < 60) {
    return secs + 's';
  }
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return mins + 'm ' + rem + 's';
}

function renderResultCard(msg) {
  const normalized = (msg.status || 'completed').toString().toLowerCase();
  const outcome = normalized.toUpperCase();
  const files = typeof msg.changedFilesCount === 'number' ? msg.changedFilesCount : 0;
  const duration = formatDuration(msg.durationMs);
  const fileLabel = files === 1 ? '1 file' : files + ' files';
  const u = msg.tokenUsage;
  const totalTok = (u && ((u.totalTokens || 0) || ((u.inputTokens || 0) + (u.outputTokens || 0)))) || 0;
  const tokLabel = totalTok > 0
    ? (totalTok >= 1000 ? (totalTok / 1000).toFixed(1) + 'K' : String(totalTok)) + ' tok'
    : '';
  const costLabel = u && u.estimatedCost > 0
    ? '$' + u.estimatedCost.toFixed(u.estimatedCost < 0.01 ? 4 : 2)
    : '';
  const tokTitle = u && u.inputTokens
    ? 'In: ' + (u.inputTokens || 0).toLocaleString() + '  Out: ' + (u.outputTokens || 0).toLocaleString() + '  Total: ' + totalTok.toLocaleString()
    : '';
  return (
    '<div class="result-card">' +
      '<span class="result-pill ' + escHtml(normalized) + '">' + escHtml(outcome) + '</span>' +
      '<span class="result-strong">' + escHtml(fileLabel) + '</span>' +
      '<span class="result-sep">' + ICON_DOT + '</span>' +
      '<span>' + escHtml(duration) + '</span>' +
      (tokLabel || costLabel
        ? '<span class="result-sep">' + ICON_DOT + '</span>' +
          '<span class="result-tokens" title="' + escHtml(tokTitle) + '">' + escHtml([tokLabel, costLabel].filter(Boolean).join(' · ')) + '</span>'
        : '') +
    '</div>'
  );
}

function markdownToHtml(text) {
  const raw = text || '';
  const parts = [];
  const bt = String.fromCharCode(96);
  const fence = bt + bt + bt;
  const escapedFence = fence.replace(/[-/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
  const regex = new RegExp(escapedFence + '([a-zA-Z0-9_-]+)?\\\\n?([\\\\s\\\\S]*?)' + escapedFence, 'g');
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(raw)) !== null) {
    const plain = raw.slice(lastIndex, match.index);
    if (plain) {
      parts.push(renderInlineMarkdown(plain));
    }
    const lang = match[1] ? '<div class="meta-text">' + escHtml(match[1]) + '</div>' : '';
    const code = '<pre><code>' + escHtml(match[2]) + '</code></pre>';
    parts.push(lang + code);
    lastIndex = regex.lastIndex;
  }

  const tail = raw.slice(lastIndex);
  if (tail) {
    parts.push(renderInlineMarkdown(tail));
  }

  return parts.join('');
}

function renderInlineMarkdown(text) {
  let html = escHtml(text);
  const bt = String.fromCharCode(96);
  const inlineCodeRegex = new RegExp(bt + '([^' + bt + ']+)' + bt, 'g');
  html = html.replace(inlineCodeRegex, '<code>$1</code>');
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
  html = html.replace(/\\n/g, '<br>');
  return html;
}

function compactUserText(text) {
  const raw = text || '';
  if (!raw.includes('[CONTEXT START]')) {
    return raw;
  }
  const lines = raw.split(/\\r?\\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : 'Prompt submitted';
}

function renderMessageBody(messageText, status, role) {
  const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : '';
  if (role === 'assistant' && normalizedStatus === 'running') {
    return (
      '<div class="msg-text">' +
        '<span class="running-inline"><span class="running-dot"></span>' + escHtml(messageText || 'Running...') + '</span>' +
      '</div>'
    );
  }
  const text = messageText || '';
  const lines = text.split(/\\r?\\n/);
  const shouldCollapse = text.length > 800 || lines.length > 18;
  const fullHtml = markdownToHtml(text);
  if (!shouldCollapse) {
    return '<div class="msg-text">' + fullHtml + '</div>';
  }

  const preview = lines.slice(0, 8).join('\\n');
  const previewHtml = markdownToHtml(preview);
  return (
    '<div class="msg-text" data-collapsible="1">' +
      '<div class="msg-preview">' + previewHtml + '</div>' +
      '<div class="msg-full" hidden>' + fullHtml + '</div>' +
      '<button type="button" class="msg-collapse">Show more</button>' +
    '</div>'
  );
}

function attachCollapseHandlers() {
  chatFeedEl.querySelectorAll('.msg-collapse').forEach((btn) => {
    btn.addEventListener('click', () => {
      const container = btn.closest('[data-collapsible="1"]');
      if (!container) { return; }
      const preview = container.querySelector('.msg-preview');
      const full = container.querySelector('.msg-full');
      const expanded = !full.hidden;
      full.hidden = expanded;
      preview.hidden = !expanded;
      btn.textContent = expanded ? 'Show more' : 'Show less';
    });
  });
}

function attachActionMenuHandlers() {
  chatFeedEl.querySelectorAll('.msg-actions-more').forEach((wrap) => {
    wrap.addEventListener('click', (event) => {
      event.stopPropagation();
    });
  });
  if (!actionMenuHandlersBound) {
    actionMenuHandlersBound = true;
    document.addEventListener('click', () => {
      chatFeedEl.querySelectorAll('.msg-more-panel.open').forEach((panel) => {
        panel.classList.remove('open');
      });
    });
  }
}

function renderChat(chatTitle, messages) {
  chatTitleEl.textContent = chatTitle || 'New Chat';
  chatFeedEl.textContent = '';
  const list = Array.isArray(messages) ? messages : [];
  chatEmptyEl.style.display = list.length === 0 ? 'block' : 'none';

  // Update empty-state text based on whether a plan with pending tasks is loaded
  if (list.length === 0) {
    const pendingTasks = Array.isArray(planGroups)
      ? planGroups.reduce(function(n, g) {
          return n + (Array.isArray(g.tasks) ? g.tasks.filter(function(t) {
            const s = String(t.status || '').toLowerCase();
            return !s || s === 'pending';
          }).length : 0);
        }, 0)
      : 0;
    const planHeader = chatEmptyEl.querySelector('strong');
    if (planHeader) {
      if (pendingTasks > 0) {
        planHeader.textContent = pendingTasks + ' task' + (pendingTasks > 1 ? 's' : '') + ' ready to run';
        const hint = chatEmptyEl.querySelector('br + br') || chatEmptyEl.querySelector('br');
        // Replace static hint text
        const secondText = chatEmptyEl.childNodes[2];
        if (secondText && secondText.nodeType === Node.TEXT_NODE) { secondText.textContent = ''; }
      } else {
        planHeader.textContent = 'New conversation';
      }
    }
  }

  for (const msg of list) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (msg.role === 'assistant' ? 'assistant' : 'user');
    const displayText = msg.role === 'user' ? compactUserText(msg.text || '') : (msg.text || '');
    const isUser = msg.role !== 'assistant';
    const avatarSvg = isUser
      ? '<svg class="msg-avatar" viewBox="0 0 16 16"><path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 1c-2.67 0-4 1.33-4 3v1h8v-1c0-1.67-1.33-3-4-3z"/></svg>'
      : '<svg class="msg-avatar" viewBox="0 0 16 16"><path d="M9 1L3 9h5l-1 6 6-8H8L9 1z"/></svg>';
    wrap.innerHTML =
      '<div class="msg-header">' +
        avatarSvg +
        '<span class="msg-author">' + escHtml(msg.author || (isUser ? 'You' : 'Assistant')) + '</span>' +
        messageTypeBadge(msg, displayText) +
        statusBadge(msg.status) +
      '</div>' +
      renderMessageBody(displayText, msg.status, msg.role);

    if (msg.role === 'assistant' && displayText.trim()) {
      if (isDoneStatus(msg.status)) {
        const cardWrap = document.createElement('div');
        cardWrap.innerHTML = renderResultCard(msg);
        wrap.appendChild(cardWrap.firstChild);
        const actions = document.createElement('div');
        actions.className = 'msg-actions';
        const changedFiles = typeof msg.changedFilesCount === 'number' ? msg.changedFilesCount : 0;
        const primaryBtn = document.createElement('button');
        primaryBtn.type = 'button';
        primaryBtn.className = 'msg-action-btn';
        if (changedFiles > 0) {
          primaryBtn.textContent = 'Review Diff';
          primaryBtn.addEventListener('click', () => vscode.postMessage({ type: 'reviewChanges' }));
        } else {
          primaryBtn.textContent = 'Open Dashboard';
          primaryBtn.addEventListener('click', () => vscode.postMessage({ type: 'showDashboard' }));
        }
        actions.appendChild(primaryBtn);

        const moreWrap = document.createElement('div');
        moreWrap.className = 'msg-actions-more';
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'msg-action-btn';
        moreBtn.textContent = 'More';
        const panel = document.createElement('div');
        panel.className = 'msg-more-panel';

        const addMoreItem = (label, onClick) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'msg-more-item';
          item.textContent = label;
          item.addEventListener('click', () => {
            panel.classList.remove('open');
            onClick();
          });
          panel.appendChild(item);
        };

        if (changedFiles > 0) {
          addMoreItem('Open Dashboard', () => vscode.postMessage({ type: 'showDashboard' }));
        } else {
          addMoreItem('Review Diff', () => vscode.postMessage({ type: 'reviewChanges' }));
        }
        addMoreItem('Use as playlist template', () => {
          const seed = 'Create a playlist + tasks from this:\\n' + displayText.slice(0, 1200);
          promptEl.value = seed;
          autoResize();
                  updateActionState();
          promptEl.focus();
        });

        moreBtn.addEventListener('click', () => {
          panel.classList.toggle('open');
        });
        moreWrap.appendChild(moreBtn);
        moreWrap.appendChild(panel);
        actions.appendChild(moreWrap);
        wrap.appendChild(actions);
      }
    }
    chatFeedEl.appendChild(wrap);
  }

  attachCollapseHandlers();
  attachActionMenuHandlers();
  if (list.length > 0) {
    chatFeedEl.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }
}

function renderRunnerChip(state) {
  runnerState = typeof state === 'string' ? state : 'idle';
  renderContextBar();
}

function renderContextBar() {
  const planLabel = (activePlanName || 'Ad hoc').replace(/^MOAG\s*[-:]\s*/i, '').trim();
  const planTrunc = planLabel.length > 20 ? planLabel.slice(0, 19) + '\u2026' : planLabel;
  const planSvg = '<svg viewBox="0 0 16 16" style="width:10px;height:10px;fill:currentColor;flex-shrink:0"><path d="M3 3h10v1H3V3zm0 4h10v1H3V7zm0 4h7v1H3v-1z"/></svg>';
  ctxPlanEl.innerHTML = planSvg + ' ' + escHtml(planTrunc);
  const stateColor = runnerState === 'playing' ? '#4caf50' : runnerState === 'paused' ? '#cca700' : 'currentColor';
  const runnerSvg = '<svg viewBox="0 0 16 16" style="width:10px;height:10px;flex-shrink:0"><circle cx="8" cy="8" r="5" fill="none" stroke="' + stateColor + '" stroke-width="1.5"/></svg>';
  const ctxRunnerLabel = runnerState === 'playing' ? 'EXECUTING' : runnerState.toUpperCase();
  ctxRunnerEl.innerHTML = runnerSvg + ' ' + escHtml(ctxRunnerLabel);
}

function setActiveTab(tab) {
  activeTab = tab === 'plan' || tab === 'history' ? tab : 'chat';
  tabEls.forEach((el) => el.classList.toggle('active', el.dataset.tab === activeTab));

  const showChat = activeTab === 'chat';
  chatScreenEl.classList.toggle('active', showChat);
  planListEl.classList.toggle('active', activeTab === 'plan');
  planToolsEl.classList.toggle('active', activeTab === 'plan');
  planOverviewEl.classList.toggle('active', activeTab === 'plan' && planGroups.length > 0);
  planRulesSectionEl?.classList.toggle('active', activeTab === 'plan');
  if (activeTab !== 'plan') {
    planQueueEl.classList.remove('active');
  }
  renderPlanListHeading();
  historyListEl.classList.toggle('active', activeTab === 'history');
  historyToolsEl.classList.toggle('active', activeTab === 'history');
  sbSectionEl.classList.toggle('active', activeTab === 'plan');
  rulesSectionEl.classList.toggle('active', activeTab === 'plan');

  // PRD button in composer toolbar: visible in chat tab only
  if (composerPrdBtnEl) {
    composerPrdBtnEl.style.display = showChat ? '' : 'none';
    composerPrdBtnEl.classList.toggle('has-prd', !!planPrdSource);
    composerPrdBtnEl.title = planPrdSource ? 'Update PRD linked to this plan' : 'Add PRD to this plan';
    composerPrdBtnEl.innerHTML = planPrdSource ? '&#128196; PRD &#10003;' : '&#128196; PRD';
  }

  if (showChat) {
    listEmptyEl.classList.remove('active');
  } else {
    if (activeTab === 'history') {
      renderHistoryList();
      return;
    }
    const activeItems = planGroups;
    listEmptyEl.textContent = 'No plan tasks yet.';
    listEmptyEl.classList.toggle('active', activeItems.length === 0);
  }
}

function attachImage(dataUri) {
  attachedImage = dataUri;
  imagePreviewThumbEl.src = dataUri;
  imagePreviewBarEl.classList.add('visible');
}

function removeImage() {
  attachedImage = null;
  imagePreviewThumbEl.src = '';
  imagePreviewBarEl.classList.remove('visible');
}

function updateFilePill() {
  if (!filePillRowEl || !filePillNameEl) { return; }
  const show = activeFile && !activeFileDismissed;
  filePillRowEl.style.display = show ? '' : 'none';
  if (show && activeFile) { filePillNameEl.textContent = activeFile.name; }
}

function submit() {
  const text = promptEl.value.trim();
  if (!text || sendEl.disabled) {
    return;
  }
  // PRD draft mode — route to guided Q&A instead of normal execution
  if (prdMode) {
    appendPrdMessage('user', text);
    promptEl.value = '';
    promptEl.style.height = '';
    var typing = showPrdTyping();
    prdAnswers.push(text);
    vscode.postMessage({ type: 'prdAnswer', answer: text, step: prdStep, answers: prdAnswers });
    prdStep++;
    return;
  }
  setActiveTab('chat');
  if (pendingFixRef) {
    const ref = pendingFixRef;
    pendingFixRef = null;
    updateComposerHint();
    vscode.postMessage({
      type: 'retryTaskWithPrompt',
      playlistIndex: ref.playlistIndex,
      taskIndex: ref.taskIndex,
      prompt: text,
    });
    return;
  }
  const injectPath = (activeFile && !activeFileDismissed) ? activeFile.path : undefined;
  vscode.postMessage({
    type: 'submit',
    text,
    engineId: engineEl.disabled ? undefined : engineEl.value,
    imageData: attachedImage || undefined,
    activeFilePath: injectPath,
  });
}

function escHtml(value) {
  const div = document.createElement('div');
  div.textContent = value || '';
  return div.innerHTML;
}

sendEl.addEventListener('click', submit);
generatePlanBtnEl?.addEventListener('click', () => {
  const text = promptEl.value.trim();
  if (!text || generatePlanBtnEl.disabled) { return; }
  vscode.postMessage({ type: 'generatePlan', text });
});
addToPlanBtnEl?.addEventListener('click', () => {
  const text = promptEl.value.trim();
  if (!text) { return; }
  vscode.postMessage({ type: 'addToPlan', text });
});
filePillDismissEl?.addEventListener('click', () => {
  activeFileDismissed = true;
  updateFilePill();
});
newChatBtnEl.addEventListener('click', () => vscode.postMessage({ type: 'newThread' }));
dashboardBtnEl.addEventListener('click', () => vscode.postMessage({ type: 'showDashboard' }));
attachBtnEl.addEventListener('click', function() {
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*';
  fileInput.onchange = function() {
    const file = fileInput.files && fileInput.files[0];
    if (!file) { return; }
    const reader = new FileReader();
    reader.onload = function(ev) { if (ev.target?.result) { attachImage(String(ev.target.result)); } };
    reader.readAsDataURL(file);
  };
  fileInput.click();
});
promptEl.addEventListener('input', () => {
  autoResize();
  updateActionState();
});
promptEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submit();
  } else if (event.key === 'Enter' && (event.altKey || event.shiftKey)) {
    event.preventDefault();
    const text = promptEl.value.trim();
    if (text) { vscode.postMessage({ type: 'addToPlan', text }); }
  }
});
settingsBtnEl.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
imageRemoveBtnEl.addEventListener('click', removeImage);
promptEl.addEventListener('paste', function(e) {
  const items = e.clipboardData?.items;
  if (!items) { return; }
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) { continue; }
      const reader = new FileReader();
      reader.onload = function(ev) { if (ev.target?.result) { attachImage(String(ev.target.result)); } };
      reader.readAsDataURL(file);
      return;
    }
  }
});
inputWrapEl.addEventListener('dragover', function(e: DragEvent) {
  if (Array.from(e.dataTransfer?.items || []).some(function(i) { return i.type.startsWith('image/'); })) {
    e.preventDefault();
    inputWrapEl.classList.add('drag-over');
  }
});
inputWrapEl.addEventListener('dragleave', function() { inputWrapEl.classList.remove('drag-over'); });
inputWrapEl.addEventListener('drop', function(e: DragEvent) {
  inputWrapEl.classList.remove('drag-over');
  const file = Array.from(e.dataTransfer?.files || []).find(function(f) { return f.type.startsWith('image/'); });
  if (!file) { return; }
  e.preventDefault();
  const reader = new FileReader();
  reader.onload = function(ev) { if (ev.target?.result) { attachImage(String(ev.target.result)); } };
  reader.readAsDataURL(file);
});
tabEls.forEach((tabEl) => tabEl.addEventListener('click', () => setActiveTab(tabEl.dataset.tab || 'chat')));
if (planListSelectModeCbEl) {
  planListSelectModeCbEl.addEventListener('change', () => {
    selectionMode = !!planListSelectModeCbEl.checked;
    if (planSelectModeCbEl) {
      planSelectModeCbEl.checked = selectionMode;
    }
    if (!selectionMode) {
      selectedPlaylists = {};
      selectedTasks = {};
    }
    renderPlanGroups(planListEl, planGroups);
    renderPlanTools();
  });
}
if (planSelectModeCbEl) {
  planSelectModeCbEl.addEventListener('change', () => {
    selectionMode = !!planSelectModeCbEl.checked;
    if (planListSelectModeCbEl) {
      planListSelectModeCbEl.checked = selectionMode;
    }
    if (!selectionMode) {
      selectedPlaylists = {};
      selectedTasks = {};
    }
    renderPlanGroups(planListEl, planGroups);
    renderPlanTools();
  });
}
planRunSelectedBtnEl.addEventListener('click', () => {
  const items = [];
  (planGroups || []).forEach((group, idx) => {
    const key = group.id || ('playlist-' + idx);
    const tasks = Array.isArray(group.tasks) ? group.tasks : [];
    for (let ti = 0; ti < tasks.length; ti++) {
      if (selectedTasks[key + ':' + ti]) {
        items.push({ kind: 'task', playlistIndex: idx, taskIndex: ti });
      }
    }
    if (selectedPlaylists[key]) {
      items.push({ kind: 'playlist', playlistIndex: idx });
    }
  });
  if (items.length > 0) {
    vscode.postMessage({ type: 'runSelectedPlaylists', items });
  }
});
planRunPendingBtnEl.addEventListener('click', () => {
  const items = [];
  (planGroups || []).forEach((group, idx) => {
    const tasks = Array.isArray(group.tasks) ? group.tasks : [];
    for (let ti = 0; ti < tasks.length; ti++) {
      const status = String(tasks[ti]?.status || '').toLowerCase();
      if (isPendingLikeStatus(status)) {
        items.push({ kind: 'task', playlistIndex: idx, taskIndex: ti });
      }
    }
  });
  if (items.length > 0) {
    vscode.postMessage({ type: 'runSelectedPlaylists', items });
  }
});
planFixAllBtnEl?.addEventListener('click', () => {
  vscode.postMessage({ type: 'fixAllFailed' });
});
planFixAllBarBtnEl?.addEventListener('click', () => {
  vscode.postMessage({ type: 'fixAllFailed' });
});
reportIssueBtnEl?.addEventListener('click', () => {
  vscode.postMessage({ type: 'reportIssue' });
});
planListEl.addEventListener('scroll', () => { planListScrollTop = planListEl.scrollTop; }, { passive: true });
planStopBtnEl.addEventListener('click', () => {
  planManageMenuEl.classList.remove('open');
  vscode.postMessage({ type: 'pauseRun' });
});
planSearchBtnEl.addEventListener('click', () => {
  if (!planSearchBarEl.classList.contains('active')) {
    planSearchBarEl.classList.add('active');
    planSearchInputEl.focus();
    planSearchInputEl.select();
    return;
  }
  if (planSearchQuery) {
    planSearchQuery = '';
    planSearchInputEl.value = '';
  } else {
    planSearchBarEl.classList.remove('active');
  }
  renderPlanGroups(planListEl, planGroups);
  renderPlanTools();
});
planSearchInputEl.addEventListener('input', () => {
  planSearchQuery = planSearchInputEl.value.trim().toLowerCase();
  renderPlanGroups(planListEl, planGroups);
  renderPlanTools();
});
planSearchInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    planSearchQuery = '';
    planSearchInputEl.value = '';
    planSearchBarEl.classList.remove('active');
    renderPlanGroups(planListEl, planGroups);
    renderPlanTools();
  }
});
planSearchClearBtnEl.addEventListener('click', () => {
  planSearchQuery = '';
  planSearchInputEl.value = '';
  planSearchInputEl.focus();
  renderPlanGroups(planListEl, planGroups);
  renderPlanTools();
});
planPlayBtnEl.addEventListener('click', () => {
  if (runnerState === 'playing') {
    vscode.postMessage({ type: 'pauseRun' });
  } else {
    vscode.postMessage({ type: 'playPlan' });
  }
});
planAddTaskBtnEl.addEventListener('click', () => vscode.postMessage({ type: 'addTask' }));
planNewBtnEl.addEventListener('click', () => vscode.postMessage({ type: 'newPlan' }));
var prdScreenMode = 'generate'; // 'generate' | 'update'
function openPrdInputScreen(mode) {
  prdScreenMode = mode;
  planManageMenuEl?.classList.remove('open');
  if (mode === 'update') {
    if (prdInputTitleEl) { prdInputTitleEl.textContent = planPrdSource ? 'Update PRD' : 'Add PRD'; }
    if (prdInputHintEl) { prdInputHintEl.innerHTML = planPrdSource
      ? 'Edit your PRD below — changes will be saved to the current plan and used for TTT criteria and Verify.'
      : 'Paste your PRD below to link it to the current plan. Use <strong>Verify Against PRD</strong> in the Test &amp; Verify panel after your test playlist runs.'; }
    if (prdGenerateBtnEl) { prdGenerateBtnEl.textContent = 'Save to Plan'; }
    if (prdTextareaEl && planPrdSource) {
      prdTextareaEl.value = planPrdSource;
      var len = planPrdSource.length;
      if (prdCharCountEl) { prdCharCountEl.textContent = len + ' chars'; }
      if (prdGenerateBtnEl) { prdGenerateBtnEl.disabled = len < 20; }
    }
  } else {
    if (prdInputTitleEl) { prdInputTitleEl.textContent = 'Generate Plan from PRD'; }
    if (prdInputHintEl) { prdInputHintEl.innerHTML = 'Paste a PRD or describe what you want to build &mdash; MOAG will generate a Design &rarr; Development &rarr; Testing plan.'; }
    if (prdGenerateBtnEl) { prdGenerateBtnEl.textContent = 'Generate Plan →'; }
    if (prdTextareaEl) { prdTextareaEl.value = ''; prdTextareaEl.style.height = '80px'; }
    if (prdCharCountEl) { prdCharCountEl.textContent = '0 chars'; }
    if (prdGenerateBtnEl) { prdGenerateBtnEl.disabled = true; }
    if (prdChipsRowEl) { prdChipsRowEl.style.display = 'flex'; }
    renderPrdProjectCard();
  }
  if (prdInputScreenEl) { prdInputScreenEl.classList.add('active'); }
  setTimeout(() => { prdTextareaEl?.focus(); }, 50);
}
function showPrdInputScreen() { openPrdInputScreen('generate'); }
function hidePrdInputScreen() {
  if (prdInputScreenEl) { prdInputScreenEl.classList.remove('active'); }
}
planFromPrdBtnEl?.addEventListener('click', showPrdInputScreen);
planFromTemplateBtnEl?.addEventListener('click', () => {
  planManageMenuEl?.classList.remove('open');
  vscode.postMessage({ type: 'newPlanFromTemplate' });
});
chatEmptyTemplateBtnEl?.addEventListener('click', () => vscode.postMessage({ type: 'newPlanFromTemplate' }));
planOpenPrdBtnEl?.addEventListener('click', () => {
  vscode.postMessage({ type: 'openPrdFromPlan' });
});
chatEmptyPrdBtnEl?.addEventListener('click', showPrdInputScreen);
chatStartPrdBtnEl?.addEventListener('click', () => { setActiveTab('chat'); startPrdMode(); });
composerPrdBtnEl?.addEventListener('click', () => openPrdInputScreen('update'));
prdModeCancelBtnEl?.addEventListener('click', exitPrdMode);
prdBackBtnEl?.addEventListener('click', hidePrdInputScreen);
function updatePrdAiBtn() {
  if (!prdAiBtnEl || !prdTextareaEl) { return; }
  var t = prdTextareaEl.value.trim();
  var looksLikePrd = t.length > 400 || /^#{1,3}\s|acceptance criteria|AC[0-9]*[:.]/im.test(t);
  prdAiBtnEl.textContent = looksLikePrd ? '✨ Improve with AI' : '✨ Draft with AI';
}
function renderPrdProjectCard() {
  if (!prdProjectCardEl || !prdProjectNameEl || !prdProjectStackEl) { return; }
  if (prdProjectMeta && prdProjectMeta.name) {
    prdProjectNameEl.textContent = prdProjectMeta.name;
    prdProjectStackEl.textContent = prdProjectMeta.stack ? '· ' + prdProjectMeta.stack : '';
    prdProjectCardEl.style.display = 'flex';
  } else {
    prdProjectCardEl.style.display = 'none';
  }
}
function autoResizePrdTextarea() {
  if (!prdTextareaEl) { return; }
  prdTextareaEl.style.height = 'auto';
  var h = Math.min(Math.max(prdTextareaEl.scrollHeight, 80), 220);
  prdTextareaEl.style.height = h + 'px';
}
if (prdChipsRowEl) {
  prdChipsRowEl.querySelectorAll('.prd-chip').forEach(function(chip) {
    chip.addEventListener('click', function() {
      var prompt = chip.getAttribute('data-prompt');
      if (prdTextareaEl && prompt) {
        prdTextareaEl.value = prompt;
        prdTextareaEl.dispatchEvent(new Event('input'));
        prdTextareaEl.focus();
      }
    });
  });
}
function updatePrdVersionBar(vers) {
  prdVersions = vers || [];
  if (!prdVersionBarEl || !prdVersionSelectEl || !prdVersionSaveBtnEl) { return; }
  if (prdVersions.length > 0) {
    prdVersionBarEl.classList.add('visible');
    prdVersionSelectEl.innerHTML = prdVersions.map(function(v) {
      var d = new Date(v.createdAt).toLocaleDateString();
      return '<option value="' + v.version + '">' + v.version + ' (' + d + ')</option>';
    }).join('');
    prdVersionSaveBtnEl.textContent = 'Save as v' + (prdVersions.length + 1) + '.0';
  } else {
    prdVersionBarEl.classList.remove('visible');
    prdVersionSaveBtnEl.textContent = 'Save as v1.0';
  }
}
prdTextareaEl?.addEventListener('input', function() {
  var len = prdTextareaEl.value.length;
  if (prdCharCountEl) { prdCharCountEl.textContent = len + ' chars'; }
  if (prdGenerateBtnEl) { prdGenerateBtnEl.disabled = len < 20; }
  if (prdChipsRowEl) { prdChipsRowEl.style.display = len > 0 ? 'none' : 'flex'; }
  autoResizePrdTextarea();
  updatePrdAiBtn();
});
prdVersionSelectEl?.addEventListener('change', function() {
  var ver = prdVersions.find(function(v) { return v.version === prdVersionSelectEl.value; });
  if (ver && prdTextareaEl) {
    prdTextareaEl.value = ver.text;
    var len = ver.text.length;
    if (prdCharCountEl) { prdCharCountEl.textContent = len + ' chars'; }
    if (prdGenerateBtnEl) { prdGenerateBtnEl.disabled = len < 20; }
    updatePrdAiBtn();
  }
});
prdVersionSaveBtnEl?.addEventListener('click', function() {
  var text = prdTextareaEl ? prdTextareaEl.value.trim() : '';
  if (!text) { return; }
  var nextVersion = 'v' + (prdVersions.length + 1) + '.0';
  vscode.postMessage({ type: 'savePrdVersion', text: text, version: nextVersion });
});
prdAiBtnEl?.addEventListener('click', function() {
  var text = prdTextareaEl ? prdTextareaEl.value.trim() : '';
  if (!text) { vscode.postMessage({ type: 'planFromPrd' }); return; }
  var looksLikePrd = text.length > 400 || /^#{1,3}\s|acceptance criteria|AC[0-9]*[:.]/im.test(text);
  prdAiBtnEl.disabled = true;
  prdAiBtnEl.textContent = looksLikePrd ? 'Improving…' : 'Drafting PRD…';
  vscode.postMessage({ type: 'prdAiImprove', text: text });
});
prdBrowseBtnEl?.addEventListener('click', () => vscode.postMessage({ type: 'openPrdFile' }));
prdGenerateBtnEl?.addEventListener('click', function() {
  var text = prdTextareaEl ? prdTextareaEl.value.trim() : '';
  if (!text) { return; }
  hidePrdInputScreen();
  if (prdScreenMode === 'update') {
    planPrdSource = text;
    renderTavPanel();
    vscode.postMessage({ type: 'savePrdToPlan', prdText: text });
  } else {
    vscode.postMessage({ type: 'generatePlanFromPrd', prdText: text });
  }
});
planManageBtnEl.addEventListener('click', (event) => {
  event.stopPropagation();
  planManageMenuEl.classList.toggle('open');
});
planManageMenuEl.addEventListener('click', (event) => {
  event.stopPropagation();
});
planFilterChipsEl.querySelectorAll('[data-plan-filter]').forEach((chip) => {
  chip.addEventListener('click', () => {
    const next = chip.getAttribute('data-plan-filter') || 'all';
    planFilterMode = (next === 'pending' || next === 'completed' || next === 'failed') ? next : 'all';
    renderPlanGroups(planListEl, planGroups);
    renderPlanTools();
  });
});
planAddTaskBtnEl.addEventListener('click', () => {
  planManageMenuEl.classList.remove('open');
});
planNewBtnEl.addEventListener('click', () => {
  planManageMenuEl.classList.remove('open');
});
planRunSelectedBtnEl.addEventListener('click', () => {
  planManageMenuEl.classList.remove('open');
});
planSwitchBtnEl.addEventListener('click', () => {
  planManageMenuEl.classList.remove('open');
});
planHeadingCollapseBtnEl.addEventListener('click', () => {
  const keys = (planGroups || []).map((group, idx) => group.id || ('playlist-' + idx));
  const anyCollapsed = keys.some((key) => !!collapsedPlanGroups[key]);
  const next = {};
  keys.forEach((key) => {
    next[key] = !anyCollapsed;
  });
  planTasksVisible = true;
  collapsedPlanGroups = next;
  renderPlanGroups(planListEl, planGroups);
  renderPlanTools();
});
planSwitchQuickBtnEl.addEventListener('click', () => {
  vscode.postMessage({ type: 'switchPlan' });
});
planSwitchBtnEl.addEventListener('click', () => {
  vscode.postMessage({ type: 'switchPlan' });
});
historyGroupByEl.addEventListener('change', () => {
  const next = historyGroupByEl.value;
  historyGroupBy = next === 'plan' || next === 'playlist' ? next : 'none';
  renderHistoryList();
});
historyStatusChipsEl.querySelectorAll('[data-status]').forEach((chip) => {
  chip.addEventListener('click', () => {
    const next = chip.getAttribute('data-status') || 'all';
    historyStatusFilter = next === 'completed' || next === 'failed' ? next : 'all';
    historyStatusChipsEl.querySelectorAll('[data-status]').forEach((el) => {
      const on = (el.getAttribute('data-status') || 'all') === historyStatusFilter;
      el.classList.toggle('active', on);
    });
    renderHistoryList();
  });
});
document.addEventListener('click', (event) => {
  planManageMenuEl.classList.remove('open');
  planFilterMenuEl.classList.remove('open');
  const target = event.target;
  const clickedSearch = target && planSearchBarEl.contains(target);
  const clickedSearchBtn = target && planSearchBtnEl.contains(target);
  if (!clickedSearch && !clickedSearchBtn && !planSearchQuery) {
    planSearchBarEl.classList.remove('active');
  }
});
engineEl.addEventListener('change', () => renderContextBar());

// ─── Sidebar AI Rules ───
const rulesSectionEl = document.getElementById('sidebarRules');
const rulesToggleEl = document.getElementById('rulesToggle');
const rulesBodyEl = document.getElementById('rulesBody');
const rulesBadgeEl = document.getElementById('rulesBadge');
const rulesListEl = document.getElementById('rulesList');
const rulesEmptyEl = document.getElementById('rulesEmpty');
const rulesAddBtnEl = document.getElementById('rulesAddBtn');
const rulesLibBtnEl = document.getElementById('rulesLibBtn');
let rulesCollapsed = true;
let aiRules = [];

rulesToggleEl.addEventListener('click', (e) => {
  if (e.target === rulesAddBtnEl || e.target === rulesLibBtnEl ||
      rulesAddBtnEl.contains(e.target) || rulesLibBtnEl.contains(e.target)) { return; }
  rulesCollapsed = !rulesCollapsed;
  rulesToggleEl.classList.toggle('collapsed', rulesCollapsed);
  rulesBodyEl.classList.toggle('collapsed', rulesCollapsed);
});
rulesAddBtnEl.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'addRule' }); });
rulesLibBtnEl.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'openRulesLibrary' }); });

function renderSidebarRules(rules) {
  aiRules = Array.isArray(rules) ? rules : [];
  const activeCount = aiRules.filter(r => r.enabled).length;
  rulesBadgeEl.textContent = activeCount > 0 ? activeCount + ' active' : '';
  rulesBadgeEl.className = 'sidebar-rules-badge' + (activeCount > 0 ? ' has-active' : '');
  rulesListEl.innerHTML = '';
  if (aiRules.length === 0) {
    rulesEmptyEl.style.display = '';
  } else {
    rulesEmptyEl.style.display = 'none';
    for (var i = 0; i < aiRules.length; i++) {
      var rule = aiRules[i];
      var item = document.createElement('div');
      item.className = 'rule-item';
      item.dataset.id = rule.id;
      item.dataset.scope = rule.scope;
      var toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'rule-toggle' + (rule.enabled ? ' enabled' : '');
      toggleBtn.title = rule.enabled ? 'Disable rule' : 'Enable rule';
      toggleBtn.dataset.id = rule.id;
      toggleBtn.dataset.scope = rule.scope;
      var nameSpan = document.createElement('span');
      nameSpan.className = 'rule-name' + (rule.enabled ? '' : ' disabled');
      nameSpan.textContent = rule.name;
      nameSpan.title = rule.name + ' (' + rule.charCount + ' chars)';
      var scopeBadge = document.createElement('span');
      scopeBadge.className = 'rule-scope-badge' + (rule.scope === 'workspace' ? ' workspace' : '');
      scopeBadge.textContent = rule.scope === 'workspace' ? 'ws' : 'global';
      var actions = document.createElement('div');
      actions.className = 'rule-actions';
      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'rule-action-btn';
      editBtn.title = 'Edit rule';
      editBtn.textContent = '✏';
      editBtn.dataset.id = rule.id;
      editBtn.dataset.scope = rule.scope;
      var deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'rule-action-btn delete';
      deleteBtn.title = 'Delete rule';
      deleteBtn.textContent = '✕';
      deleteBtn.dataset.id = rule.id;
      deleteBtn.dataset.scope = rule.scope;
      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);
      item.appendChild(toggleBtn);
      item.appendChild(nameSpan);
      item.appendChild(scopeBadge);
      item.appendChild(actions);
      rulesListEl.appendChild(item);
      toggleBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'toggleRule', id: this.dataset.id, scope: this.dataset.scope });
      });
      editBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'editRule', id: this.dataset.id, scope: this.dataset.scope });
      });
      deleteBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteRule', id: this.dataset.id, scope: this.dataset.scope });
      });
    }
  }
  // Auto-expand when first rule is added
  if (aiRules.length > 0 && rulesCollapsed && activeCount > 0) {
    rulesCollapsed = false;
    rulesToggleEl.classList.remove('collapsed');
    rulesBodyEl.classList.remove('collapsed');
  }
}

// ─── Sidebar Sandbox ───
const sbSectionEl = document.getElementById('sidebarSandbox');
const sbToggleEl = document.getElementById('sbToggle');
const sbBodyEl = document.getElementById('sbBody');
const sbDotEl = document.getElementById('sbDot');
const sbStatusEl = document.getElementById('sbStatus');
const sbFrameworkEl = document.getElementById('sbFramework');
const sbUrlEl = document.getElementById('sbUrl');
const sbBadgeEl = document.getElementById('sbBadge');
const sbLaunchEl = document.getElementById('sbLaunch');
const sbStopEl = document.getElementById('sbStop');
const sbScreenshotEl = document.getElementById('sbScreenshot');
const sbTestToolEl = document.getElementById('sbTestTool');
const sbTttHintRowEl = document.getElementById('sbTttHintRow');
const sbTttHintEl = document.getElementById('sbTttHint');
// TAV panel elements
const tavPanelEl = document.getElementById('tavPanel');
const tavHeaderEl = document.getElementById('tavHeader');
const tavBodyEl = document.getElementById('tavBody');
const tavStateBadgeEl = document.getElementById('tavStateBadge');
const tavTestToolEl = document.getElementById('tavTestTool');
const tavSbDotEl = document.getElementById('tavSbDot');
const tavSbStatusEl = document.getElementById('tavSbStatus');
const tavSbUrlEl = document.getElementById('tavSbUrl');
const tavLaunchEl = document.getElementById('tavLaunch');
const tavStopEl = document.getElementById('tavStop');
const tavScreenshotEl = document.getElementById('tavScreenshot');
const tavPrdValEl = document.getElementById('tavPrdVal');
const tavOpenPrdEl = document.getElementById('tavOpenPrd');
const tavHintRowEl = document.getElementById('tavHintRow');
const tavHintEl = document.getElementById('tavHint');
const tavCriteriaWrapEl = document.getElementById('tavCriteriaWrap');
const tavVerifyBtnEl = document.getElementById('tavVerifyBtn');
const tavFixIterEl = document.getElementById('tavFixIter');
let tavCollapsed = false;
let tavSandboxState = null;
let tavCriteriaChecked = [];
let sbCollapsed = false;

sbToggleEl.addEventListener('click', () => {
  sbCollapsed = !sbCollapsed;
  sbToggleEl.classList.toggle('collapsed', sbCollapsed);
  sbBodyEl.classList.toggle('collapsed', sbCollapsed);
});
sbLaunchEl.addEventListener('click', () => vscode.postMessage({ type: 'launchSandbox' }));
sbStopEl.addEventListener('click', () => vscode.postMessage({ type: 'stopSandbox' }));
sbScreenshotEl.addEventListener('click', () => vscode.postMessage({ type: 'takeScreenshot' }));
tttVerifyBtnEl?.addEventListener('click', () => vscode.postMessage({ type: 'tttAllCriteriaVerified' }));

// ─── GitHub Sync Panel ───
const ghSyncHeaderIndicatorEl = document.getElementById('ghSyncHeaderIndicator');
const ghSyncSectionEl = document.getElementById('ghSyncSection');
const ghSyncToggleEl = document.getElementById('ghSyncToggle');
const ghSyncBodyEl = document.getElementById('ghSyncBody');
const ghSyncDotEl = document.getElementById('ghSyncDot');
const ghSyncRepoEl = document.getElementById('ghSyncRepo');
const ghSyncLastEl = document.getElementById('ghSyncLast');
const ghSyncCountEl = document.getElementById('ghSyncCount');
const ghSyncRepoInputEl = document.getElementById('ghSyncRepoInput');
const ghSyncLabelInputEl = document.getElementById('ghSyncLabelInput');
const ghSyncConnectEl = document.getElementById('ghSyncConnect');
const ghSyncSetupEl = document.getElementById('ghSyncSetup');
const ghSyncConnectedEl = document.getElementById('ghSyncConnected');
const ghSyncPollNowEl = document.getElementById('ghSyncPollNow');
const ghSyncDisconnectEl = document.getElementById('ghSyncDisconnect');
const ghSyncEnabledToggleEl = document.getElementById('ghSyncEnabledToggle');
const ghSyncToggleLabelEl = document.getElementById('ghSyncToggleLabel');
let ghSyncCollapsed = false;

ghSyncToggleEl?.addEventListener('click', () => {
  ghSyncCollapsed = !ghSyncCollapsed;
  ghSyncToggleEl.classList.toggle('collapsed', ghSyncCollapsed);
  if (ghSyncBodyEl) { ghSyncBodyEl.classList.toggle('collapsed', ghSyncCollapsed); }
});
ghSyncConnectEl?.addEventListener('click', () => {
  const repo = (ghSyncRepoInputEl && ghSyncRepoInputEl.value.trim()) || '';
  const label = (ghSyncLabelInputEl && ghSyncLabelInputEl.value.trim()) || 'moag';
  if (!repo) { ghSyncRepoInputEl && ghSyncRepoInputEl.focus(); return; }
  vscode.postMessage({ type: 'ghSyncConfigure', repo, label, enabled: true });
});
ghSyncPollNowEl?.addEventListener('click', () => vscode.postMessage({ type: 'ghSyncPollNow' }));
ghSyncDisconnectEl?.addEventListener('click', () => {
  vscode.postMessage({ type: 'ghSyncConfigure', repo: '', label: 'moag', enabled: false });
});
ghSyncEnabledToggleEl?.addEventListener('change', () => {
  const enabled = !!ghSyncEnabledToggleEl.checked;
  vscode.postMessage({ type: 'ghSyncToggleEnabled', enabled });
});

function renderGhSync(state) {
  const repo = (state && state.issueSyncRepo) || '';
  const enabled = !!(state && state.issueSyncEnabled);
  const hasRepo = !!repo;

  // Header indicator — always visible in plan overview regardless of scroll
  if (ghSyncHeaderIndicatorEl) {
    if (hasRepo) {
      const dotCls = enabled ? 'gh-sync-header-dot active' : 'gh-sync-header-dot';
      const shortRepo = repo.split('/').pop() || repo;
      ghSyncHeaderIndicatorEl.innerHTML = '<span class="' + dotCls + '"></span><span class="gh-sync-header-label">' + shortRepo + '</span>';
      ghSyncHeaderIndicatorEl.style.display = '';
      ghSyncHeaderIndicatorEl.title = (enabled ? 'GitHub sync on — click to manage' : 'GitHub sync off — click to manage') + ' (' + repo + ')';
    } else {
      ghSyncHeaderIndicatorEl.innerHTML = '<span class="gh-sync-header-dot"></span><span class="gh-sync-header-label gh-sync-header-connect">Connect GitHub</span>';
      ghSyncHeaderIndicatorEl.style.display = '';
      ghSyncHeaderIndicatorEl.title = 'Connect GitHub Issues sync — click to configure';
    }
    ghSyncHeaderIndicatorEl.onclick = function() {
      vscode.postMessage({ type: 'ghSyncConfigure' });
    };
  }

  if (!ghSyncSectionEl) { return; }

  if (ghSyncSetupEl)     { ghSyncSetupEl.style.display = hasRepo ? 'none' : ''; }
  if (ghSyncConnectedEl) { ghSyncConnectedEl.style.display = hasRepo ? '' : 'none'; }

  if (ghSyncDotEl) {
    ghSyncDotEl.className = 'gh-sync-status-dot' + (hasRepo && enabled ? ' active' : '');
  }
  if (ghSyncRepoEl) { ghSyncRepoEl.textContent = repo; }
  if (ghSyncEnabledToggleEl) { ghSyncEnabledToggleEl.checked = enabled; }
  if (ghSyncToggleLabelEl)   { ghSyncToggleLabelEl.textContent = enabled ? 'On' : 'Off'; }
  if (ghSyncLastEl) {
    const last = state && state.issueSyncLastPoll;
    ghSyncLastEl.textContent = last
      ? 'Last polled: ' + new Date(last).toLocaleTimeString()
      : enabled ? 'Polling every ' + Math.round(((state && state.issueSyncIntervalMs) || 300000) / 60000) + ' min' : 'Sync off — toggle to enable';
  }
  if (ghSyncCountEl) {
    const count = state && state.issueSyncTrackedCount;
    ghSyncCountEl.textContent = count != null && count > 0 ? count + ' issue' + (count !== 1 ? 's' : '') + ' tracked' : '';
  }
  // gh auth status row
  var ghAuthEl = document.getElementById('ghSyncAuthStatus');
  if (ghAuthEl) {
    var authUser = state && state.ghAuthUser;
    if (authUser) {
      ghAuthEl.innerHTML = '<span class="gh-sync-auth-dot ok"></span><span class="gh-sync-auth-label">gh: ' + authUser + '</span>';
      ghAuthEl.title = 'GitHub CLI authenticated as ' + authUser;
    } else {
      ghAuthEl.innerHTML = '<span class="gh-sync-auth-dot"></span><span class="gh-sync-auth-label gh-sync-auth-warn">gh not authenticated — run "gh auth login"</span>';
      ghAuthEl.title = 'GitHub CLI is not authenticated';
    }
  }
}

sbTestToolEl?.addEventListener('change', () => {
  testTool = sbTestToolEl.value;
  vscode.postMessage({ type: 'setTestTool', value: testTool });
  renderSandboxTttHint();
});

// TAV panel
tavHeaderEl?.addEventListener('click', () => {
  tavCollapsed = !tavCollapsed;
  tavHeaderEl.classList.toggle('collapsed', tavCollapsed);
  if (tavBodyEl) { tavBodyEl.classList.toggle('collapsed', tavCollapsed); }
});
tavTestToolEl?.addEventListener('change', () => {
  testTool = tavTestToolEl.value;
  if (sbTestToolEl) { sbTestToolEl.value = testTool; }
  vscode.postMessage({ type: 'setTestTool', value: testTool });
  renderTavPanel();
});
tavLaunchEl?.addEventListener('click', () => vscode.postMessage({ type: 'launchSandbox' }));
tavStopEl?.addEventListener('click', () => vscode.postMessage({ type: 'stopSandbox' }));
tavScreenshotEl?.addEventListener('click', () => vscode.postMessage({ type: 'takeScreenshot' }));
tavOpenPrdEl?.addEventListener('click', () => vscode.postMessage({ type: 'openPrdFromPlan' }));
tavVerifyBtnEl?.addEventListener('click', () => vscode.postMessage({ type: 'verifyAgainstPrd' }));

function renderTavPanel() {
  if (!tavPanelEl) { return; }
  tavPanelEl.classList.toggle('active', activeTab === 'plan');
  if (activeTab !== 'plan') { return; }
  if (tavTestToolEl) { tavTestToolEl.value = testTool; }

  // Sandbox state
  var sbState = tavSandboxState;
  var sbRunning = sbState && sbState.status === 'running';
  var sbStarting = sbState && sbState.status === 'starting';
  var sbActive = sbRunning || sbStarting;
  if (tavSbDotEl) { tavSbDotEl.className = 'tav-sb-dot ' + (sbState ? (sbState.status || 'stopped') : ''); }
  if (tavSbStatusEl) {
    tavSbStatusEl.style.display = sbRunning ? 'none' : '';
    tavSbStatusEl.textContent = sbStarting ? 'Starting...' : sbState && sbState.error ? sbState.error.substring(0, 50) : 'Not started';
  }
  if (tavSbUrlEl) {
    if (sbRunning && sbState.url) {
      tavSbUrlEl.textContent = sbState.url;
      tavSbUrlEl.dataset.url = sbState.url;
      tavSbUrlEl.style.display = '';
    } else {
      tavSbUrlEl.style.display = 'none';
    }
  }
  if (tavLaunchEl) { tavLaunchEl.style.display = sbActive ? 'none' : ''; }
  if (tavStopEl) { tavStopEl.style.display = sbActive ? '' : 'none'; }
  if (tavScreenshotEl) { tavScreenshotEl.style.display = sbRunning ? '' : 'none'; }

  // Test phase detection
  var hasTestPlaylist = Array.isArray(planGroups) && planGroups.some(function(g) { return g.testPhase; });
  var testPlaylistRunning = Array.isArray(planGroups) && planGroups.some(function(g) {
    return g.testPhase && (g.playlistStatus === 'running' || g.playlistStatus === 'paused');
  });

  // State badge
  var badgeText = testPlaylistRunning ? 'Running' : hasTestPlaylist ? 'Ready' : 'Setup';
  var badgeClass = testPlaylistRunning ? 'running' : hasTestPlaylist ? 'done' : 'warn';
  if (tavStateBadgeEl) { tavStateBadgeEl.textContent = badgeText; tavStateBadgeEl.className = 'tav-state-badge ' + badgeClass; }

  // PRD row
  var hasPrd = !!(planPrdSource);
  var prdLabel = detectedPrdFilePath ? detectedPrdFilePath.split(/[\\/]/).pop() : (hasPrd ? 'Stored in plan' : 'None linked');
  if (tavPrdValEl) { tavPrdValEl.textContent = prdLabel; tavPrdValEl.style.color = hasPrd ? '' : 'var(--vscode-descriptionForeground)'; }
  if (tavOpenPrdEl) { tavOpenPrdEl.style.display = hasPrd ? '' : 'none'; }

  // Hint row
  var hint = '';
  var hintClass = '';
  if (!hasTestPlaylist) {
    hint = '⚠ No test playlist — right-click a playlist → Toggle Test Phase';
    hintClass = 'warn';
  } else if (testTool === 'sandbox' && !sbActive && !testPlaylistRunning) {
    hint = 'Sandbox will auto-launch when test playlist starts';
    hintClass = 'ok';
  } else if (testTool === 'manual' && hasTestPlaylist) {
    hint = 'Switch to "Sandbox (auto-launch)" to automate this step';
    hintClass = '';
  }
  if (tavHintRowEl) { tavHintRowEl.style.display = hint ? '' : 'none'; }
  if (tavHintEl) { tavHintEl.textContent = hint; tavHintEl.className = 'tav-hint ' + hintClass; }

  // Criteria — show when test playlist is running AND PRD exists
  if (tavCriteriaWrapEl) {
    var showCriteria = testPlaylistRunning && hasPrd;
    tavCriteriaWrapEl.style.display = showCriteria ? '' : 'none';
    if (showCriteria) {
      var criteria = parsePrdCriteria(planPrdSource);
      if (tavCriteriaChecked.length !== criteria.length) { tavCriteriaChecked = new Array(criteria.length).fill(false); }
      tavCriteriaWrapEl.innerHTML = '';
      criteria.forEach(function(text, i) {
        var row = document.createElement('label');
        row.className = 'tav-criterion' + (tavCriteriaChecked[i] ? ' checked' : '');
        var cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = !!tavCriteriaChecked[i];
        cb.addEventListener('change', function() { tavCriteriaChecked[i] = cb.checked; row.classList.toggle('checked', cb.checked); });
        var span = document.createElement('span');
        span.className = 'tav-criterion-text'; span.textContent = text;
        row.appendChild(cb); row.appendChild(span);
        tavCriteriaWrapEl.appendChild(row);
      });
    }
  }

  // Verify button
  if (tavVerifyBtnEl) { tavVerifyBtnEl.disabled = !hasPrd; }

  // Fix iteration counter
  if (tavFixIterEl) {
    if (planFixIterations > 0) {
      tavFixIterEl.textContent = '🔄 Fix loop: iteration ' + planFixIterations + '/3';
      tavFixIterEl.className = 'tav-fix-iter active';
      tavFixIterEl.style.display = '';
    } else {
      tavFixIterEl.style.display = 'none';
    }
  }

  // Hide old sandbox extras-seg when TAV is visible
  var sbSegEl = document.getElementById('sidebarSandbox');
  if (sbSegEl) { sbSegEl.style.display = activeTab === 'plan' ? 'none' : ''; }
}
sbUrlEl.addEventListener('click', () => {
  const url = sbUrlEl.dataset.url;
  if (url) { vscode.postMessage({ type: 'openSandboxBrowser', url: url }); }
});

var sbThumbEl = document.getElementById('sbThumb');

function renderSidebarSandbox(state) {
  if (!state) { return; }
  sbDotEl.className = 'sidebar-sandbox-dot ' + (state.status || 'stopped');
  var labels = { stopped: 'Stopped', starting: 'Starting...', running: 'Running', error: 'Error' };
  sbStatusEl.textContent = state.error || labels[state.status] || state.status;
  sbFrameworkEl.textContent = state.projectInfo ? state.projectInfo.framework : '';
  if (state.url) {
    sbUrlEl.textContent = state.url;
    sbUrlEl.dataset.url = state.url;
    sbUrlEl.style.display = 'inline';
  } else {
    sbUrlEl.style.display = 'none';
  }
  var active = state.status === 'running' || state.status === 'starting';
  sbLaunchEl.style.display = active ? 'none' : 'inline-block';
  sbStopEl.style.display = active ? 'inline-block' : 'none';
  sbBadgeEl.textContent = active ? (state.status === 'running' ? 'Running' : 'Starting') : '';
  sbBadgeEl.className = 'sidebar-sandbox-badge ' + (active ? state.status : '');
  if (sbScreenshotEl) {
    sbScreenshotEl.disabled = state.status !== 'running';
    sbScreenshotEl.title = state.status !== 'running' ? 'Start the sandbox first' : 'Capture screenshot and attach to next agent task';
  }
  if (sbThumbEl) {
    if (state.lastScreenshotPath) {
      sbThumbEl.src = state.lastScreenshotPath;
      sbThumbEl.style.display = 'block';
    } else {
      sbThumbEl.style.display = 'none';
    }
  }
}

function renderSandboxTttHint() {
  if (!sbTestToolEl || !sbTttHintRowEl || !sbTttHintEl) { return; }
  sbTestToolEl.value = testTool;
  const hasTestPlaylist = Array.isArray(planGroups) && planGroups.some(function(g) { return g.testPhase; });
  if (testTool === 'sandbox') {
    if (hasTestPlaylist) {
      sbTttHintEl.textContent = '✓ Auto-launches when test playlist runs';
      sbTttHintEl.className = 'sb-ttt-hint ok';
    } else {
      sbTttHintEl.textContent = '⚠ No test playlist — right-click a playlist → Toggle Test Phase';
      sbTttHintEl.className = 'sb-ttt-hint warn';
    }
    sbTttHintRowEl.style.display = '';
  } else if (testTool === 'manual') {
    sbTttHintRowEl.style.display = hasTestPlaylist ? '' : 'none';
    sbTttHintEl.textContent = hasTestPlaylist ? 'Manual — switch to Sandbox for auto-launch' : '';
    sbTttHintEl.className = 'sb-ttt-hint warn';
  } else {
    sbTttHintEl.textContent = hasTestPlaylist ? ('✓ ' + testTool + ' runs via test tasks') : '';
    sbTttHintEl.className = 'sb-ttt-hint ok';
    sbTttHintRowEl.style.display = hasTestPlaylist ? '' : 'none';
  }
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'showPrdInputScreen') {
    if (prdInputScreenEl) { prdInputScreenEl.classList.add('active'); }
    setTimeout(() => { prdTextareaEl?.focus(); }, 50);
    return;
  }
  if (msg.type === 'prdMoagQuestion') {
    // Remove typing indicator if present
    var typingEl = chatFeedEl ? chatFeedEl.querySelector('.prd-typing') : null;
    if (typingEl) { typingEl.remove(); }
    appendPrdMessage('bot', msg.question);
    promptEl.placeholder = 'Your answer...';
    promptEl.focus();
    return;
  }
  if (msg.type === 'prdConvertReady') {
    var typingEl2 = chatFeedEl ? chatFeedEl.querySelector('.prd-typing') : null;
    if (typingEl2) { typingEl2.remove(); }
    appendPrdMessage('bot', 'I have enough context to write your PRD. Opening the editor now...');
    exitPrdMode();
    return;
  }
  if (msg.type === 'prdError') {
    var typingEl3 = chatFeedEl ? chatFeedEl.querySelector('.prd-typing') : null;
    if (typingEl3) { typingEl3.remove(); }
    var errWrap = document.createElement('div');
    errWrap.className = 'prd-msg prd-bot';
    var errAuthor = document.createElement('div');
    errAuthor.className = 'prd-msg-author';
    errAuthor.textContent = 'MOAG';
    var errText = document.createElement('div');
    errText.className = 'prd-msg-text';
    errText.style.color = '#f48771';
    errText.textContent = msg.error || 'Something went wrong. Please try again.';
    errWrap.appendChild(errAuthor);
    errWrap.appendChild(errText);
    if (msg.action) {
      var actionBtn = document.createElement('button');
      actionBtn.className = 'chat-empty-start-prd-btn';
      actionBtn.style.marginTop = '8px';
      actionBtn.textContent = msg.action.label;
      actionBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'runCommand', command: msg.action.command });
      });
      errWrap.appendChild(actionBtn);
    }
    if (chatFeedEl) { chatFeedEl.appendChild(errWrap); chatFeedEl.scrollTop = chatFeedEl.scrollHeight; }
    prdStep = Math.max(1, prdStep - 1);
    promptEl.focus();
    return;
  }
  if (msg.type === 'prdFileContent') {
    if (prdTextareaEl && typeof msg.text === 'string') {
      prdTextareaEl.value = msg.text;
      var len = msg.text.length;
      if (prdCharCountEl) { prdCharCountEl.textContent = len + ' chars'; }
      if (prdGenerateBtnEl) { prdGenerateBtnEl.disabled = len < 20; }
      prdTextareaEl.focus();
    }
    return;
  }
  if (msg.type === 'prdAiImproveResult') {
    if (prdTextareaEl && typeof msg.text === 'string' && msg.text) {
      prdTextareaEl.value = msg.text;
      var len2 = msg.text.length;
      if (prdCharCountEl) { prdCharCountEl.textContent = len2 + ' chars'; }
      if (prdGenerateBtnEl) { prdGenerateBtnEl.disabled = len2 < 20; }
    }
    if (prdAiBtnEl) { prdAiBtnEl.disabled = false; updatePrdAiBtn(); }
    return;
  }
  if (msg.type === 'prdVersionSaved') {
    updatePrdVersionBar(msg.versions || []);
    if (prdVersionSelectEl && msg.version) { prdVersionSelectEl.value = msg.version; }
    return;
  }
  if (msg.type === 'setBusy') {
    busy = !!msg.busy;
    promptEl.disabled = busy;
    engineEl.disabled = busy || engineEl.options.length === 0 || engineEl.value === '';
    updateActionState();
  } else if (msg.type === 'clear') {
    promptEl.value = '';
    removeImage();
    autoResize();
      updateActionState();
    if (!busy) {
      promptEl.focus();
    }
  } else if (msg.type === 'syncState') {
    renderEngines(msg.engines || [], msg.selectedEngineId);
    chatItems = msg.chatItems || [];
    planItems = msg.planItems || [];
    planGroups = msg.planGroups || [];
    planAiRules = msg.planAiRules || '';
    planPrdSource = msg.planPrdSource || '';
    detectedPrdFilePath = msg.detectedPrdFilePath || '';
    updatePrdVersionBar(msg.planPrdVersions || []);
    testTool = msg.testTool || 'manual';
    planFixIterations = msg.planFixIterations ?? 0;
    prdProjectMeta = msg.prdProjectMeta ?? { name: '', stack: '' };
    renderPrdProjectCard();
    renderPlanRulesSection();
    renderTttCriteria();
    renderSandboxTttHint();
    const currentKeys = new Set((planGroups || []).map((g, i) => g.id || ('playlist-' + i)));
    Object.keys(selectedPlaylists).forEach((key) => {
      if (!currentKeys.has(key)) {
        delete selectedPlaylists[key];
      }
    });
    const validTaskKeys = new Set();
    (planGroups || []).forEach((group, idx) => {
      const gk = group.id || ('playlist-' + idx);
      const tasks = Array.isArray(group.tasks) ? group.tasks : [];
      for (let ti = 0; ti < tasks.length; ti++) {
        validTaskKeys.add(gk + ':' + ti);
      }
    });
    Object.keys(selectedTasks).forEach((key) => {
      if (!validTaskKeys.has(key)) {
        delete selectedTasks[key];
      }
    });
    historyItems = msg.historyItems || [];
    activeThreadId = msg.activeThreadId || '';
    chatMessages = msg.chatMessages || [];
    const incomingPlanName = msg.activePlanName || '';
    if (incomingPlanName !== activePlanName) {
      planListScrollInitialized = false;
      planListScrollTop = 0;
      tttCriteriaChecked = [];
    }
    activePlanName = incomingPlanName;
    activePlaylistName = msg.activePlaylistName || '';
    // Chat tab is conversation-first; no session strip row.
    renderPlanGroups(planListEl, planGroups);
    renderPlanOverview(planGroups);
    renderPlanQueue(planGroups);
    renderPlanTools();
    renderHistoryList();
    if (!prdMode) { renderChat(msg.chatTitle || 'New Chat', chatMessages); }
    renderRunnerChip(msg.runnerState || 'idle');
    renderContextBar();
    setActiveTab(activeTab);
    engineEl.disabled = busy || engineEl.options.length === 0 || engineEl.value === '';
    updateActionState();
    if (msg.sandboxState) {
      renderSidebarSandbox(msg.sandboxState);
      tavSandboxState = msg.sandboxState;
    }
    renderTavPanel();
    renderGhSync(msg);
    if (msg.aiRules !== undefined) { renderSidebarRules(msg.aiRules); }
    if (msg.activeFile !== undefined) { activeFile = msg.activeFile || null; updateFilePill(); }
  } else if (msg.type === 'rules-state') {
    renderSidebarRules(msg.rules);
  } else if (msg.type === 'active-file') {
    const prev = activeFile ? activeFile.path : null;
    activeFile = msg.file || null;
    // Auto-show pill when a new file becomes active; reset dismissed state
    if (activeFile && activeFile.path !== prev) { activeFileDismissed = false; }
    updateFilePill();
  } else if (msg.type === 'sandbox-state') {
    renderSidebarSandbox(msg.sandboxState);
    tavSandboxState = msg.sandboxState;
    renderTavPanel();
  } else if (msg.type === 'sessionCost') {
    const cost = typeof msg.cost === 'number' ? msg.cost : 0;
    const tokensIn = typeof msg.tokensIn === 'number' ? msg.tokensIn : 0;
    const tokensOut = typeof msg.tokensOut === 'number' ? msg.tokensOut : 0;
    const totalTok = tokensIn + tokensOut;
    if ((cost > 0 || totalTok > 0) && ctxCostEl) {
      const tokStr = totalTok > 0
        ? (totalTok >= 1000 ? (totalTok / 1000).toFixed(1) + 'K' : String(totalTok)) + ' tok'
        : '';
      const costStr = cost > 0 ? '$' + cost.toFixed(cost < 0.01 ? 4 : 2) : '';
      ctxCostEl.textContent = [tokStr, costStr].filter(Boolean).join(' · ');
      ctxCostEl.title = tokensIn > 0
        ? 'Input: ' + tokensIn.toLocaleString() + ' · Output: ' + tokensOut.toLocaleString() + ' · Total: ' + totalTok.toLocaleString() + ' tokens'
        : '';
      ctxCostEl.style.display = '';
    } else if (cost === 0 && ctxCostEl) {
      ctxCostEl.style.display = 'none';
    }
  } else if (msg.type === 'live-output-start') {
    // Update plan-tab live panel
    liveTaskId = msg.taskId || '';
    liveTaskName = msg.taskName || '';
    liveOutputLines = [];
    renderLivePanel();
    // Auto-switch to chat tab so the user sees the live stream
    setActiveTab('chat');
    var block = document.getElementById('live-block-' + msg.taskId);
    if (!block) {
      block = document.createElement('div');
      block.id = 'live-block-' + msg.taskId;
      block.className = 'live-output-block';
      chatFeedEl.appendChild(block);
      chatEmptyEl.style.display = 'none';
    }
    block.innerHTML =
      '<div class="live-output-header">' +
        '<svg class="msg-avatar" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1L3 9h5l-1 6 6-8H8L9 1z"/></svg>' +
        '<span class="live-output-task-name">' + escHtml(msg.taskName || 'Running...') + '</span>' +
        '<span class="live-output-badge running" id="live-badge-' + msg.taskId + '">running</span>' +
      '</div>' +
      '<pre class="live-output-body" id="live-body-' + msg.taskId + '"></pre>';
    chatFeedEl.scrollTop = chatFeedEl.scrollHeight;

  } else if (msg.type === 'live-output-chunk') {
    var bodyEl = document.getElementById('live-body-' + msg.taskId);
    if (bodyEl) {
      // Keep last 4000 chars to avoid unbounded DOM growth
      var combined = (bodyEl.textContent || '') + (msg.text || '');
      bodyEl.textContent = combined.length > 4000 ? combined.slice(-4000) : combined;
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }
    // Update plan-tab live panel — split incoming text into lines, keep last 4
    if (msg.taskId === liveTaskId && msg.text) {
      var newLines = msg.text.split('\\n');
      liveOutputLines = liveOutputLines.concat(newLines).filter((l) => l.trim()).slice(-4);
      renderLivePanel();
    }

  } else if (msg.type === 'fillComposer') {
    if (promptEl) {
      promptEl.value = msg.text || '';
      autoResize();
      updateActionState();
      pendingFixRef = msg.fixRef || null;
      updateComposerHint();
      if (msg.text) {
        if (runnerState === 'idle') {
          setActiveTab('chat');
          promptEl.focus();
          promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
        }
      }
    }

  } else if (msg.type === 'live-output-end') {
    var badge = document.getElementById('live-badge-' + msg.taskId);
    if (badge) {
      var passed = msg.status === 'completed';
      badge.textContent = passed ? 'done' : 'failed';
      badge.className = 'live-output-badge ' + (passed ? 'completed' : 'failed');
    }
    // Remove block after brief pause — syncState will re-render the real result card
    var endBlock = document.getElementById('live-block-' + msg.taskId);
    if (endBlock) {
      setTimeout(function() {
        if (endBlock.parentNode) { endBlock.parentNode.removeChild(endBlock); }
      }, 1800);
    }
    // Clear the plan-tab live panel after a short delay
    if (msg.taskId === liveTaskId) {
      setTimeout(function() {
        liveTaskId = '';
        liveTaskName = '';
        liveOutputLines = [];
        renderLivePanel();
      }, 2000);
    }
  }
});

autoResize();
updateActionState();
setActiveTab('chat');
renderContextBar();
vscode.postMessage({ type: 'ready' });
promptEl.focus();
