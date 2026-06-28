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
import { routeSearch } from '../stage3/index.mjs';   // score the SAME retrieval path production ships (recency routing)

const r3 = (x) => Math.round(x * 1000) / 1000;
const pct = (x) => `${Math.round(x * 100)}%`;
const pctile = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const parseJSON = (s) => { try { return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { return null; } };
// Wilson 95% score interval for a proportion — at N≈15 the CI is ±~0.25, so a point estimate near a
// gate is meaningless. The gate-of-record clears its LOWER bound, not the point estimate (panel ruling).
const wilson = (k, n) => {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [r3(Math.max(0, c - h)), r3(Math.min(1, c + h))];
};

// Generate one natural question whose answer lives in this captured moment. Returns null on failure.
export async function genProbe(ep, llm) {
  const txt = ((ep.structured && ep.structured.summary) || ep.text || '').slice(0, 800);
  if (!txt) return null;
  const q = await llm(
    'From this captured moment of a user\'s own activity, write ONE specific, natural question the user might later ask that is FULLY answerable from THIS moment alone — do not ask for details (names, numbers, files) that are not present here. No preamble — return only the question.',
    txt, 60,
  );
  const clean = String(q || '').trim().replace(/^["'-]+|["']+$/g, '').split('\n')[0];
  return clean && clean.length > 8 ? clean : null;
}

// Is the question actually answerable from its source? Drops over-specific / malformed auto-probes so
// the correctness metric measures the SYSTEM, not the quality of the generated questions.
async function answerable(q, sourceText, llm) {
  const v = await llm('Is the QUESTION answerable specifically and factually from the SOURCE text alone? Reply ONLY "yes" or "no".', `SOURCE: ${String(sourceText).slice(0, 700)}\n\nQUESTION: ${q}`, 5);
  return /^\s*yes/i.test(String(v || ''));
}

// Better probe: a (question, expected_answer) PAIR anchored to ONE concrete fact in the moment.
// Pairs give crisp ground truth (we judge the answer, not a whole episode) AND let us validate
// DETERMINISTICALLY — the expected answer must actually appear in the source — so we never measure
// the system against a hallucinated or aggregate ("how many times today") probe, and we drop the
// flaky per-probe LLM yes/no call entirely. Returns { q, a } or null.
export async function genProbeQA(ep, llm) {
  const txt = ((ep.structured && ep.structured.summary) || ep.text || '').slice(0, 800);
  if (!txt) return null;
  const out = await llm(
    'From this captured moment of the user\'s own activity, pick ONE concrete fact stated in it and write a natural question the user might later ask whose answer IS that fact. Rules: the answer MUST be a short literal string taken from the moment (a name, number, file, tool, decision, URL, or phrase). FORBIDDEN: counting/aggregate questions ("how many times..."), anything spanning multiple moments or "today/this week", and anything not answerable from THIS text alone. Reply ONLY JSON: {"q":"...","a":"..."}. If no such specific fact exists, reply {"q":null}.',
    txt, 120,
  );
  const o = parseJSON(out) || {};
  if (!o.q || !o.a) return null;
  const q = String(o.q).trim(), a = String(o.a).trim();
  return q.length > 8 && a.length >= 2 ? { q, a } : null;
}

// Tokenize a short fact: split letter/digit boundaries ("4.5K"→[4,5,k], "5:30PM"→[5,30,pm]) and keep
// ALL alphanumeric tokens — numbers and 1–2 char tokens ("pt", "ml") are often the discriminating part.
export const factTokens = (s) => String(s).toLowerCase()
  .replace(/([a-z])([0-9])/g, '$1 $2').replace(/([0-9])([a-z])/g, '$1 $2')
  // Latin/digit words OR single CJK/Hangul chars (those scripts have no word spaces, so match per-glyph)
  .match(/[a-z0-9]+|[぀-ヿ㐀-䶿一-鿿가-힯]/g) || [];

// Deterministic, numeric-aware fact check: is the expected FACT actually present in `text`?
//   • every numeric token must match EXACTLY    ("4.5K" ≠ "4500"),
//   • the single most distinctive (longest) word token must be present
//        ("Avery ML @Northwind" ≠ "marketing at Northwind" — the discriminating "ml"/"avery" is required),
//   • and ≥80% of all expected tokens appear.
// No LLM call ⇒ reproducible, and it can't be fooled by an invented/partially-wrong answer. Used both to
// VALIDATE a probe (fact is in its source) and to SCORE correctness (fact is in the model's answer).
export function answerInSource(expected, text) {
  const e = factTokens(expected); if (!e.length) return false;
  const t = new Set(factTokens(text));
  const nums = e.filter((w) => /[0-9]/.test(w));
  if (nums.some((w) => !t.has(w))) return false;                       // numbers must match exactly
  const words = e.filter((w) => !/[0-9]/.test(w)).sort((a, b) => b.length - a.length);
  if (words[0] && !t.has(words[0])) return false;                      // the discriminating token must match
  return e.filter((w) => t.has(w)).length / e.length >= 0.8;
}

// Judge an answer against the ground-truth source moment + the snippets it was given.
// Returns { correct, grounded }. Conservative (false) when the model's reply can't be parsed.
export async function judgeAnswer(q, sourceText, answer, snippets, llm, expected) {
  // When the probe carries an EXPECTED answer (QA pairs), judge against that crisp target; otherwise
  // fall back to judging against the whole ground-truth source moment (legacy single-question probes).
  const target = expected ? `EXPECTED ANSWER: ${String(expected).slice(0, 200)}` : `GROUND-TRUTH SOURCE: ${String(sourceText).slice(0, 600)}`;
  const j = await llm(
    'You are a strict evaluator. Reply ONLY JSON: {"correct": true|false, "grounded": true|false}. correct = the ANSWER conveys the expected fact (semantic match; ignore phrasing). grounded = every claim in the ANSWER is supported by the CONTEXT (no fabrication). If CONTEXT is empty, set grounded to false.',
    `QUESTION: ${q}\n${target}\nANSWER: ${String(answer).slice(0, 500)}\nCONTEXT: ${String(snippets).slice(0, 800)}`,
    40,
  );
  const o = parseJSON(j) || {};
  return { correct: o.correct === true, grounded: o.grounded === true };
}

// Generate the probe set ONCE — questions written from the user's own salient moments, each paired
// with the source episode it came from (ground truth). Reuse the same set across configs for a fair A/B.
export async function generateProbes(episodes = [], llm, { n = 10, validate = false, pool } = {}) {
  const sources = episodes
    .filter((e) => (e.text || '').length > 80)
    .sort((a, b) => (b.salience || 0) - (a.salience || 0) || (b.end || 0) - (a.end || 0))
    .slice(0, pool || n * (validate ? 4 : 2));   // widen the pool when validating, since some probes get dropped;
                                                 // noisy corpora drop most auto-probes, so callers can pass a bigger `pool`
  const probes = [];
  for (const src of sources) {
    if (probes.length >= n) break;
    const q = await genProbe(src, llm);
    if (!q) continue;
    if (validate && !(await answerable(q, src.text, llm))) continue;
    probes.push({ q, sourceId: src.content_hash, source: src });
  }
  return probes;
}

// QA-pair probe set: coherent moments → {q, a} pairs, each ground-truth-validated by string overlap.
// This is the credible default — it avoids the unanswerable-probe trap and the per-probe yes/no call.
export async function generateProbesQA(episodes = [], llm, { n = 12, pool = 60, minLen = 200 } = {}) {
  const sources = episodes
    .filter((e) => (e.text || '').length > minLen)   // coherent moments only (raw OCR fragments yield bad probes)
    .sort((a, b) => (b.salience || 0) - (a.salience || 0) || (b.end || 0) - (a.end || 0))
    .slice(0, pool);
  const probes = [];
  for (const src of sources) {
    if (probes.length >= n) break;
    const qa = await genProbeQA(src, llm);
    if (!qa || !answerInSource(qa.a, src.text)) continue;
    probes.push({ q: qa.q, a: qa.a, sourceId: src.content_hash, source: src });
  }
  return probes;
}

// Score a fixed probe set against ONE retrieval config (index). Three DISTINCT model roles so the
// instrument never grades itself (eval-plan §0.2): answerLlm = the deployed agent model; judgeLlm =
// a different *family* (no self-preference bias); baselineLlm = same family as the answerer (so the
// necessity metric isolates "retrieval added value", not "a weaker model is worse"). All default to
// `llm` for back-compat — but a single-model run is labeled self-graded/provisional.
export async function scoreProbes(probes = [], { index, llm, answerLlm, judgeLlm, baselineLlm, k = 5, now = 0, searchOpts = {} } = {}) {
  const answer = answerLlm || llm, judge = judgeLlm || llm, baseline = baselineLlm || llm;
  const split = !!(answerLlm && judgeLlm && answerLlm !== judgeLlm);
  const rows = [];
  for (const p of probes) {
    const t0 = (globalThis.performance && performance.now) ? performance.now() : 0;
    const hits = await index.search(p.q, { k, now, ...routeSearch(p.q), ...searchOpts });   // SAME path production ships (+ optional reranker)
    const latency = ((globalThis.performance && performance.now) ? performance.now() : 0) - t0;

    const rank = hits.findIndex((h) => h.ep.content_hash === p.sourceId);
    const snippets = hits.map((h) => h.ep.text).join('\n---\n').slice(0, 1200);

    const withAns = await answer('Answer the question using ONLY this context from the user\'s activity. If it is not there, say you do not have it.', `Context:\n${snippets}\n\nQuestion: ${p.q}`, 160);
    const withJ = await judgeAnswer(p.q, p.source.text, withAns, snippets, judge, p.a);
    const withoutAns = await baseline('Answer the question from general knowledge only. If this is about a specific user\'s private activity you cannot know, say you do not have it.', `Question: ${p.q}`, 160);
    const withoutJ = await judgeAnswer(p.q, p.source.text, withoutAns, '', judge, p.a);

    // DETERMINISTIC signal (only for QA probes that carry an expected answer `a`): reproducible, no model.
    // This is the GATE-OF-RECORD for correctness/necessity; the LLM judge is reported alongside as a check.
    const cDet = p.a ? answerInSource(p.a, withAns) : null;
    const bDet = p.a ? answerInSource(p.a, withoutAns) : null;
    rows.push({
      q: p.q, app: (p.source.app) || 'Unknown', rank, latency,
      hit: rank >= 0 && rank < k, rr: rank >= 0 ? 1 / (rank + 1) : 0,
      correct: withJ.correct, grounded: withJ.grounded,
      necessary: withJ.correct && !withoutJ.correct,   // we got it right; the bare model did not
      correctDet: cDet, groundedDet: cDet === null ? null : (cDet && answerInSource(p.a, snippets)),
      necessaryDet: cDet === null ? null : (cDet && !bDet),
    });
  }
  if (!rows.length) return { error: 'no probes scored.' };
  const n = rows.length;
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / n;
  const count = (f) => rows.reduce((s, r) => s + (f(r) ? 1 : 0), 0);
  const rate = (f) => ({ p: r3(count(f) / n), ci95: wilson(count(f), n) });   // point estimate + Wilson 95% CI
  const det = rows.every((r) => r.correctDet !== null);   // deterministic signal available (QA probes)?
  const lat = rows.map((r) => r.latency);
  return {
    n, k,
    judging: split ? 'split (answer ≠ judge family)' : 'self-graded — provisional',
    gateOfRecord: det ? 'deterministic (fact-match)' : 'llm-judge',
    retrieval: { hitAtK: r3(mean((r) => r.hit ? 1 : 0)), hitAtKci: wilson(count((r) => r.hit), n), mrr: r3(mean((r) => r.rr)) },
    // both signals reported; *Det is the reproducible gate-of-record, judge is the cross-family check
    correctness: det ? rate((r) => r.correctDet) : rate((r) => r.correct),
    correctnessJudge: rate((r) => r.correct),
    groundedness: det ? rate((r) => r.groundedDet) : rate((r) => r.grounded),
    necessity: det ? rate((r) => r.necessaryDet) : rate((r) => r.necessary),
    necessityJudge: rate((r) => r.necessary),
    latencyMs: { p50: Math.round(pctile(lat, 0.5)), p95: Math.round(pctile(lat, 0.95)) },
    weakest: rows.filter((r) => !r.hit).slice(0, 5).map((r) => ({ q: r.q, app: r.app, rank: r.rank })),
    rows: rows.map((r) => ({ q: r.q, app: r.app, rank: r.rank, hit: r.hit, correct: r.correct, grounded: r.grounded, necessary: r.necessary, correctDet: r.correctDet, groundedDet: r.groundedDet, necessaryDet: r.necessaryDet })),
  };
}

// Run the full measurement over the live store (or injected episodes/index for tests). Defaults to the
// QA-pair path (deterministic ground truth, the methodology this gate is described by); `legacy:true`
// keeps the old single-question generator for back-compat. Pass probeLlm/judgeLlm distinct from the
// answerer for a rigorous cross-family run; a single-model run honestly self-labels "provisional".
export async function runMeasure({ n = 12, k = 5, embed, llm, probeLlm, answerLlm, judgeLlm, baselineLlm, episodes, index, now = 0, minLen = 200, pool = 60, legacy = false } = {}) {
  episodes = episodes || loadEpisodes();
  const probeM = probeLlm || judgeLlm || llm;   // probes are written by the judge/neutral model, never the answerer
  if (!probeM) return { error: 'measurement needs a model to write probes and judge. Set up Ollama (free, local) or add an API key, then retry.' };
  if (episodes.filter((e) => (e.text || '').length > 80).length < 4) return { error: `not enough captured memory yet. Run \`continuum start\` for a while, then retry.` };
  const probes = legacy
    ? await generateProbes(episodes, probeM, { n, validate: true })
    : await generateProbesQA(episodes, probeM, { n, pool, minLen });
  if (!probes.length) return { error: 'could not generate probes from the current memory — try again or capture more.' };
  index = index || await loadIndex(embed);
  const nowMs = now || episodes.reduce((m, e) => Math.max(m, e.end || e.start || 0), 0);
  return scoreProbes(probes, { index, llm, answerLlm, judgeLlm, baselineLlm, k, now: nowMs });
}

export function formatScorecard(r) {
  if (r.error) return `continuum measure\n\n  ${r.error}`;
  const ci = (m) => (m && m.ci95) ? ` [95% CI ${pct(m.ci95[0])}–${pct(m.ci95[1])}]` : '';
  const L = [
    'continuum measure — retrieval & answer quality (over your own captured memory)\n',
    `  Probes              ${r.n} questions generated from your real activity   (small N ⇒ read the CIs, not the point)`,
    `  Judging             ${r.judging || 'self-graded — provisional'}   ·   gate-of-record: ${r.gateOfRecord || 'llm-judge'}`,
    `  Retrieval           hit@${r.k} ${pct(r.retrieval.hitAtK)}${r.retrieval.hitAtKci ? ` [95% CI ${pct(r.retrieval.hitAtKci[0])}–${pct(r.retrieval.hitAtKci[1])}]` : ''}    MRR ${r.retrieval.mrr}`,
    `  Answer correctness  ${pct(r.correctness.p)}${ci(r.correctness)}   right when grounded in your memory   (judge ${pct(r.correctnessJudge.p)})`,
    `  Groundedness        ${pct(r.groundedness.p)}${ci(r.groundedness)}   (${pct(1 - r.groundedness.p)} fabricated — want this at 0)`,
    `  Necessity           ${pct(r.necessity.p)}${ci(r.necessity)}   the bare model could NOT answer   (judge ${pct(r.necessityJudge.p)})`,
    `  Retrieval latency   p50 ${r.latencyMs.p50}ms   p95 ${r.latencyMs.p95}ms`,
  ];
  if (r.weakest.length) {
    L.push('\n  Weakest — retrieval missed the source (fix these first):');
    for (const w of r.weakest) L.push(`   • [${w.app}] "${w.q}"  → source ${w.rank < 0 ? 'not in top-' + r.k : 'ranked #' + (w.rank + 1)}`);
  }
  L.push('\n  Re-run after any capture/retrieval change — gate the change on these numbers.');
  return L.join('\n');
}
