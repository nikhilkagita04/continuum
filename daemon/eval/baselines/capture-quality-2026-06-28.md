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

## AX vs OCR (an earlier open question), settled by measurement
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
Captured **every non-private installed dev app on the machine — at the state it launched in** (9 surfaces this
round, + System Settings 1.00 earlier). **Report the mean split, not a single number** (a skeptic audit flagged
that a combined mean launders trivial states): **0.90 on the 5 genuinely dense working surfaces** (Terminal,
Activity Monitor, Finder, Cursor's code editor, Preview's PDF) — this is the honest headline — vs **0.98 on the
4 light launch states** (Xcode dialog, Android welcome, Console empty, Cursor start). Combined = 0.94, but the
0.90 is the number that matters.
| app (surface) | fact-recall | notes |
|---|---|---|
| Terminal (git log output) | 1.00 | |
| Activity Monitor (process table) | 1.00 | |
| Finder (file list) | 1.00 | |
| System Settings | 1.00 | earlier set |
| Console — **EMPTY "No Messages" state** | 1.00 | new — *light state*: sidebar reports + empty body. NOT a live streaming-log torrent (the real working surface — untested) |
| Xcode — **first-launch component dialog** | 1.00 | new — *light state*: a centered modal (version, 5 SDK rows + sizes). NOT the code editor (needs ~8 GB SDK download — untested) |
| Android Studio — **welcome screen, DARK** | 1.00 | new — *light state*: proves dark-theme dialog chrome renders. NOT the editor with a project open (untested) |
| Cursor (start screen) | 0.93 | |
| Cursor (repo / file-tree + code, DARK) | 0.79 | only misses = macOS keyboard glyphs (⌘/⌥, unreadable by Vision, not real facts) + the tiny git-branch in the status bar (Vision resolution limit) |
| **Preview (PDF — ls(1) man page)** | 0.71 | new — *worst-case dense man-page*; all PROSE reads; the 4 misses are tiny isolated single-char flag glyphs in the left margin (`-@`, `-B` — it got `-A`), the run-on synopsis bracket (`[--color=when]`), and the small title-bar filename. Normal prose/table PDFs are not this dense |

**Read the mean honestly — it mixes dense surfaces with light states.** Of the 9, FIVE are genuinely dense
working surfaces: Terminal git-log, Activity Monitor + Finder tables (all 1.00), Cursor's actual code editor
(0.79), and the Preview PDF (0.71). The other FOUR are *light chrome/dialog/empty* states: Xcode's first-launch
component dialog, Android Studio's welcome screen, Console's empty "No Messages" state, and Cursor's start
screen (0.93–1.00). The 1.00s on Xcode/Android/Console therefore prove the OCR **renders those app types'
chrome — including dark theme — and their dialogs/sidebars**, but do NOT prove a dense Xcode/Android editor in
active use, nor a Console streaming a live log torrent. **The only evidence for a dense IDE *editor* is Cursor
at 0.79** (the lowest real-surface score, and the honest ceiling for "developer staring at a wall of code").
So the headline is not "IDEs are solved" — it's "IDE chrome/dialogs + one real dense code editor read at
0.79–1.00; the heaviest editor states (real Xcode/Android projects) remain the untested leap."

**Additional surfaces captured (window-id, no computer-use)** — bringing the named-app total to **14 native +
3 comms**:
- TextEdit showing Swift code — a *native* plain-text/code editor — **0.92** (misses only code-punctuation
  glyphs Vision approximates: `(_`, `->`, `[`/`]`; every identifier + the fibonacci sequence read). The native
  *editor* class now has TWO independent confirmations (Cursor 0.79 Electron + TextEdit 0.92 AppKit).
- **Instruments** — a 24-cell profiling-template **icon grid** (small labels) — **0.93**, read in correct
  left→right/top→bottom order (Blank, Activity Monitor, Allocations … Swift Concurrency, System Trace).
- **Font Book** — a **dense 361-typeface grid** (font name + style-count per cell, multilingual samples) —
  **1.00**, 41 lines, every label present.
- **Create ML** — light welcome state — 1.00. · Disk Utility's system-metadata table read 41 lines cleanly
  (kept LOCAL, not egressed — personal disk-image names).

**New surface-type confirmed: dense small-label ICON GRIDS** (Instruments, Font Book) read completely and in
order — the most label-dense native layout, and it's not a problem. Two more apps (Script Editor, Automator)
were launched but only surfaced a file-OPEN dialog showing personal folder names — skipped, not captured.

