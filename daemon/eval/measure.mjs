// continuum measure — does retrieval actually help, on YOUR real memory?
//
// The capture eval (eval.mjs) scores fixtures. This scores the live store: it generates probe
// questions from your own captured episodes (so we have ground truth — the episode each question
// came from), then measures the dials that matter:
//   • Retrieval quality   hit@k / MRR — did the right moment come back?  (the dial to optimize)
//   • Answer correctness  given retrieval, is the answer right?
//   • Groundedness        is the answer supported by what was retrieved (no fabrication)?
//   • Necessity           how often it answered something the bare model could NOT (why it earns its place)
//   • Latency             retrieval p50 / p95
//
// Needs a model (Ollama = free/local, or an API key) to write probes and judge. Everything runs
// locally over ~/.continuum; nothing is sent anywhere except your configured model.
import { loadEpisodes, loadIndex } from '../store.mjs';

const r3 = (x) => Math.round(x * 1000) / 1000;
const pct = (x) => `${Math.round(x * 100)}%`;
const pctile = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const parseJSON = (s) => { try { return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { return null; } };

// Generate one natural question whose answer lives in this captured moment. Returns null on failure.
export async function genProbe(ep, llm) {
  const txt = ((ep.structured && ep.structured.summary) || ep.text || '').slice(0, 800);
  if (!txt) return null;
  const q = await llm(
    'From this captured moment of a user\'s own activity, write ONE specific, natural question the user might later ask whose answer is found in this moment. No preamble — return only the question.',
    txt, 60,
  );
  const clean = String(q || '').trim().replace(/^["'-]+|["']+$/g, '').split('\n')[0];
  return clean && clean.length > 8 ? clean : null;
}

// Judge an answer against the ground-truth source moment + the snippets it was given.
// Returns { correct, grounded }. Conservative (false) when the model's reply can't be parsed.
export async function judgeAnswer(q, sourceText, answer, snippets, llm) {
  const j = await llm(
    'You are a strict evaluator. Given the QUESTION, the GROUND-TRUTH source, the ANSWER, and the CONTEXT the answer was given, reply ONLY with JSON: {"correct": true|false, "grounded": true|false}. correct = the answer matches the ground truth. grounded = every claim in the answer is supported by the CONTEXT (no fabrication). If CONTEXT is empty, set grounded to false.',
    `QUESTION: ${q}\nGROUND-TRUTH: ${String(sourceText).slice(0, 600)}\nANSWER: ${String(answer).slice(0, 500)}\nCONTEXT: ${String(snippets).slice(0, 800)}`,
    40,
  );
  const o = parseJSON(j) || {};
  return { correct: o.correct === true, grounded: o.grounded === true };
}

// Generate the probe set ONCE — questions written from the user's own salient moments, each paired
// with the source episode it came from (ground truth). Reuse the same set across configs for a fair A/B.
export async function generateProbes(episodes = [], llm, { n = 10 } = {}) {
  const sources = episodes
    .filter((e) => (e.text || '').length > 80)
    .sort((a, b) => (b.salience || 0) - (a.salience || 0) || (b.end || 0) - (a.end || 0))
    .slice(0, n * 2);
  const probes = [];
  for (const src of sources) {
    if (probes.length >= n) break;
    const q = await genProbe(src, llm);
    if (q) probes.push({ q, sourceId: src.content_hash, source: src });
  }
  return probes;
}

// Score a fixed probe set against ONE retrieval config (index) + judge. Returns the scorecard.
export async function scoreProbes(probes = [], { index, llm, k = 5, now = 0 } = {}) {
  const rows = [];
  for (const p of probes) {
    const t0 = (globalThis.performance && performance.now) ? performance.now() : 0;
    const hits = await index.search(p.q, { k, now });
    const latency = ((globalThis.performance && performance.now) ? performance.now() : 0) - t0;

    const rank = hits.findIndex((h) => h.ep.content_hash === p.sourceId);
    const snippets = hits.map((h) => h.ep.text).join('\n---\n').slice(0, 1200);

    const withAns = await llm('Answer the question using ONLY this context from the user\'s activity. If it is not there, say you do not have it.', `Context:\n${snippets}\n\nQuestion: ${p.q}`, 160);
    const withJ = await judgeAnswer(p.q, p.source.text, withAns, snippets, llm);
    const withoutAns = await llm('Answer the question from general knowledge only. If this is about a specific user\'s private activity you cannot know, say you do not have it.', `Question: ${p.q}`, 160);
    const withoutJ = await judgeAnswer(p.q, p.source.text, withoutAns, '', llm);

    rows.push({
      q: p.q, app: (p.source.app) || 'Unknown', rank, latency,
      hit: rank >= 0 && rank < k, rr: rank >= 0 ? 1 / (rank + 1) : 0,
      correct: withJ.correct, grounded: withJ.grounded,
      necessary: withJ.correct && !withoutJ.correct,   // we got it right; the bare model did not
    });
  }
  if (!rows.length) return { error: 'no probes scored.' };
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  const lat = rows.map((r) => r.latency);
  return {
    n: rows.length, k,
    retrieval: { hitAtK: r3(mean((r) => r.hit ? 1 : 0)), mrr: r3(mean((r) => r.rr)) },
    correctness: r3(mean((r) => r.correct ? 1 : 0)),
    groundedness: r3(mean((r) => r.grounded ? 1 : 0)),
    necessity: r3(mean((r) => r.necessary ? 1 : 0)),
    latencyMs: { p50: Math.round(pctile(lat, 0.5)), p95: Math.round(pctile(lat, 0.95)) },
    weakest: rows.filter((r) => !r.hit).slice(0, 5).map((r) => ({ q: r.q, app: r.app, rank: r.rank })),
  };
}

// Run the full measurement over the live store (or injected episodes/index for tests).
export async function runMeasure({ n = 10, k = 5, embed, llm, episodes, index, now = 0 } = {}) {
  episodes = episodes || loadEpisodes();
  if (!llm) return { error: 'measurement needs a model to write probes and judge. Set up Ollama (free, local) or add an API key, then retry.' };
  if (episodes.filter((e) => (e.text || '').length > 80).length < 4) return { error: `not enough captured memory yet. Run \`continuum start\` for a while, then retry.` };
  const probes = await generateProbes(episodes, llm, { n });
  if (!probes.length) return { error: 'could not generate probes from the current memory — try again or capture more.' };
  index = index || await loadIndex(embed);
  const nowMs = now || episodes.reduce((m, e) => Math.max(m, e.end || e.start || 0), 0);
  return scoreProbes(probes, { index, llm, k, now: nowMs });
}

export function formatScorecard(r) {
  if (r.error) return `continuum measure\n\n  ${r.error}`;
  const L = [
    'continuum measure — retrieval & answer quality (over your own captured memory)\n',
    `  Probes              ${r.n} questions generated from your real activity`,
    `  Retrieval           hit@${r.k} ${pct(r.retrieval.hitAtK)}    MRR ${r.retrieval.mrr}     ← the dial: better embeddings / a reranker move this`,
    `  Answer correctness  ${pct(r.correctness)} right when grounded in your memory`,
    `  Groundedness        ${pct(r.groundedness)} supported    (${pct(1 - r.groundedness)} fabricated — want this at 0)`,
    `  Necessity           ${pct(r.necessity)} the bare model could NOT answer — why Continuum earns its place`,
    `  Retrieval latency   p50 ${r.latencyMs.p50}ms   p95 ${r.latencyMs.p95}ms`,
  ];
  if (r.weakest.length) {
    L.push('\n  Weakest — retrieval missed the source (fix these first):');
    for (const w of r.weakest) L.push(`   • [${w.app}] "${w.q}"  → source ${w.rank < 0 ? 'not in top-' + r.k : 'ranked #' + (w.rank + 1)}`);
  }
  L.push('\n  Re-run after any capture/retrieval change — gate the change on these numbers.');
  return L.join('\n');
}
