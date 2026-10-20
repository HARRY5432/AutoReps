/* AutoRep Perception Engine v0.2 - structured page intelligence
 * We do not send literal outerHTML to the model. Instead we produce bounded,
 * structured facts: site identity, page structure, content signals, and an
 * actionable control inventory. Numeric ids are scoped to one snapshot.
 */
(function () {
  if (window.__autoRepPerceptionLoaded) return;
  window.__autoRepPerceptionLoaded = true;

  const BADGE_CONTAINER_ID = '__autorep-badges';
  const SNAPSHOT_SCHEMA = 'autorep.page-intelligence.v1';
  const CONTROL_LIMIT = 250;
  const TEXT_PREVIEW_LIMIT = 3500;
  const HEADING_LIMIT = 20;
  const FORM_LIMIT = 12;
  const TABLE_LIMIT = 8;
  const OPTION_LIMIT = 40;
  let lastSnapshot = null;
  let badgesVisible = false;
  let currentSnapshotId = null;
  const snapshotRegistry = new Map();

  const JUNK_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'SVG', 'PATH', 'SOURCE']);
  const KEEP_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);

  function makeSnapshotId() {
    try {
      if (crypto.randomUUID) return 's_' + crypto.randomUUID();
    } catch (e) {}
    return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function normalizeText(value, limit = 160) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function hasHiddenAncestor(el) {
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.inert) return true;
      current = current.parentElement || current.getRootNode?.().host || null;
    }
    return false;
  }

  function isVisible(el) {
    try {
      if (hasHiddenAncestor(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = (el.ownerDocument?.defaultView || window).getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') return false;
      // off-screen far away still keep if scrollable page (for scroll action), but deprioritize
      return true;
    } catch (e) {
      return false;
    }
  }

  function getName(el) {
    // priority: aria-label > innerText > value > placeholder > title > alt > id
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().slice(0, 120);
    let text = el.tagName === 'SELECT' ? '' : (el.innerText || '').replace(/\s+/g, ' ').trim();
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
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (['submit', 'button', 'reset', 'file'].includes(t)) return 'button';
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
    if (el.closest?.('#' + BADGE_CONTAINER_ID)) return false;
    if (KEEP_TAGS.has(tag)) return true;
    if (el.isContentEditable) return true;
    if (el.hasAttribute) {
      if (el.hasAttribute('onclick') || el.hasAttribute('role') || el.hasAttribute('tabindex') || el.hasAttribute('jsaction')) return true;
      const cursor = window.getComputedStyle(el).cursor;
      if (cursor === 'pointer' && (el.tagName === 'DIV' || el.tagName === 'SPAN')) return true;
    }
    return false;
  }

  // Recursive walker that records whether a control came from open Shadow DOM.
  function* walk(root, meta = {}) {
    const ownerDocument = root.ownerDocument || document;
    const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let node = walker.currentNode;
    if (node && node.tagName) yield { el: node, ...meta };
    while ((node = walker.nextNode())) {
      yield { el: node, ...meta };
      if (node.shadowRoot) {
        yield* walk(node.shadowRoot, { ...meta, inShadowRoot: true });
      }
    }
  }

  function getFormId(form, formIds) {
    if (!form) return null;
    if (!formIds.has(form)) formIds.set(form, 'form-' + (formIds.size + 1));
    return formIds.get(form);
  }

  function getState(el) {
    const type = String(el.type || '').toLowerCase();
    const ariaChecked = el.getAttribute?.('aria-checked');
    const ariaExpanded = el.getAttribute?.('aria-expanded');
    const ariaPressed = el.getAttribute?.('aria-pressed');
    const ariaSelected = el.getAttribute?.('aria-selected');
    const checked = ['checkbox', 'radio'].includes(type) || getRole(el) === 'checkbox' || getRole(el) === 'radio'
      ? (ariaChecked === 'true' ? true : ariaChecked === 'false' ? false : !!el.checked)
      : null;
    return {
      disabled: !!el.disabled || el.getAttribute?.('aria-disabled') === 'true',
      readonly: !!el.readOnly || el.getAttribute?.('aria-readonly') === 'true',
      required: !!el.required || el.getAttribute?.('aria-required') === 'true',
      checked,
      selected: ariaSelected === 'true' ? true : ariaSelected === 'false' ? false : null,
      expanded: ariaExpanded === 'true' ? true : ariaExpanded === 'false' ? false : null,
      pressed: ariaPressed === 'true' ? true : ariaPressed === 'false' ? false : null
    };
  }

  function getCapabilities(el, state) {
    const role = getRole(el);
    const tag = el.tagName.toLowerCase();
    const type = String(el.type || '').toLowerCase();
    const capabilities = [];
    const reasons = [];

    if (state.disabled) reasons.push('disabled');
    if (state.readonly && ['textbox', 'combobox'].includes(role)) reasons.push('readonly');

    if (type === 'file') reasons.push('file-upload-not-supported');
    else if (['button', 'link', 'summary', 'checkbox', 'radio'].includes(role)) capabilities.push('click');
    else if (el.isContentEditable) capabilities.push('type', 'pressEnter');
    else if (role === 'textbox' && !['file'].includes(type)) capabilities.push('type', 'pressEnter');
    else if (role === 'combobox' && tag === 'select' && !el.multiple) capabilities.push('selectOption');
    else if (role === 'combobox' && tag === 'select' && el.multiple) reasons.push('multi-select-not-supported');
    else if (role === 'combobox') reasons.push('custom-combobox-not-supported');
    else if (el.hasAttribute?.('onclick') || el.getAttribute?.('tabindex') !== null) capabilities.push('click');
    else reasons.push('unsupported-control');

    if (state.readonly && capabilities.includes('type')) {
      return { capabilities: capabilities.filter(cap => cap !== 'type' && cap !== 'pressEnter'), reasons };
    }
    return { capabilities, reasons };
  }

  function getSafeValue(el) {
    const type = String(el.type || '').toLowerCase();
    if (['password', 'file'].includes(type)) return null;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return null;
    return normalizeText(el.value, 100);
  }

  function getOptions(el) {
    if (el.tagName !== 'SELECT') return { options: [], optionsTruncated: false };
    const all = Array.from(el.options || []);
    return {
      options: all.slice(0, OPTION_LIMIT).map(option => ({
        label: normalizeText(option.textContent, 120),
        value: normalizeText(option.value, 120),
        selected: !!option.selected,
        disabled: !!option.disabled
      })),
      optionsTruncated: all.length > OPTION_LIMIT
    };
  }

  function getHrefInfo(el) {
    if (el.tagName !== 'A' || !el.href) return null;
    try {
      const target = new URL(el.href, location.href);
      return {
        url: target.href.slice(0, 500),
        sameOrigin: target.origin === location.origin,
        external: target.origin !== location.origin,
        target: el.target || '_self'
      };
    } catch (e) {
      return { url: String(el.href).slice(0, 500), sameOrigin: false, external: true, target: el.target || '_self' };
    }
  }

  function describeControl(entry, id, formIds) {
    const el = entry.el;
    const rect = el.getBoundingClientRect();
    const state = getState(el);
    const { capabilities, reasons } = getCapabilities(el, state);
    const role = getRole(el);
    const type = String(el.type || '').toLowerCase();
    const actionable = capabilities.length > 0 && reasons.length === 0;
    const formId = getFormId(el.form || el.closest?.('form'), formIds);
    const optionInfo = getOptions(el);
    const item = {
      id,
      role,
      tag: el.tagName.toLowerCase(),
      type,
      name: getName(el) || '(no name)',
      state,
      value: getSafeValue(el),
      contentEditable: !!el.isContentEditable,
      options: optionInfo.options,
      optionsTruncated: optionInfo.optionsTruncated,
      capabilities,
      actionable,
      actionabilityReasons: reasons,
      formId,
      framePath: entry.framePath || [],
      inShadowRoot: !!entry.inShadowRoot,
      href: getHrefInfo(el),
      selector: buildSelector(el),
      geometry: {
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        inViewport: rect.top >= 0 && rect.top <= window.innerHeight
      }
    };
    // Compatibility fields for the existing actor and side panel.
    item.checked = state.checked;
    item.disabled = state.disabled;
    item.x = item.geometry.x;
    item.y = item.geometry.y;
    item.inViewport = item.geometry.inViewport;
    return item;
  }

  function collectCandidates() {
    const candidates = [];
    const seen = new Set();
    const addRoot = (root, meta = {}) => {
      for (const entry of walk(root, meta)) {
        const el = entry.el;
        if (!isInteractive(el) || !isVisible(el) || seen.has(el)) continue;
        seen.add(el);
        candidates.push(entry);
      }
    };

    addRoot(document.body || document.documentElement, { framePath: [], inShadowRoot: false });

    const inaccessibleFrames = [];
    Array.from(document.querySelectorAll('iframe')).forEach((frame, index) => {
      try {
        if (frame.contentDocument?.body) {
          addRoot(frame.contentDocument.body, { framePath: [index], inShadowRoot: false });
        } else {
          inaccessibleFrames.push({ index, src: normalizeText(frame.src, 300) });
        }
      } catch (e) {
        inaccessibleFrames.push({ index, src: normalizeText(frame.src, 300) });
      }
    });
    return { candidates, inaccessibleFrames };
  }

  function scanV2() {
    const { candidates, inaccessibleFrames } = collectCandidates();
    const snapshotId = makeSnapshotId();
    const formIds = new Map();
    const ordered = candidates.sort((a, b) => {
      const ra = a.el.getBoundingClientRect();
      const rb = b.el.getBoundingClientRect();
      const aIn = ra.top >= 0 && ra.top <= window.innerHeight;
      const bIn = rb.top >= 0 && rb.top <= window.innerHeight;
      if (aIn !== bIn) return aIn ? -1 : 1;
      return ra.top - rb.top;
    });
    const returned = ordered.slice(0, CONTROL_LIMIT);
    const omittedOverLimit = Math.max(0, ordered.length - returned.length);

    window.__autoRepRefs = {};
    snapshotRegistry.clear();
    const elements = returned.map((entry, index) => {
      const id = index + 1;
      const item = describeControl(entry, id, formIds);
      window.__autoRepRefs[id] = entry.el;
      snapshotRegistry.set(id, { element: entry.el, fingerprint: item, snapshotId });
      return item;
    });
    currentSnapshotId = snapshotId;

    const page = understandPage(elements, { inaccessibleFrames, formIds });
    lastSnapshot = {
      schemaVersion: SNAPSHOT_SCHEMA,
      snapshotId,
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      count: elements.length,
      elements,
      inventory: {
        scope: ['document', 'open-shadow-dom', 'same-origin-iframes'],
        limit: CONTROL_LIMIT,
        candidateCount: ordered.length,
        returnedCount: elements.length,
        actionableCount: elements.filter(item => item.actionable).length,
        truncated: omittedOverLimit > 0,
        omitted: {
          overLimit: omittedOverLimit,
          inaccessibleFrames: inaccessibleFrames.length
        },
        ordering: 'viewport-first-then-document-order'
      },
      page
    };
    if (badgesVisible) renderBadges();
    return lastSnapshot;
  }

  function renderBadgesV2Note() { return true; }

  function understandPage(elements = [], metadata = {}) {
    // Structured page facts are intentionally smaller and safer than outerHTML.
    try {
      const bodyAllText = document.body ? document.body.innerText || '' : '';
      const normalizedBodyText = bodyAllText.replace(/\s+/g, ' ').trim();
      const textPreview = normalizedBodyText.slice(0, TEXT_PREVIEW_LIMIT);
      const urlObj = (() => { try { return new URL(location.href); } catch (e) { return null; } })();
      const domain = urlObj ? urlObj.hostname : location.hostname;
      const urlPath = urlObj ? urlObj.pathname.slice(0, 300) : '';
      const urlQuery = urlObj ? urlObj.search.slice(0, 300) : '';
      const pathSegments = urlPath.split('/').filter(Boolean).slice(0, 20);
      const queryKeys = urlObj ? Array.from(urlObj.searchParams.keys()).slice(0, 20) : [];
      const lowerText = normalizedBodyText.toLowerCase();
      const lowerUrl = location.href.toLowerCase();

      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4'))
        .filter(h => isVisible(h) && normalizeText(h.innerText))
        .slice(0, HEADING_LIMIT)
        .map(h => ({ level: Number(h.tagName.slice(1)), text: normalizeText(h.innerText, 160) }));

      const landmarks = Array.from(document.querySelectorAll('main,nav,header,footer,aside,[role="main"],[role="navigation"],[role="dialog"]'))
        .filter(el => isVisible(el) || el.getAttribute('role') === 'dialog')
        .slice(0, 20)
        .map(el => ({
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          name: normalizeText(el.getAttribute('aria-label') || el.innerText, 100),
          tag: el.tagName.toLowerCase()
        }));

      const navLinks = Array.from(document.querySelectorAll('nav a, header a'))
        .filter(a => isVisible(a) && normalizeText(a.innerText))
        .slice(0, 15)
        .map(a => normalizeText(a.innerText, 80));

      const formsDetailed = Array.from(document.querySelectorAll('form')).slice(0, FORM_LIMIT).map((form, index) => {
        const formId = metadata.formIds?.get(form) || 'form-' + (index + 1);
        const controls = elements.filter(item => item.formId === formId).map(item => item.id);
        const action = form.getAttribute('action') || location.pathname;
        return {
          id: formId,
          name: normalizeText(form.getAttribute('aria-label') || form.name || form.id, 100),
          method: String(form.method || 'get').toLowerCase(),
          actionPath: normalizeText(action, 300),
          controlIds: controls,
          submitControlIds: controls.filter(id => {
            const item = elements.find(control => control.id === id);
            return item && item.role === 'button' && (item.type === 'submit' || item.name.toLowerCase().includes('submit'));
          })
        };
      });

      const tables = Array.from(document.querySelectorAll('table')).slice(0, TABLE_LIMIT).map((table, index) => ({
        index,
        caption: normalizeText(table.querySelector('caption')?.innerText, 120),
        headers: Array.from(table.querySelectorAll('th')).slice(0, 12).map(th => normalizeText(th.innerText, 100)),
        rows: table.querySelectorAll('tr').length
      }));

      const dialogs = Array.from(document.querySelectorAll('dialog,[role="dialog"]')).slice(0, 8).map(dialog => ({
        role: dialog.getAttribute('role') || 'dialog',
        name: normalizeText(dialog.getAttribute('aria-label') || dialog.innerText, 120),
        open: dialog.tagName.toLowerCase() === 'dialog' ? !!dialog.open : isVisible(dialog),
        modal: dialog.getAttribute('aria-modal') === 'true'
      }));

      const loneInputs = elements
        .filter(item => item.role === 'textbox' && !item.formId)
        .slice(0, 10)
        .map(item => `${item.tag}[${item.type || 'text'}] "${item.name}"`);

      const priceMatches = (normalizedBodyText.match(/(₹\s?[\d,]+|\$\s?[\d,.]+|€\s?[\d,.]+|£\s?[\d,.]+)/g) || []).slice(0, 12);
      const videoTitles = Array.from(document.querySelectorAll('a#video-title, ytd-video-renderer a, [class*="video"] a'))
        .map(a => normalizeText(a.innerText, 160)).filter(text => text.length > 5).slice(0, 8);
      const productNames = Array.from(document.querySelectorAll('[data-asin] h2, .s-title, [class*="product"] h2, [class*="card"] h3'))
        .map(h => normalizeText(h.innerText, 160)).filter(text => text.length > 5).slice(0, 8);

      let pageHint = 'generic';
      if (/login|signin|sign-in|auth/.test(lowerUrl) || /sign in|log in|password/.test(lowerText.slice(0, 800))) pageHint = 'maybe-auth';
      else if (/youtube\./.test(domain) || videoTitles.length) pageHint = 'maybe-video';
      else if (/checkout|payment|billing/.test(lowerUrl) || /checkout|payment|card number|cvv/.test(lowerText)) pageHint = 'maybe-checkout';
      else if (/add to cart|buy now|product/.test(lowerText)) pageHint = 'maybe-product';
      else if (formsDetailed.length || elements.some(item => item.role === 'textbox')) pageHint = 'maybe-form';

      const countsByRole = {};
      elements.forEach(item => { countsByRole[item.role] = (countsByRole[item.role] || 0) + 1; });
      const scrollY = Math.round(window.scrollY);
      const pageHeight = document.documentElement?.scrollHeight || document.body?.scrollHeight || 0;
      const viewportHeight = window.innerHeight || 0;
      const signals = {
        prices: priceMatches,
        videoTitles,
        productNames,
        authSignals: /login|signin|sign-in|password|one-time code|otp/.test(lowerUrl + ' ' + lowerText),
        paymentSignals: /payment|checkout|billing|card number|cvv|upi|stripe|razorpay/.test(lowerUrl + ' ' + lowerText),
        captchaSignals: /captcha|verify you are human|are you a robot/.test(lowerText),
        needsHuman: /captcha|otp|one-time code|verify you are human|payment|checkout|card number|cvv|upi|stripe|razorpay/.test(lowerUrl + ' ' + lowerText)
      };

      const counts = {
        controlsByRole: countsByRole,
        visibleControls: elements.filter(item => item.geometry.inViewport).length,
        actionableControls: elements.filter(item => item.actionable).length,
        disabledControls: elements.filter(item => item.state.disabled).length,
        forms: formsDetailed.length,
        tables: tables.length,
        headings: headings.length,
        dialogs: dialogs.length
      };

      const summary = `${document.title || '(untitled)'} on ${domain}${urlPath} | hint=${pageHint} | ` +
        `controls:${elements.length} forms:${formsDetailed.length} headings:${headings.length}` +
        `${priceMatches.length ? ' prices:' + priceMatches.slice(0, 3).join(',') : ''}` +
        `${videoTitles.length ? ' videos:' + videoTitles.slice(0, 2).join(' | ').slice(0, 120) : ''}` +
        `${productNames.length ? ' products:' + productNames.slice(0, 2).join(' | ').slice(0, 120) : ''}`;

      return {
        url: location.href,
        title: document.title,
        domain,
        urlPath,
        urlQuery,
        lang: document.documentElement.lang || 'en',
        pageHint,
        summary,
        site: {
          hostname: domain,
          domain,
          origin: urlObj?.origin || location.origin,
          protocol: urlObj?.protocol || location.protocol
        },
        location: {
          path: urlPath,
          pathSegments,
          queryKeys,
          hashPresent: !!(urlObj?.hash)
        },
        document: {
          title: document.title,
          language: document.documentElement.lang || 'en',
          direction: document.documentElement.dir || 'ltr'
        },
        viewport: {
          width: window.innerWidth,
          height: viewportHeight,
          scrollX: Math.round(window.scrollX),
          scrollY,
          pageWidth: document.documentElement?.scrollWidth || 0,
          pageHeight,
          atTop: scrollY <= 2,
          atBottom: scrollY + viewportHeight >= pageHeight - 2
        },
        headings,
        landmarks,
        navLinks,
        forms: formsDetailed,
        loneInputs,
        tables,
        table: tables[0] || null,
        dialogs,
        contentSignals: signals,
        prices: priceMatches,
        videos: videoTitles,
        products: productNames,
        mainText: textPreview,
        text: {
          preview: textPreview,
          characterCount: normalizedBodyText.length,
          truncated: normalizedBodyText.length > TEXT_PREVIEW_LIMIT
        },
        frames: {
          sameOriginScanned: elements.filter(item => item.framePath.length > 0).length,
          inaccessible: metadata.inaccessibleFrames || []
        },
        counts,
        scrollY,
        pageHeight,
        needsHuman: signals.needsHuman
      };
    } catch (e) {
      return {
        url: location.href,
        title: document.title,
        domain: location.hostname,
        pageHint: 'unknown',
        summary: document.title,
        error: String(e).slice(0, 200)
      };
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
    understand: () => scanV2().page,
    toggleBadges,
    clearBadges,
    saveSnapshot,
    getLast: () => lastSnapshot,
    getSnapshotId: () => currentSnapshotId,
    getRegistryEntry: (id) => snapshotRegistry.get(Number(id)) || null,
    getElementById: (id) => (window.__autoRepRefs || {})[id] || null
  };

  // listen for messages from sidepanel
  chrome.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
    const handled = ['AUTOREP_SCAN', 'AUTOREP_UNDERSTAND', 'AUTOREP_TOGGLE_BADGES', 'AUTOREP_SAVE'].includes(msg.type);
    if (!handled) return false;
    if (msg.type === 'AUTOREP_SCAN') sendResponse({ ok: true, snapshot: scanV2() });
    if (msg.type === 'AUTOREP_UNDERSTAND') {
      const snapshot = scanV2();
      sendResponse({ ok: true, page: snapshot.page, snapshot });
    }
    if (msg.type === 'AUTOREP_TOGGLE_BADGES') sendResponse({ ok: true, visible: toggleBadges(msg.show) });
    if (msg.type === 'AUTOREP_SAVE') sendResponse({ ok: true, ...saveSnapshot() });
    return true;
  });

  console.log('%c[AutoRep] perception loaded - top notch eyes ON', 'color:#7c3aed;font-weight:bold');
})();
