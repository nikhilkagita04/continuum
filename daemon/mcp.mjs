// MCP core logic — transport-free and testable. The stdio server (mcp-server.mjs) is a thin wrapper
// over these. Pure over (index, episodes); no I/O. Design: docs/architecture/mcp.md.
import { redactPII } from './stage2/segmenter.mjs';

const SNIP = 280;
const WORD = /[a-z0-9]+/gi;
const STOP = new Set('the a an and or of to in on for with is are was were be been it this that you your i we they he she my our their from at as by'.split(' '));
export const tokens = (s) => ((s || '').toLowerCase().match(WORD) || []);

// Egress scrub (defense-in-depth for cloud agents): capture-time PII + secret-shaped strings.
const SECRET = /\b(sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]{8,}|gh[ps]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{10,})\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;
export const scrub = (s) => redactPII(String(s || '')).replace(SECRET, '[redacted]');

export function relTime(t, now = Date.now()) {
  if (!t) return 'unknown';
  const s = Math.max(0, (now - t) / 1000);
  const ago = s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
  return `${ago} · ${new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

const ownerOf = (e) => {
  if (e.speaker) return e.speaker === 'you' ? 'you' : 'others';
  if (e.label && e.label.owner) return e.label.owner === 'me' ? 'you' : e.label.owner === 'other' ? 'others' : 'system';
  return (e.source_mix || []).includes('input') ? 'you' : 'system';
};

// Map an episode → the attributed, scrubbed, snippet-capped result schema (with a citation id).
export function mapResult(e, now = Date.now()) {
  return {
    when: relTime(e.end || e.start || 0, now),
    app: e.app || 'Unknown',
    who: ownerOf(e),
    type: (e.label && e.label.type) || 'unknown',
    text: scrub((e.structured && e.structured.summary) || e.text || '').slice(0, SNIP),
    id: e.content_hash ? `ep_${e.content_hash}` : `ep_${e.end || e.start || 0}`,
  };
}

// Parse a time token ("today" | "week" | "month" | "24h" | "7d" | ISO) → ms timestamp (or null).
export function parseSince(token, now = Date.now()) {
  if (token == null) return null;
  const s = String(token).trim().toLowerCase();
  if (s === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (s === 'week') return now - 7 * 864e5;
  if (s === 'month') return now - 30 * 864e5;
  const m = s.match(/^(\d+)\s*([hd])$/);
  if (m) return now - Number(m[1]) * (m[2] === 'h' ? 36e5 : 864e5);
  const iso = Date.parse(token);
  return Number.isNaN(iso) ? null : iso;
}

const keep = (exclude) => { const ex = new Set(exclude || []); return (e) => !ex.has(e.app); };
const tOf = (e) => e.end || e.start || 0;

// recall — semantic search + filters → attributed snippets.
export async function recall(index, episodes, opts = {}) {
  const { query, since, until, apps, sources, k = 5, exclude = [], floor = 0, now = Date.now() } = opts;
  const hits = await index.search(query || '', { k: Math.max(k, 15), now });
  let eps = hits.map((h) => h.ep).filter(keep(exclude));
  const lo = Math.max(parseSince(since, now) || 0, floor || 0), hi = parseSince(until, now);
  if (lo) eps = eps.filter((e) => tOf(e) >= lo);
  if (hi != null) eps = eps.filter((e) => tOf(e) <= hi);
  if (apps && apps.length) { const a = new Set(apps.map((x) => String(x).toLowerCase())); eps = eps.filter((e) => a.has((e.app || '').toLowerCase())); }
  if (sources && sources.length) { const ss = new Set(sources); eps = eps.filter((e) => (e.source_mix || []).some((x) => ss.has(x))); }
  return eps.slice(0, k).map((e) => mapResult(e, now));
}

// catch_up — recent activity, newest-first, deduped (no query needed).
export function catchUp(episodes, opts = {}) {
  const { window = 'today', limit = 12, exclude = [], floor = 0, now = Date.now() } = opts;
  const lo = Math.max(parseSince(window, now) ?? now - 24 * 36e5, floor || 0);
  const ok = keep(exclude), out = [], seen = new Set();
  for (let i = episodes.length - 1; i >= 0 && out.length < limit; i--) {
    const e = episodes[i];
    if (tOf(e) < lo || !ok(e) || seen.has(e.content_hash)) continue;
    seen.add(e.content_hash);
    out.push(mapResult(e, now));
  }
  return out;
}

const countBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (k) m.set(k, (m.get(k) || 0) + 1); } return m; };
const topN = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
const entityCounts = (eps) => { const m = new Map(); for (const e of eps) for (const w of String(e.text || '').match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || []) { if (!STOP.has(w.toLowerCase())) m.set(w, (m.get(w) || 0) + 1); } return m; };

// profile — synthesized understanding of the user. Heuristic always; LLM-enriched when configured.
export async function profile(episodes, opts = {}) {
  const { topic, llm, exclude = [], floor = 0, now = Date.now() } = opts;
  let eps = episodes.filter(keep(exclude));
  if (floor) eps = eps.filter((e) => tOf(e) >= floor);
  if (topic) { const q = tokens(topic).filter((w) => !STOP.has(w)); eps = eps.filter((e) => q.some((w) => (e.text || '').toLowerCase().includes(w))); }
  const apps = topN(countBy(eps, (e) => e.app), 5);
  const types = topN(countBy(eps, (e) => (e.label && e.label.type) || ''), 5);
  const recurring = topN(entityCounts(eps), 8);
  const voice = eps.filter((e) => ownerOf(e) === 'you' || (e.structured && e.structured.authored)).slice(-6).map((e) => scrub((e.structured && e.structured.authored) || e.text).slice(0, 140));
  const sources = eps.slice(-6).map((e) => mapResult(e, now));
  const base = { topic: topic || null, apps, types, recurring, voice_samples: voice, sources };
  if (!llm || !eps.length) return { kind: 'heuristic', note: !eps.length ? 'No matching activity yet.' : 'Heuristic profile — set llm.provider for a synthesized understanding.', ...base };
  const ctx = eps.slice(-50).map((e) => '- ' + scrub((e.structured && e.structured.summary) || e.text).slice(0, 160)).join('\n');
  let brief = '';
  try { brief = await llm("From these captured moments of ONE user, write a short grounded brief on who they are: what they're building, recurring people/projects/tools, how they think and write, their taste. Two short paragraphs. State only what the moments support — do not invent.", (topic ? `Focus: ${topic}\n\n` : '') + ctx, 320); } catch { /* fall back to heuristic */ }
  return { kind: brief ? 'synthesized' : 'heuristic', ...(brief ? { brief } : {}), ...base };
}

// snapshot — a cheap one-line "who is this user" for the initialize instructions (no LLM).
export function snapshot(episodes, opts = {}) {
  const { exclude = [], now = Date.now() } = opts;
  const eps = episodes.filter(keep(exclude));
  if (!eps.length) return null;
  const apps = topN(countBy(eps, (e) => e.app), 3);
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const where = (eps.some((e) => tOf(e) >= d.getTime()) ? 'today mostly in ' : 'recently in ') + apps.slice(0, 2).join(' and ');
  const recurring = topN(entityCounts(eps), 5);
  return `Snapshot of this user: active ${where}${recurring.length ? `; recurring topics/projects/people: ${recurring.join(', ')}` : ''}. Call profile() for depth, recall() for specifics.`;
}
