const logEl = document.getElementById('log');
function log(...a){ logEl.textContent += a.join(' ') + '\n'; logEl.scrollTop = 1e9; }

async function activeTab(){ const [t]=await chrome.tabs.query({active:true,currentWindow:true}); return t; }
async function sendToTab(tabId, type, data={}){
  if(!tabId) throw new Error('No target tab');
  return await chrome.tabs.sendMessage(tabId, {type, ...data});
}
async function sendActive(type, data={}){
  const tab = inspectedTabId ? { id: inspectedTabId } : await activeTab();
  return await sendToTab(tab?.id, type, data);
}

const ui = {
  targetTitle: document.getElementById('targetTitle'),
  targetUrl: document.getElementById('targetUrl'),
  targetState: document.getElementById('targetState'),
  connectionDot: document.getElementById('connectionDot'),
  connectionText: document.getElementById('connectionText'),
  currentAction: document.getElementById('currentAction'),
  currentDetail: document.getElementById('currentDetail'),
  stateBadge: document.getElementById('stateBadge'),
  progressBar: document.getElementById('progressBar'),
  scanAge: document.getElementById('scanAge'),
  controlCount: document.getElementById('controlCount'),
  actionableCount: document.getElementById('actionableCount'),
  formCount: document.getElementById('formCount'),
  domainName: document.getElementById('domainName'),
  controlHelp: document.getElementById('controlHelp'),
  controlFilter: document.getElementById('controlFilter'),
  controlList: document.getElementById('controlList'),
  timeline: document.getElementById('timeline'),
  clearTimeline: document.getElementById('clearTimeline'),
  log: logEl
};

let inspectedTabId = null;
let lastSnapshot = null;

function setConnection(kind, text){
  ui.connectionDot.className = `dot ${kind || ''}`;
  ui.connectionText.textContent = text;
}

function setState(title, detail, status='ready', progress=null){
  ui.currentAction.textContent = title;
  ui.currentDetail.textContent = detail;
  ui.stateBadge.textContent = status.toUpperCase();
  ui.stateBadge.className = `state-badge ${status}`;
  if(progress !== null) ui.progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
}

function addTimeline(title, detail, status=''){
  const empty = ui.timeline.querySelector('.empty');
  if(empty) empty.remove();
  const item = document.createElement('div');
  item.className = `event ${status}`;
  const time = document.createElement('div');
  time.className = 'event-time';
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const body = document.createElement('div');
  body.className = 'event-text';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const detailEl = document.createElement('span');
  detailEl.textContent = detail;
  body.append(strong, detailEl);
  item.append(time, body);
  ui.timeline.prepend(item);
}

function updatePageOverview(snapshot){
  lastSnapshot = snapshot;
  const page = snapshot.page || {};
  const inventory = snapshot.inventory || {};
  const site = page.site || {};
  ui.targetTitle.textContent = snapshot.title || '(untitled page)';
  ui.targetUrl.textContent = snapshot.url || '';
  ui.targetState.textContent = page.needsHuman ? 'Sensitive flow detected — human review required' : 'Page inspected and ready';
  ui.targetState.style.color = page.needsHuman ? 'var(--amber)' : 'var(--green)';
  ui.controlCount.textContent = inventory.returnedCount ?? snapshot.count ?? 0;
  ui.actionableCount.textContent = inventory.actionableCount ?? page.counts?.actionableControls ?? 0;
  ui.formCount.textContent = page.forms?.length ?? 0;
  ui.domainName.textContent = site.hostname || page.domain || '—';
  ui.scanAge.textContent = 'just now';
  ui.controlHelp.textContent = inventory.truncated ? `${inventory.omitted?.overLimit || 0} more not shown` : 'Choose a control to see it on the page';
  setConnection('good', 'Page connected');
  renderControls(snapshot);
}

async function inspectPage(tabId = null){
  const tab = tabId ? { id: tabId } : await activeTab();
  if(!tab?.id) throw new Error('No active tab');
  inspectedTabId = tab.id;
  setState('Inspecting this page', 'Finding buttons, fields, links, forms, and page content…', 'acting', 15);
  try {
    const result = await sendToTab(tab.id, 'AUTOREP_SCAN');
    updatePageOverview(result.snapshot);
    setState('Ready', 'Pick a task or choose a control below to try it without code.', 'verified', 100);
    addTimeline('Page inspected', `${result.snapshot.page?.site?.hostname || 'This page'} • ${result.snapshot.count} controls found`, 'verified');
    log(`INSPECTED ${result.snapshot.url} controls=${result.snapshot.count}`);
    return result.snapshot;
  } catch(error){
    setConnection('bad', 'Page not connected');
    setState('Could not inspect page', 'Reload the website and make sure the extension can access it.', 'failed', 0);
    addTimeline('Inspection failed', error.message, 'failed');
    throw error;
  }
}

