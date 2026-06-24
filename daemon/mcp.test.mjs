// MCP core logic — recall filters, egress scrub, profile (grounded), catch_up, snapshot.
import { scrub, mapResult, parseSince, recall, catchUp, profile, snapshot } from './mcp.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nMCP core (recall · catch_up · profile)\n');

const now = 1_700_000_000_000;
const E = (app, text, agoH, extra = {}) => ({ app, text, end: now - agoH * 36e5, source_mix: ['ocr'], content_hash: `${app}${agoH}`, label: { type: 'document', owner: 'system' }, ...extra });
const eps = [
  E('Code', 'building the Continuum perception pipeline and scene graph', 50, { label: { type: 'document', owner: 'me' }, source_mix: ['ocr', 'input'] }),
  E('Slack', 'team decided to ship the Continuum dashboard before the graph view', 30, { label: { type: 'message', owner: 'other' } }),
  E('Terminal', 'export TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 then deploy', 6, { content_hash: 'term6' }),
  E('X', 'posting about the Continuum launch and reading replies', 5, { label: { type: 'social-post', owner: 'me' } }),
  E('Zoom', 'we should cut feature X before launch', 2, { source_mix: ['audio'], speaker: 'them', content_hash: 'zoom2' }),
  E('1Password', 'vault token sk-ant-api03-SECRETSHOULDNOTLEAK1234', 1, { content_hash: 'pw1' }),
].sort((a, b) => a.end - b.end); // chronological, like the real append-only store
const idx = { search: async (q, { k = 5 } = {}) => eps.map((ep) => ({ ep, score: 1 })).slice(0, k) };

// egress scrub
{
  const s = scrub('key sk-ant-api03-ABCDEFGHIJKLMNOP12 token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 mail a@b.com num 1234 5678 9012 3456');
  ok('scrub redacts API key', !/sk-ant-api03-ABCDEF/.test(s) && /\[redacted\]/.test(s), s);
  ok('scrub redacts GitHub token', !/ghp_ABCDEF/.test(s));
  ok('scrub redacts PII (email + long number)', /\[email\]/.test(s) && /\[number\]/.test(s), s);
}

// result schema
{
  const r = mapResult(eps.find((e) => e.app === 'Code'), now);
  ok('mapResult schema (when/app/who/type/text/id)', r.when && r.app === 'Code' && r.who === 'you' && r.type === 'document' && typeof r.text === 'string' && r.id.startsWith('ep_'));
  ok('snippet capped <= 280', r.text.length <= 280);
}

// parseSince
ok('parseSince 24h', parseSince('24h', now) === now - 24 * 36e5);
ok('parseSince 7d', parseSince('7d', now) === now - 7 * 864e5);

// recall — filters + egress scrub + exclusions
{
  const all = await recall(idx, eps, { query: 'x', now });
  ok('recall excludes nothing by default but scrubs secrets', all.every((r) => !/ghp_|sk-ant/.test(r.text)), JSON.stringify(all.map((r) => r.text)));
  const excl = await recall(idx, eps, { query: 'x', exclude: ['1Password'], now });
  ok('recall honors app exclusions', excl.every((r) => r.app !== '1Password'));
  const win = await recall(idx, eps, { query: 'x', since: '24h', now });
  ok('recall time filter (since 24h drops older)', win.length >= 3 && win.every((r) => r.app !== 'Slack' && r.app !== 'Code'), `${win.length} ${win.map((r) => r.app)}`);
  const onlySlack = await recall(idx, eps, { query: 'x', apps: ['Slack'], now });
  ok('recall app filter', onlySlack.every((r) => r.app === 'Slack') && onlySlack.length === 1);
  const audio = await recall(idx, eps, { query: 'x', sources: ['audio'], now });
  ok('recall source filter (audio)', audio.length === 1 && audio[0].app === 'Zoom');
}

// catch_up — newest-first, deduped, excludes
{
  const rows = catchUp(eps, { window: 'week', exclude: ['1Password'], now });
  ok('catch_up newest-first', rows[0].app === 'Zoom', rows[0] && rows[0].app);
  ok('catch_up excludes excluded apps', rows.every((r) => r.app !== '1Password'));
  ok('catch_up returns several', rows.length >= 3);
}

// profile — heuristic, grounded, topic-focused
{
  const p = await profile(eps, { exclude: ['1Password'], now });
  ok('profile heuristic without llm', p.kind === 'heuristic');
  ok('profile surfaces recurring entity (Continuum)', p.recurring.includes('Continuum'), JSON.stringify(p.recurring));
  ok('profile voice_samples from the user', p.voice_samples.length >= 1);
  ok('profile is grounded (every source has a citation id)', p.sources.length >= 1 && p.sources.every((s) => s.id.startsWith('ep_')));
  ok('profile never leaks secrets in sources', p.sources.every((s) => !/ghp_|sk-ant/.test(s.text)));
  const pt = await profile(eps, { topic: 'dashboard', exclude: ['1Password'], now });
  ok('profile topic narrows to matching activity', pt.sources.some((s) => /dashboard/i.test(s.text)));
  const pl = await profile(eps, { llm: async () => 'They are building Continuum, an on-device memory tool.', exclude: ['1Password'], now });
  ok('profile synthesizes a brief with an llm', pl.kind === 'synthesized' && /Continuum/.test(pl.brief));
}

// snapshot
{
  const s = snapshot(eps, { exclude: ['1Password'], now });
  ok('snapshot is a compact non-empty brief', typeof s === 'string' && /this user/i.test(s));
  ok('snapshot mentions recurring/app signal', /Continuum|Code|Slack/.test(s), s);
  ok('empty store → null snapshot', snapshot([], { now }) === null);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
