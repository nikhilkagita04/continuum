# Capture quality — design, quality model & contributor guide

Status: open for contributions · Last updated: 2026-06-24

Capture quality **is** the product. Everything downstream — search, ask, the graph, the daily
digest — is bounded by what we capture and how cleanly. A perfect retrieval stack over noisy capture
is still noise. This doc defines what "SOTA quality" means *measurably*, the levers for screen and
audio, and the guardrails so contributions don't go down a fragile path.

## The principle (read this first)
**Prefer stable, semantic interfaces over brittle structural ones — and push "understanding" into a
model, not into per-site parsers you maintain forever.** Robustness comes from generalization.

### ❌ Anti-pattern: per-site DOM / selector scraping
Do not build capture on scraping site DOMs (CSS selectors, class names). Class names are
implementation details that change every redesign; some sites actively obfuscate them; it's N fragile
integrations forever. A documented, versioned API (calendar, mail) is fine as an *optional enhancer* —
never the foundation.

## The quality model (what "SOTA" means — and how we measure it)
A memory layer is best-in-class when retrieval is **faithful, complete, clean, attributed, structured,
and private.** That decomposes into seven measurable dimensions:

| # | Dimension | Question | Metric |
|---|---|---|---|
| 1 | **Fidelity** | Did we capture what was actually on screen / said, correctly? | OCR CER/WER · ASR WER |
| 2 | **Coverage** | Did we capture the moment *at all* (no missed window/app/utterance)? | miss-rate on a scripted session |
| 3 | **Signal-to-noise** | Is the episode *content*, not chrome/ads/nav/dedup-spam? | % content tokens vs UI tokens (labeled fixtures) |
| 4 | **Attribution** | Who authored/said it (you vs page vs other), which app, when? | author/speaker label accuracy |
| 5 | **Structure** | Is it distilled to meaning (summary, entities, decisions), not a text dump? | extraction precision/recall |
| 6 | **Segmentation** | Are episodes coherent units (one task/turn), not bloated fusions or fragments? | boundary F1 vs labeled task boundaries |
| 7 | **Privacy precision** | Did we correctly *exclude* what we shouldn't capture? | false-capture rate on secure fixtures |

The end-to-end metric that subsumes all of them: **retrieval answer accuracy** over captured memory
(a LongMemEval-style eval). The seven above tell you *why* it's good or bad.

