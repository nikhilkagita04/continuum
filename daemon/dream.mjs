// Dreaming — the out-of-band "second-order process" that curates memory. It reads the episodic
// firehose (+ the existing Tier-2 memory) and VERIFY · ORGANIZE · ENRICH · DEDUP it into the small,
// durable understanding files. Grounded in episode ids, never fabricates, merges with what's already
// there (keeps what holds, drops what's stale/contradicted). Model-agnostic: Ollama (free/local) or a
// frontier model (Pro). Runs between sessions, not on the capture path.
import { loadEpisodes } from './store.mjs';
import { writeMemory, readMemory, MEMORY_DIR } from './memory.mjs';
import { instructionsBlock, activePreferences } from './preferences.mjs';

const epId = (e) => 'ep_' + (e.content_hash || e.end || 0);
const authored = (e) => (e.structured && e.structured.authored) || ((e.source_mix || []).includes('input') ? e.text : '') || ((e.label && e.label.owner === 'me') ? e.text : '');

// The categories of durable understanding — small focused files (memory-store best practice).
export const SECTIONS = [
  { file: 'about.md', title: 'About', ask: 'Write a 2-4 sentence profile of WHO this user is: what they do, what they are building right now, and how they work.' },
  { file: 'projects.md', title: 'Projects', ask: 'The user\'s active projects/work. For each, a name as "## Name" then 1-2 grounded sentences. Only real, recurring projects — not one-offs.' },
  { file: 'people.md', title: 'People', ask: 'Recurring people / orgs the user works with or refers to, each a "- Name — one line on the relationship". Only those that genuinely recur.' },
  { file: 'taste.md', title: 'Taste', ask: 'The user\'s taste and working style — design/aesthetic, how they write, what they like and dislike — inferred from how they actually talk and decide.' },
  { file: 'decisions.md', title: 'Decisions', ask: 'Notable decisions the user has made, each "- Decision — short reason/context". Only clear, real decisions.' },
];

// Compact, grounded evidence digest: the most salient/authored moments, each tagged with its id.
export function digest(episodes, { n = 80, perChars = 170 } = {}) {
  return episodes
    .filter((e) => (e.text || '').length > 40)
    .sort((a, b) => (b.salience || 0) - (a.salience || 0) || (b.end || 0) - (a.end || 0))
    .slice(0, n)
    .map((e) => `[${epId(e)}] (${e.app || '?'}) ${(authored(e) || e.text || '').replace(/\s+/g, ' ').slice(0, perChars)}`)
    .join('\n');
}

const stamp = (body, date, n) => {
  const lines = String(body || '').split('\n');
  return [lines[0] || '', `<!-- dreamed ${date} · grounded in ${n} moments -->`, ...lines.slice(1)].join('\n');
};

export async function dream({ episodes, llm, sections = SECTIONS, now = Date.now() } = {}) {
  episodes = episodes || loadEpisodes();
  if (!llm) return { error: 'dreaming needs a model — set up Ollama (free, local) or add a key for Pro, then retry.' };
  const usable = episodes.filter((e) => (e.text || '').length > 40);
  if (usable.length < 8) return { error: `not enough memory to dream over yet (${usable.length} usable episodes). Run \`continuum start\` for a while.` };

  const ev = digest(usable);
  const date = new Date(now).toISOString().slice(0, 10);
  const written = [];
  for (const s of sections) {
    const existing = readMemory(s.file);
    const sys = `You are curating ONE section of a user's durable memory that AI agents read to understand them. Task: ${s.ask}\n`
      + `Rules: ground every claim ONLY in the evidence; cite the supporting moment ids inline like (ep_…). MERGE with the existing section — keep what still holds, drop what is stale or contradicted. Be concise and specific. Output GitHub markdown starting with the line "# ${s.title}". If there is genuinely nothing real to say, output exactly:\n# ${s.title}\n(nothing yet)`;
    const user = `EXISTING SECTION:\n${existing || '(none)'}\n\nEVIDENCE — the user's recent salient moments (most salient first):\n${ev}`;
    let body;
    try { body = await llm(sys, user, 600); } catch { written.push({ file: s.file, ok: false }); continue; }
    body = String(body || '').trim();
    if (!body) { written.push({ file: s.file, ok: false }); continue; }
    if (!/^#\s/.test(body)) body = `# ${s.title}\n${body}`;
    const r = writeMemory(s.file, stamp(body, date, usable.length), { reason: `dream ${date}`, source: 'dream' });
    written.push({ file: s.file, ...r });
  }

  // preferences.md comes from the (free, no-model) preferences engine — already grounded + human-curated.
  const prefs = instructionsBlock(activePreferences(usable));
  if (prefs) writeMemory('preferences.md', stamp(`# Preferences\n${prefs}`, date, usable.length), { reason: `dream ${date}`, source: 'dream' });

  return { ok: true, date, episodes: usable.length, written: written.filter((w) => w.ok).map((w) => w.file), dir: MEMORY_DIR };
}
