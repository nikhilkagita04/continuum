// Strip browser chrome from OCR'd text — the tab strip, bookmarks bar, and nav toolbars that frame
// the actual page content. OCR captures them every frame (and jitters), so they repeat and dilute.
// Gated to BROWSERS only: in a code editor or terminal, short-line runs are real content (code,
// logs), so we must never strip there. The page body (prose, longer lines) is always kept.
const BROWSER = /(chrome|safari|firefox|arc|edge|brave|opera|vivaldi|chromium)/i;
export const isBrowser = (app = '') => BROWSER.test(app);

const wordCount = (line) => (line.match(/[a-z0-9]+/gi) || []).length;
const shortLine = (line) => wordCount(line) > 0 && wordCount(line) <= 3;

// Tab-strip noise: a row of tab close-buttons + truncated titles ("Nikh X Cont X Gmai X") OCRs as many
// 1-char / "x" tokens. Require BOTH a high junk ratio AND >=2 junk tokens, so a genuine garbled tab strip
// is caught but a short content/nav line with a single arrow-misread ("U.S. v", "For Business +") is kept
// — the single-junk case was costing ~0.05 fact-recall.
const tabNoise = (line) => {
  const toks = line.split(/\s+/).filter(Boolean);
  if (toks.length < 2) return false;
  const junk = toks.filter((t) => t.length <= 1 || /^x+$/i.test(t)).length;
  return junk >= 2 && junk / toks.length >= 0.4;
};

// Per-frame chrome removal does ONLY what's unambiguous junk: drop garbled tab-strip noise (OCR misreads
// of truncated tab titles + close buttons — "Nikh X", "Cont X"). The bookmark/nav bar is real short text
// that REPEATS every frame, so CROSS-FRAME LineNovelty is the correct tool for it (captured once as
// context, then suppressed) — not per-frame line-length heuristics. The old short-line-run strip measured
// at −0.10 fact-recall because line length cannot tell chrome ("WORLD", "U.S.") from short CONTENT
// ("Iran war", "World Cup 2026", post metadata, table cells) — it deleted real facts on feed/list/table
// pages, exactly the user's main apps (LinkedIn, X). `runLen` kept for back-compat; unused.
export function stripChrome(text, app, { runLen = 4 } = {}) {
  if (!isBrowser(app)) return text;
  return String(text || '').split(/\n/).filter((l) => !tabNoise(l)).join('\n');
}
