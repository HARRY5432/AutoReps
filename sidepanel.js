const logEl = document.getElementById('log');
function log(...a){ logEl.textContent += a.join(' ') + '\n'; logEl.scrollTop = 1e9; }

async function activeTab(){ const [t]=await chrome.tabs.query({active:true,currentWindow:true}); return t; }
async function sendToTab(tabId, type, data={}){
  if(!tabId) throw new Error('No target tab');
  return await chrome.tabs.sendMessage(tabId, {type, ...data});
}
async function sendActive(type, data={}){
  const tab = await activeTab();
  return await sendToTab(tab?.id, type, data);
}

const runButton = document.getElementById('run');
const stopButton = document.getElementById('stop');
const runState = {
  running: false,
  runId: null,
  tabId: null,
  controller: null
};

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
    const r=await sendActive('AUTOREP_SCAN');
    const snapshot = r.snapshot;
    const pg = snapshot.page || {};
    const inv = snapshot.inventory || {};
    const site = pg.site || {};
    log(`🧠 SEES: "${snapshot.title}"`);
    log(`🌐 ${site.hostname || pg.domain || ''}${pg.urlPath || ''}${pg.urlQuery || ''}`);
    log(`🆔 snapshot ${snapshot.snapshotId || '?'} • hint=${pg.pageHint || '?'}`);
    log(`📋 ${pg.summary || ''}`);
    log(`🧩 controls ${inv.returnedCount ?? snapshot.count}/${inv.candidateCount ?? snapshot.count}` + (inv.truncated ? ` • truncated (${inv.omitted?.overLimit || 0} omitted)` : ' • complete'));
    log(`✅ actionable ${inv.actionableCount ?? pg.counts?.actionableControls ?? '?'} • domain ${site.hostname || '?'}`);
    if(pg.loneInputs?.length) log(` 🔍 inputs: ${pg.loneInputs.join(', ')}`);
    if(pg.prices?.length) log(` 💰 prices: ${pg.prices.slice(0,3).join(', ')}`);
    if(pg.videos?.length) log(` 🎬 videos: ${pg.videos.slice(0,2).join(' | ').slice(0,120)}`);
    if(pg.products?.length) log(` 🛍 products: ${pg.products.slice(0,2).join(' | ').slice(0,120)}`);
    log(`👁 controls:`);
    snapshot.elements.slice(0,30).forEach(e=>{
      const state = e.state?.disabled ? 'disabled' : e.actionable ? 'ready' : 'inspect-only';
      const caps = e.capabilities?.length ? ` <${e.capabilities.join(',')}>` : '';
      const options = e.options?.length ? ` options:${e.options.filter(option => !option.disabled).slice(0,4).map(option => option.label).join('|')}` : '';
      log(` [${e.id}] ${e.role} "${e.name}" — ${state}${caps}${options}`);
    });
    if(snapshot.count>30) log(`... +${snapshot.count-30} more`);
  }catch(e){log('❌ scan failed, reload page:',e.message)}
};
let badgesOn=false;
document.getElementById('badges').onclick = async ()=>{
  badgesOn=!badgesOn;
  try{ const r=await sendActive('AUTOREP_TOGGLE_BADGES',{show:badgesOn}); log(r.visible?'# badges ON':'# badges OFF'); }catch(e){log('❌',e.message)}
};
document.getElementById('extract').onclick = async ()=>{
  try{ const r=await sendActive('AUTOREP_EXTRACT'); log('📄 extracted text:\n'+r.text.slice(0,800)); }catch(e){log('❌',e.message)}
};

runButton.onclick = async ()=>{
  const task=document.getElementById('task').value.trim();
  if(!task) return log('write task first');
  if(runState.running) return log('⚠ a run is already active; press Stop first');
  const target = await activeTab();
  if(!target?.id) return log('❌ no active tab');
  const runId = crypto.randomUUID?.() || `run_${Date.now().toString(36)}`;
  const controller = new AbortController();
  runState.running = true;
  runState.runId = runId;
  runState.tabId = target.id;
  runState.controller = controller;
  setRunUi(true);
  log('🚀 task:',task,`(tab ${target.id}, run ${runId.slice(0,8)})`);
  try{
    for(let step=0; step<12; step++){
      if(controller.signal.aborted) throw new DOMException('The run was cancelled', 'AbortError');
      const s=await sendToTab(target.id,'AUTOREP_SCAN',{runId});
      const pg = s.snapshot.page||{};
      log(`-- step ${step+1} [${pg.site?.hostname || pg.domain || '?'}${pg.urlPath || ''}] ${s.snapshot.url.slice(0,60)} (${s.snapshot.count} controls)`);
      if(pg.needsHuman){
        log('⛔ human review required before acting on this page (auth, payment, OTP, CAPTCHA, or sensitive flow detected)');
        break;
      }
      const plan=await AutoRepAI.plan(task, s.snapshot,{ signal: controller.signal });
      validatePlan(plan, s.snapshot);
      log('🧠 AI:', JSON.stringify(plan));
      if(plan.action==='done'){ log('✅ DONE:', plan.reason||''); break; }
      if(plan.action==='click'){
        const r=await sendToTab(target.id,'AUTOREP_CLICK',{id:plan.id, snapshotId:s.snapshot.snapshotId, runId});
        log(r.ok?' ✓ clicked':' ❌ click fail '+r.error);
      }
      else if(plan.action==='type'){
        const beforeUrl = s.snapshot.url;
        const r=await sendToTab(target.id,'AUTOREP_TYPE',{id:plan.id, text:plan.text||'', pressEnter:plan.pressEnter !== false, snapshotId:s.snapshot.snapshotId, runId});
        log(r.ok?` ✓ typed "${plan.text}" + Enter + SearchBtn`:' ❌ type fail');
        await wait(2500, controller.signal);
        // verify navigation / results loaded - whole-page check
        try{
          const after=await sendToTab(target.id,'AUTOREP_SCAN',{runId});
          if(after.snapshot.url!==beforeUrl) log(' ✓ page changed → '+after.snapshot.url.slice(0,80));
          else {
            log(' ⚠ same page; next loop will rescan and re-plan instead of reusing an old control id');
          }
          continue; // skip extra wait at bottom, already waited
        }catch(e){}
      }
      else if(plan.action==='select'){
        const r=await sendToTab(target.id,'AUTOREP_SELECT',{id:plan.id, option:plan.option, snapshotId:s.snapshot.snapshotId, runId});
        log(r.ok?` ✓ selected "${r.label || plan.option}"`:' ❌ select fail '+r.error);
      }
      else if(plan.action==='scroll'){ await sendToTab(target.id,'AUTOREP_SCROLL',{direction:plan.direction||'down',runId}); }
      else if(plan.action==='extract'){ const r=await sendToTab(target.id,'AUTOREP_EXTRACT',{runId}); log('📄', r.text.slice(0,500)); break; }
      await wait(1500, controller.signal);
    }
  }catch(e){
    if(isAbortError(e)) log('■ run stopped');
    else log('❌ error:', e.message);
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
