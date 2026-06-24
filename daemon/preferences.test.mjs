// Preferences — stated extraction, inference, curation store, and the auto-apply block.
// Run with CONTINUUM_DATA=$(mktemp -d) so the curated store writes to a scratch dir.
import { extractStated, extractInferred, candidates, approve, dismiss, removeApproved, loadStore, instructionsBlock } from './preferences.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nPreferences (learn → curate → auto-apply)\n');

const E = (app, text, extra = {}) => ({ app, text, end: 1700000000000, content_hash: app + text.slice(0, 6), source_mix: ['ocr'], ...extra });
const eps = [
  E('Claude', 'please be concise and skip the preamble', { source_mix: ['ocr', 'input'], label: { owner: 'me' } }),
  E('Cursor', 'keep it short here too', { source_mix: ['ocr', 'input'] }),
  E('Terminal', 'run all tests before the PR please', { source_mix: ['input'] }),
  E('Code', 'use TypeScript instead of JavaScript for this module', { label: { owner: 'me' } }),
  E('Slack', 'someone said random text with no directive at all', {}),
];

// stated extraction (no model)
{
  const c = extractStated(eps);
  const concise = c.find((p) => /concise/i.test(p.text));
  ok('extracts a stated preference (be concise)', !!concise && concise.kind === 'style', JSON.stringify(c.map((x) => x.text)));
  ok('repetition raises confidence', concise && concise.confidence >= 0.9, concise && concise.confidence);
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

// curation store + auto-apply
{
  const c = extractStated(eps);
  const concise = c.find((p) => /concise/i.test(p.text));
  approve(concise);
  ok('approve persists to the store', loadStore().approved.some((p) => p.id === concise.id));
  ok('approved is dropped from future suggestions', !(await candidates(eps)).some((p) => p.id === concise.id));
  ok('instructionsBlock applies approved prefs (free, no model)', /Be concise/i.test(instructionsBlock()) && /how this user wants you to work/i.test(instructionsBlock()));

  const tests = c.find((p) => /tests before/i.test(p.text));
  dismiss(tests.id);
  ok('dismiss hides a suggestion', loadStore().dismissed.includes(tests.id) && !(await candidates(eps)).some((p) => p.id === tests.id));

  removeApproved(concise.id);
  ok('remove takes an approved pref back out', !loadStore().approved.some((p) => p.id === concise.id));
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
