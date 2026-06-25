// Assemble the answer context from retrieved hits. Retrieval gets the right episodes into the top-k
// (hit@5 ~95%), but raw top-k is a poor answer context: this corpus repeats heavily, so the slots fill
// with near-duplicates, and browser chrome residue leaks in. Cleaner, more *diverse* context from the
// same retrieval = more correct, better-grounded answers. Trim chrome → drop near-dups → keep best-
// ranked first → cap.
import { simhash, hamming } from './stage2/segmenter.mjs';
import { stripChrome } from './stage1/chrome.mjs';

export function assembleContext(hits = [], { maxSnippets = 5, near = 6, perSnippet = 420, maxChars = 1500 } = {}) {
  const out = [], sigs = []; let chars = 0;
  for (const h of hits) {
    const ep = h.ep || h;
    let text = stripChrome(ep.text || '', ep.app).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const sh = simhash(text);
    if (sigs.some((s) => hamming(s, sh) <= near)) continue;   // skip a snippet that ~duplicates a kept one
    sigs.push(sh);
    text = text.slice(0, perSnippet);
    if (chars + text.length > maxChars) text = text.slice(0, Math.max(0, maxChars - chars));
    if (!text) break;
    out.push({ ep, text }); chars += text.length;
    if (out.length >= maxSnippets) break;
  }
  return out;
}

export const contextText = (assembled) => assembled.map((s) => s.text).join('\n---\n');
