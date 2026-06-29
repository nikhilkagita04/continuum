// stripChrome — now a LIGHT per-frame filter: drop only the garbled tab-strip NOISE (OCR misreads of
// truncated tab titles + close buttons, "Nikh X"). Real bookmark/nav chrome REPEATS every frame and is
// suppressed CROSS-FRAME by LineNovelty (see novelty.test.mjs). Per-frame line-LENGTH heuristics can't
// tell chrome ("WORLD") from short CONTENT ("Iran war") and measured at −0.16 fact-recall, so we don't.
import { stripChrome, isBrowser } from './chrome.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nstripChrome (tab-strip noise filter)\n');

// garbled tab strip: lines with MANY (>=2) 1-char / "x" tokens (close buttons + truncated titles)
const tabStrip = ['Nikh X 4 Verc X', 'X Move x |'].join('\n');
ok('drops garbled tab-strip noise', stripChrome(tabStrip, 'Google Chrome').trim() === '', JSON.stringify(stripChrome(tabStrip, 'Google Chrome')));
// single arrow/close misread on a real nav/content line is KEPT (the >=2-junk rule avoids false positives)
ok('keeps single-junk content ("U.S. v", "For Business +")', stripChrome('U.S. v\nFor Business +', 'Google Chrome') === 'U.S. v\nFor Business +');

// THE regression that matters: short CONTENT facts must SURVIVE (the old run-of-short-lines strip deleted them)
const content = ['Iran war', 'World Cup 2026', 'Louisiana primary', '3.2K impressions', 'For Business',
  'So here is my ask: if your computer remembered everything you did, what would you build with it?',
  'I open-sourced it today. Try it (Mac, one command): npm i -g continuum-core'].join('\n');
ok('keeps short content facts (the fix)', stripChrome(content, 'Google Chrome') === content, stripChrome(content, 'Google Chrome'));

// guard: never touch non-browsers (code/terminal short-line runs are legit content)
const code = ['const a = 1', 'let b = 2', 'return a', 'if (x) {', '  go()', '}'].join('\n');
ok('non-browser text is untouched', stripChrome(code, 'Code') === code && stripChrome(code, 'Terminal') === code);
ok('isBrowser classifies correctly', isBrowser('Google Chrome') && isBrowser('Safari') && !isBrowser('Code') && !isBrowser('Terminal'));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
