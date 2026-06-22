// Shared math/text helpers for the pipeline.
export const terms = (s) => ((s || '').toLowerCase().match(/[a-z0-9]+/g) || []);

export function cosine(a, b) {
  if (!a || !b || !a.length || !b.length) return 0;
  let d = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  for (let i = 0; i < a.length; i++) na += a[i] * a[i];
  for (let i = 0; i < b.length; i++) nb += b[i] * b[i];
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

export function mean(vecs) {
  if (!vecs.length) return [];
  const d = vecs[0].length, out = new Array(d).fill(0);
  for (const v of vecs) for (let i = 0; i < d; i++) out[i] += v[i];
  for (let i = 0; i < d; i++) out[i] /= vecs.length;
  return out;
}

// normalize a numeric field across an array of objects to 0..1 (min-max)
export function normalizeField(arr, key) {
  let lo = Infinity, hi = -Infinity;
  for (const o of arr) { if (o[key] < lo) lo = o[key]; if (o[key] > hi) hi = o[key]; }
  const span = hi - lo;
  for (const o of arr) o[key] = span > 1e-12 ? (o[key] - lo) / span : 0;
}
