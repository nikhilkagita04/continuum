# Perception — turning the screen (and sound) into a semantic scene

Status: **finalized for implementation** · 2026-06-24

Continuum should perceive a screen the way a person does: not as pixels or a flat string, but as a
**hierarchical semantic scene** — *this is a document, that's an AI chat, that's a post with a reply
nested under it, that's the box I'm typing in* — and bind what it **hears** to what it **sees** on one
clock. This doc is the implementation-ready design, reviewed against the state of the art, staged with
a clear *before → after* per step. It is the perception layer that feeds
[`ingestion-pipeline.md`](ingestion-pipeline.md); quality metrics live in
[`capture-quality.md`](capture-quality.md); audio specifics in [`audio-capture.md`](audio-capture.md).

## 0. Grounding (how human perception actually works)
- **Gestalt grouping** (proximity, similarity, common-region, figure/ground) segments a screen into
  regions *before* reading — so our unit is a **region**, not a window.
- **Schemas** let people instantly *type* a region (doc / chat / post / composer) — the "what is what."
- **Figure-ground + visual hierarchy** give **ownership** (mine vs theirs) and **nesting** (reply under post).
- **Attention / reading order** (F/Z, foveal) weight the *active* region — capture should too (salience).
- **Audio-visual binding**: the brain fuses signals that **co-occur in time** (the "unity assumption,"
  within a temporal binding window). → one clock, bind within a window.

The faithful representation of all of this is a **tree of typed, owned, ordered regions on a timeline.**

## 1. The representation: the Screen Scene Graph
An episode is no longer a flat OCR string; it is a **scene graph snapshot** (plus, for meetings, a
transcript on the same clock). Node schema:

```jsonc
{
  "id": "n12", "parent": "n3", "order": 2,        // hierarchy + reading order
  "role":  "AXTextArea",                           // structural role (AX vocab) — from AX or vision
  "type":  "composer",                             // SEMANTIC: document | ai-chat | message | social-post
                                                   //   | comment | composer | nav | toolbar | ad | result | unknown
  "owner": "me",                                   // me (I authored) | other | system  (or "unknown")
  "bbox":  [x, y, w, h],
  "text":  "…",                                    // ALWAYS OCR/AX-extracted, never model-generated
  "salience": 0.0,                                 // attention weight (focused/active region scores high)
  "conf":  { "type": 0.9, "owner": 0.8 }           // labeler confidence; low → render as unknown
}
```

The pipeline stays **source-agnostic**: the segmenter/index/distill consume the graph's text + tags;
they don't care whether a node came from AX, vision, or OCR.

## 2. Principles (the non-negotiables this design is built on)
1. **Grounded, never fabricated.** `text` is only ever extracted (OCR/AX). Models may *organize and
   label* real text — never invent it. Fabricated structure = false memory = the one unforgivable bug.
2. **OCR is the universal floor.** Pixels never lie and never break on redesign. Everything richer is
   an enricher layered on top; if every enricher fails we still have grounded text.
3. **AX is an opportunistic enricher, not the skeleton.** (See review §3.) Free, exact hierarchy where
   present; absent/gated in most browsers + Electron. Use it when it's there; never depend on it.
4. **We are a recorder, not an agent.** No sub-second budget. Seconds of latency on a *change* are
   fine; **battery and thermals are the real budget** — heavy work is gated, async, and pauses on
   low-power.
5. **On-device & private by default.** No raw screen/audio leaves the machine; secure fields excluded;
   raw audio transcribed-then-deleted.
6. **Confidence over bravado.** Every label carries confidence; below threshold we emit `unknown`
   rather than guess. Trust is the product.

## 3. Review — what the critique changed
A skeptical pass (web-grounded) reshaped three assumptions:

