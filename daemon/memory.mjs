// Tier-2 consolidated memory — the small, durable markdown files an agent reads to UNDERSTAND the
// user (about / projects / people / taste / decisions / preferences), distilled from the episodic
// firehose by the dreaming pass. File-native (agents are great at files), grounded in episode ids,
// and READ-ONLY to agents — written only by Continuum's own dreaming + human curation, so a
// prompt-injected agent can never poison it (the failure mode agent memory stores warn about).
//
// Production primitives, mirrored from agent memory stores: immutable versions (audit + rollback),
// content-hash preconditions (optimistic concurrency for the future team layer), and redact.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { contentHash } from './stage2/segmenter.mjs';

export const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const VLOG = path.join(MEMORY_DIR, '.versions.jsonl');
const VDIR = path.join(MEMORY_DIR, '.versions');
const sha = (s) => contentHash(s || '');
const ensure = () => fs.mkdirSync(VDIR, { recursive: true });

export function listMemory() {
  try { return fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
}
export function readMemory(name) { try { return fs.readFileSync(path.join(MEMORY_DIR, name), 'utf8'); } catch { return ''; } }

// The whole consolidated memory as one block (for profile() / the MCP initialize instructions).
export function memoryBlock({ only, max = 8000 } = {}) {
  const files = (only ? [].concat(only) : listMemory());
  let out = '';
  for (const f of files) { const c = readMemory(f).trim(); if (!c || /\(nothing yet\)/.test(c)) continue; out += (out ? '\n\n' : '') + c; if (out.length >= max) break; }
  return out.slice(0, max);
}

// Write a memory file + record an immutable version. Optional content-hash precondition (CAS).
export function writeMemory(name, content, { reason = '', source = 'dream', expectSha = null } = {}) {
  ensure();
  const file = path.join(MEMORY_DIR, name);
  const prev = readMemory(name);
  const prevSha = sha(prev);
  if (expectSha != null && prevSha !== expectSha) return { ok: false, conflict: true, sha: prevSha };   // someone wrote first
  const body = content.endsWith('\n') ? content : content + '\n';
  if (sha(body) === prevSha) return { ok: true, unchanged: true, sha: prevSha };
  fs.writeFileSync(file, body);
  const id = 'memver_' + sha(name + body + Date.now());
  fs.writeFileSync(path.join(VDIR, id + '.md'), body);
  fs.appendFileSync(VLOG, JSON.stringify({ id, name, sha: sha(body), prevSha, source, reason, op: prev ? 'update' : 'create', t: Date.now() }) + '\n');
  return { ok: true, id, sha: sha(body) };
}

// Immutable version history (newest first), point-in-time read, and rollback.
export function versions(name) {
  try { return fs.readFileSync(VLOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((v) => !name || v.name === name).reverse(); } catch { return []; }
}
export function readVersion(id) { try { return fs.readFileSync(path.join(VDIR, id + '.md'), 'utf8'); } catch { return null; } }
export function rollback(name, id, { reason = 'rollback' } = {}) { const c = readVersion(id); if (c == null) return { ok: false }; return writeMemory(name, c, { reason: `${reason} → ${id}`, source: 'human' }); }

// Redact a past version's snapshot in place (compliance / secret scrub) while keeping the audit trail.
export function redactVersion(id) {
  try { fs.writeFileSync(path.join(VDIR, id + '.md'), '[redacted]\n'); return { ok: true }; } catch { return { ok: false }; }
}

export function memoryTree() {
  return listMemory().map((f) => ({ file: f, sha: sha(readMemory(f)), chars: readMemory(f).length }));
}
