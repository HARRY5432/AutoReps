/* AutoRep Actor v0.2 - snapshot-bound, cancellable hands */
(function () {
  if (window.__autoRepActorLoaded) return;
  window.__autoRepActorLoaded = true;
  const cancelledRuns = new Set();

  function runError(runId) {
    if (runId && cancelledRuns.has(runId)) {
      return { ok: false, errorCode: 'CANCELLED', error: 'The run was cancelled.' };
    }
    return null;
  }

  function validateSnapshot(snapshotId, runId) {
    const cancelled = runError(runId);
    if (cancelled) return cancelled;
    if (!snapshotId) return null;
    const current = window.AutoRepPerception?.getSnapshotId?.();
    if (current !== snapshotId) {
      return {
        ok: false,
        errorCode: 'STALE_SNAPSHOT',
        error: 'The page changed after the plan was created. Scan and plan again.'
      };
    }
    return null;
  }

  function getEl(idOrSelector, selectorFallback, snapshotId, runId) {
    const stale = validateSnapshot(snapshotId, runId);
    if (stale) return stale;
    const registryEntry = window.AutoRepPerception?.getRegistryEntry?.(idOrSelector);
    if (snapshotId) {
      if (!registryEntry || registryEntry.snapshotId !== snapshotId) {
        return { ok: false, errorCode: 'TARGET_NOT_FOUND', error: 'The snapshot does not contain this control.' };
      }
      if (!registryEntry.element?.isConnected) {
        return { ok: false, errorCode: 'STALE_TARGET', error: 'The target was replaced or removed; scan and plan again.' };
      }
    }
    // try live ref first
    const refs = window.__autoRepRefs || {};
    if (refs[idOrSelector]) {
      if (refs[idOrSelector].isConnected) return { ok: true, element: refs[idOrSelector] };
    }
    // try perception API
    try {
      const el = window.AutoRepPerception?.getElementById(idOrSelector);
      if (el && el.isConnected) return { ok: true, element: el };
    } catch (e) {}
    // fallback to selector query
    if (selectorFallback) {
      try {
        const el = document.querySelector(selectorFallback);
        if (el) return { ok: true, element: el };
      } catch (e) {}
    }
    return { ok: false, errorCode: 'TARGET_NOT_FOUND', error: 'Element ' + idOrSelector + ' was not found.' };
  }

  function scrollIntoViewSafe(el, runId) {
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {
      el.scrollIntoView();
    }
    return new Promise(resolve => setTimeout(() => resolve(runError(runId)), 450));
  }

  function captureState(el) {
    return {
      url: el.ownerDocument?.defaultView?.location?.href || location.href,
      value: typeof el.value === 'string' ? el.value : null,
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      checked: typeof el.checked === 'boolean' ? el.checked : null,
      selectedIndex: typeof el.selectedIndex === 'number' ? el.selectedIndex : null,
      expanded: el.getAttribute?.('aria-expanded'),
      pressed: el.getAttribute?.('aria-pressed'),
      selected: el.getAttribute?.('aria-selected')
    };
  }

  function pageSignature(doc) {
    const text = (doc.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return `${text.length}|${text.slice(0, 120)}|${text.slice(-120)}`;
  }

  function observeAction(el, before, duration=1400) {
    const doc = el.ownerDocument || document;
    const beforePage = pageSignature(doc);
    let domChanged = false;
    const observer = new MutationObserver(() => { domChanged = true; });
    try {
      observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (e) {}
    return new Promise(resolve => setTimeout(() => {
      observer.disconnect();
      const after = captureState(el);
      const stateChanged = ['value', 'text', 'checked', 'selectedIndex', 'expanded', 'pressed', 'selected'].some(key => before[key] !== after[key]);
      const urlChanged = before.url !== after.url;
      const pageChanged = beforePage !== pageSignature(doc);
      resolve({ domChanged, pageChanged, stateChanged, urlChanged, after, verified: stateChanged || urlChanged || (domChanged && pageChanged) });
    }, duration));
  }

  function mark(id, status, message, snapshotId) {
    try { return window.AutoRepPerception?.showActionMarker?.(id, status, message, snapshotId, false); } catch (e) { return null; }
  }

  async function doClick(id, selector, snapshotId, runId) {
    const resolved = getEl(id, selector, snapshotId, runId);
    if (!resolved.ok) return resolved;
    const el = resolved.element;
    const registryEntry = window.AutoRepPerception?.getRegistryEntry?.(id);
    if (snapshotId && registryEntry && registryEntry.snapshotId === snapshotId && registryEntry.element !== el) {
      return { ok: false, errorCode: 'STALE_TARGET', error: 'The target was replaced; scan and plan again.' };
    }
    if (el.disabled || el.getAttribute?.('aria-disabled') === 'true') {
      return { ok: false, errorCode: 'UNSUPPORTED_ACTION', error: 'The target is disabled.' };
    }
    const afterScroll = await scrollIntoViewSafe(el, runId);
    if (afterScroll) return afterScroll;
    const cancelled = runError(runId);
    if (cancelled) return cancelled;
    if (!el.isConnected) return { ok: false, errorCode: 'STALE_TARGET', error: 'The target disappeared while scrolling.' };
    el.focus?.();
    const before = captureState(el);
    const observation = observeAction(el, before);
    // Prefer native activation. Synthetic pointer events are not trusted input
    // and often do not trigger the browser's default behavior.
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    const observed = await observation;
    const status = observed.verified ? 'verified' : 'unverified';
    const message = observed.verified ? 'The website showed a visible response.' : 'The click was sent, but no visible page response was detected.';
    mark(id, status === 'verified' ? 'verified' : 'warning', message, snapshotId);
    return { ok: true, status, id, tag: el.tagName, name: (el.innerText || el.value || '').slice(0, 80), observed, message };
  }

  async function doType(id, text, selector, pressEnter, snapshotId, runId) {
    const resolved = getEl(id, selector, snapshotId, runId);
    if (!resolved.ok) return resolved;
    const el = resolved.element;
    if (el.disabled || el.readOnly || el.getAttribute?.('aria-disabled') === 'true') {
      return { ok: false, errorCode: 'UNSUPPORTED_ACTION', error: 'The target cannot accept text.' };
    }
    if (!String(text || '').trim()) return { ok: false, errorCode: 'INVALID_ACTION', error: 'Text is required.' };
    const afterScroll = await scrollIntoViewSafe(el, runId);
    if (afterScroll) return afterScroll;
    const cancelled = runError(runId);
    if (cancelled) return cancelled;
    if (!el.isConnected) return { ok: false, errorCode: 'STALE_TARGET', error: 'The target disappeared while scrolling.' };
    el.focus?.();
    try { el.click?.(); } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
    const afterFocus = runError(runId);
    if (afterFocus) return afterFocus;
    const before = captureState(el);

    if (el.isContentEditable) {
      const doc = el.ownerDocument || document;
      const view = doc.defaultView || window;
      try {
        const selection = view.getSelection?.();
        const range = doc.createRange();
        range.selectNodeContents(el);
        selection?.removeAllRanges();
        selection?.addRange(range);
        const inserted = doc.execCommand?.('insertText', false, String(text));
        if (!inserted) {
          el.textContent = String(text);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(text), inputType: 'insertText' }));
        }
      } catch (e) {
        el.textContent = String(text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(text), inputType: 'insertText' }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const afterEdit = runError(runId);
      if (afterEdit) return afterEdit;
      if (pressEnter !== false) {
        const enterResult = await doPressEnter(id, selector, snapshotId, runId);
        if (!enterResult.ok) return enterResult;
        await new Promise(r => setTimeout(r, 800));
        await trySubmitFallback(el);
      }
      const after = captureState(el);
      const expected = String(text);
      const verified = after.text === expected || after.text.includes(expected);
      const status = verified ? 'verified' : 'failed';
      const message = verified ? 'The editable area contains the requested text.' : 'The page did not keep the requested text in the editable area.';
      mark(id, verified ? 'verified' : 'failed', message, snapshotId);
      return { ok: verified, status, id, typed: text, contentEditable: true, observed: { stateChanged: before.text !== after.text, value: after.text }, message, error: verified ? null : message };
    }

    // React-proof clear + set (YouTube, Gmail, React apps need native setter)
    try {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const selAll = () => {
        try { el.focus(); el.select?.(); } catch (e) {}
        (el.ownerDocument || document).execCommand?.('selectAll', false, null);
      };
      selAll();
      if (setter) setter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) { el.value = ''; }

    // human-like typing with proper InputEvent
    for (const ch of String(text)) {
      const cancelledDuringType = runError(runId);
      if (cancelledDuringType) return cancelledDuringType;
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
      const enterResult = await doPressEnter(id, selector, snapshotId, runId);
      if (!enterResult.ok) return enterResult;
      await new Promise(r => setTimeout(r, 800));
      // if URL didn't change and we're on YouTube/Google, try clicking search button fallback
      await trySubmitFallback(el);
    }
    const after = captureState(el);
    const verified = after.value === String(text);
    const status = verified ? 'verified' : 'failed';
    const message = verified ? 'The field contains the requested text.' : 'The page changed or rejected the requested text.';
    mark(id, verified ? 'verified' : 'failed', message, snapshotId);
    return { ok: verified, status, id, typed: text, observed: { stateChanged: before.value !== after.value, value: after.value }, message, error: verified ? null : message };
  }

  async function doPressEnter(id, selector, snapshotId, runId) {
    const resolved = getEl(id, selector, snapshotId, runId);
    if (!resolved.ok && snapshotId) return resolved;
    const el = resolved.ok ? resolved.element : document.activeElement;
    if (!el) return resolved;
    const cancelled = runError(runId);
    if (cancelled) return cancelled;
    const ownerDocument = el.ownerDocument || document;
    const ownerWindow = ownerDocument.defaultView || window;
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new ownerWindow.KeyboardEvent('keydown', opts));
    el.dispatchEvent(new ownerWindow.KeyboardEvent('keypress', opts));
    el.dispatchEvent(new ownerWindow.KeyboardEvent('keyup', opts));
    // also dispatch on document for framework listeners
    ownerDocument.dispatchEvent(new ownerWindow.KeyboardEvent('keydown', opts));
    return { ok: true };
  }

  async function doSelect(id, option, selector, snapshotId, runId) {
    const resolved = getEl(id, selector, snapshotId, runId);
    if (!resolved.ok) return resolved;
    const el = resolved.element;
    if (el.tagName !== 'SELECT') {
      return { ok: false, errorCode: 'UNSUPPORTED_ACTION', error: 'Only native select controls support select actions.' };
    }
    if (el.multiple) {
      return { ok: false, errorCode: 'UNSUPPORTED_ACTION', error: 'Multiple-select controls are not supported yet.' };
    }
    if (el.disabled || el.getAttribute?.('aria-disabled') === 'true') {
      return { ok: false, errorCode: 'UNSUPPORTED_ACTION', error: 'The select control is disabled.' };
    }
    const afterScroll = await scrollIntoViewSafe(el, runId);
    if (afterScroll) return afterScroll;
    if (!el.isConnected) return { ok: false, errorCode: 'STALE_TARGET', error: 'The select control disappeared while scrolling.' };
    const requested = String(option ?? '').trim().toLowerCase();
    const matches = Array.from(el.options || []).filter(candidate => {
      if (candidate.disabled) return false;
      return String(candidate.value).trim().toLowerCase() === requested || String(candidate.textContent).trim().toLowerCase() === requested;
    });
    if (matches.length === 0) return { ok: false, errorCode: 'INVALID_ACTION', error: 'The requested option is not available.' };
    if (matches.length > 1) return { ok: false, errorCode: 'INVALID_ACTION', error: 'The requested option is ambiguous.' };
    const candidate = matches[0];
    const cancelled = runError(runId);
    if (cancelled) return cancelled;
    const before = captureState(el);
    const observation = observeAction(el, before, 500);
    el.value = candidate.value;
    Array.from(el.options).forEach(item => { item.selected = item === candidate; });
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const observed = await observation;
    const verified = el.value === candidate.value;
    const status = verified ? 'verified' : 'failed';
    const message = verified ? `The page selected “${candidate.textContent.trim()}”.` : 'The page did not keep the selected option.';
    mark(id, verified ? 'verified' : 'failed', message, snapshotId);
    return { ok: verified, status, id, value: candidate.value, label: candidate.textContent.trim(), observed, message, error: verified ? null : message };
  }

  async function trySubmitFallback(typedEl) {
    try {
      // 1. Use the browser's native form submission algorithm when possible.
      const form = typedEl?.closest?.('form');
      if (form) {
        const btn = form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
        if (btn && !btn.disabled) {
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit(btn);
            return { ok: true, via: 'form-requestSubmit', element: btn };
          }
          btn.click();
          return { ok: true, via: 'form-btn', element: btn };
        }
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
          return { ok: true, via: 'form-requestSubmit' };
        }
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
    const handled = ['AUTOREP_CLICK', 'AUTOREP_TYPE', 'AUTOREP_PRESS_ENTER', 'AUTOREP_SELECT', 'AUTOREP_SCROLL', 'AUTOREP_EXTRACT', 'AUTOREP_CANCEL_RUN'].includes(msg.type);
    if (!handled) return false;
    (async () => {
      if (msg.type === 'AUTOREP_CLICK') sendResponse(await doClick(msg.id, msg.selector, msg.snapshotId, msg.runId));
      else if (msg.type === 'AUTOREP_TYPE') sendResponse(await doType(msg.id, msg.text, msg.selector, msg.pressEnter, msg.snapshotId, msg.runId));
      else if (msg.type === 'AUTOREP_PRESS_ENTER') sendResponse(await doPressEnter(msg.id, msg.selector, msg.snapshotId, msg.runId));
      else if (msg.type === 'AUTOREP_SELECT') sendResponse(await doSelect(msg.id, msg.option, msg.selector, msg.snapshotId, msg.runId));
      else if (msg.type === 'AUTOREP_CANCEL_RUN') {
        if (msg.runId) cancelledRuns.add(msg.runId);
        sendResponse({ ok: true, runId: msg.runId, cancelled: true });
      }
      else if (msg.type === 'AUTOREP_SCROLL') sendResponse(doScroll(msg.direction, msg.amount));
      else if (msg.type === 'AUTOREP_EXTRACT') sendResponse(doExtract());
    })();
    return true; // async
  });

  window.AutoRepActor = { doClick, doType, doPressEnter, doSelect, doScroll, doExtract };
  console.log('%c[AutoRep] actor loaded - hands ON', 'color:#059669;font-weight:bold');
})();
