// Strip browser chrome from OCR'd text — the tab strip, bookmarks bar, and nav toolbars that frame
// the actual page content. OCR captures them every frame (and jitters), so they repeat and dilute.
// Gated to BROWSERS only: in a code editor or terminal, short-line runs are real content (code,
// logs), so we must never strip there. The page body (prose, longer lines) is always kept.
const BROWSER = /(chrome|safari|firefox|arc|edge|brave|opera|vivaldi|chromium)/i;
export const isBrowser = (app = '') => BROWSER.test(app);

const wordCount = (line) => (line.match(/[a-z0-9]+/gi) || []).length;
const shortLine = (line) => wordCount(line) > 0 && wordCount(line) <= 3;

// Tab-strip noise: lots of 1-char / "x" tokens (tab close buttons + truncated titles like "Nikh X").
const tabNoise = (line) => {
  const toks = line.split(/\s+/).filter(Boolean);
  if (toks.length < 2) return false;
  const junk = toks.filter((t) => t.length <= 1 || /^x+$/i.test(t)).length;
  return junk / toks.length >= 0.4;
};

// Drop runs of >= runLen consecutive short lines (a toolbar / bookmark bar / nav list) and tab noise.
// Isolated short lines amid prose are kept (they may be real). Returns the cleaned text.
export function stripChrome(text, app, { runLen = 4 } = {}) {
  if (!isBrowser(app)) return text;
  const lines = String(text || '').split(/\n/);
  const drop = new Array(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (shortLine(lines[i])) {
      let j = i; while (j < lines.length && shortLine(lines[j])) j++;
      if (j - i >= runLen) for (let k = i; k < j; k++) drop[k] = true;
      i = j;
    } else i++;
  }
  const kept = [];
  for (let k = 0; k < lines.length; k++) if (!drop[k] && !tabNoise(lines[k])) kept.push(lines[k]);
  return kept.join('\n');
}
