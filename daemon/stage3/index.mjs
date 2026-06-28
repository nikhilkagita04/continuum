// Stage 3 — hybrid index (the firehose tier). Every episode is searchable cheaply by
// fusing four signals: semantic (vector), lexical (BM25), recency, and salience.
import { terms, cosine, normalizeField } from '../util.mjs';

const K1 = 1.5, B = 0.75;

// Query routing: "what did I JUST install / the LATEST version / what was published TODAY" are
// recency-sensitive — among many near-duplicate episodes (terminal commands, version bumps), the
// answer is the most RECENT match, not the most semantically central. Route those to recency-weighted
// fusion; everything else uses RRF (best for general relevance). Surfaced by the validated eval.
const RECENCY_Q = /\b(just|recently|latest|last|current(ly)?|now|today|tonight|this (week|morning|afternoon|evening)|most recent|earlier|previous)\b/i;
export function routeSearch(query) {
  return RECENCY_Q.test(query || '')
    ? { fusion: 'weighted', weights: { vec: 0.35, kw: 0.3, rec: 0.3, sal: 0.05 } }
    : { fusion: 'rrf' };
}

export class HybridIndex {
  constructor({ embed, recencyHalfLifeMs = 7 * 864e5 } = {}) {
    this.embed = embed;              // async (text) -> number[]  (optional; vector signal off if absent)
    this.half = recencyHalfLifeMs;
    this.docs = [];
    this.df = new Map();             // term -> document frequency
    this.totalLen = 0;
  }

  async add(ep) {
    const toks = terms(ep.text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.totalLen += toks.length;
    this.docs.push({
      ep, tf, len: toks.length,
      vec: this.embed ? await this.embed(ep.text) : null,
      ts: ep.end ?? ep.start ?? 0,
      salience: ep.salience ?? 0.5,
    });
  }

  _bm25(qTerms, d) {
    const N = this.docs.length || 1;
    const avgdl = this.totalLen / N || 1;
    let s = 0;
    for (const t of qTerms) {
      const f = d.tf.get(t); if (!f) continue;
      const idf = Math.log(1 + (N - (this.df.get(t) || 0) + 0.5) / ((this.df.get(t) || 0) + 0.5));
      s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / avgdl));
    }
    return s;
  }

  async search(query, { k = 5, now = 0, weights = { vec: 0.5, kw: 0.3, rec: 0.1, sal: 0.1 }, fusion = 'rrf', rerank = false, reranker = null, pool = 50 } = {}) {
    if (!this.docs.length) return [];
    const qv = this.embed ? await this.embed(query) : null;
    const qt = terms(query);
    const nowMs = now || this.docs.reduce((m, d) => Math.max(m, d.ts), 0);
    const scored = this.docs.map((d) => ({
      ep: d.ep,
      vec: qv && d.vec ? cosine(qv, d.vec) : 0,
      kw: this._bm25(qt, d),
      rec: Math.pow(0.5, Math.max(0, nowMs - d.ts) / this.half),
      sal: d.salience,
    }));
    if (fusion === 'rrf') {
      // Reciprocal Rank Fusion of the lexical + semantic rankings (Glean-style) — robust to the two
      // signals being on different scales; recency/salience kept as light tie-breaking bonuses.
      const ranksOf = (f) => { const order = scored.map((_, i) => i).sort((a, b) => scored[b][f] - scored[a][f]); const r = new Array(scored.length); order.forEach((i, rank) => { r[i] = rank; }); return r; };
      const rv = ranksOf('vec'), rk = ranksOf('kw'), rr = ranksOf('rec'), rs = ranksOf('sal'); const C = 60;
      // recency + salience join as LIGHT rank contributions (0.25×) — on the same 1/(C+rank) scale as
      // the relevance signals, so they tie-break without overpowering semantic/lexical relevance.
      for (let i = 0; i < scored.length; i++) scored[i].score = 1 / (C + rv[i]) + 1 / (C + rk[i]) + 0.25 / (C + rr[i]) + 0.25 / (C + rs[i]);
    } else {
      normalizeField(scored, 'vec');   // cosine is already 0..1-ish but normalize for fair fusion
      normalizeField(scored, 'kw');    // BM25 is unbounded → must normalize
      for (const s of scored) s.score = weights.vec * s.vec + weights.kw * s.kw + weights.rec * s.rec + weights.sal * s.sal;
    }
    scored.sort((a, b) => b.score - a.score);
    if (reranker) {                                   // SEMANTIC cross-encoder reorders the widened pool
      try {
        const top = scored.slice(0, pool);
        const ce = await reranker(query, top.map((s) => s.ep.text || ''));
        top.forEach((s, i) => { s.ce = ce[i] ?? -Infinity; });
        top.sort((a, b) => b.ce - a.ce);
        return top.slice(0, k);
      } catch { /* reranker unavailable (model load/network) → degrade to first-stage, never break search */ }
    }
    return rerank ? this._rerank(query, scored.slice(0, pool), k) : scored.slice(0, k);   // pure-JS fallback
  }

  // Pure-JS reranker over the cheap-fusion top-`pool` (no model, no dependency — keeps zero-install).
  // Re-scores with signals RRF under-weights — query-term COVERAGE, exact PHRASE (bigram) overlap, and
  // term PROXIMITY — then MMR-selects the final k to drop near-duplicate capture frames (the dominant
  // failure on a noisy screen corpus). Stays within the latency budget; lifts recall before any neural
  // cross-encoder is added.
  _rerank(query, cand, k) {
    const qt = terms(query); if (!qt.length || !cand.length) return cand.slice(0, k);
    const qset = new Set(qt), qbg = bigramSet(qt);
    const maxBase = Math.max(...cand.map((c) => c.score), 1e-9);
    for (const c of cand) {
      const dt = terms(c.ep.text), dset = new Set(dt);
      const coverage = qt.filter((t) => dset.has(t)).length / qt.length;       // distinct query terms present
      const dbg = bigramSet(dt);
      const phrase = qbg.size ? [...qbg].filter((b) => dbg.has(b)).length / qbg.size : 0;   // exact phrase overlap
      const pos = []; dt.forEach((t, i) => { if (qset.has(t)) pos.push(i); });   // proximity of matched terms
      const prox = pos.length > 1 ? pos.length / (pos[pos.length - 1] - pos[0] + 1) : (pos.length ? 0.5 : 0);
      c.rr = c.score / maxBase + 0.6 * coverage + 0.5 * phrase + 0.3 * prox;
      c._t = dset;
    }
    cand.sort((a, b) => b.rr - a.rr);
    const out = [];
    while (out.length < k && cand.length) {                                     // MMR: penalize near-duplicates
      let best = -Infinity, bi = 0;
      for (let i = 0; i < cand.length; i++) {
        let sim = 0;
        for (const o of out) { const inter = [...cand[i]._t].filter((t) => o._t.has(t)).length; const uni = new Set([...cand[i]._t, ...o._t]).size || 1; sim = Math.max(sim, inter / uni); }
        const mmr = cand[i].rr - 0.5 * sim;
        if (mmr > best) { best = mmr; bi = i; }
      }
      out.push(cand.splice(bi, 1)[0]);
    }
    return out;
  }
}

const bigramSet = (toks) => { const s = new Set(); for (let i = 0; i + 1 < toks.length; i++) s.add(toks[i] + ' ' + toks[i + 1]); return s; };
