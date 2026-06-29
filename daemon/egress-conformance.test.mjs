// egress-conformance — the STATIC GUARANTEE that all outbound network goes through egress.mjs (the
// import-ban, the PRIMARY trust control). Scans daemon runtime modules, strips comments + template
// literals (the dashboard's frontend fetch lives inside the HTML string), and FAILS the build if any
// OUTBOUND network token appears outside egress.mjs. Inbound (http.createServer) is allowed; eval/ dev
// tools are consent-gated and out of scope. "The egress surface is statically bounded to one module."
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };
console.log('\negress conformance (the network import-ban)\n');

const DAEMON = path.dirname(fileURLToPath(import.meta.url));

function collect(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'eval' || e.name === 'node_modules') continue; out.push(...collect(p)); }
    else if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs') && e.name !== 'egress.mjs') out.push(p);
  }
  return out;
}

const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')        // block comments
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')     // line comments (the [^:] guard avoids eating http://)
  .replace(/`(?:\\.|[^`\\])*`/gs, '``');    // template literals (the dashboard's HTML/frontend strings)

const BANNED = [
  { re: /\bfetch\s*\(/, name: 'fetch(' },
  { re: /\bhttps?\.(?:request|get)\s*\(/, name: 'http(s).request/get(' },
  { re: /\bnet\.(?:connect|createConnection)\s*\(/, name: 'net.connect(' },
  { re: /from\s+['"]node:net['"]/, name: "import 'node:net'" },
];

const files = collect(DAEMON);
ok('found runtime modules to scan', files.length > 5, `${files.length} files`);

const violations = [];
for (const f of files) {
  const code = strip(fs.readFileSync(f, 'utf8'));
  for (const b of BANNED) if (b.re.test(code)) violations.push(`${path.relative(DAEMON, f)} → ${b.name}`);
}
ok('NO outbound network outside egress.mjs (the import-ban holds)', violations.length === 0, '\n   ' + violations.join('\n   '));

// the ban is only meaningful if the gate actually OWNS the network primitive
const gate = fs.readFileSync(path.join(DAEMON, 'egress.mjs'), 'utf8');
ok('egress.mjs owns egressFetch + the single real fetch', /export async function egressFetch/.test(gate) && /\bfetch\s*\(/.test(gate));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
