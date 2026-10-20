const logEl = document.getElementById('log');
function log(...a){ logEl.textContent += a.join(' ') + '\n'; logEl.scrollTop = 1e9; }

async function activeTab(){ const [t]=await chrome.tabs.query({active:true,currentWindow:true}); return t; }
async function send(type, data={}){
  const tab = await activeTab();
  return await chrome.tabs.sendMessage(tab.id, {type, ...data});
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
    const pg = r.snapshot.page || {};
    log(`🧠 SEES: "${r.snapshot.title}"`);
    log(`🌐 ${pg.domain||''}${pg.urlPath||''}${pg.urlQuery||''} (hint=${pg.pageHint||'?'})`);
    log(`📋 ${pg.summary||''}`);
    if(pg.loneInputs?.length) log(` 🔍 searches: ${pg.loneInputs.join(', ')}`);
    if(pg.prices?.length) log(` 💰 prices: ${pg.prices.slice(0,3).join(', ')}`);
    if(pg.videos?.length) log(` 🎬 videos: ${pg.videos.slice(0,2).join(' | ').slice(0,120)}`);
    if(pg.products?.length) log(` 🛍 products: ${pg.products.slice(0,2).join(' | ').slice(0,120)}`);
    log(`👁 ${r.snapshot.count} clickable:`);
    r.snapshot.elements.slice(0,20).forEach(e=>log(` [${e.id}] ${e.role} "${e.name}"`));
    if(r.snapshot.count>20) log(`... +${r.snapshot.count-20} more`);
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
    let lastUrl = (await send('AUTOREP_SCAN')).snapshot.url;
    for(let step=0; step<12; step++){
      const s=await send('AUTOREP_SCAN');
      const pg = s.snapshot.page||{};
      log(`-- step ${step+1} [${pg.pageType||'?'}] ${s.snapshot.url.slice(0,60)} (${s.snapshot.count} els)`);
      const plan=await AutoRepAI.plan(task, s.snapshot);
      log('🧠 AI:', JSON.stringify(plan));
      if(plan.action==='done'){ log('✅ DONE:', plan.reason||''); break; }
      if(plan.action==='click'){
        const r=await send('AUTOREP_CLICK',{id:plan.id});
        log(r.ok?' ✓ clicked':' ❌ click fail '+r.error);
      }
      else if(plan.action==='type'){
        const beforeUrl = s.snapshot.url;
        const r=await send('AUTOREP_TYPE',{id:plan.id, text:plan.text||'', pressEnter:true});
        log(r.ok?` ✓ typed "${plan.text}" + Enter + SearchBtn`:' ❌ type fail');
        await new Promise(r=>setTimeout(r,2500));
        // verify navigation / results loaded - whole-page check
        try{
          const after=await send('AUTOREP_SCAN');
          if(after.snapshot.url!==beforeUrl) log(' ✓ page changed → '+after.snapshot.url.slice(0,80));
          else {
            log(' ⚠ same page, retrying Enter + Search click...');
            await send('AUTOREP_PRESS_ENTER',{id:plan.id});
            await new Promise(r=>setTimeout(r,1500));
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
