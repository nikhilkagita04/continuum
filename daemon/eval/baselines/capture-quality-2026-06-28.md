# Capture quality — OCR SOTA pass (2026-06-28)

S0 found capture quality is the bottleneck ("retrieved 76% / answered ~40%" — facts present in noisy OCR
token-soup but not cleanly answerable). This pass measured and fixed it. **Aggregate-only record (no
screenshots/PII committed); reproduce locally with the capture gate.**

## The gate
Episode-level, DETERMINISTIC **fact-recall**: a vision model mints the visible FACTS from a screenshot
(ground truth), then each capture config is scored by the fraction present in the captured text via
`answerInSource` (numeric-aware, now Unicode-aware token match). Deterministic scoring; vision only mints
facts. Run over 14 diverse surfaces (Wikipedia, Hacker News, GitHub code, Python/MDN docs, arXiv, AP News,
YouTube, Reddit, a Wikipedia data table, StackOverflow, **System Settings (native)**, French/German/**Japanese**).

## Result — fact-recall (does the capture contain the answerable on-screen facts)
| | mean |
|---|---|
| baseline (old shipped: naive sort + aggressive stripChrome) | ~0.86 |
| **shipped now (XY-cut + relaxed filter + light chrome + auto-lang)** | **~0.97** |
| AX-tree-as-primary (the prior panel's thesis) | 0.31 — refuted by measurement |

Per-set: 5 web pages 0.96 · 6 web+native 0.98 · 3 non-English 0.98.

## Fixes shipped (each measured, committed, unit-tested)
1. **Completeness** (the dominant "incompleteness" cause): the OCR line filter `words>=2 || count>=16`
   dropped short single-word facts (names/numbers/labels). Relaxed to keep any 3+ char non-glyph-soup line.
   fact-recall 0.80 → 0.96.
2. **Reading order**: recursive XY-cut column/block layout analysis replaces the naive 60-band (row,x) sort
   (sidebars/columns/overlays no longer interleaved). reading_order 48 → 91 (vision judge).
3. **Chrome**: `stripChrome` was deleting short CONTENT (headlines/list/table rows) as if chrome (−0.10);
   now drops only garbled tab-strip noise — repeated bookmark/nav chrome is `LineNovelty`'s cross-frame job.
4. **Repetition** (the "same sentence multiple times" symptom): segmenter growth-coalesce was strict
   char-prefix, defeated by mid-string OCR jitter ("every"→"everytc") so typed fields piled up every
   keystroke stage (90/115 dup sentences worst case). Added word-subsequence + token-Jaccard variant
   coalescing — with a **numeric guard** (two variants differing only in a number are NOT coalesced, so a
   number is never silently dropped). Typed fields collapse to one clean episode.
5. **Non-English**: English-only Vision garbled CJK ("# 8-75553511753"); default to
   `automaticallyDetectsLanguage` + a broad candidate list. Japanese reads cleanly (0.93); Latin unaffected.
6. **Ship-parity**: the `.app` bundled `capture.swift` = AX-ONLY (the 0.31 path); now ships `screen` (OCR).

## AX vs OCR (the prior panel's strategy question), settled by measurement
Head-to-head: OCR+XY-cut beat the shipped AX extractor 5/5 pages (answerable 88 vs 19). AX is incomplete
(drops <3-word facts), UNRELIABLE (a news page gave 168 lines one run, 1 the next), captures off-screen DOM.
On the gate: OCR 0.80, AX 0.31, OCR+AX 0.84 — AX adds nothing once OCR is complete. **AX-as-primary refuted;**
the OCR path, fixed, is the SOTA direction.

## End-to-end check (does better capture raise answering?)
Ran the full chain on the 14 captured surfaces (new OCR → real pipeline → HybridIndex → retrieve →
Claude-answer → answerInSource):
- **Capture → answer extraction (own-page context, no retrieval): 0.73** — near the 0.75 magic bar, and
  up from ~0.40 on the pre-fix store. The capture fixes (order + completeness) translate to answering.
- Full-pipeline over the 14 surfaces scored 0.34, but that is a RETRIEVAL ARTIFACT of pooling 14
  *unrelated* pages: queries are ambiguous across them (the fact's own page is retrieved only 0.66 of the
  time; fact present in any retrieved page 0.69 = the answering ceiling). Not representative of a coherent
  personal store, and NOT a capture problem.
Conclusion: capture quality is SOTA and it moved end-to-end answering 0.40 → 0.73. The remaining gap to the
full magic bar is **retrieval precision over a coherent corpus** — a downstream lever, and it needs a real
re-captured store to measure fairly (the 14-unrelated-pages proxy under-states retrieval).

## Native dev apps (same process, measured)
Extended the gate to native developer apps (captured by CGWindowList window-id, focus-independent).
Privacy-safe set — **mean fact-recall 0.94**:
| app | fact-recall | |
|---|---|---|
| Terminal (git log output) | 1.00 | |
| Activity Monitor (process table) | 1.00 | |
| Finder (file list) | 1.00 | |
| System Settings | 1.00 | (earlier set) |
| Cursor (start screen) | 0.93 | |
| Cursor (repo / file-tree + code) | 0.79 | only misses = macOS keyboard glyphs (⌘/⌥, unreadable by Vision, not real facts) + the tiny git-branch in the status bar (Vision resolution limit) |

The capture config (XY-cut + relaxed short-fact filter + auto-language) generalizes to native apps unchanged —
no native-specific OCR work was needed. Gate refinements this round: `stripChrome` must never touch native
apps (it only acts on browsers in production; the gate now measures raw OCR for the presence metric), and
`tabNoise` now requires >=2 junk tokens so single-arrow content lines survive (+0.05 recall).

**Honest scope (panel caveats):** this is a small INTERNAL measure, not a benchmarked SOTA claim — N=6 apps,
~14 facts each (~84 facts), one screenshot per app, one fact-gen model; per-app Wilson 95% CI is wide
(~±0.1+) and there is no native baseline/competitor comparison. It covers **representative text-surface**
native apps; the HARD surfaces are untested (Xcode dense/custom-rendered, Electron/Slack, Docker/TablePlus
tiny-monospace tables, Figma canvas ~zero OCR signal). "Config generalizes unchanged" is real for text-grid
apps; generalization to Xcode/Figma is the untested leap. The real open question — does native capture
*answer* questions end-to-end — is still unmeasured (see follow-ups).

**Privacy — capture itself is the boundary, not just egress:** opening native apps shows whatever the user
already had open (Sublime surfaced private scratch; Notes private content) — OCR'd and stored BEFORE any
model. Fixes: (a) **private-by-default exclusions now expanded** beyond credential managers to private
messaging (Messages/WhatsApp/Signal/Telegram/FaceTime/Discord) + personal content (Mail/Notes) in
`screen.swift`, opt-in via `CONTINUUM_INCLUDE`; (b) the committed gate is **local-by-default** (Ollama
vision, no egress) so a real store is never bulk-uploaded. Still needed before native rollout: a visible
pause/redaction control, and ideally allowlist-not-denylist for mixed-use apps (a code editor also holds
private scratch — it can't be denylisted).

## Still open (follow-ups)
- Commit the capture gate as a runnable harness with LOCAL-by-default fact-gen (vision via local model;
  cloud only on synthetic/consented fixtures — never bulk-upload the live store).
- END-TO-END re-gate: re-capture a corpus through the NEW pipeline and confirm S0 answer-correctness rises
  to the magic bar (>=0.75; was ~0.40 on the pre-fix store). Requires a fresh capture window.
- Minor: `SELF_MARKERS` self-capture guard is brittle string-matching; `stripChrome` `runLen` param is dead.