async function focusControl(id){
  if(!lastSnapshot || !inspectedTabId) return;
  const control = lastSnapshot.elements.find(item => item.id === id);
  if(!control) return;
  setState(`Showing “${control.name}”`, 'The target is highlighted in the website tab.', 'acting');
  try {
    const result = await sendToTab(inspectedTabId, 'AUTOREP_FOCUS', { id, snapshotId: lastSnapshot.snapshotId });
    if(!result.ok) throw new Error(result.error || 'The target could not be highlighted.');
    addTimeline('Target highlighted', `${control.role}: ${control.name}`, 'acting');
    setState('Target highlighted', 'Look at the website tab to see the exact interaction point.', 'verified');
  } catch(error){
    addTimeline('Could not highlight target', error.message, 'failed');
    setState('Highlight failed', error.message, 'failed');
  }
}

function renderControls(snapshot){
  const filter = (ui.controlFilter.value || '').trim().toLowerCase();
  ui.controlList.textContent = '';
  const controls = (snapshot.elements || []).filter(control => {
    if(!filter) return true;
    return `${control.name} ${control.role} ${control.tag} ${control.type}`.toLowerCase().includes(filter);
  });
  if(!controls.length){
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = filter ? 'No matching controls.' : 'No controls were found on this page.';
    ui.controlList.append(empty);
    return;
  }
  controls.forEach(control => ui.controlList.append(createControlCard(control, snapshot)));
}

function createControlCard(control, snapshot){
  const card = document.createElement('div');
  card.className = 'control';
  const top = document.createElement('div');
  top.className = 'control-top';
  const id = document.createElement('span');
  id.className = 'control-id';
  id.textContent = `#${control.id}`;
  const main = document.createElement('div');
  main.className = 'control-main';
  const name = document.createElement('div');
  name.className = 'control-name';
  name.textContent = control.name;
  const meta = document.createElement('div');
  meta.className = 'control-meta';
  meta.textContent = `${control.role} • ${control.tag}${control.type ? ` • ${control.type}` : ''}${control.state?.disabled ? ' • disabled' : ''}`;
  const cap = document.createElement('div');
  cap.className = 'control-cap';
  cap.textContent = control.actionable ? `Can: ${control.capabilities.join(', ')}` : `Inspect only: ${(control.actionabilityReasons || []).join(', ') || 'not available'}`;
  main.append(name, meta, cap);
  top.append(id, main);
  card.append(top);
  const actions = document.createElement('div');
  actions.className = 'control-actions';
  const focus = document.createElement('button');
  focus.className = 'ghost';
  focus.textContent = '📍 Show on page';
  focus.onclick = () => focusControl(control.id);
  actions.append(focus);
  if(control.actionable && control.capabilities.includes('click')){
    const tryClick = document.createElement('button');
    tryClick.textContent = '▶ Try click';
    tryClick.onclick = () => manualAction('click', control, snapshot);
    actions.append(tryClick);
  }
  if(control.actionable && control.capabilities.includes('type')){
    const input = document.createElement('input');
    input.placeholder = 'Text to enter…';
    input.style.marginTop = '7px';
    input.dataset.typeValue = '1';
    const typeButton = document.createElement('button');
    typeButton.className = 'secondary';
    typeButton.textContent = 'Type here';
    typeButton.onclick = () => manualAction('type', control, snapshot, input.value);
    const typeWrap = document.createElement('div');
    typeWrap.style.cssText = 'display:flex;gap:5px;flex:1;margin-top:7px';
    input.style.marginTop = '0';
    typeWrap.append(input, typeButton);
    card.append(typeWrap);
  }
  if(control.actionable && control.capabilities.includes('selectOption')){
    const select = document.createElement('select');
    select.style.marginTop = '7px';
    (control.options || []).filter(option => !option.disabled).forEach(option => {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label || option.value;
      select.append(item);
    });
    const selectButton = document.createElement('button');
    selectButton.className = 'secondary';
    selectButton.textContent = 'Choose';
    selectButton.onclick = () => manualAction('select', control, snapshot, select.value);
    const selectWrap = document.createElement('div');
    selectWrap.style.cssText = 'display:flex;gap:5px;flex:1;margin-top:7px';
    select.style.marginTop = '0';
    selectWrap.append(select, selectButton);
    card.append(selectWrap);
  }
  if(actions.children.length) card.append(actions);
  return card;
}

