// clean.mjs — salvage the clean tail of progressive-typing garble; delete the unsalvageable; leave
// clean episodes untouched.
import { cleanTail, cleanText, uniqRatio } from './clean.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nClean (salvage / delete polluted episodes)\n');

const garble = 'Yes I th Yes I think this sho Yes I think this should be in Yes I think this should be in the pro profile and applied silently to every agent session';
const clean = 'I think this should be in the pro profile and applied silently to every agent session';

ok('cleanTail recovers the clean ending from garble', (cleanTail(garble) || '').includes('pro profile and applied silently'));
ok('recovered tail is high unique-token ratio', uniqRatio(cleanTail(garble)) > 0.8, uniqRatio(cleanTail(garble) || '').toFixed(2));

ok('garbled episode → cleaned', cleanText(garble).action === 'cleaned');
ok('cleaned text drops the keystroke stages', !/think this sho\b.*think this should/i.test(cleanText(garble).text));
ok('already-clean text → kept unchanged', cleanText(clean).action === 'keep' && cleanText(clean).text === clean);
ok('short text → kept (nothing to do)', cleanText('quick note').action === 'keep');

// hopeless garble (no clean tail at all) → delete
const hopeless = Array(40).fill('the the the').join(' ');
ok('unsalvageable garble → delete', cleanText(hopeless).action === 'delete', JSON.stringify(cleanText(hopeless)));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
