import { HybridIndex } from './index.mjs';
import { localEmbedder } from '../adapters.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };
const embed = localEmbedder();

console.log('\nStage 3 hybrid index\n');

{
  const idx = new HybridIndex({ embed });
  await idx.add({ id: 'a', text: 'designing the temporal knowledge graph and entity resolution', salience: 0.8, end: 1000 });
  await idx.add({ id: 'b', text: 'lunch options near campus coffee and a walk', salience: 0.3, end: 2000 });
  await idx.add({ id: 'c', text: 'segmentation state machine dedup simhash boundaries', salience: 0.9, end: 3000 });
  const r = await idx.search('how does the knowledge graph entity resolution work', { k: 3, now: 3000 });
  ok('semantic+lexical: graph doc ranks top', r[0].ep.id === 'a', `top=${r[0].ep.id}`);
  ok('returns k results', r.length === 3);
}

// recency: between two equally-relevant docs, the newer wins when recency is weighted
{
  const idx = new HybridIndex({ embed, recencyHalfLifeMs: 1000 });
  await idx.add({ id: 'old', text: 'standup notes about the roadmap and milestones', salience: 0.5, end: 0 });
  await idx.add({ id: 'new', text: 'standup notes about the roadmap and milestones', salience: 0.5, end: 10_000 });
  const r = await idx.search('roadmap milestones standup', { k: 2, now: 10_000, weights: { vec: 0.3, kw: 0.3, rec: 0.4, sal: 0 } });
  ok('recency boosts the newer duplicate', r[0].ep.id === 'new', `top=${r[0].ep.id}`);
}

// salience: weight it heavily and the high-salience doc surfaces
{
  const idx = new HybridIndex({ embed });
  await idx.add({ id: 'low', text: 'misc background chatter about nothing in particular', salience: 0.1, end: 1 });
  await idx.add({ id: 'high', text: 'misc background chatter about nothing in particular', salience: 0.9, end: 1 });
  const r = await idx.search('background chatter', { now: 1, weights: { vec: 0.2, kw: 0.2, rec: 0, sal: 0.6 } });
  ok('salience boost surfaces the salient doc', r[0].ep.id === 'high', `top=${r[0].ep.id}`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