| Finding | Source | Design response |
|---|---|---|
| Chromium/Electron (Chrome, Slack, VS Code, new Teams) **gate AX off by default**; waking it via `AXManualAccessibility`/`AXEnhancedUserInterface` can **slow the target app**. | [Electron](https://www.electronjs.org/docs/latest/tutorial/accessibility/), [Chromium](https://www.chromium.org/developers/design-documents/accessibility/) | AX demoted to **enricher**; OCR is the floor. Waking AX is **opt-in, per-app, perf-flagged.** Don't assume AX coverage for "real work" apps. |
| On-device vision parsing is **10–30× slower on CPU** (seconds/frame). | [OmniParser V2](https://www.microsoft.com/en-us/research/articles/omniparser-v2-turning-any-llm-into-a-computer-use-agent/) | Vision completion is **gated** (change-detected), **async**, **region-scoped**, **downscaled**, on a **small CoreML** model, and **paused on battery/thermal pressure**. Acceptable because we're not real-time. |
| MLLMs **hallucinate** UI (object/attribute/relational/fabrication) and miss small elements. | [hallucination survey](https://arxiv.org/html/2507.19024v1) | **Grounded-never-fabricated** rule (§2.1); labels are constrained to existing OCR text + carry confidence; **hallucination rate is a tracked metric** (§6). |

## 4. Layered perception architecture
```
                          ┌──────────────────────────────────────────┐
 pixels ── OCR (Vision) ──▶ TEXT + boxes  (universal floor, grounded) │
 AX tree ─ enricher ──────▶ roles + hierarchy (where present, opt-in) │ ── fuse ─▶ Scene Graph
 vision parser ─ gated ───▶ regions + groups (fills AX-blind apps)    │            (typed, owned,
 LLM labeler ─ grounded ──▶ type + owner + salience (semantics)       │             ordered tree)
 stable APIs ─ optional ──▶ calendar/mail/participants (enhancers)    │
                          └──────────────────────────────────────────┘
 audio (mic+system) ── VAD ── ASR ──▶ utterances on the SAME CLOCK ──▶ bound into multimodal episode
```

## 5. Staged implementation — before → after
Each stage ships independently and is gated on a metric (§6). "Before" = today's behavior; "After" =
the stage's done-state.

### Stage 0 — Quality harness (`continuum eval`)  ·  *measure first*
- **Before:** capture changes are judged by eye; no regression signal; "better" is a vibe.
- **After:** `continuum eval` runs locally over fixtures and prints CER/WER (OCR), capture miss-rate,
  SNR, segmentation F1, ASR WER, scene-graph region-F1 / role&type accuracy / **hallucination rate**,
  and an end-to-end Q&A score. CI-able. Every later stage cites numbers, not adjectives.
- **Approach:** `daemon/eval/` with checked-in fixtures (synthetic screenshots + labels; short audio
  clips). Pure local, no telemetry.
- **Acceptance:** harness runs on CI; baselines recorded for current v0 capture.
- **Risk:** fixture realism. *Mitigation:* seed from real (opt-in, user-donated) captures, scrubbed.

### Stage 1 — Scene Graph v1 (OCR floor + AX enricher)
- **Before:** an episode is a single flat OCR string per window; AX is used only for the focused input.
- **After:** capture emits a **hierarchical scene graph** — OCR regions everywhere (grounded text),
  enriched with AX roles + parent/child where the app exposes them. Reading order from layout. Flat
  text remains available as a fallback view.
- **Approach:** Swift in `daemon/stage1/` — walk `AXUIElementCopyAttributeValue` children into a tree
  where available; cluster OCR observations into geometric blocks otherwise (XY-cut style); merge;
  emit `CaptureEvent` carrying a `scene` graph. Pipeline reads `scene.text` for back-compat.
- **Acceptance:** region-F1 ≥ baseline on fixtures; reading-order correct on multi-column fixtures; no
  fabricated text (text==extracted, byte-checked).
- **Risk:** AX traversal cost / waking Electron. *Mitigation:* time-boxed AX walk; AX wake opt-in.

### Stage 2 — Semantic labeling (type + owner), grounded
- **Before:** regions have structural roles only — no "what is what," no "mine vs theirs."
- **After:** each region tagged `type` (document/ai-chat/message/social-post/comment/composer/nav/…) and
  `owner` (me/other/system) **with confidence**; "your reply vs the thread" resolved semantically; low
  confidence → `unknown`. Runs at distill (cheap, async).
- **Approach:** extend the Stage-4 structuring pass; the model sees the *scene graph text + geometry*
  (not raw pixels) and returns labels constrained to existing node ids. Heuristic fast-path (composer
  = focused editable at viewport bottom; owner=me when AX value == focused input).
- **Acceptance:** type accuracy and owner accuracy ≥ target on labeled fixtures; **hallucination rate
  ≈ 0** (no label references nonexistent text/region).
- **Risk:** LLM hallucination/cost. *Mitigation:* grounded prompt + confidence gate + local-model option.

### Stage 3 — Vision completion (small on-device parser, gated)
- **Before:** AX-blind apps (most browsers/Electron, canvas, games) yield only flat OCR — no hierarchy.
- **After:** a small CoreML region/group detector completes the graph where AX is absent, so hierarchy
  is **universal**; runs only on meaningful change, async, downscaled, **paused on battery/thermal**.
- **Approach:** distill/evaluate a compact detector (Screen2AX/OmniParser-lineage) to CoreML (ANE);
  region+group boxes only (text still from OCR). Gate behind the change detector from Stage 1.
- **Acceptance:** region-F1 on AX-blind fixtures ≥ target; added energy ≤ budget (measured); p95 parse
  latency within the recorder budget (seconds, not real-time).
- **Risk:** latency/energy/accuracy of on-device VLM. *Mitigation:* small model, gating, ANE, opt-out.

### Stage 4 — Audio capture (two-channel + VAD + on-device ASR)
- **Before:** no audio; meetings/calls are invisible to memory.
- **After:** the `audio` helper captures mic (you) + system (them) separately → VAD utterances →
  on-device transcription → `CaptureEvent{source:"audio", speaker}`; meeting-gated; 🔴 indicator;
  transcribe-then-delete. (Full design: [`audio-capture.md`](audio-capture.md).)
- **Approach:** Swift `audio` helper (sibling of `screen`); `SCStream` audio + `AVAudioEngine`;
  `SFSpeechRecognizer` on-device default.
- **Acceptance:** WER ≤ target on speech fixtures; speaker label correct by construction; zero raw
  audio written to disk (asserted); capture never blocks (bounded buffer).
- **Risk:** consent/legal, backpressure. *Mitigation:* default-off + indicator; bounded ring buffer.

### Stage 5 — Cross-modal fusion (one clock + temporal binding)
- **Before:** audio and screen produce *separate* episodes; the slide and the sentence don't connect.
- **After:** audio utterances and scene-graph captures within the same active window/time-bucket fuse
  into one **multimodal episode** (`source_mix:["ocr","audio"]`); distill synthesizes across both
  ("while reviewing the Q3 dashboard, the team decided to cut feature X").
- **Approach:** temporal co-windowing in Stage 2 segmenter (shared millisecond clock + a binding
  window, e.g. utterance attaches to the scene active at its timestamp ± window).
- **Acceptance:** fused episodes correctly co-locate audio+screen on a scripted meeting fixture;
  end-to-end Q&A over a meeting improves vs single-modality.
- **Risk:** clock skew between helpers. *Mitigation:* single monotonic clock source; tolerance window.

### Stage 6 — Temporal scene diffing  *(later / optional)*
- **Before:** scrolling/editing yields disjoint snapshots that dedup fragments or drops.
- **After:** consecutive scene graphs are **diffed** (region add/remove/change); a scroll or edit
  becomes one evolving episode, not N fragments — and "what changed" is itself a signal.
- **Approach:** node-matching across consecutive graphs (bbox+text overlap); stitch long content.
- **Acceptance:** segmentation F1 on scroll/edit fixtures ≥ target.
- **Risk:** matching errors. *Mitigation:* conservative thresholds; fall back to snapshot.

## 6. Measurement (perception-specific, on top of `capture-quality.md`)
- **Region F1** — detected regions vs labeled (Stages 1, 3, 6).
- **Role / type / owner accuracy** — vs labeled fixtures (Stages 1, 2).
- **Reading-order correctness** — block-level order vs ground truth (Stage 1).
- **Hallucination rate** — fraction of nodes/labels referencing text/structure not actually present;
  **target ≈ 0** (Stages 2, 3). The metric that protects trust.
- **Energy/latency** — added Wh and p95 parse time per change, within budget (Stage 3).
- **End-to-end Q&A** — the metric that subsumes the rest (all stages).

## 7. Energy & privacy guardrails
- Heavy perception (vision parse, LLM labeling) is **gated by change detection**, **async**, and
  **suspended on battery / thermal pressure** (`NSProcessInfo` thermal state, power source).
- AX waking is **opt-in per app** with a visible note that it may affect that app's performance.
- Secure fields never captured; visible PII redacted pre-persist; private/incognito windows skipped;
  raw audio never written to disk.

## 8. Open questions
- Scene-graph **storage**: full tree per snapshot vs a compact semantic outline + spans? (size vs fidelity)
- Which **small vision detector** distills best to CoreML/ANE within the energy budget?
- Local vs cloud for the **labeler** (Stage 2) — tie to the existing tier model.
- Ground-truth **fixtures**: synthetic-first, then opt-in donated captures (scrubbed).
