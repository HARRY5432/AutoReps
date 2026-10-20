/* AutoRep Perception Engine v0.1 - TOP NOTCH
 * Why this beats raw outerHTML:
 * raw HTML = 500KB-2MB garbage, LLM chokes.
 * This = 50-150 interactive elements only, with stable ai-ids.
 * Handles: Shadow DOM, same-origin iframes, React re-renders, lazy-load, infinite scroll.
 */
(function () {
  if (window.__autoRepPerceptionLoaded) return;
  window.__autoRepPerceptionLoaded = true;

  const BADGE_CONTAINER_ID = '__autorep-badges';
  let lastSnapshot = null;
  let badgesVisible = false;
  let idCounter = 0;
  const elementToId = new WeakMap();
  const idToElement = new Map();

  const JUNK_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'SVG', 'PATH', 'SOURCE']);
  const KEEP_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION']);

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (el.hasAttribute('hidden')) return false;
    // off-screen far away still keep if scrollable page (for scroll action), but deprioritize
    return true;
  }

  function getName(el) {
    // priority: aria-label > innerText > value > placeholder > title > alt > id
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().slice(0, 120);
    let text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    // for inputs, innerText empty - use surrounding label
    if (!text && el.labels && el.labels.length > 0) {
      text = Array.from(el.labels).map(l => l.innerText).join(' ').trim();
    }
    if (!text && el.value && ['button', 'submit'].includes(el.type)) text = el.value;
    if (!text) text = el.getAttribute ? (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '') : '';
    if (!text && el.tagName === 'A' && el.href) text = el.href.slice(0, 60);
    return (text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function getRole(el) {
    if (el.getAttribute && el.getAttribute('role')) return el.getAttribute('role');
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (['checkbox', 'radio', 'submit', 'button'].includes(t)) return 'button';
      return 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (el.isContentEditable) return 'textbox';
    if (el.hasAttribute && (el.hasAttribute('onclick') || el.getAttribute('tabindex') !== null)) return 'button';
    return tag;
  }

  function buildSelector(el) {
    // robust selector: prefer id, data-*, name, else nth-of-type path (max 4 levels)
    try {
      if (el.id) return '#' + CSS.escape(el.id);
      const dataAttrs = ['data-testid', 'data-test', 'data-action', 'data-add-to-cart', 'data-id', 'name'];
      for (const a of dataAttrs) {
        if (el.hasAttribute && el.hasAttribute(a)) {
          const v = el.getAttribute(a);
          if (v) return `${el.tagName.toLowerCase()}[${a}="${CSS.escape(v)}"]`;
        }
      }
      // fallback path
      const path = [];
      let cur = el;
      for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
        let sel = cur.tagName.toLowerCase();
        if (cur.classList && cur.classList.length > 0) {
          // take first stable-looking class (no hash-like)
          const cls = Array.from(cur.classList).find(c => !/^[a-z]{1,2}[0-9]|^[0-9]|__|--/.test(c) === false || c.length < 20);
          // actually keep simple: skip obfuscated classes longer than 15 with mixed case+digits
          const clean = Array.from(cur.classList).find(c => c.length < 20 && !/[A-Z].*[0-9]|[0-9].*[A-Z]/.test(c));
          if (clean) sel += '.' + CSS.escape(clean);
        }
        const parent = cur.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
          if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
        path.unshift(sel);
        cur = parent;
      }
      return path.join(' > ');
    } catch (e) {
      return el.tagName.toLowerCase();
    }
  }

  function isInteractive(el) {
    if (!el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    if (JUNK_TAGS.has(tag)) return false;
    if (KEEP_TAGS.has(tag)) return true;
    if (el.isContentEditable) return true;
    if (el.hasAttribute) {
      if (el.hasAttribute('onclick') || el.hasAttribute('role') || el.hasAttribute('tabindex') || el.hasAttribute('jsaction')) return true;
      const cursor = window.getComputedStyle(el).cursor;
      if (cursor === 'pointer' && (el.tagName === 'DIV' || el.tagName === 'SPAN')) return true;
    }
    return false;
  }

  // Recursive walker that pierces Shadow DOM
  function* walk(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let node = walker.currentNode;
    // include root itself
    if (node && node.tagName) yield node;
    while ((node = walker.nextNode())) {
      yield node;
      if (node.shadowRoot) {
        yield* walk(node.shadowRoot);
      }
    }
  }

  function scan() {
    idCounter = 0;
    idToElement.clear();
    // keep WeakMap across scans for stability? reset ids each scan for simplicity but selector stable
    const elements = [];
    const seen = new Set();

    const roots = [document.body || document.documentElement];
    // same-origin iframes
    document.querySelectorAll('iframe').forEach(frame => {
      try {
        if (frame.contentDocument && frame.contentDocument.body) roots.push(frame.contentDocument.body);
      } catch (e) { /* cross-origin - skip, will need vision later */ }
    });

    for (const root of roots) {
      for (const el of walk(root)) {
        if (!isInteractive(el)) continue;
        if (!isVisible(el)) continue;
        if (seen.has(el)) continue;
        seen.add(el);

        const rect = el.getBoundingClientRect();
        const inViewport = rect.top >= -200 && rect.top <= window.innerHeight + 800;

        let aiId;
        if (elementToId.has(el)) {
          aiId = elementToId.get(el);
        } else {
          aiId = ++idCounter + (idCounter > 900 ? 0 : 0); // simple increment
          // ensure unique across roots
          aiId = elements.length + 1;
          elementToId.set(el, aiId);
        }
        idToElement.set(aiId, el);

        elements.push({
          id: aiId,
          role: getRole(el),
          name: getName(el) || '(no name)',
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          value: (el.value || '').slice(0, 100),
          checked: el.checked || false,
          disabled: el.disabled || false,
          selector: buildSelector(el),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          inViewport
        });

        if (elements.length >= 200) break;
      }
      if (elements.length >= 200) break;
    }

    // sort: viewport first, then buttons/links/inputs priority
    elements.sort((a, b) => {
      if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
      return a.id - b.id;
    });

    // re-assign clean 1..N after sort and rebuild map
    const finalEls = elements.slice(0, 150).map((e, idx) => ({ ...e, id: idx + 1 }));
    idToElement.clear();
    finalEls.forEach(e => {
      // find original el by selector? easier: keep ref via old id lookup
      // we stored in order, so map via elements[idx]
    });
    // rebuild idToElement correctly
    elements.slice(0, 150).forEach((orig, idx) => {
      const oldEl = idToElement.get(orig.id) || null;
    });
    // Simpler: second pass - walk again? Instead store el ref directly:
    // Re-do with el refs preserved:
    const withRefs = elements.slice(0, 150);
    idToElement.clear();
    const out = withRefs.map((e, idx) => {
      const newId = idx + 1;
      // find element: search by old id
      return { ...e, id: newId };
    });
    // fix mapping: we need el refs - let's store them in order
    // NOTE: orig elements order changed by sort, but idToElement was built pre-sort.
    // Easiest: rebuild mapping by selector lookup on demand in actor (querySelector).
    // For badges + clicks we keep live refs in _refs array:
    scan._refs = withRefs.map(w => {
      // recover el via previous map: find key by matching selector+name (approx) OR store ref earlier
      return null;
    });

    // --- Correct approach: keep refs alongside ---
    // Let's rebuild properly with refs:
    // (We already have seen order; redo quickly storing refs)
    const snapshot = {
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      count: out.length,
      elements: out
    };
    // store live refs separately in window for actor
    window.__autoRepRefs = {};
    // re-walk to fill refs by order of out (selector-based recovery is okay for now)
    // Actor will use selector to re-query live, so refs not strictly needed.
    lastSnapshot = snapshot;
    if (badgesVisible) renderBadges();
    return snapshot;
  }

  // Simpler robust scan v2 that keeps refs correctly (used by default)
  function scanV2() {
    const items = [];
    const roots = [document.body || document.documentElement];
    document.querySelectorAll('iframe').forEach(f => {
      try { if (f.contentDocument?.body) roots.push(f.contentDocument.body); } catch (e) {}
    });

    const candidates = [];
    for (const root of roots) {
      for (const el of walk(root)) {
        if (!isInteractive(el)) continue;
        if (!isVisible(el)) continue;
        candidates.push(el);
        if (candidates.length > 500) break;
      }
    }
    // prioritize viewport
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const aIn = ra.top >= 0 && ra.top <= window.innerHeight;
      const bIn = rb.top >= 0 && rb.top <= window.innerHeight;
      if (aIn !== bIn) return aIn ? -1 : 1;
      return ra.top - rb.top;
    });

    const sliced = candidates.slice(0, 150);
    window.__autoRepRefs = {};
    const elements = sliced.map((el, i) => {
      const id = i + 1;
      window.__autoRepRefs[id] = el;
      const rect = el.getBoundingClientRect();
      return {
        id,
        role: getRole(el),
        name: getName(el) || '(no name)',
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        value: (el.value || '').slice(0, 100),
        checked: !!el.checked,
        disabled: !!el.disabled,
        selector: buildSelector(el),
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        inViewport: rect.top >= 0 && rect.top <= window.innerHeight
      };
    });

    lastSnapshot = { url: location.href, title: document.title, timestamp: Date.now(), count: elements.length, elements, page: understandPage() };
    if (badgesVisible) renderBadges();
    return lastSnapshot;
  }

  function renderBadgesV2Note() { return true; }

  function understandPage() {
    // UNIVERSAL WHOLE-PAGE UNDERSTANDING v2 - makes AI feel powerful on ANY site
    // Gives BOTH ends: 1) what USER wants (task side handled in brain) 2) what PAGE offers (this side)
    try {
      const visible = el => { try { return !!(el.offsetWidth || el.getClientRects().length) && el.innerText; } catch (e) { return false; } };

      const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
        .filter(h => h.innerText && h.innerText.trim().length > 0 && h.offsetParent !== null)
        .slice(0, 12).map(h => `${h.tagName}: ${h.innerText.trim().slice(0, 120)}`);

      // landmarks & sections
      const navLinks = Array.from(document.querySelectorAll('nav a, header a'))
        .filter(a => a.innerText.trim()).slice(0, 10).map(a => a.innerText.trim().slice(0, 40));

      const formsDetailed = Array.from(document.querySelectorAll('form')).slice(0, 4).map(f => {
        const fields = Array.from(f.querySelectorAll('input,select,textarea')).slice(0, 12).map(inp => {
          const lab = inp.labels?.[0]?.innerText?.trim() || inp.placeholder || inp.name || inp.type;
          return `${inp.tagName.toLowerCase()}[${inp.type||''}] "${(lab||'').slice(0,40)}"`;
        });
        return { id: f.id || f.name || 'form', fields, submit: !!f.querySelector('[type=submit],button') };
      });

      // standalone inputs outside forms (YouTube, Google search etc)
      const loneInputs = Array.from(document.querySelectorAll('input[type="search"], input[type="text"], input:not([type])'))
        .filter(el => el.offsetParent !== null && !el.closest('form'))
        .slice(0, 5).map(el => `input "${(el.placeholder||el.name||el.getAttribute('aria-label')||'search').slice(0,50)}"`);

      // prices / products / videos - key entities AI needs
      const bodyAllText = document.body ? document.body.innerText || '' : '';
      const priceMatches = (bodyAllText.match(/(₹\s?[\d,]+|\$\s?[\d,.]+|€\s?[\d,.]+)/g) || []).slice(0, 8);
      const videoTitles = Array.from(document.querySelectorAll('a#video-title, ytd-video-renderer a, [class*="video"] a'))
        .map(a => a.innerText.trim()).filter(t => t.length > 5).slice(0, 6);
      const productNames = Array.from(document.querySelectorAll('[data-asin] h2, .s-title, [class*="product"] h2, [class*="card"] h3'))
        .map(h => h.innerText.trim()).filter(t => t.length > 5).slice(0, 6);
      const tableInfo = (() => {
        const t = document.querySelector('table');
        if (!t) return null;
        const headers = Array.from(t.querySelectorAll('th')).map(h => h.innerText.trim()).slice(0, 8);
        return { headers, rows: t.querySelectorAll('tr').length };
      })();

      let mainText = bodyAllText.replace(/\s+/g, ' ').trim().slice(0, 3500);

      // NO MORE RULE-BASED pageType! User is right: AI brain is powerful enough.
      // We just give RAW FACTS: domain, URL structure, signals. AI infers what page is.
      const urlObj = (() => { try { return new URL(location.href); } catch (e) { return null; } })();
      const domain = urlObj ? urlObj.hostname : location.hostname;
      const urlPath = urlObj ? urlObj.pathname.slice(0, 200) : '';
      const urlQuery = urlObj ? urlObj.search.slice(0, 200) : '';
      // tiny hint only for offline Scan display (AI is allowed to IGNORE/override this)
      let pageHint = 'generic';
      const bt = mainText.toLowerCase();
      const lowUrl = location.href.toLowerCase();
      if (/login|signin/.test(lowUrl) || /sign in/.test(bt.slice(0,500))) pageHint = 'maybe-auth';
      else if (lowUrl.includes('youtube.com')) pageHint = 'maybe-video';
      else if (/checkout|payment/.test(bt)) pageHint = 'maybe-checkout';
      else if (/add to cart|buy now/.test(bt)) pageHint = 'maybe-product';

      // human-readable summary - raw, no decision
      const summary = `${document.title} on ${domain}${urlPath} | hint=${pageHint} | ` +
        `headings[${headings.length}] forms[${formsDetailed.length}] ` +
        `${priceMatches.length ? 'prices:' + priceMatches.slice(0,3).join(',') + ' ' : ''}` +
        `${videoTitles.length ? 'videos:' + videoTitles.slice(0,2).join(' | ').slice(0,120) + ' ' : ''}` +
        `${productNames.length ? 'products:' + productNames.slice(0,2).join(' | ').slice(0,120) : ''}`.trim();

      const counts = {};
      try { (lastSnapshot?.elements || []).forEach(e => { counts[e.role] = (counts[e.role] || 0) + 1; }); } catch (e) {}

      return {
        url: location.href, title: document.title,
        domain, urlPath, urlQuery,
        lang: document.documentElement.lang || 'en',
        pageHint, summary, // hint only, AI decides real type
        headings, navLinks, forms: formsDetailed, loneInputs,
        prices: priceMatches, videos: videoTitles, products: productNames, table: tableInfo,
        mainText, counts,
        scrollY: Math.round(window.scrollY), pageHeight: document.body ? document.body.scrollHeight : 0,
        needsHuman: /captcha|otp|verify you are human|payment|upi|card|cvv|razorpay|stripe/i.test(mainText)
      };
    } catch (e) {
      return { url: location.href, title: document.title, pageType: 'unknown', summary: document.title, error: String(e).slice(0, 200) };
    }
  }

  function renderBadges() {
    let container = document.getElementById(BADGE_CONTAINER_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = BADGE_CONTAINER_ID;
      container.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:2147483647;';
      document.body.appendChild(container);
    }
    container.innerHTML = '';
    if (!lastSnapshot) return;
    const refs = window.__autoRepRefs || {};
    for (const item of lastSnapshot.elements) {
      const el = refs[item.id];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      const badge = document.createElement('div');
      badge.textContent = item.id;
      badge.style.cssText = `position:absolute;left:${rect.left + window.scrollX - 8}px;top:${rect.top + window.scrollY - 14}px;` +
        `background:#7c3aed;color:white;font:700 11px/1.4 system-ui;padding:1px 6px;border-radius:8px;` +
        `border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none;`;
      container.appendChild(badge);
      // highlight
      const oldOutline = el.style.outline;
      el.style.outline = '2px dashed #7c3aed';
      el.dataset.autorepOutlined = '1';
      setTimeout(() => { if (el.dataset.autorepOutlined) { el.style.outline = oldOutline || ''; delete el.dataset.autorepOutlined; } }, 2500);
    }
  }

  function clearBadges() {
    const c = document.getElementById(BADGE_CONTAINER_ID);
    if (c) c.remove();
    document.querySelectorAll('[data-autorep-outlined]').forEach(el => {
      el.style.outline = '';
      delete el.dataset.autorepOutlined;
    });
  }

  function toggleBadges(show) {
    badgesVisible = show !== undefined ? show : !badgesVisible;
    if (badgesVisible) {
      if (!lastSnapshot) scanV2();
      renderBadges();
    } else clearBadges();
    return badgesVisible;
  }

  function saveSnapshot() {
    const snap = lastSnapshot || scanV2();
    const html = '<!-- AutoRep snapshot ' + new Date().toISOString() + ' -->\n<!-- URL: ' + snap.url + ' -->\n' + document.documentElement.outerHTML.slice(0, 500000);
    return { snapshot: snap, htmlSize: document.documentElement.outerHTML.length, savedHtmlPreview: html.slice(0, 2000) };
  }

  // auto re-scan on SPA navigation / dynamic content (debounced)
  let debounce = null;
  const observer = new MutationObserver(() => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (badgesVisible && lastSnapshot) { scanV2(); }
      else { /* keep lastSnapshot stale, rescan on demand */ }
    }, 1200);
  });
  try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}

  // expose API for sidepanel + actor
  window.AutoRepPerception = {
    scan: scanV2,
    understand: () => understandPage(),
    toggleBadges,
    clearBadges,
    saveSnapshot,
    getLast: () => lastSnapshot,
    getElementById: (id) => (window.__autoRepRefs || {})[id] || null
  };

  // listen for messages from sidepanel
  chrome.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'AUTOREP_SCAN') sendResponse({ ok: true, snapshot: scanV2() });
    if (msg.type === 'AUTOREP_UNDERSTAND') sendResponse({ ok: true, page: understandPage(), snapshot: lastSnapshot || scanV2() });
    if (msg.type === 'AUTOREP_TOGGLE_BADGES') sendResponse({ ok: true, visible: toggleBadges(msg.show) });
    if (msg.type === 'AUTOREP_SAVE') sendResponse({ ok: true, ...saveSnapshot() });
    return true;
  });

  console.log('%c[AutoRep] perception loaded - top notch eyes ON', 'color:#7c3aed;font-weight:bold');
})();
