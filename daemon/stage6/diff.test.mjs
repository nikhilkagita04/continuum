// Stage 6 — temporal scene diffing (#12).
import { overlapLen, stitchLines, stitchScroll, diffScenes } from './diff.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nStage 6 temporal scene diffing\n');

// scroll stitching: overlapping snapshots merge into one continuous text, no duplication
{
  ok('overlapLen finds the shared tail/head', overlapLen(['A', 'B', 'C', 'D'], ['C', 'D', 'E', 'F']) === 2);
  const merged = stitchLines(['A', 'B', 'C', 'D'], ['C', 'D', 'E', 'F']);
  ok('stitchLines de-overlaps', merged.join(',') === 'A,B,C,D,E,F', merged.join(','));
  const text = stitchScroll('intro paragraph\nsection one\nsection two', 'section one\nsection two\nsection three\nconclusion');
  ok('stitchScroll yields continuous text', text === 'intro paragraph\nsection one\nsection two\nsection three\nconclusion', JSON.stringify(text));
  ok('no duplicated overlap line', (text.match(/section two/g) || []).length === 1);
  ok('no overlap → simple concat', stitchLines(['A'], ['B']).join(',') === 'A,B');
}

// scene diff: what appeared / left / stayed across two snapshots
{
  const prev = [{ type: 'social-post', text: 'post one' }, { type: 'social-post', text: 'post two' }];
  const next = [{ type: 'social-post', text: 'post two' }, { type: 'social-post', text: 'post three' }];
  const d = diffScenes(prev, next);
  ok('detects the new region', d.added.length === 1 && d.added[0].text === 'post three', JSON.stringify(d.added));
  ok('detects the removed region', d.removed.length === 1 && d.removed[0].text === 'post one', JSON.stringify(d.removed));
  ok('keeps the unchanged region', d.kept.length === 1 && d.kept[0].text === 'post two');
  ok('changed count = added + removed', d.changed === 2);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
