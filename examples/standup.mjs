// Example use case built on the Continuum SDK: generate a standup from today's context.
// This is the kind of thing the shovel makes a 20-line script. Run after `continuum start`
// has captured some activity:  node examples/standup.mjs
import { loadEpisodes } from '../daemon/store.mjs';
import { buildDeps } from '../daemon/config.mjs';

const { llm } = buildDeps();                 // uses whatever provider you configured
const today = loadEpisodes().filter((e) => e.salience > 0.3);

if (!today.length) { console.log('No activity captured yet. Run `continuum start` first.'); process.exit(0); }

const bullets = today.map((e) => `- [${e.app}] ${e.text.slice(0, 160)}`).join('\n');

if (!llm) {
  console.log('Today (raw, no LLM configured):\n' + bullets);
} else {
  const standup = await llm(
    'Turn this raw activity log into a crisp 3-bullet standup: what I worked on, decisions, blockers.',
    bullets, 300,
  );
  console.log(standup);
}
