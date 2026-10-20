/* AutoRep AI Provider - 100% AGNOSTIC BYOK
 * Supports: OpenAI, Gemini, Anthropic, Groq, Ollama, OpenRouter, any OpenAI-compatible
 * All normalize to: { action: click|type|scroll|extract|done, id, text, direction, reason }
 */

const AutoRepAI = (() => {
  async function getConfig() {
    const s = await chrome.storage.local.get(['provider', 'apiKey', 'model', 'baseURL']);
    return {
      provider: s.provider || 'openai',
      apiKey: s.apiKey || '',
      model: s.model || 'gpt-4o-mini',
      baseURL: s.baseURL || ''
    };
  }

  function defaultBaseURL(provider) {
    if (provider === 'openai') return 'https://api.openai.com/v1';
    if (provider === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta/openai';
    if (provider === 'anthropic') return 'https://api.anthropic.com/v1';
    if (provider === 'groq') return 'https://api.groq.com/openai/v1';
    if (provider === 'openrouter') return 'https://openrouter.ai/api/v1';
    if (provider === 'ollama') return 'http://localhost:11434/v1';
    return '';
  }

  function systemPrompt() {
    return `You are AutoRep universal web agent. YOU are the brain that understands the page - no hardcoded rules.
You get RAW FACTS: domain, urlPath, urlQuery, title, headings, mainText, forms, prices, videos, products + ELEMENTS.
YOU infer: what site is this? (youtube, google, amazon, gmail, etc from domain) What page is this? (home, search results, product, checkout, login, inbox...) What is user's intent steps?

TASK may be multi-step. Do ONE action now, loop calls you again.
Return ONLY JSON: {"action":"click|type|scroll|extract|done","id":number,"text":"type text","direction":"down|up","reason":"I see [domain+page] + TASK needs X so I do Y"}

How to think (use domain + URL structure like you said):
- domain=youtube.com + path=/ + loneInputs search => video home, need type+submit
- domain=youtube.com + path=/results + query search_query => results, need click video
- domain=google.* + path=/search => search results, pick link
- domain=amazon.*/flipkart.* + prices present => ecommerce, extract or add to cart
- path contains /login/signin/auth + password field => auth, fill + submit
- path contains /checkout/cart/payment => careful, pause for human on pay
- YOU decide, pageHint is weak suggestion you may IGNORE. Trust domain+URL+content more.
- NEVER invent id. NEVER type without text. If no match, scroll/extract for more context.`;
  }

  async function plan(task, snapshot) {
    const cfg = await getConfig();
    if (!cfg.apiKey && cfg.provider !== 'ollama') throw new Error('No API key set. Add in settings.');
    const base = (cfg.baseURL || defaultBaseURL(cfg.provider)).replace(/\/$/, '');

    const elementsCompact = snapshot.elements.map(e => ({ id: e.id, role: e.role, name: e.name, tag: e.tag })).slice(0, 80);
    const pageCtx = snapshot.page || {};
    const pageCompact = {
      domain: pageCtx.domain || '',
      urlPath: pageCtx.urlPath || '',
      urlQuery: pageCtx.urlQuery || '',
      title: snapshot.title || '',
      hint: pageCtx.pageHint || '',
      summary: pageCtx.summary || '',
      headings: (pageCtx.headings || []).slice(0, 8),
      nav: (pageCtx.navLinks || []).slice(0, 6),
      forms: pageCtx.forms || [],
      loneInputs: pageCtx.loneInputs || [],
      prices: (pageCtx.prices || []).slice(0, 5),
      videos: (pageCtx.videos || []).slice(0, 4),
      products: (pageCtx.products || []).slice(0, 4),
      mainText: (pageCtx.mainText || '').slice(0, 1200),
      needsHuman: pageCtx.needsHuman || false
    };

    const body = {
      model: cfg.model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: `TASK: ${task}\nURL: ${snapshot.url}\nTITLE: ${snapshot.title}\nPAGE: ${JSON.stringify(pageCompact)}\nELEMENTS: ${JSON.stringify(elementsCompact)}` }
      ]
    };

    // Gemini native OpenAI-compat uses same /chat/completions
    const url = base + '/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.provider === 'anthropic') {
      // Anthropic via OpenAI-compat not standard - use simple proxy note: user should use OpenRouter for Anthropic
      headers['x-api-key'] = cfg.apiKey;
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else {
      headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    }
    if (cfg.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://autorep.local';
      headers['X-Title'] = 'AutoRep';
    }

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`AI error ${res.status}: ${t.slice(0, 400)}`);
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    try {
      const json = JSON.parse(content.match(/\{[\s\S]*\}/)[0]);
      return json;
    } catch (e) {
      throw new Error('AI returned bad JSON: ' + content.slice(0, 300));
    }
  }

  return { getConfig, plan, defaultBaseURL };
})();
