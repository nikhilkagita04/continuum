// Progressive-typing coalesce — a long prompt typed into an app is OCR'd at every keystroke stage;
// those growing prefixes must collapse to ONE clean episode, not pile up into garble.
import { Segmenter } from './segmenter.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };
const uniqRatio = (t) => { const w = (t.toLowerCase().match(/[a-z0-9]+/g) || []); return w.length ? new Set(w).size / w.length : 1; };

console.log('\nProgressive-typing coalesce\n');

const seg = new Segmenter({ minActiveMs: 0, minTokens: 0, idleMs: 90_000 });
const full = 'Yes I think this should be in the pro profile and applied silently to every agent';
const stages = ['Yes I th', 'Yes I think this sho', 'Yes I think this should be in the', 'Yes I think this should be in the pro profile and applied', full];

let out = [];
stages.forEach((s, i) => { out = out.concat(seg.ingest({ t: i * 1000, source: 'ocr', app: 'Claude', window_id: 'w1', text: s })); });
out = out.concat(seg.flush());

ok('the whole typing burst becomes ONE episode', out.length === 1, `got ${out.length}`);
ok('keeps the full final text', out[0] && out[0].text === full, out[0] && JSON.stringify(out[0].text));
ok('no keystroke-stage garble piled up', out[0] && !/think this sho\b.*think this should/i.test(out[0].text));
ok('clean unique-token ratio (not the ~0.03 garble)', out[0] && uniqRatio(out[0].text) > 0.85, out[0] && uniqRatio(out[0].text).toFixed(2));

// guard: genuinely different lines in the same window must NOT be coalesced away
const seg2 = new Segmenter({ minActiveMs: 0, minTokens: 0, idleMs: 90_000, driftSimMin: 0 });
let out2 = [];
out2 = out2.concat(seg2.ingest({ t: 0, source: 'ocr', app: 'Code', window_id: 'w2', text: 'function parseConfig reads the yaml file' }));
out2 = out2.concat(seg2.ingest({ t: 1000, source: 'ocr', app: 'Code', window_id: 'w2', text: 'export default function App renders the dashboard' }));
out2 = out2.concat(seg2.flush());
ok('distinct content is still kept (no false coalesce)', out2.length === 1 && /parseConfig/.test(out2[0].text) && /renders the dashboard/.test(out2[0].text), out2[0] && out2[0].text);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
