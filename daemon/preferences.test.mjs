// Preferences — stated/inferred extraction, the auto-apply tier, curation store, and the apply block.
// Run with CONTINUUM_DATA=$(mktemp -d) so the curated store writes to a scratch dir.
import { extractStated, extractInferred, activePreferences, candidates, approve, dismiss, removeApproved, loadStore, instructionsBlock } from './preferences.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nPreferences (learn → curate → auto-apply)\n');

const E = (app, text, extra = {}) => ({ app, text, end: 1700000000000, content_hash: app + text.slice(0, 6), source_mix: ['ocr'], ...extra });
const eps = [
  E('Claude', 'please be concise and skip the preamble', { source_mix: ['ocr', 'input'], label: { owner: 'me' } }), // authored → concise
  E('Cursor', 'keep it short here too', { source_mix: ['ocr', 'input'] }),                                          // authored → concise (2nd mention)
  E('Terminal', 'run all tests before the PR please', { source_mix: ['input'] }),                                  // authored once → tests-before-PR
  E('Code', 'use TypeScript instead of JavaScript for this module', { label: { owner: 'me' } }),                   // authored once → prefer TS over JS
  E('Slack', 'someone said random text with no directive at all', {}),                                             // no preference
];

// stated extraction (no model)
{
  const c = extractStated(eps);
  const concise = c.find((p) => /concise/i.test(p.text));
  ok('extracts a stated preference (be concise)', !!concise && concise.kind === 'style', JSON.stringify(c.map((x) => x.text)));
  ok('repetition raises confidence', concise && concise.confidence >= 0.9, concise && concise.confidence);
  ok('exposes authored count (stated twice vs once)', concise && concise.authored === 2 && c.find((p) => /tests before/i.test(p.text)).authored === 1);
  ok('extracts a process pref (tests before PR)', c.some((p) => /tests before/i.test(p.text)));
  ok('extracts a dynamic tool pref (X over Y)', c.some((p) => /Prefer TypeScript over JavaScript/i.test(p.text)), JSON.stringify(c.map((x) => x.text)));
  ok('every candidate is grounded in evidence', c.every((p) => p.evidence.length && p.evidence.every((e) => e.id.startsWith('ep_'))));
  ok('ignores non-preference text', !c.some((p) => /random text/i.test(p.text)));
}

// inferred extraction (model — Ollama free / frontier Pro)
{
  const llm = async () => '[{"text":"Default to small, atomic commits","kind":"process"},{"text":"Prefer a functional style","kind":"code"}]';
  const inf = await extractInferred(eps, llm);
  ok('infers preferences via a model, grounded JSON', inf.length === 2 && inf.every((p) => p.source === 'inferred' && p.text), JSON.stringify(inf));
  ok('no model → no inferred (free, zero-setup still works via stated)', (await extractInferred(eps, null)).length === 0);
}

// auto-apply tier: a pref the user has STATED themselves 2+ times applies without approval; nothing else does
{
  const a = activePreferences(eps);                            // empty store
  ok('auto-applies a clearly + repeatedly stated pref', a.some((p) => /concise/i.test(p.text) && p.applied === 'auto'), JSON.stringify(a));
  ok('does NOT auto-apply a once-stated pref', !a.some((p) => /tests before/i.test(p.text)));
  const cands = await candidates(eps);
  ok('auto-applied pref is not also suggested', !cands.some((p) => /concise/i.test(p.text)));
  ok('once-stated + dynamic prefs are suggested', cands.some((p) => /tests before/i.test(p.text)) && cands.some((p) => /Prefer TypeScript/i.test(p.text)));
}

// curation store + apply block
{
  const c = extractStated(eps);
  const tests = c.find((p) => /tests before/i.test(p.text));
  const concise = c.find((p) => /concise/i.test(p.text));

  approve(tests);
  ok('approve persists a suggestion to the store', loadStore().approved.some((p) => p.id === tests.id));
  ok('approved shows as active (approved)', activePreferences(eps).some((p) => p.id === tests.id && p.applied === 'approved'));
  ok('approved is dropped from future suggestions', !(await candidates(eps)).some((p) => p.id === tests.id));

  dismiss(concise.id);                                         // turn off an auto-applied pref
  ok('turning off an auto pref drops it from active', !activePreferences(eps).some((p) => p.id === concise.id));
  ok('a turned-off pref does not return as a suggestion', !(await candidates(eps)).some((p) => p.id === concise.id));

  ok('instructionsBlock applies the active set, silently', (function () { const b = instructionsBlock(activePreferences(eps)); return /tests before/i.test(b) && !/concise/i.test(b) && /silently/i.test(b) && /apply these by default/i.test(b); })());

  removeApproved(tests.id);
  ok('remove takes an approved pref back out', !loadStore().approved.some((p) => p.id === tests.id));
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
