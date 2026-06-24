# Capture quality — design & contributor guide

Status: open for contributions · Last updated: 2026-06-23

The honest state of v0: **OCR capture is universal and works on every app, but it captures the
whole screen** — so an episode fuses what *you* wrote with the surrounding UI and other people's
content, and it can't attribute "who said what." This doc is the design for fixing that, and the
guardrails for *how*, so contributions don't go down a fragile path.

## The principle (read this first)

**Prefer stable, semantic interfaces over brittle structural ones — and push "understanding"
into a model, not into per-site parsers you maintain forever.** Robustness comes from
generalization, not hand-coded structure.

### ❌ Anti-pattern: per-site DOM / selector scraping
Do **not** build the capture foundation on scraping site DOMs (CSS selectors, class names).
- Class names are implementation details — sites change them every redesign.
- X actively obfuscates + randomizes them and fights scrapers.
- It's N fragile integrations to maintain forever — an integration treadmill.

A documented, **versioned API** with a contract (Gmail, Slack) is fine as an *optional enhancer*.
Scraping a volatile web UI is not, and never as the foundation.

## The layered architecture (what we're building toward)

| Layer | Role | Stability |
|-------|------|-----------|
| **1. OCR (Vision)** | universal floor — captures what's on screen in *any* app | rock-solid (pixels don't break on redesign) |
| **2. AX focused-element** | the clean **user-authored** signal (`AXFocusedUIElement` value = what you typed) | high — accessibility is a maintained contract (ADA/WCAG), keyed on focus+role not class names |
| **3. LLM structuring pass** | reads the messy OCR/AX capture and labels it semantically (your reply vs. original post vs. chrome/noise) | high — understands *meaning*, so a UI redesign doesn't break it |
| **4. Stable APIs** | optional enrichers where a versioned contract exists (calendar, email) | only as enhancers, never the base |

Why this works: your authored text comes from the *narrow, stable* signal (focused field);
"who-said-what" context comes from the universal capture + a model. No brittle selectors anywhere.

## Where contributors can help

See the issues tagged **`good first issue`** and **`help wanted`**. The high-leverage ones:

1. **AX focused-element capture** — emit the focused textbox value as a distinct `source: "input"`
   CaptureEvent (clean "user authored this"), alongside the OCR of the page. Solves "isolate my reply"
   without any DOM scraping. (Swift, in `daemon/stage1/`.)
2. **LLM structuring pass** — a Stage-4 step that turns a raw OCR episode into structured fields
   (author, content, app, noise dropped). Injectable LLM, runs at distill time.
3. **Browser-chrome reduction** — crop the top toolbar/tab/bookmark band before OCR for browser
   windows (reduces the tab-strip prefix noise). Heuristic, keep it conservative.
4. **Tighter episode segmentation** — current OCR episodes can be large/bloated; tune Stage-2
   thresholds and dedup so episodes are focused.
5. **Self-capture exclusion** — skip Continuum's own dashboard/terminal windows.

## Ground rules for capture PRs
- Keep the core **source-agnostic**: new sources emit the same `CaptureEvent` contract; the
  pipeline shouldn't care where text came from.
- **On-device + private by default.** No capture path should send raw screen data off the machine.
- **No new runtime dependencies** in the core without discussion.
- Respect the redaction boundary: secure fields are never captured; PII is redacted before persist.

See [`ingestion-pipeline.md`](ingestion-pipeline.md) for the full pipeline design.
