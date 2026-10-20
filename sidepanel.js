const logEl = document.getElementById('log');
function log(...a){ logEl.textContent += a.join(' ') + '\n'; logEl.scrollTop = 1e9; }

async function activeTab(){ const [t]=await chrome.tabs.query({active:true,currentWindow:true}); return t; }
async function send(type, data={}){
  const tab = await activeTab();
  return await chrome.tabs.sendMessage(tab.id, {type, ...data});
}

function validatePlan(plan, snapshot){
  const allowed = new Set(['click','type','scroll','extract','done']);
  if(!plan || !allowed.has(plan.action)) throw new Error('AI returned unsupported action');
  if(plan.action === 'click' || plan.action === 'type'){
    if(!Number.isInteger(plan.id)) throw new Error('AI returned an invalid control id');
    const control = (snapshot.elements || []).find(e => e.id === plan.id);
    if(!control) throw new Error(`AI selected missing control id ${plan.id}`);
    const capability = plan.action === 'click' ? 'click' : 'type';
    if(!control.actionable || !control.capabilities?.includes(capability)){
      throw new Error(`AI selected non-actionable control ${plan.id}`);
    }
    if(plan.action === 'type' && !String(plan.text || '').trim()){
      throw new Error('AI returned an empty typing action');
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
    const r=await send('AUTOREP_SCAN');
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
      log(` [${e.id}] ${e.role} "${e.name}" — ${state}${caps}`);
    });
    if(snapshot.count>30) log(`... +${snapshot.count-30} more`);
  }catch(e){log('❌ scan failed, reload page:',e.message)}
};
let badgesOn=false;
document.getElementById('badges').onclick = async ()=>{
  badgesOn=!badgesOn;
  try{ const r=await send('AUTOREP_TOGGLE_BADGES',{show:badgesOn}); log(r.visible?'# badges ON':'# badges OFF'); }catch(e){log('❌',e.message)}
};
document.getElementById('extract').onclick = async ()=>{
  try{ const r=await send('AUTOREP_EXTRACT'); log('📄 extracted text:\n'+r.text.slice(0,800)); }catch(e){log('❌',e.message)}
};

document.getElementById('run').onclick = async ()=>{
  const task=document.getElementById('task').value.trim();
  if(!task) return log('write task first');
  log('🚀 task:',task);
  try{
    for(let step=0; step<12; step++){
      const s=await send('AUTOREP_SCAN');
      const pg = s.snapshot.page||{};
      log(`-- step ${step+1} [${pg.site?.hostname || pg.domain || '?'}${pg.urlPath || ''}] ${s.snapshot.url.slice(0,60)} (${s.snapshot.count} controls)`);
      if(pg.needsHuman){
        log('⛔ human review required before acting on this page (auth, payment, OTP, CAPTCHA, or sensitive flow detected)');
        break;
      }
      const plan=await AutoRepAI.plan(task, s.snapshot);
      validatePlan(plan, s.snapshot);
      log('🧠 AI:', JSON.stringify(plan));
      if(plan.action==='done'){ log('✅ DONE:', plan.reason||''); break; }
      if(plan.action==='click'){
        const r=await send('AUTOREP_CLICK',{id:plan.id, snapshotId:s.snapshot.snapshotId});
        log(r.ok?' ✓ clicked':' ❌ click fail '+r.error);
      }
      else if(plan.action==='type'){
        const beforeUrl = s.snapshot.url;
        const r=await send('AUTOREP_TYPE',{id:plan.id, text:plan.text||'', pressEnter:true, snapshotId:s.snapshot.snapshotId});
        log(r.ok?` ✓ typed "${plan.text}" + Enter + SearchBtn`:' ❌ type fail');
        await new Promise(r=>setTimeout(r,2500));
        // verify navigation / results loaded - whole-page check
        try{
          const after=await send('AUTOREP_SCAN');
          if(after.snapshot.url!==beforeUrl) log(' ✓ page changed → '+after.snapshot.url.slice(0,80));
          else {
            log(' ⚠ same page; next loop will rescan and re-plan instead of reusing an old control id');
          }
          continue; // skip extra wait at bottom, already waited
        }catch(e){}
      }
      else if(plan.action==='scroll'){ await send('AUTOREP_SCROLL',{direction:plan.direction||'down'}); }
      else if(plan.action==='extract'){ const r=await send('AUTOREP_EXTRACT'); log('📄', r.text.slice(0,500)); break; }
      await new Promise(r=>setTimeout(r,1500));
    }
  }catch(e){ log('❌ error:', e.message); }
};
