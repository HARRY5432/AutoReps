/* AutoRep Actor v0.1 - hands that click/type safely */
(function () {
  if (window.__autoRepActorLoaded) return;
  window.__autoRepActorLoaded = true;

  function getEl(idOrSelector, selectorFallback) {
    // try live ref first
    const refs = window.__autoRepRefs || {};
    if (refs[idOrSelector]) {
      if (document.contains(refs[idOrSelector])) return refs[idOrSelector];
    }
    // try perception API
    try {
      const el = window.AutoRepPerception?.getElementById(idOrSelector);
      if (el && document.contains(el)) return el;
    } catch (e) {}
    // fallback to selector query
    if (selectorFallback) {
      try { return document.querySelector(selectorFallback); } catch (e) {}
    }
    return null;
  }

  function scrollIntoViewSafe(el) {
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {
      el.scrollIntoView();
    }
    return new Promise(r => setTimeout(r, 450));
  }

  async function doClick(id, selector) {
    const el = getEl(id, selector);
    if (!el) return { ok: false, error: 'element ' + id + ' not found, re-scan needed' };
    await scrollIntoViewSafe(el);
    el.focus?.();
    // trusted click sequence
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(t => {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
    return { ok: true, id, tag: el.tagName, name: (el.innerText || el.value || '').slice(0, 80) };
  }

  async function doType(id, text, selector, pressEnter) {
    const el = getEl(id, selector);
    if (!el) return { ok: false, error: 'element ' + id + ' not found' };
    await scrollIntoViewSafe(el);
    el.focus?.();
    try { el.click?.(); } catch (e) {}
    await new Promise(r => setTimeout(r, 150));

    // React-proof clear + set (YouTube, Gmail, React apps need native setter)
    try {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const selAll = () => {
        try { el.focus(); el.select?.(); } catch (e) {}
        document.execCommand?.('selectAll', false, null);
      };
      selAll();
      if (setter) setter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) { el.value = ''; }

    // human-like typing with proper InputEvent
    for (const ch of String(text)) {
      try {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, (el.value || '') + ch);
        else el.value = (el.value || '') + ch;
      } catch (e) { el.value += ch; }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      await new Promise(r => setTimeout(r, 20 + Math.random() * 40));
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));

    if (pressEnter !== false) {
      // always try enter by default for search boxes
      await doPressEnter(id, selector);
      await new Promise(r => setTimeout(r, 800));
      // if URL didn't change and we're on YouTube/Google, try clicking search button fallback
      await trySubmitFallback(el);
    }
    return { ok: true, id, typed: text };
  }

  async function doPressEnter(id, selector) {
    const el = getEl(id, selector) || document.activeElement;
    if (!el) return { ok: false };
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    // also dispatch on document for framework listeners
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    return { ok: true };
  }

  async function trySubmitFallback(typedEl) {
    try {
      // 1. form submit
      const form = typedEl?.closest?.('form');
      if (form) {
        const btn = form.querySelector('button[type="submit"], input[type="submit"]');
        if (btn) { btn.click(); return { ok: true, via: 'form-btn' }; }
        // don't call form.submit() directly (skips validation) - dispatch submit event
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
      // 2. YouTube specific
      const ytBtn = document.querySelector('#search-icon-legacy, button[aria-label="Search"], button[title="Search"]');
      if (ytBtn && location.hostname.includes('youtube')) {
        // only if typedEl looks like search
        ytBtn.click();
        return { ok: true, via: 'youtube-search-btn' };
      }
      // 3. generic: nearby submit/search button
      const generic = document.querySelector('button[type="submit"], button[aria-label*="Search" i], button[aria-label*="search" i]');
      if (generic && typedEl && (typedEl.placeholder?.toLowerCase().includes('search') || typedEl.type === 'search' || location.hostname.includes('youtube') || location.hostname.includes('google'))) {
        generic.click();
        return { ok: true, via: 'generic-search-btn' };
      }
    } catch (e) {}
    return { ok: false };
  }

  function doScroll(direction, amount) {
    amount = amount || 500;
    if (direction === 'up') window.scrollBy({ top: -amount, behavior: 'smooth' });
    else if (direction === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    else if (direction === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
    else window.scrollBy({ top: amount, behavior: 'smooth' });
    return { ok: true };
  }

  function doExtract() {
    const snap = window.AutoRepPerception?.scan();
    const text = document.body.innerText.slice(0, 15000);
    const tables = Array.from(document.querySelectorAll('table')).slice(0, 3).map(t => t.innerText.slice(0, 2000));
    return { ok: true, url: location.href, title: document.title, text, tables, snapshot: snap };
  }

  chrome.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg.type === 'AUTOREP_CLICK') sendResponse(await doClick(msg.id, msg.selector));
      else if (msg.type === 'AUTOREP_TYPE') sendResponse(await doType(msg.id, msg.text, msg.selector, msg.pressEnter));
      else if (msg.type === 'AUTOREP_PRESS_ENTER') sendResponse(await doPressEnter(msg.id, msg.selector));
      else if (msg.type === 'AUTOREP_SCROLL') sendResponse(doScroll(msg.direction, msg.amount));
      else if (msg.type === 'AUTOREP_EXTRACT') sendResponse(doExtract());
    })();
    return true; // async
  });

  window.AutoRepActor = { doClick, doType, doPressEnter, doScroll, doExtract };
  console.log('%c[AutoRep] actor loaded - hands ON', 'color:#059669;font-weight:bold');
})();
