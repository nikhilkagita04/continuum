// Adapters — the seams where the pure pipeline meets the outside world.
// Each has a real implementation and an offline/mock variant so the whole pipeline
// runs and tests with zero network.

// ---------- embedders: async (text) -> number[] ----------

// Deterministic local embedder (hashed bag-of-words, L2-normalized). No deps, no
// network — used for tests and as a cheap on-device fallback.
export function localEmbedder(dim = 256) {
  return async (text) => {
    const v = new Float64Array(dim);
    for (const t of (text || '').toLowerCase().match(/[a-z0-9]+/g) || []) {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      v[h % dim] += 1;
    }
    let n = 0; for (let i = 0; i < dim; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1;
    return Array.from(v, (x) => x / n);
  };
}

// FREE / private: a real local embedding model via Ollama (no key, no network leaves device).
//   prerequisite: `ollama pull nomic-embed-text`
export function ollamaEmbedder({ model = 'nomic-embed-text', base = 'http://localhost:11434' } = {}) {
  return async (text) => {
    const r = await fetch(base + '/api/embeddings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });
    const j = await r.json();
    return j.embedding;
  };
}

// PAID / quality: OpenAI embeddings (cheap — text-embedding-3-small ≈ $0.02 / 1M tokens).
// NOTE: Anthropic has no embeddings API, so the paid embedder is OpenAI (or Voyage/Cohere later).
export function openaiEmbedder({ apiKey, model = 'text-embedding-3-small', base = 'https://api.openai.com/v1' }) {
  return async (text) => {
    const r = await fetch(base + '/embeddings', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    });
    const j = await r.json();
    return j.data[0].embedding;
  };
}

// Advanced/escape-hatch: any OpenAI-compatible endpoint (self-host or another provider).
export function apiEmbedder({ apiKey, base, model }) {
  return async (text) => {
    const r = await fetch(base + '/embeddings', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    });
    const j = await r.json();
    return j.data[0].embedding;
  };
}

// ---------- LLM: async (system, user, maxTokens) -> string ----------

export function llmClient({ provider = 'openai', apiKey, model, base }) {
  return async (system, user, maxTokens = 400) => {
    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: model || 'claude-sonnet-4-6', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      });
      const j = await r.json();
      return j.content?.[0]?.text ?? '';
    }
    const r = await fetch((base || 'https://api.openai.com/v1') + '/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || 'gpt-4o-mini', max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const j = await r.json();
    return j.choices?.[0]?.message?.content ?? '';
  };
}

// PAID / quality, eval-grade JUDGE: Google Gemini via its OpenAI-compatible endpoint.
// The cross-family eval judge (answer ≠ judge family ⇒ no self-preference bias, eval-plan §0.2).
// Gemini 2.5 models "think" by default, silently spending the whole max_tokens budget on hidden
// reasoning and returning EMPTY content at small budgets (a 60-token probe call came back ''
// with completion_tokens:0, finish_reason:length). The judge/probe roles want short deterministic
// verdicts, not chain-of-thought — so we pin reasoning_effort:'none', which makes tiny budgets work.
// minIntervalMs paces requests under the Gemini FREE-TIER cap (20 req/min for gemini-2.5-flash):
// ~3.2s spacing ≈ 18.75/min stays safely under it, so a long eval loop runs slower but never
// collapses to empty verdicts. On a 429 we still honor the API's own "retry in Xs" hint.
export function geminiLLM({ apiKey, model = 'gemini-2.5-flash', base = 'https://generativelanguage.googleapis.com/v1beta/openai', retries = 5, minIntervalMs = 3600 } = {}) {
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let nextAt = 0;   // client-side throttle gate, shared across all calls from this client
  return async (system, user, maxTokens = 400) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const wait = nextAt - Date.now(); if (wait > 0) await sleep(wait);
      nextAt = Date.now() + minIntervalMs;   // reserve the next slot before firing
      const r = await fetch(base + '/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, reasoning_effort: 'none', messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      // Gemini returns errors as a bare array ([{ error: {...} }]); 429 (rate limit) is transient.
      if (r.status === 429 || r.status >= 500) {
        if (attempt >= retries) return '';
        const t = await r.text().catch(() => '');
        const m = /retry in ([\d.]+)s/i.exec(t);   // respect the server's suggested delay when present
        await sleep(m ? Math.ceil(parseFloat(m[1]) * 1000) + 500 : 2000 * 2 ** attempt);
        continue;
      }
      const j = await r.json();
      if (Array.isArray(j)) { if (attempt >= retries) return ''; await sleep(2000 * 2 ** attempt); continue; }
      return j.choices?.[0]?.message?.content ?? '';
    }
    return '';
  };
}

// FREE / private: local LLM via Ollama (summaries on-device). Graph extraction still
// wants a frontier model — local models can't satisfy the strict extraction schemas.
export function ollamaLLM({ model = 'llama3.1', base = 'http://localhost:11434' } = {}) {
  return async (system, user, _maxTokens) => {
    const r = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const j = await r.json();
    return j.message?.content ?? '';
  };
}

// Deterministic mock LLM for tests.
export const mockLLM = async (_system, user) =>
  `summary: ${(user.match(/[a-z]{4,}/gi) || []).slice(0, 6).join(' ')}`;

// ---------- graph: { add(text,group,date), search(q,group,k) } over the graphiti sidecar ----------

export function graphClient(url = 'http://localhost:8000') {
  const post = (p, b) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  return {
    add: (text, group = 'default', date) => post('/add', { text, name: 'rollup', group_id: group, date }),
    search: (query, group = 'default', k = 6) => post('/search', { query, group_id: group, k }),
  };
}

// Mock graph that records calls, for tests.
export function mockGraph() {
  const calls = [];
  return { calls, add: async (text) => { calls.push(text); return { ok: true }; }, search: async () => ({ results: [] }) };
}
