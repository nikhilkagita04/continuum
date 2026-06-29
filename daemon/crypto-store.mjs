// crypto-store — encryption at rest for the episode log. AES-256-GCM with a 256-bit data key kept in the
// macOS KEYCHAIN (preferred) or, as an explicitly INSECURE fallback, a 0600 file in DATA_DIR.
//
// HONEST THREAT MODEL (do not overclaim): protects the on-disk store against DEVICE THEFT / OFFLINE
// FORENSICS — *and only meaningfully when the key lives in the keychain*. The file fallback co-locates
// the key with the data and protects almost nothing (it exists so non-macOS/CI still round-trips). It
// does NOT defend a compromised logged-in session or malware running with the user's privileges, and
// episodes are PLAINTEXT in the daemon's address space while indexing. Per-subject crypto-shred (destroy
// one subject by destroying their key) is the deferred advanced version; today deletion is rewriteEpisodes.
//
// Opt-in: config `capture.encryptAtRest` (default OFF for OSS back-compat). Migration-tolerant — a store
// with mixed plaintext + encrypted lines reads fine; new appends are encrypted once the flag is on.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR, loadConfig } from './config.mjs';

const SERVICE = 'continuum', ACCOUNT = 'episode-store-key', PREFIX = 'enc:';

export function encryptionEnabled() {
  try { const c = loadConfig(); return !!(c.capture && c.capture.encryptAtRest); } catch { return false; }
}

// --- key: macOS keychain preferred; 0600 file fallback (INSECURE — key beside the data) ---
function keychainGet() {
  try { return Buffer.from(execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'hex'); }
  catch { return null; }
}
function keychainSet(hex) {
  // `-w` with no value makes `security` read the secret from STDIN — keeps the key out of argv/process
  // list. Falls back to the file key if this fails (older security, no TTY, etc.).
  try { execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-U', '-w'], { input: hex + '\n', stdio: ['pipe', 'ignore', 'ignore'] }); return true; }
  catch { return false; }
}

let _key = null, _src = null;
export function dataKey() {
  if (_key) return _key;
  // CONTINUUM_KEY_FILE=1 forces the file fallback (CI / tests, no keychain prompt)
  if (process.platform === 'darwin' && process.env.CONTINUUM_KEY_FILE !== '1') {
    const existing = keychainGet();
    if (existing && existing.length === 32) { _key = existing; _src = 'keychain'; return _key; }
    const fresh = crypto.randomBytes(32);
    if (keychainSet(fresh.toString('hex'))) { _key = fresh; _src = 'keychain'; return _key; }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = path.join(DATA_DIR, 'store.key');
  try { _key = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex'); if (_key.length !== 32) throw 0; }
  catch { _key = crypto.randomBytes(32); fs.writeFileSync(f, _key.toString('hex'), { mode: 0o600 }); }
  _src = 'file-insecure';
  return _key;
}
export const keySource = () => { dataKey(); return _src; };

// --- AES-256-GCM seal/open of one record (line) ---
export function sealLine(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dataKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export const isEncryptedLine = (line) => typeof line === 'string' && line.startsWith(PREFIX);
export function openLine(line) {
  if (!isEncryptedLine(line)) return JSON.parse(line);   // plaintext — back-compat / migration-tolerant
  const buf = Buffer.from(line.slice(PREFIX.length), 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', dataKey(), iv);
  d.setAuthTag(tag);                                      // GCM auth ⇒ throws on any tamper
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}
