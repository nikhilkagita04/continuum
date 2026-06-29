// self-contained — the STATIC GUARANTEE that continuum-core stays zero-dependency. Every runtime module
// imports ONLY Node builtins (`node:*`) or other in-repo files (relative paths that stay inside the repo).
// No bare external package imports; no relative path escaping the repo root. This keeps the install a single
// `npm i -g continuum-core` with no transitive supply chain, and keeps the trust surface auditable in one
// tree. (Optional integrations live behind the pluggable `embed`/`llm` seams, injected by the caller.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };
console.log('\nself-contained (zero external runtime deps)\n');

const DAEMON = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(DAEMON);

function collect(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'eval' || e.name === 'node_modules') continue; out.push(...collect(p)); }
    else if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) out.push(p);
  }
  return out;
}
const BIN = path.join(ROOT, 'bin');

const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/`(?:\\.|[^`\\])*`/gs, '``');

// Only genuine module specifiers — `import/export … from 'x'`, side-effect `import 'x'`, dynamic
// `import('x')`, and `require('x')` — NOT the English word "from" in front of a string literal.
const PATTERNS = [
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
];

// allowed: a Node builtin, or a relative/absolute path that resolves INSIDE the repo. A bare specifier is
// an external package (not self-contained); a relative path resolving outside the repo escapes the tree.
const allowed = (spec, fromFile) => {
  if (spec.startsWith('node:')) return true;
  if (spec.startsWith('.') || spec.startsWith('/')) return path.resolve(path.dirname(fromFile), spec).startsWith(ROOT + path.sep);
  return false;
};

const files = [...collect(DAEMON), ...(fs.existsSync(BIN) ? collect(BIN) : [])];
ok('found core runtime modules to scan', files.length > 5, `${files.length} files`);

const violations = [];
for (const f of files) {
  const code = strip(fs.readFileSync(f, 'utf8'));
  for (const re of PATTERNS) { let m; while ((m = re.exec(code))) if (!allowed(m[1], f)) violations.push(`${path.relative(ROOT, f)} → ${m[1]}`); }
}
ok('every import is a Node builtin or an in-repo file (zero external runtime deps)', violations.length === 0, '\n    ' + violations.join('\n    '));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
