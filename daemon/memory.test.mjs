// Tier-2 memory — versioned writes, content-hash CAS, rollback, redact. Run with CONTINUUM_DATA=$(mktemp -d).
import { writeMemory, readMemory, memoryBlock, versions, readVersion, rollback, redactVersion, listMemory } from './memory.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nTier-2 memory (file-based, versioned)\n');

const a = writeMemory('about.md', '# About\nBuilding Continuum, a local-first memory layer.', { reason: 'dream 1', source: 'dream' });
ok('write creates the file + a version', a.ok && a.id && readMemory('about.md').includes('Continuum'));
ok('listed in the memory tree', listMemory().includes('about.md'));

const b = writeMemory('about.md', '# About\nBuilding Continuum and shipping 0.6.x.', { reason: 'dream 2' });
ok('an edit creates a new version', b.ok && b.id !== a.id);
ok('two versions recorded, newest first', versions('about.md').length === 2 && versions('about.md')[0].op === 'update');

ok('rewriting identical content is a no-op', writeMemory('about.md', readMemory('about.md')).unchanged === true);

// content-hash CAS
ok('CAS rejects a stale write', writeMemory('about.md', '# About\nclobber', { expectSha: a.sha }).conflict === true);
ok('CAS accepts a write against the current sha', writeMemory('about.md', '# About\nfresh', { expectSha: b.sha }).ok === true);

// rollback to the first version's content
const v1 = versions('about.md').reverse()[0];   // oldest
rollback('about.md', v1.id);
ok('rollback restores an earlier snapshot', readMemory('about.md').includes('shipping 0.6.x') || readMemory('about.md').includes('local-first memory layer'), readMemory('about.md'));

// redact a snapshot
ok('redact scrubs a version snapshot', redactVersion(v1.id).ok && readVersion(v1.id).includes('[redacted]'));

// memoryBlock concatenates, skips "(nothing yet)"
writeMemory('people.md', '# People\n(nothing yet)');
writeMemory('projects.md', '# Projects\n## Continuum\nThe memory layer.');
const block = memoryBlock();
ok('memoryBlock concatenates real files', /About/.test(block) && /Continuum/.test(block));
ok('memoryBlock skips empty "(nothing yet)" files', !/nothing yet/.test(block));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
