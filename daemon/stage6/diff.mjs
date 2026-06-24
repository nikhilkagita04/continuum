// Stage 6 — temporal scene diffing (#12). Consecutive captures of the same surface (scroll, edit)
// shouldn't become N fragmented episodes. Stitch overlapping snapshots into one continuous text,
// and diff consecutive scenes so "what changed" is itself a signal. Pure, no I/O.

// Largest k such that the last k of `prev` equals the first k of `next` (the scrolled-through overlap).
export function overlapLen(prev, next) {
  const max = Math.min(prev.length, next.length);
  for (let k = max; k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) if (prev[prev.length - k + i] !== next[i]) { match = false; break; }
    if (match) return k;
  }
  return 0;
}

// Merge two consecutive line arrays, dropping the duplicated overlap region.
export function stitchLines(prev, next) {
  return prev.concat(next.slice(overlapLen(prev, next)));
}

// Stitch two consecutive OCR/scene texts of the same surface into one continuous text.
export function stitchScroll(prevText, nextText) {
  const norm = (s) => (s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  return stitchLines(norm(prevText), norm(nextText)).join('\n');
}

// Diff two scene-graph snapshots (region arrays) by a stable content key → what appeared / left / stayed.
const regionKey = (r) => `${r.type || ''}|${(r.text || '').slice(0, 80)}`;
export function diffScenes(prev = [], next = []) {
  const pm = new Map(prev.map((r) => [regionKey(r), r]));
  const nm = new Map(next.map((r) => [regionKey(r), r]));
  const added = [], removed = [], kept = [];
  for (const [k, r] of nm) (pm.has(k) ? kept : added).push(r);
  for (const [k, r] of pm) if (!nm.has(k)) removed.push(r);
  return { added, removed, kept, changed: added.length + removed.length };
}
