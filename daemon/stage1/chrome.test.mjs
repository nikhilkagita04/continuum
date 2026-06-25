// stripChrome — drop browser tab/bookmark/nav chrome, keep page content, never touch non-browsers.
import { stripChrome, isBrowser } from './chrome.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nstripChrome (browser UI-noise filter)\n');

const page = [
  'X Move x |', 'Nikh X 4 Verc X', 'Goo, X', 'Ask Gemini',          // tab strip
  '• UMass', '• Learn', 'Morning Brew', '• Google Gemini', 'h My hoopla', '# Shoes', '• Sunglasses', 'All Bookmarks', // bookmarks bar
  'My Network', 'Me v', 'For Business +',                            // nav
  'So here is my ask: if your computer remembered everything you did, what would you build with it?',
  'I open-sourced it today. Try it (Mac, one command): npm i -g continuum-core',
  'This started last Sunday at the Agents You Love hackathon and somehow won 1st place.',
].join('\n');

const out = stripChrome(page, 'Google Chrome');
ok('drops the tab strip', !/Move x|Verc/.test(out));
ok('drops the bookmarks bar', !/UMass|Sunglasses|All Bookmarks/.test(out));
ok('drops the nav toolbar', !/My Network|For Business/.test(out));
ok('keeps the page content', /what would you build/.test(out) && /continuum-core/.test(out) && /won 1st place/.test(out));
ok('cuts the line count substantially', out.split('\n').length <= 5, out.split('\n').length);

// the guard that matters: never strip non-browsers (code/terminal have legit short-line runs)
const code = ['const a = 1', 'let b = 2', 'return a', 'if (x) {', '  go()', '}'].join('\n');
ok('non-browser text is untouched', stripChrome(code, 'Code') === code && stripChrome(code, 'Terminal') === code);
ok('isBrowser classifies correctly', isBrowser('Google Chrome') && isBrowser('Safari') && !isBrowser('Code') && !isBrowser('Terminal'));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