async function manualAction(action, control, snapshot, value=''){
  if(!inspectedTabId) return;
  const target = action === 'click' ? `Clicking “${control.name}”` : action === 'type' ? `Typing into “${control.name}”` : `Choosing “${value}” in “${control.name}”`;
  setState(target, 'Sending the action to the website…', 'acting');
  addTimeline(target, 'Waiting for the page to respond…', 'acting');
  try {
    const focusResult = await sendToTab(inspectedTabId, 'AUTOREP_FOCUS', { id: control.id, snapshotId: snapshot.snapshotId, kind: 'acting', message: target });
    if(!focusResult.ok) throw new Error(focusResult.error || 'The target could not be highlighted.');
    let result;
    if(action === 'click') result = await sendToTab(inspectedTabId, 'AUTOREP_CLICK', { id: control.id, snapshotId: snapshot.snapshotId, runId: `manual_${Date.now()}` });
    if(action === 'type') {
      if(!String(value).trim()) throw new Error('Enter text first.');
      result = await sendToTab(inspectedTabId, 'AUTOREP_TYPE', { id: control.id, text: value, pressEnter: false, snapshotId: snapshot.snapshotId, runId: `manual_${Date.now()}` });
    }
    if(action === 'select') result = await sendToTab(inspectedTabId, 'AUTOREP_SELECT', { id: control.id, option: value, snapshotId: snapshot.snapshotId, runId: `manual_${Date.now()}` });
    showResult(result, target);
  } catch(error){
    addTimeline('Action failed', error.message, 'failed');
    setState('Action failed', error.message, 'failed');
    log(`ACTION FAILED ${action}: ${error.message}`);
  }
}

function showResult(result, target){
  const status = result?.status || (result?.ok ? 'sent' : 'failed');
  const verified = status === 'verified';
  const warning = status === 'sent' || status === 'unverified';
  const state = verified ? 'verified' : warning ? 'warning' : 'failed';
  const detail = verified ? (result.message || 'The page visibly changed.') : warning ? (result.message || 'The action was sent, but no visible page response was confirmed.') : (result?.error || 'The website rejected the action.');
  setState(verified ? 'Page responded' : warning ? 'Action sent — check the page' : 'Action failed', detail, state);
  addTimeline(verified ? 'Verified on website' : warning ? 'Sent, not verified' : 'Action failed', `${target}. ${detail}`, state);
  log(`${status.toUpperCase()} ${target}: ${detail}`);
}

const runButton = document.getElementById('run');
const stopButton = document.getElementById('stop');
const runState = {
  running: false,
  runId: null,
  tabId: null,
  controller: null
};

chrome.tabs?.onActivated?.addListener(info => {
  if(runState.running && info.tabId !== runState.tabId){
    ui.targetState.textContent = `Run is still operating on tab ${runState.tabId}`;
    ui.targetState.style.color = 'var(--amber)';
    setConnection('good', 'Run target is another tab');
  }
});

function setRunUi(running){
  runButton.disabled = running;
  stopButton.disabled = !running;
}

function isAbortError(error){
  return error?.name === 'AbortError' || runState.controller?.signal?.aborted || /aborted|cancelled|canceled/i.test(error?.message || '');
}

