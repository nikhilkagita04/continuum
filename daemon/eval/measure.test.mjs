// measure.mjs — self-generating retrieval/answer eval. Deterministic: a fake model + the real
// hybrid index over fixture episodes (no network, no store writes).
import { runMeasure, genProbe, judgeAnswer, formatScorecard } from './measure.mjs';
import { HybridIndex } from '../stage3/index.mjs';
import { localEmbedder } from '../adapters.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nMeasure (retrieval & answer quality over real memory)\n');

const E = (content_hash, text, salience) => ({ content_hash, app: 'Test', text, salience, end: 1700000000000 });
const eps = [
  E('h1', 'I was reading the neo4j documentation about temporal graph indexes and cypher queries for the knowledge graph store', 0.9),
  E('h2', 'implementing the segmenter state machine with simhash dedup and idle boundaries inside the capture pipeline today', 0.8),
  E('h3', 'drafting the pitch deck visuals for the design team review on friday about the product demo flow and timeline', 0.7),
  E('h4', 'debugging the kubernetes ingress controller timeout on the staging cluster deployment for the platform team', 0.6),
  E('h5', 'writing notes on broccoli recipes and roasting vegetables in the oven for a healthy dinner this weekend at home', 0.5),
];
const TOKENS = ['neo4j', 'segmenter', 'pitch', 'kubernetes', 'broccoli'];

// A fake model: writes probes that contain the source's distinctive token, and judges an answer
// correct+grounded exactly when it was given non-empty context.
const fakeLLM = async (system, user) => {
  if (/answerable specifically/i.test(system)) return 'yes';
  if (/write ONE specific/i.test(system)) { const t = TOKENS.find((tok) => user.toLowerCase().includes(tok)); return `What was I doing with ${t || user.split(/\s+/)[3]}?`; }
  if (/strict evaluator/i.test(system)) { const ctx = (user.split('CONTEXT:')[1] || '').trim(); return ctx ? '{"correct": true, "grounded": true}' : '{"correct": false, "grounded": false}'; }
  if (/using ONLY this context/i.test(system)) return 'From your memory: ' + user.slice(0, 40);
  if (/general knowledge only/i.test(system)) return 'I do not have that — it is about your private activity.';
  return '';
};

const embed = localEmbedder();
const index = new HybridIndex({ embed });
for (const e of eps) await index.add(e);

// pure helpers
{
  const q = await genProbe(eps[0], fakeLLM);
  ok('genProbe writes a question grounded in the moment', !!q && /neo4j/i.test(q), q);
  const g = await judgeAnswer('q', 'src', 'ans', 'some context', fakeLLM);
  ok('judgeAnswer: grounded when context present', g.correct && g.grounded);
  const g2 = await judgeAnswer('q', 'src', 'ans', '', fakeLLM);
  ok('judgeAnswer: not grounded when context empty', !g2.correct && !g2.grounded);
}

// full run
{
  const r = await runMeasure({ n: 5, k: 3, llm: fakeLLM, episodes: eps, index, now: 1700000000001 });
  ok('runs over all probes', r.n === 5, JSON.stringify(r));
  ok('retrieval finds the source moment (hit@k high)', r.retrieval.hitAtK >= 0.8, r.retrieval && r.retrieval.hitAtK);
  ok('MRR is computed', r.retrieval.mrr > 0);
  ok('answer correctness scored', r.correctness === 1);
  ok('groundedness scored', r.groundedness === 1);
  ok('necessity = right with memory, wrong without', r.necessity === 1);
  ok('latency percentiles present', typeof r.latencyMs.p50 === 'number' && typeof r.latencyMs.p95 === 'number');
  ok('scorecard renders the key dials', /Retrieval/.test(formatScorecard(r)) && /Necessity/.test(formatScorecard(r)));
}

// graceful degradation
{
  const noModel = await runMeasure({ episodes: eps, index });
  ok('no model → clear error, not a crash', !!noModel.error && /model/i.test(noModel.error));
  const thin = await runMeasure({ llm: fakeLLM, episodes: eps.slice(0, 2), index });
  ok('too little memory → clear error', !!thin.error && /enough/i.test(thin.error));
  ok('formatScorecard renders errors', /not enough|model/i.test(formatScorecard(thin)));
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
