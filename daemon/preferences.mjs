// Preferences — learn how the user wants their agent to work (from what they've stated and how they
// behave), let the human curate it, and once approved auto-apply it to every agent via the MCP
// instructions. Open engine: works with NO model (stated extraction) and gets richer with one
// (Ollama = decent & free & local, frontier = Pro). APPLYING approved prefs is always free.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const STORE = path.join(DATA_DIR, 'preferences.json');
const KINDS = new Set(['style', 'process', 'research', 'code', 'format', 'tone', 'tool']);
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
const pid = (text) => 'pref_' + hash(String(text).toLowerCase().trim());

// Canonical directive rules — specific enough that even a stray on-screen match is usually real
// signal; the human-curation gate handles the rest. `text` is the directive an agent should follow.
const RULES = [
  { re: /\b(be concise|keep it (short|brief)|concisely|no preamble|just the (code|answer)|tl;?dr)\b/i, text: 'Be concise — minimal preamble, just what is needed', kind: 'style' },
  { re: /\b(be thorough|in[- ]?depth|step[- ]by[- ]step|explain (your|the) reasoning|walk me through)\b/i, text: 'Be thorough and explain the reasoning', kind: 'style' },
  { re: /\brun (the |all )?tests\b|\btests? (pass|green)\b|\bbefore (the )?(pr|merge|commit)\b/i, text: 'Run the tests before opening a PR / committing', kind: 'process' },
  { re: /\b(lightweight|quick) (deep )?research\b|\bcite (your )?sources\b|\bwith (sources|citations|references)\b/i, text: 'Do research and cite sources', kind: 'research' },
  { re: /\bmatch (the )?(existing|surrounding) style\b|\bfollow (the )?conventions\b|\bconsistent with the (existing|surrounding)\b/i, text: 'Match the existing code style and conventions', kind: 'code' },
  { re: /\bno comments\b|\bdon'?t add comments\b/i, text: 'Avoid adding code comments unless asked', kind: 'code' },
  { re: /\bcommit by commit\b|\bsmall (commits|prs)\b|\batomic commits\b/i, text: 'Prefer small, commit-by-commit changes', kind: 'process' },
  { re: /\bask (me )?(first|before)\b|\bconfirm before\b|\bdon'?t (just )?assume\b/i, text: 'Ask / confirm before large or risky changes', kind: 'process' },
  { re: /\buse ([A-Za-z0-9.+#]{2,}) instead of ([A-Za-z0-9.+#]{2,})\b/i, text: null, kind: 'tool' }, // dynamic
];

// The user's authored text (what THEY produced) if any — the highest-signal source for "stated" prefs.
const authored = (e) => (e.structured && e.structured.authored) || ((e.source_mix || []).includes('input') ? e.text : '') || ((e.label && e.label.owner === 'me') ? e.text : '');

// extractStated — no model needed. Finds standing preferences the user has explicitly stated,
// favoring their own authored text, with frequency + evidence → confidence.
export function extractStated(episodes = []) {
  const found = new Map();
  for (const e of episodes) {
    const own = authored(e);
    const txt = own || e.text || '';
    if (!txt) continue;
    for (const r of RULES) {
      const m = txt.match(r.re); if (!m) continue;
      let text = r.text;
      if (!text) { if (m[1] && m[2] && m[1].toLowerCase() !== m[2].toLowerCase()) text = `Prefer ${m[1]} over ${m[2]}`; else continue; }
      const key = text.toLowerCase();
      const c = found.get(key) || { text, kind: r.kind, count: 0, authoredHits: 0, evidence: [] };
      c.count++; if (own) c.authoredHits++;
      if (c.evidence.length < 3) c.evidence.push({ id: 'ep_' + (e.content_hash || (e.end || e.start || 0)), app: e.app || 'Unknown', snippet: (m[0] || '').slice(0, 80) });
      found.set(key, c);
    }
  }
  return [...found.values()].map((c) => ({
    id: pid(c.text), text: c.text, kind: c.kind, source: 'stated',
    confidence: Math.min(1, 0.4 + 0.12 * c.count + 0.2 * c.authoredHits), evidence: c.evidence,
  })).sort((a, b) => b.confidence - a.confidence);
}

// extractInferred — behavioral inference via the configured model (Ollama free / frontier Pro).
// Grounded JSON, never invents.
export async function extractInferred(episodes = [], llm) {
  if (!llm || !episodes.length) return [];
  const sample = episodes.slice(-60).map((e) => '- ' + ((e.structured && e.structured.authored) || e.text || '').slice(0, 140)).join('\n');
  let raw = '';
  try { raw = await llm('From these captured moments of ONE user, infer their standing PREFERENCES for how an AI agent should work for them (style, process, research depth, formatting, tools). Return ONLY a JSON array of {"text": the directive, "kind": one of style|process|research|code|format|tone}. 3-6 items, only what the moments actually support — do not invent. No prose.', sample, 400); } catch { return []; }
  let arr = [];
  try { arr = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)); } catch { return []; }
  return (Array.isArray(arr) ? arr : []).filter((x) => x && x.text).slice(0, 6).map((x) => ({ id: pid(String(x.text)), text: String(x.text).slice(0, 160), kind: KINDS.has(x.kind) ? x.kind : 'style', source: 'inferred', confidence: 0.6, evidence: [] }));
}

// ---- curated store: { approved:[{id,text,kind,addedAt}], dismissed:[id] } ----
export function loadStore() { try { return { approved: [], dismissed: [], ...JSON.parse(fs.readFileSync(STORE, 'utf8')) }; } catch { return { approved: [], dismissed: [] }; } }
function saveStore(s) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(s, null, 2) + '\n'); return s; }

export function approve(pref) {
  if (!pref || !pref.text) return loadStore();
  const s = loadStore();
  const id = pid(pref.text);                                   // recompute so edited text gets its own id
  if (!s.approved.find((p) => p.id === id)) s.approved.push({ id, text: String(pref.text).slice(0, 200), kind: KINDS.has(pref.kind) ? pref.kind : 'style', addedAt: Date.now() });
  s.dismissed = s.dismissed.filter((d) => d !== id);
  return saveStore(s);
}
export function dismiss(id) { const s = loadStore(); if (id && !s.dismissed.includes(id)) s.dismissed.push(id); s.approved = s.approved.filter((p) => p.id !== id); return saveStore(s); }
export function removeApproved(id) { const s = loadStore(); s.approved = s.approved.filter((p) => p.id !== id); return saveStore(s); }

// candidates = freshly extracted, minus what's already approved or dismissed.
export async function candidates(episodes = [], { llm } = {}) {
  const s = loadStore();
  const have = new Set([...s.approved.map((p) => p.id), ...s.dismissed]);
  const seen = new Set(); const out = [];
  for (const c of [...extractStated(episodes), ...(await extractInferred(episodes, llm))]) {
    if (have.has(c.id) || seen.has(c.id)) continue;
    seen.add(c.id); out.push(c);
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 12);
}

// The block injected into the MCP initialize instructions — approved prefs the agent applies by default.
export function instructionsBlock(approved = loadStore().approved) {
  if (!approved || !approved.length) return '';
  return 'How this user wants you to work (their standing preferences — apply them by default):\n' + approved.slice(0, 12).map((p) => `- ${p.text}`).join('\n');
}
