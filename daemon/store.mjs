// Persistence — a simple append-only NDJSON episode log. Decouples the capture daemon
// from the query interfaces (CLI / MCP / dashboard): capture appends, readers rebuild
// the index. Local-first, debuggable, greppable.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { HybridIndex } from './stage3/index.mjs';
import { encryptionEnabled, sealLine, openLine } from './crypto-store.mjs';

export const STORE_FILE = path.join(DATA_DIR, 'episodes.ndjson');

// One line on disk = one episode. Encrypted (AES-256-GCM) when capture.encryptAtRest is on, else plain
// JSON; reads handle both (openLine), so turning it on is non-destructive and a mixed store still loads.
const encodeLine = (ep) => (encryptionEnabled() ? sealLine(ep) : JSON.stringify(ep));

export function appendEpisode(ep) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(STORE_FILE, encodeLine(ep) + '\n');
}

export function loadEpisodes() {
  let raw;
  try { raw = fs.readFileSync(STORE_FILE, 'utf8'); } catch { return []; }
  // Per-line decode: skip a single corrupt / foreign-key / truncated line — NEVER let one bad byte read
  // the whole episode store as empty (silent total memory loss). Durability over strictness.
  const out = [];
  for (const line of raw.split('\n')) { if (!line) continue; try { out.push(openLine(line)); } catch { /* skip one bad line */ } }
  return out;
}

export async function loadIndex(embed) {
  const idx = new HybridIndex({ embed });
  for (const ep of loadEpisodes()) await idx.add(ep);
  return idx;
}

// Rewrite the store keeping only episodes for which keepFn is true. Returns # remaining.
// Used by the dashboard's delete / clear controls (the trust center).
export function rewriteEpisodes(keepFn) {
  const kept = loadEpisodes().filter(keepFn);
  fs.writeFileSync(STORE_FILE, kept.map(encodeLine).join('\n') + (kept.length ? '\n' : ''));
  return kept.length;
}
