// One-time cleanup of an already-polluted store. The streaming fix (segmenter progressive-typing
// coalesce) keeps NEW captures clean; this salvages OLD ones — and deletes what's beyond saving.
//
// Progressive-typing garble accumulates at the FRONT (short keystroke prefixes) and the clean final
// version sits at the END. So we keep the longest clean tail; if even that is hopeless, we drop the
// episode (the user would rather have clean memory than padded memory). Always backs up first.
import fs from 'node:fs';
import { loadEpisodes, STORE_FILE } from './store.mjs';
import { contentHash } from './stage2/segmenter.mjs';
import { stripChrome } from './stage1/chrome.mjs';

const toks = (t) => (t || '').toLowerCase().match(/[a-z0-9]+/g) || [];
export const uniqRatio = (t) => { const w = toks(t); return w.length ? new Set(w).size / w.length : 1; };

// Longest contiguous clean tail: grow a suffix from the end while its unique-token ratio stays high;
// stop once it dips into the repetitive garble at the front. O(n).
export function cleanTail(text, { tailUniq = 0.8, minTokens = 5 } = {}) {
  const w = (text || '').split(/\s+/).filter(Boolean);
  if (w.length < minTokens) return null;
  const counts = new Map(); let total = 0, uniq = 0, bestStart = w.length, established = false;
  for (let i = w.length - 1; i >= 0; i--) {
    for (const t of (w[i].toLowerCase().match(/[a-z0-9]+/g) || [])) { total++; const c = counts.get(t) || 0; if (c === 0) uniq++; counts.set(t, c + 1); }
    const r = total ? uniq / total : 1;
    if (r >= tailUniq) { bestStart = i; established = true; }
    else if (established) break;                 // garble begins here — stop extending into it
  }
  return (w.length - bestStart) >= minTokens ? w.slice(bestStart).join(' ') : null;
}

// Classify + clean one episode's text: keep (clean enough), cleaned (salvaged tail), or delete.
export function cleanText(text, { keepUniq = 0.6, tailUniq = 0.8, minTokens = 5 } = {}) {
  if (toks(text).length < 12 || uniqRatio(text) >= keepUniq) return { action: 'keep', text };
  const salvaged = cleanTail(text, { tailUniq, minTokens });
  if (salvaged && uniqRatio(salvaged) >= keepUniq) return { action: 'cleaned', text: salvaged };
  return { action: 'delete', text: null };
}

// Sweep the whole store. Read-only unless apply=true (which backs up to .bak first).
export function cleanStore({ apply = false, opts = {} } = {}) {
  const eps = loadEpisodes();
  const out = [];
  const s = { total: eps.length, kept: 0, cleaned: 0, deleted: 0, tokBefore: 0, tokAfter: 0, uBefore: 0, uAfter: 0, nB: 0, nA: 0, samples: [] };
  for (const e of eps) {
    const n = toks(e.text).length; s.tokBefore += n;
    if (n >= 20) { s.uBefore += uniqRatio(e.text); s.nB++; }
    const r = cleanText(e.text, opts);
    if (r.action === 'delete') { s.deleted++; if (s.samples.length < 5) s.samples.push({ act: 'delete', app: e.app, was: (e.text || '').replace(/\s+/g, ' ').slice(0, 70) }); continue; }
    const text = stripChrome(r.action === 'cleaned' ? r.text : e.text, e.app);   // also drop browser chrome
    const ep = text !== e.text ? { ...e, text, content_hash: contentHash(text) } : e;
    if (text !== e.text) { s.cleaned++; if (s.samples.length < 5) s.samples.push({ act: 'cleaned', app: e.app, was: (e.text || '').replace(/\s+/g, ' ').slice(0, 50), now: text.replace(/\s+/g, ' ').slice(0, 50) }); }
    else s.kept++;
    const m = toks(ep.text).length; s.tokAfter += m;
    if (m >= 20) { s.uAfter += uniqRatio(ep.text); s.nA++; }
    out.push(ep);
  }
  s.uniqBefore = s.nB ? s.uBefore / s.nB : 1;
  s.uniqAfter = s.nA ? s.uAfter / s.nA : 1;
  if (apply) {
    fs.copyFileSync(STORE_FILE, STORE_FILE + '.bak');
    fs.writeFileSync(STORE_FILE, out.map((e) => JSON.stringify(e)).join('\n') + (out.length ? '\n' : ''));
    s.backup = STORE_FILE + '.bak';
  }
  return s;
}

export function formatClean(s, applied) {
  const L = [
    `continuum clean — ${applied ? 'APPLIED' : 'preview (dry run)'}\n`,
    `  episodes        ${s.total} → ${s.kept + s.cleaned}   (kept ${s.kept}, cleaned ${s.cleaned}, deleted ${s.deleted})`,
    `  unique-token    ${s.uniqBefore.toFixed(2)} → ${s.uniqAfter.toFixed(2)}   (target ~0.85+)`,
    `  stored tokens   ${s.tokBefore} → ${s.tokAfter}   (${Math.round(100 * (1 - s.tokAfter / (s.tokBefore || 1)))}% smaller)`,
  ];
  if (s.samples.length) { L.push('\n  examples:'); for (const x of s.samples) L.push(x.act === 'delete' ? `   ✗ delete [${x.app}] "${x.was}…"` : `   ✓ clean  [${x.app}] "${x.was}…" → "${x.now}…"`); }
  L.push(applied ? `\n  backup: ${s.backup}` : '\n  re-run with --apply to write (backs up episodes.ndjson → .bak first).');
  return L.join('\n');
}
