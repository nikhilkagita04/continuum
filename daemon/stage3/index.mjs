// Stage 3 — hybrid index (the firehose tier). Every episode is searchable cheaply by
// fusing four signals: semantic (vector), lexical (BM25), recency, and salience.
import { terms, cosine, normalizeField } from '../util.mjs';

const K1 = 1.5, B = 0.75;

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

  async search(query, { k = 5, now = 0, weights = { vec: 0.5, kw: 0.3, rec: 0.1, sal: 0.1 } } = {}) {
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
    normalizeField(scored, 'vec');   // cosine is already 0..1-ish but normalize for fair fusion
    normalizeField(scored, 'kw');    // BM25 is unbounded → must normalize
    for (const s of scored) s.score = weights.vec * s.vec + weights.kw * s.kw + weights.rec * s.rec + weights.sal * s.sal;
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
