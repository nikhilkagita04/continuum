// crypto-store — encryption at rest. Run with CONTINUUM_DATA=<tmp> CONTINUUM_KEY_FILE=1 (file-fallback
// key, no keychain prompt). Verifies: ciphertext (no plaintext leak), round-trip, GCM tamper detection,
// legacy-plaintext back-compat, key persistence, and end-to-end (store on disk is ciphertext when on).
import fs from 'node:fs';
import { sealLine, openLine, isEncryptedLine } from './crypto-store.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };
console.log('\ncrypto-store (encryption at rest)\n');

const obj = { app: 'Code', text: 'secret token ghp_ABCDEFG and SHOULDNOTLEAK', n: 42 };
const sealed = sealLine(obj);
ok('seal → ciphertext (enc: prefix, no plaintext leak)', isEncryptedLine(sealed) && !/SHOULDNOTLEAK|ghp_ABCDEFG/.test(sealed), sealed.slice(0, 30));
ok('open round-trips to the original object', JSON.stringify(openLine(sealed)) === JSON.stringify(obj));

// GCM tamper detection — flip the last base64 chunk
const tampered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
let threw = false; try { openLine(tampered); } catch { threw = true; }
ok('tamper detected (GCM auth tag) — open throws', threw);

ok('openLine reads legacy plaintext JSON (migration-tolerant)', JSON.stringify(openLine(JSON.stringify(obj))) === JSON.stringify(obj));
ok('key persists — a second independent seal also opens', JSON.stringify(openLine(sealLine(obj))) === JSON.stringify(obj));

// end-to-end: with encryptAtRest ON, the on-disk store must be ciphertext and still load back
const { readRawConfig, writeRawConfig } = await import('./config.mjs');
const cfg = readRawConfig(); cfg.capture = { ...(cfg.capture || {}), encryptAtRest: true }; writeRawConfig(cfg);
const store = await import('./store.mjs');
store.appendEpisode({ app: 'X', text: 'on-disk secret PLAINTEXTCANARY', content_hash: 'h1', end: 1 });
const raw = fs.readFileSync(store.STORE_FILE, 'utf8');
ok('on-disk store is CIPHERTEXT when encryptAtRest on (no plaintext canary)', /enc:/.test(raw) && !/PLAINTEXTCANARY/.test(raw), raw.slice(0, 40));
ok('loadEpisodes decrypts the store back', store.loadEpisodes().some((e) => e.text === 'on-disk secret PLAINTEXTCANARY'));

// durability (Phase-I review fix): one corrupt/foreign line must be SKIPPED, never empty the whole store
fs.appendFileSync(store.STORE_FILE, 'CORRUPT_NOT_JSON{bad\n');
store.appendEpisode({ app: 'Z', text: 'survives the corrupt line', content_hash: 'h2', end: 2 });
const after = store.loadEpisodes();
ok('a single corrupt line is skipped, not fatal', after.some((e) => e.text === 'survives the corrupt line') && after.some((e) => e.text === 'on-disk secret PLAINTEXTCANARY'));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