**Third wave (→ 17 native apps + 3 comms):** Dictionary **1.00**, Shortcuts **0.86** (starter/default shortcuts —
non-private), Grapher OCR-complete (13/13 lines: 2D/3D Graph, Default, Margins, Classic, Polar, Lin-Log … —
its gate 0.00 is a fact-gen ARTIFACT: cloud minted 0 facts on the sparse axis image, not an OCR miss). Full
native list now: Cursor, Terminal, Activity Monitor, Finder, System Settings, Console, Xcode(dialog), Android
Studio, Preview, TextEdit, Disk Utility, Instruments, Font Book, Create ML, Dictionary, Shortcuts, Grapher.

**Gate-design caveat found this wave: the LOCAL (no-egress) gemma3 scorer is UNRELIABLE on sparse surfaces** —
it scored Dictionary 0.00 where cloud (Gemini) scored 1.00, because gemma3 hallucinates facts not on a
near-empty screen and `answerInSource` (correctly) can't match them. The OCR was fine both times. Implication:
the privacy-safe local scorer is OK for dense surfaces but UNDER-reports on sparse ones; trustworthy gating of
the live store still needs a better local vision model, or cloud on consented fixtures only. Logged as a
follow-up — it's a property of the SCORER, not the capture.

**The one surface I could NOT reach, and why (honest):** a real **Xcode code editor** with a project. Xcode
re-shows its first-launch component-install dialog as a MODAL on every launch; every CLI path (`open -a Xcode
file`, `xed file`) queues behind it and never reaches the editor, `xcodebuild -runFirstLaunch` needs admin
(can't enter a password), and dismissing the modal needs a click/keypress — but computer-use access timed out
(user away) and Xcode is tier-"click" (no key presses) anyway. Not a punt — a real wall. Mitigant: Xcode's source
editor is native AppKit text (crisp, high-contrast, standard font) which Vision reads at least as well as
Cursor's Electron canvas (0.79), so the residual risk that *Xcode specifically* under-reads is low — but it is
genuinely **unmeasured**. (Also: "Postman" turned out to be a Chrome PWA, i.e. Chromium-rendered — already
covered by the comms fixtures — not the native app.)

Two new findings: (a) **dark IDE themes read fine** — Android Studio (white-on-near-black) scored 1.00 and Cursor's dark
editor 0.79–0.93, so the OCR config is not light-theme-dependent. (b) **Apple Vision needs an OPAQUE background**:
a PDF rendered to PNG with a *transparent* page background (via `sips`) returned ZERO lines, while the SAME PDF
screencaptured from the Preview window (opaque, white-composited) read completely (24 lines). Not a pipeline bug —
`screencapture` always yields opaque window pixels — but a real edge if we ever OCR transparent/alpha assets directly.

**Capture → answer (own-app context, no retrieval): 0.79** across the 70 native facts — ABOVE the 0.75
magic bar (and higher than web's 0.73). So native captures aren't just complete (0.94 presence); they're
clean enough that the agent actually answers. The capture config (XY-cut + relaxed short-fact filter +
auto-language) generalizes to native apps unchanged — no native-specific OCR work was needed. Gate refinements this round: `stripChrome` must never touch native
apps (it only acts on browsers in production; the gate now measures raw OCR for the presence metric), and
`tabNoise` now requires >=2 junk tokens so single-arrow content lines survive (+0.05 recall).

**Honest scope (panel caveats):** this is an INTERNAL measure, not a benchmarked SOTA claim — N=9 apps this
round, ~13 facts each, one screenshot per app, one fact-gen model; per-app Wilson 95% CI is wide (~±0.1+) and
there is no native baseline/competitor comparison. Every non-private installed dev app was captured, but **at
whatever state it launched in** — and for Xcode/Android Studio/Console that was a dialog / welcome / empty
state, NOT their dense working surface. So what's genuinely *demonstrated* on hard surfaces is narrower than the
app list suggests: a real dense **code editor** (Cursor, 0.79 — and only Cursor; Xcode/Android editors are
untested), dense **tables** (Activity Monitor, Finder, Terminal — all 1.00), a **PDF document** (Preview, 0.71),
and that **dark chrome renders** (Android welcome + Cursor dark). The honest gain over the prior round is the
PDF surface, the dark-theme confirmation, and confidence that *launching* any installed dev app captures its
chrome — NOT a claim that IDEs-under-load are solved (they aren't measured).

**Genuinely still untested (and why):** (1) a **dense code editor with a real open project** — Xcode here is
only at its first-launch component dialog (the editor needs ~8 GB of SDK components to download); Cursor covers
this class but Xcode's own custom editor rendering is unconfirmed. (2) **Canvas/design tools (Figma)** — not
installed; and these inherently carry near-zero extractable OCR text (a real product limitation, not a fixable
bug — a design canvas mostly isn't text). (3) **Comms apps (Mail/Messages/WhatsApp/Slack)** — installed but
*deliberately not captured from the real accounts* (private-by-default; capturing the live inbox would repeat
the privacy incident below). **Now validated via SYNTHETIC fixtures instead — see the Comms section below.**
(4) **Tiny isolated glyphs / run-on flag strings**
(the Preview man-page misses) are an Apple-Vision resolution limit, not a filter bug.

**Privacy — capture itself is the boundary, not just egress:** opening native apps shows whatever the user
already had open (Sublime surfaced private scratch; Notes private content) — OCR'd and stored BEFORE any
model. Fixes: (a) **private-by-default exclusions now expanded** beyond credential managers to private
messaging (Messages/WhatsApp/Signal/Telegram/FaceTime/Discord) + personal content (Mail/Notes) in
`screen.swift`, opt-in via `CONTINUUM_INCLUDE`; (b) the committed gate is **local-by-default** (Ollama
vision, no egress) so a real store is never bulk-uploaded. Still needed before native rollout: a visible
pause/redaction control, and ideally allowlist-not-denylist for mixed-use apps (a code editor also holds
private scratch — it can't be denylisted).

## Comms surfaces (synthetic fixtures — privacy-safe, and representative)
The real Mail/Messages/WhatsApp/Slack are private-by-default and were NOT captured. Instead, validated the comms
surface *class* on three synthetic HTML fixtures (no PII) rendered with **Chrome headless at 2× scale**. This is
not a cop-out for representativeness: **Slack, Discord, and WhatsApp Desktop are Electron (Chromium), and Gmail
is web** — so Chromium-rendered pixels are essentially what those real apps draw.

| fixture | surface stressed | fact-recall | |
|---|---|---|---|
| iMessage-style thread | **alternating L/R chat bubbles** (the reading-order risk) | 1.00 | |
| Gmail inbox | dense list rows (sender · subject · time columns) | 1.00 | |
| Slack channel | sidebar + main column, sender/timestamp/code/threads | 0.93 | only miss = the `👍 3` emoji reaction count |

**fact-recall 0.98** — but the real test was **reading order + relational answering**, and both passed:
- **Chat order is PRESERVED.** The alternating L/R bubbles read in correct conversational order top→bottom.
  XY-cut does NOT scramble them into all-left-then-all-right, because the bubbles overlap the horizontal center
  so there is no clean vertical gutter to (wrongly) column-split on. The big risk for chat OCR — out-of-order
  turns — does not occur.
- **Relational answering = 10/10 (1.00)**, including the 5 Gmail row-association questions. Gmail's list IS read
  *column-major* (all senders, then all subjects, then all times — a clean inter-column gutter triggers the
  vertical split), which de-interleaves each row. But every column preserves row ORDER, so the answerer re-zips
  by position: "what time did the Stripe email arrive?" → 9:02 AM, "the GitHub one?" → 8:41 AM, both correct.
  So column-major reading does not break answering for uniform lists (it *would* get fragile if a column had a
  missing cell shifting the alignment — noted as a follow-up).
- **Only systematic loss: emoji** (the `🔥`, `👍 3`, `🎉 1` reaction chips). Apple Vision doesn't read emoji
  glyphs, so reaction counts vanish — low-information for recall, not worth a fix.

## Still open (follow-ups)
- **Table/list row-association**: XY-cut reads strong-gutter lists column-major. Recoverable-by-index today (LLM
  re-zips), but fragile if a column has a gap. A row-band-first pass for grid-detected regions would harden it.
- Commit the capture gate as a runnable harness with LOCAL-by-default fact-gen (vision via local model;
  cloud only on synthetic/consented fixtures — never bulk-upload the live store).
- END-TO-END re-gate: re-capture a corpus through the NEW pipeline and confirm S0 answer-correctness rises
  to the magic bar (>=0.75; was ~0.40 on the pre-fix store). Requires a fresh capture window.
- Minor: `SELF_MARKERS` self-capture guard is brittle string-matching; `stripChrome` `runLen` param is dead.
