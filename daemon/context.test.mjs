// assembleContext — trim chrome, drop near-duplicate snippets, keep order, cap.
import { assembleContext, contextText } from './context.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nassembleContext (answer-context assembly)\n');

const hit = (app, text) => ({ ep: { app, text } });
const hits = [
  hit('Code', 'implementing the segmentation state machine with simhash dedup and idle boundaries'),
  hit('Code', 'implementing the segmentation state machine with simhash dedup and idle boundaries today'), // near-dup of #1
  hit('Google Chrome', 'X Move x\nNikh X\n• UMass\n• Learn\nAll Bookmarks\nThe pitch deck visuals for the design review are due Friday'),
  hit('Terminal', 'npm test runs the full suite with no network access'),
];

const a = assembleContext(hits, { maxSnippets: 5, near: 6 });
ok('drops the near-duplicate snippet', a.length === 3, `kept ${a.length}`);
ok('trims garbled tab-strip noise, keeps content', /pitch deck visuals/.test(contextText(a)) && !/Move x|Nikh X|UMass/.test(contextText(a)));
ok('keeps the distinct snippets', /segmentation state machine/.test(contextText(a)) && /npm test/.test(contextText(a)));
ok('preserves rank order (first hit first)', a[0].ep.text.startsWith('implementing the segmentation'));

// caps
const many = Array.from({ length: 20 }, (_, i) => hit('Code', 'distinct snippet number ' + i + ' about topic ' + i + ' with unique words ' + 'alpha'.repeat(i + 1)));
ok('respects maxSnippets cap', assembleContext(many, { maxSnippets: 4 }).length === 4);
ok('respects maxChars cap', contextText(assembleContext(many, { maxSnippets: 20, maxChars: 300 })).length <= 320);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