function wait(ms, signal){
  return new Promise((resolve, reject) => {
    if(signal?.aborted) return reject(new DOMException('The run was cancelled', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('The run was cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function validatePlan(plan, snapshot){
  const allowed = new Set(['click','type','select','scroll','extract','done']);
  if(!plan || !allowed.has(plan.action)) throw new Error('AI returned unsupported action');
  if(plan.action === 'click' || plan.action === 'type' || plan.action === 'select'){
    if(!Number.isInteger(plan.id)) throw new Error('AI returned an invalid control id');
    const control = (snapshot.elements || []).find(e => e.id === plan.id);
    if(!control) throw new Error(`AI selected missing control id ${plan.id}`);
    const capability = plan.action === 'click' ? 'click' : plan.action === 'type' ? 'type' : 'selectOption';
    if(!control.actionable || !control.capabilities?.includes(capability)){
      throw new Error(`AI selected non-actionable control ${plan.id}`);
    }
    if(plan.action === 'type' && !String(plan.text || '').trim()){
      throw new Error('AI returned an empty typing action');
    }
    if(plan.action === 'select' && !String(plan.option ?? '').trim()){
      throw new Error('AI returned an empty select option');
    }
    if(plan.action === 'select'){
      const requested = String(plan.option).trim().toLowerCase();
      const options = control.options || [];
      const match = options.find(option => !option.disabled && (String(option.value).trim().toLowerCase() === requested || String(option.label).trim().toLowerCase() === requested));
      if(!match) throw new Error(`AI selected an unavailable option for control ${plan.id}`);
    }
  }
  if(plan.action === 'scroll' && !['up','down','top','bottom'].includes(plan.direction || 'down')){
    throw new Error('AI returned an invalid scroll direction');
  }
  return plan;
}

// load settings
(async ()=>{
  const c = await chrome.storage.local.get(['provider','apiKey','model','baseURL']);
  if(c.provider) document.getElementById('provider').value=c.provider;
  if(c.apiKey) document.getElementById('apiKey').value=c.apiKey;
  if(c.model) document.getElementById('model').value=c.model;
  if(c.baseURL) document.getElementById('baseURL').value=c.baseURL;
  if(!c.model) document.getElementById('model').value='gpt-4o-mini';
})();

document.getElementById('provider').onchange = e=>{
  document.getElementById('baseURL').value = AutoRepAI.defaultBaseURL(e.target.value);
};
document.getElementById('save').onclick = async ()=>{
  await chrome.storage.local.set({
    provider: document.getElementById('provider').value,
    apiKey: document.getElementById('apiKey').value.trim(),
    model: document.getElementById('model').value.trim(),
    baseURL: document.getElementById('baseURL').value.trim()
  });
  log('✅ saved AI config');
};

document.getElementById('scan').onclick = async ()=>{
  try{
    await inspectPage();
  }catch(e){log('❌ scan failed, reload page:',e.message)}
};
let badgesOn=false;
document.getElementById('badges').onclick = async ()=>{
  badgesOn=!badgesOn;
  try{
    if(!inspectedTabId) await inspectPage();
    const r=await sendToTab(inspectedTabId,'AUTOREP_TOGGLE_BADGES',{show:badgesOn});
    log(r.visible?'TARGET MAP ON':'TARGET MAP OFF');
    addTimeline(r.visible ? 'Target map shown' : 'Target map hidden', r.visible ? 'The website tab now shows control numbers.' : 'Control markers were removed.', 'acting');
  }catch(e){log('❌ target map:',e.message)}
};
document.getElementById('extract').onclick = async ()=>{
  try{
    if(!inspectedTabId) await inspectPage();
    const r=await sendToTab(inspectedTabId,'AUTOREP_EXTRACT');
    setState('Page text read', 'The extracted text is available in Diagnostics below.', 'verified');
    addTimeline('Page text read', `${r.text.length} characters captured.`, 'verified');
    log(`PAGE TEXT\n${r.text.slice(0,1600)}`);
  }catch(e){log('❌ read page:',e.message)}
};
ui.controlFilter.addEventListener('input', () => { if(lastSnapshot) renderControls(lastSnapshot); });
ui.clearTimeline.onclick = () => { ui.timeline.innerHTML = '<div class="empty">Your actions and page responses will appear here.</div>'; };

runButton.onclick = async ()=>{
  const task=document.getElementById('task').value.trim();
  if(!task) return log('write task first');
  if(runState.running) return log('⚠ a run is already active; press Stop first');
  const target = await activeTab();
  if(!target?.id) return log('❌ no active tab');
  inspectedTabId = target.id;
  const runId = crypto.randomUUID?.() || `run_${Date.now().toString(36)}`;
  const controller = new AbortController();
  runState.running = true;
  runState.runId = runId;
  runState.tabId = target.id;
  runState.controller = controller;
  setRunUi(true);
  setState('Starting task', `Working on ${target.title || 'the selected website'}…`, 'acting', 0);
  addTimeline('Task started', task, 'acting');
  log(`RUN STARTED tab=${target.id} run=${runId.slice(0,8)} task=${task}`);
  try{
    for(let step=0; step<12; step++){
      if(controller.signal.aborted) throw new DOMException('The run was cancelled', 'AbortError');
      const s=await sendToTab(target.id,'AUTOREP_SCAN',{runId});
      updatePageOverview(s.snapshot);
      const pg = s.snapshot.page||{};
      setState(`Step ${step + 1} of 12`, `Understanding ${pg.site?.hostname || pg.domain || 'the page'}…`, 'acting', ((step + 1) / 12) * 100);
      log(`STEP ${step+1} ${s.snapshot.url} controls=${s.snapshot.count}`);
      if(pg.needsHuman){
        setState('Human review required', 'This page looks like a sensitive flow. AutoRep will not act automatically.', 'warning');
        addTimeline('Task paused for review', 'Authentication, payment, OTP, or CAPTCHA signals were detected.', 'warning');
        log('PAUSED: sensitive flow detected');
        break;
      }
      const plan=await AutoRepAI.plan(task, s.snapshot,{ signal: controller.signal });
      validatePlan(plan, s.snapshot);
      log(`PLAN ${plan.action} ${plan.reason || ''}`);
      if(plan.action==='done'){
        setState('AI says it is done', plan.reason || 'No independent page change was provided.', 'warning');
        addTimeline('AI reported completion', plan.reason || 'This is not independently verified yet.', 'warning');
        break;
      }
      if(plan.action==='click'){
        const r=await sendToTab(target.id,'AUTOREP_CLICK',{id:plan.id, snapshotId:s.snapshot.snapshotId, runId});
        const control = s.snapshot.elements.find(item => item.id === plan.id);
        showResult(r, `Clicking “${control?.name || plan.id}”`);
        if(!r.ok) break;
      }
      else if(plan.action==='type'){
        const beforeUrl = s.snapshot.url;
        const r=await sendToTab(target.id,'AUTOREP_TYPE',{id:plan.id, text:plan.text||'', pressEnter:plan.pressEnter !== false, snapshotId:s.snapshot.snapshotId, runId});
        const control = s.snapshot.elements.find(item => item.id === plan.id);
        showResult(r, `Typing into “${control?.name || plan.id}”`);
        if(!r.ok) break;
        await wait(2500, controller.signal);
        // verify navigation / results loaded - whole-page check
        try{
          const after=await sendToTab(target.id,'AUTOREP_SCAN',{runId});
          updatePageOverview(after.snapshot);
          if(after.snapshot.url!==beforeUrl) log(' ✓ page changed → '+after.snapshot.url.slice(0,80));
          else {
            log('NO NAVIGATION: the next step will use a fresh scan');
          }
          continue; // skip extra wait at bottom, already waited
        }catch(e){}
      }
      else if(plan.action==='select'){
        const r=await sendToTab(target.id,'AUTOREP_SELECT',{id:plan.id, option:plan.option, snapshotId:s.snapshot.snapshotId, runId});
        const control = s.snapshot.elements.find(item => item.id === plan.id);
        showResult(r, `Choosing “${plan.option}” in “${control?.name || plan.id}”`);
        if(!r.ok) break;
      }
      else if(plan.action==='scroll'){
        await sendToTab(target.id,'AUTOREP_SCROLL',{direction:plan.direction||'down',runId});
        setState('Page scrolled', `Moved ${plan.direction || 'down'} to find more of the page.`, 'verified');
        addTimeline('Page scrolled', `Moved ${plan.direction || 'down'}.`, 'verified');
      }
      else if(plan.action==='extract'){
        const r=await sendToTab(target.id,'AUTOREP_EXTRACT',{runId});
        setState('Page text read', `${r.text.length} characters captured.`, 'verified');
        addTimeline('Page text read', `${r.text.length} characters captured.`, 'verified');
        log(`PAGE TEXT\n${r.text.slice(0,1600)}`);
        break;
      }
      await wait(1500, controller.signal);
    }
  }catch(e){
    if(isAbortError(e)) {
      setState('Task stopped', 'No more actions will be sent to the website.', 'warning');
      addTimeline('Task stopped', 'You stopped the run.', 'warning');
      log('RUN STOPPED');
    } else {
      setState('Task failed', e.message, 'failed');
      addTimeline('Task failed', e.message, 'failed');
      log('RUN FAILED ' + e.message);
    }
  }finally{
    if(runState.runId === runId){
      runState.running = false;
      runState.runId = null;
      runState.tabId = null;
      runState.controller = null;
      setRunUi(false);
    }
  }
};

stopButton.onclick = async ()=>{
  if(!runState.running) return;
  const { tabId, runId, controller } = runState;
  controller?.abort();
  try{ await sendToTab(tabId,'AUTOREP_CANCEL_RUN',{runId}); }catch(e){}
  log('■ stopping run…');
};