## The layered capture architecture
| Layer | Role | Stability |
|---|---|---|
| **1. OCR (Vision)** | universal floor — anything on screen, any app | rock-solid (pixels don't break on redesign) |
| **2. AX (accessibility tree)** | the clean *semantic* signal: focused field (what you typed) **and** main content region | high — AX is a maintained contract (ADA/WCAG), keyed on focus/role, not class names |
| **3. LLM structuring** | reads messy OCR/ASR and labels meaning (your reply vs thread vs chrome; decisions; entities) | high — understands *meaning*, survives redesigns |
| **4. Stable APIs** | optional enrichers where a versioned contract exists (calendar, mail) | enhancers only, never the base |

Authored text comes from the *narrow, stable* signal (focused field); "who-said-what" context comes
from universal capture + a model. No brittle selectors anywhere.

## Screen quality levers
v0 already does: retina 2× capture, reading-order OCR, browser-chrome crop, role/length filtering,
perceptual-hash change detection, AX focused-input, self-capture exclusion. The SOTA upgrades:

- **S1 · AX content-region capture (highest leverage).** Use the AX tree to find the *main content*
  element (web area / document / text view) and capture **that**, dropping toolbars, sidebars, tab
  strips, ads. Fall back to full-window OCR when AX is unavailable. Attacks SNR + segmentation at the
  root. *(dims 3, 6)*
- **S2 · Content-aware change detection.** The 8×8 average-hash is coarse (misses subtle text changes,
  over-fires on cursor blink/animation). Hash the *OCR text* of the content region, debounce, capture
  on scroll-settle and immediately on focus/window change. Capture meaningful new text, not "pixels
  moved." *(dims 1, 2, 3)*
- **S3 · Scroll stitching.** Scrolling a long doc/thread today yields disjoint snapshots that dedup
  fragments or drops. Detect scroll and stitch overlapping OCR by matching trailing/leading lines, so
  a long article/thread is one coherent episode. *(dims 2, 6)*
- **S4 · OCR confidence & language.** Drop low-confidence Vision observations; set
  `recognitionLanguages` from locale + autodetect; filter single-glyph/icon-label noise. *(dims 1, 3)*
- **S5 · LLM structuring (Layer 3).** At distill, turn raw OCR into `{summary, authored, others,
  app_context, entities, decisions}` and drop noise — resolving "your reply vs the thread"
  *semantically*, no DOM scraping. Feeds the graph. *(dims 4, 5)*
- **S6 · Layout-aware reading order.** Cluster observations into geometric blocks (columns, cards),
  order blocks then lines — so multi-column / card UIs don't interleave. *(dim 1)*
- **S7 · On-screen sensitive-data precision.** Beyond app exclusion + secure-field skip: detect visible
  card/SSN-like patterns and redact before persist; skip private/incognito windows. *(dim 7)*

## Audio quality levers
(Full design in [`audio-capture.md`](audio-capture.md).)
- **A1 · Two-channel capture → free speaker attribution** (mic = you, system = them). The biggest
  audio-quality lever; no diarization model needed. *(dim 4)*
- **A2 · VAD utterance segmentation** — silence-bounded turns: clean boundaries, low latency, no
  mid-word cuts. *(dims 1, 6)*
- **A3 · Tiered transcription** — Apple Speech (on-device default) → WhisperKit → cloud; tune WER. *(dim 1)*
- **A4 · Punctuation/casing restoration** — WhisperKit native, or a distill-time pass for Apple Speech;
  readable transcripts retrieve better. *(dims 1, 5)*
- **A5 · Meeting/noise gating** — VAD + meeting-detection transcribe speech, not music/keyboard. *(dim 3)*
- **A6 · Meeting enrichment** — attach title/participants (calendar API, Layer 4). *(dims 4, 5)*

## The differentiator: cross-modal fusion
Single-modality tools capture either screen *or* audio. The moment you actually want to remember is
**both**: in a meeting you *see* slides/Figma/code while you *hear* the discussion. Fuse them.

Mechanism: the Stage-2 segmenter already keys by window + time. Add **temporal co-windowing** — audio
utterances and screen captures within the same active window/time-bucket merge into one multimodal
episode (`source_mix: ["ocr","audio"]`); distill then synthesizes across modalities ("while reviewing
the Q3 dashboard, the team decided to cut feature X"). Memory of the *whole* moment, not half of it — something a
screen-only or audio-only capture tool structurally cannot reconstruct.

## Measurement — the quality gate (you can't improve what you don't measure)
Quality is regression-tested **locally**, on synthetic/opt-in fixtures — consistent with no-telemetry
(nothing is phoned home). Proposed `continuum eval`:
- **OCR fidelity** — golden screenshots with known text → CER/WER.
- **Capture recall** — a scripted window/edit sequence → did every meaningful state emit an episode? (miss-rate)
- **SNR** — labeled fixtures → % content vs chrome tokens.
- **Segmentation** — labeled task boundaries → boundary F1.
- **ASR WER** — standard speech fixtures, per backend.
- **End-to-end** — a LongMemEval-style Q&A over captured memory (the metric that matters most).
Wire it as a CI-able command so capture changes are gated on quality, not vibes.

## Where contributors can help
High-leverage, mapped to the levers above: **S1** AX content-region capture · **S2** content-aware
change detection · **S3** scroll stitching · **S5** richer LLM structuring + entity/decision
extraction · the **`continuum eval`** harness · the **`audio`** helper (see `audio-capture.md`).

## Ground rules for capture PRs
- Keep the core **source-agnostic** — new sources emit the same `CaptureEvent`; the pipeline doesn't
  care where text came from.
- **On-device & private by default** — no capture path sends raw screen/audio off the machine.
- Respect the redaction boundary — secure fields never captured; PII redacted before persist; **raw
  audio is never written to disk** (transcribe-then-delete).
- **No new runtime dependencies** in the core without discussion.
- Land a fixture/metric with quality-affecting changes where feasible — move a number, don't guess.

See [`perception.md`](perception.md) for the finalized, staged implementation plan (the Screen Scene
Graph), [`ingestion-pipeline.md`](ingestion-pipeline.md) for the full pipeline, and
[`audio-capture.md`](audio-capture.md) for the audio design.
