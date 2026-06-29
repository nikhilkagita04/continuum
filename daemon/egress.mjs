// egress.mjs — THE single egress chokepoint. EVERY outbound network call from the daemon runtime goes
// through egressFetch(): a fail-closed endpoint allowlist + an append-only audit of what left the
// machine. This is the PRIMARY trust control, statically enforced by egress-conformance.test.mjs — no
// other runtime module may touch the network. "Verify us, not trust us." (Redaction lives elsewhere as
// defense-in-depth and is NEVER the boundary; the boundary is this allowlist + the import ban.)
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';   // read lazily (call-time) — avoids the config↔adapters↔egress init cycle

// Default allowed egress hosts: the model/embedder/graph providers + on-device (Ollama / local graph).
// A user-configured custom base extends this at runtime via allowHost().
const DEFAULT_HOSTS = new Set([
  'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com',
  'localhost', '127.0.0.1',
]);
const extraHosts = new Set();
export function allowHost(h) { if (h) extraHosts.add(h); }            // register a user-configured base
export const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

// Append-only audit of what left the machine (host · bytes · purpose). Best-effort foundation; the
// hash-chained, externally-anchored ledger is a possible future hardening.
function ledger(entry) {
  try { fs.appendFileSync(path.join(DATA_DIR, 'egress-ledger.ndjson'), JSON.stringify({ t: Date.now(), ...entry }) + '\n'); } catch { /* best-effort */ }
}

// Fail-closed network primitive: an unknown host is BLOCKED (throws) and ledgered, never called. Drop-in
// for fetch(url, opts).
export async function egressFetch(url, opts = {}) {
  const host = hostOf(url);
  if (!host || (!DEFAULT_HOSTS.has(host) && !extraHosts.has(host))) {
    ledger({ host, url: String(url).slice(0, 120), bytes: 0, blocked: true });
    throw new Error(`egress blocked: "${host || url}" is not an allowed endpoint (configure it, or it never leaves)`);
  }
  ledger({ host, bytes: opts.body ? String(opts.body).length : 0 });
  return fetch(url, opts);
}

// ---------- the network clients (moved here verbatim from adapters.mjs; only fetch→egressFetch) ----------

// FREE / private: a real local embedding model via Ollama (no key, nothing leaves device).
export function ollamaEmbedder({ model = 'nomic-embed-text', base = 'http://localhost:11434' } = {}) {
  allowHost(hostOf(base));
  return async (text) => {
    const r = await egressFetch(base + '/api/embeddings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });
    const j = await r.json();
    return j.embedding;
  };
}

// PAID / quality: OpenAI embeddings (Anthropic has no embeddings API).
export function openaiEmbedder({ apiKey, model = 'text-embedding-3-small', base = 'https://api.openai.com/v1' }) {
  allowHost(hostOf(base));
  return async (text) => {
    const r = await egressFetch(base + '/embeddings', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    });
    const j = await r.json();
    return j.data[0].embedding;
  };
}

// Advanced/escape-hatch: any OpenAI-compatible endpoint (self-host or another provider).
export function apiEmbedder({ apiKey, base, model }) {
  allowHost(hostOf(base));
  return async (text) => {
    const r = await egressFetch(base + '/embeddings', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    });
    const j = await r.json();
    return j.data[0].embedding;
  };
}

// LLM: async (system, user, maxTokens) -> string.
export function llmClient({ provider = 'openai', apiKey, model, base }) {
  if (base) allowHost(hostOf(base));
  return async (system, user, maxTokens = 400) => {
    if (provider === 'anthropic') {
      const r = await egressFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: model || 'claude-sonnet-4-6', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      });
      const j = await r.json();
      return j.content?.[0]?.text ?? '';
    }
    const r = await egressFetch((base || 'https://api.openai.com/v1') + '/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || 'gpt-4o-mini', max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const j = await r.json();
    return j.choices?.[0]?.message?.content ?? '';
  };
}

// PAID / quality, eval-grade JUDGE: Google Gemini via its OpenAI-compatible endpoint. reasoning_effort:'none'
// (Gemini 2.5 "thinks" by default, spending the whole budget on hidden reasoning + returning empty at small
// budgets); minIntervalMs paces under the free-tier 20 req/min cap; honors the server's retry-in hint on 429.
export function geminiLLM({ apiKey, model = 'gemini-2.5-flash', base = 'https://generativelanguage.googleapis.com/v1beta/openai', retries = 5, minIntervalMs = 3600 } = {}) {
  allowHost(hostOf(base));
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let nextAt = 0;
  return async (system, user, maxTokens = 400) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const wait = nextAt - Date.now(); if (wait > 0) await sleep(wait);
      nextAt = Date.now() + minIntervalMs;
      const r = await egressFetch(base + '/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, reasoning_effort: 'none', messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (r.status === 429 || r.status >= 500) {
        if (attempt >= retries) return '';
        const t = await r.text().catch(() => '');
        const m = /retry in ([\d.]+)s/i.exec(t);
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

// FREE / private: local LLM via Ollama (summaries on-device).
export function ollamaLLM({ model = 'llama3.1', base = 'http://localhost:11434' } = {}) {
  allowHost(hostOf(base));
  return async (system, user, _maxTokens) => {
    const r = await egressFetch(base + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const j = await r.json();
    return j.message?.content ?? '';
  };
}

// graph: { add, search } over the (optional) graphiti sidecar.
export function graphClient(url = 'http://localhost:8000') {
  allowHost(hostOf(url));
  const post = (p, b) => egressFetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  return {
    add: (text, group = 'default', date) => post('/add', { text, name: 'rollup', group_id: group, date }),
    search: (query, group = 'default', k = 6) => post('/search', { query, group_id: group, k }),
  };
}
