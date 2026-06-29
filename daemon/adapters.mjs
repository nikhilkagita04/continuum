// Adapters — the seams where the pure pipeline meets the outside world. The NETWORK clients now live in
// egress.mjs (the single audited egress chokepoint, allowlisted + fail-closed); they are re-exported here
// so existing imports keep working. This module itself makes NO network calls — only the zero-network
// primitives (local hashed embedder + deterministic mocks) live here.

// ---------- embedders: async (text) -> number[] ----------

// Deterministic local embedder (hashed bag-of-words, L2-normalized). No deps, no network — used for
// tests and as the cheap on-device default.
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

// The network clients (embedders, LLMs, graph) live behind the egress chokepoint. Re-exported for
// back-compat: every call they make is allowlisted + audited in egress.mjs.
export { ollamaEmbedder, openaiEmbedder, apiEmbedder, llmClient, geminiLLM, ollamaLLM, graphClient } from './egress.mjs';

// ---------- deterministic mocks (no network) — for tests ----------

export const mockLLM = async (_system, user) =>
  `summary: ${(user.match(/[a-z]{4,}/gi) || []).slice(0, 6).join(' ')}`;

export function mockGraph() {
  const calls = [];
  return { calls, add: async (text) => { calls.push(text); return { ok: true }; }, search: async () => ({ results: [] }) };
}
