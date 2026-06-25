// Dreaming — consolidates episodes into Tier-2 memory files, grounded, merging with existing.
// Run with CONTINUUM_DATA=$(mktemp -d). Deterministic: a fake model + fixture episodes.
import { dream, digest } from './dream.mjs';
import { readMemory, listMemory, versions } from './memory.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nDreaming (consolidate episodes → memory)\n');

const E = (ch, app, text, extra = {}) => ({ content_hash: ch, app, text, salience: 0.7, end: 1700000000000, source_mix: ['ocr', 'input'], ...extra });
const eps = Array.from({ length: 12 }, (_, i) => E('h' + i, i % 2 ? 'Claude' : 'Code',
  i % 3 === 0 ? 'building Continuum, a local-first memory layer for Mac, shipping version 0.6'
    : i % 3 === 1 ? 'decided to use RRF fusion with bge-m3 embeddings for retrieval'
      : 'prefer concise answers and Apple-minimal design with no clutter'));

// fake model: echoes a grounded line per section, citing an evidence id it was given
const fakeLLM = async (system, user) => {
  const id = (user.match(/\[(ep_[a-z0-9]+)\]/) || [])[1] || 'ep_h0';
  const title = (system.match(/starting with the line "# ([A-Za-z]+)"/) || [])[1] || 'Section';
  if (/nothing real to say/.test(system) && /NOEVIDENCE/.test(user)) return `# ${title}\n(nothing yet)`;
  return `# ${title}\nContinuum is a local-first memory layer the user is building (${id}).`;
};

{
  const d = await dream({ episodes: eps, llm: fakeLLM });
  ok('dream completes and reports written files', d.ok && d.written.length >= 4, JSON.stringify(d));
  ok('writes the about section, grounded with an episode id', /Continuum/.test(readMemory('about.md')) && /\(ep_/.test(readMemory('about.md')));
  ok('writes projects/people/taste/decisions', ['projects.md', 'people.md', 'taste.md', 'decisions.md'].every((f) => listMemory().includes(f)));
  ok('stamps provenance (dreamed date · N moments)', /dreamed \d{4}-\d{2}-\d{2} · grounded in 12 moments/.test(readMemory('about.md')));

  // second pass merges + versions (doesn't pile up)
  await dream({ episodes: eps, llm: fakeLLM });
  ok('a second dream records a new version (merge, not append)', versions('about.md').length >= 1);
}

// graceful degradation
ok('no model → clear error', (await dream({ episodes: eps })).error?.includes('model'));
ok('too few episodes → clear error', (await dream({ episodes: eps.slice(0, 3), llm: fakeLLM })).error?.includes('not enough'));

// digest grounding
ok('digest tags every moment with an id', digest(eps).split('\n').every((l) => /^\[ep_/.test(l)));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
