// Capture-quality gate — does the OCR capture actually CONTAIN the answerable facts on screen?
//
// For each screenshot: a vision model mints the visible {q, a} FACTS (a = a short literal on-screen
// string); we OCR the image with the SAME config the daemon ships (daemon/stage1/ocr-image, built from
// ocr-image.swift == screen.swift's ocr()), then score DETERMINISTIC fact-recall = fraction of facts
// present in the captured text via answerInSource (numeric + Unicode aware). Deterministic scoring; the
// vision model is used ONLY to mint ground-truth facts.
//
// LOCAL-BY-DEFAULT: fact-gen runs on a local Ollama vision model (no egress). Cloud (Gemini, more
// accurate) is OPT-IN via CONTINUUM_CAPTURE_JUDGE=cloud — use it only on SYNTHETIC/CONSENTED fixtures,
// never bulk-upload a real personal store.
//
// Build the OCR tool once:  swiftc daemon/stage1/ocr-image.swift -o daemon/stage1/ocr-image
// Run:  node daemon/eval/capture-quality.mjs <screenshots-dir>
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerInSource } from './measure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OCR_BIN = process.env.CONTINUUM_OCR_BIN || path.join(ROOT, 'daemon/stage1/ocr-image');
const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { console.error('usage: node daemon/eval/capture-quality.mjs <screenshots-dir>'); process.exit(2); }
if (!fs.existsSync(OCR_BIN)) { console.error(`OCR tool missing: build it →\n  swiftc daemon/stage1/ocr-image.swift -o daemon/stage1/ocr-image`); process.exit(2); }

const FACT_PROMPT = `From this SCREENSHOT, list up to 14 specific factual {q,a} pairs a user might later ask about what they
saw, where "a" is a SHORT literal string VISIBLE on screen (a name, number, title, headline, label, date, code token).
Spread them across the page (nav, body, sidebars, lists, tables, footer). Reply ONLY a JSON array: [{"q":"...","a":"..."}].`;

const parseFacts = (txt) => { try { return JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1)); } catch { return []; } };

// LOCAL: Ollama multimodal model (default). CLOUD: Gemini vision (opt-in, more accurate, egresses image).
async function mintFactsLocal(imgPath, model = process.env.CONTINUUM_VISION_MODEL || 'gemma3:4b') {
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const r = await fetch('http://localhost:11434/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: FACT_PROMPT, images: [b64] }] }) });
  const j = await r.json(); return parseFacts(j.message?.content ?? '');
}
async function mintFactsCloud(imgPath, model = 'gemini-2.5-pro') {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('GEMINI_API_KEY required for cloud judge');
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', { method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 6000, messages: [{ role: 'user', content: [
      { type: 'text', text: FACT_PROMPT }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] }] }) });
  const j = await r.json(); return parseFacts(Array.isArray(j) ? '' : (j.choices?.[0]?.message?.content ?? ''));
}
const mintFacts = process.env.CONTINUUM_CAPTURE_JUDGE === 'cloud' ? mintFactsCloud : mintFactsLocal;

const shots = fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f)).sort();
console.log(`capture-quality gate · ${shots.length} screenshots · fact-gen=${process.env.CONTINUUM_CAPTURE_JUDGE === 'cloud' ? 'cloud(gemini)' : 'local(' + (process.env.CONTINUUM_VISION_MODEL || 'gemma3:4b') + ')'}\n`);
const recalls = [];
for (const f of shots) {
  const img = path.join(dir, f);
  const cache = `${img}.facts.json`;
  const facts = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : await mintFacts(img);
  if (!fs.existsSync(cache) && facts.length) fs.writeFileSync(cache, JSON.stringify(facts));
  // Measure RAW OCR fact-recall — does the capture CONTAIN the fact? (stripChrome removes browser noise,
  // not facts, and applies only to browsers in production, so it's out of scope for the presence metric.)
  let text = ''; try { text = execFileSync(OCR_BIN, [img], { encoding: 'utf8', maxBuffer: 1e7 }); } catch {}
  const present = facts.filter((x) => answerInSource(x.a, text)).length;
  const r = facts.length ? present / facts.length : 0; recalls.push(r);
  console.log(`  ${f.padEnd(22)} facts ${String(facts.length).padStart(2)} · fact-recall ${r.toFixed(2)}`);
}
const mean = recalls.length ? recalls.reduce((s, x) => s + x, 0) / recalls.length : 0;
console.log(`\n  MEAN fact-recall  ${mean.toFixed(2)}   (does the capture contain the answerable on-screen facts)`);
