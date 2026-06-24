# Audio capture — design

Status: design · 2026-06-24

Text capture ("what you see") can't reach a whole category of context: **what was *said*** —
meetings, calls, huddles. "What did we decide on yesterday's call?" lives in audio. This is the
design for capturing it at SOTA quality, on-device, as a first-class citizen of the same pipeline.

## 0. Non-negotiables
- **On-device by default.** Audio is the most sensitive signal; the default path must keep "nothing
  leaves this Mac" true.
- **We keep words, not recordings.** Raw audio is transcribed in memory and **discarded** — never
  written to disk. The store holds transcript text only.
- **Consent is visible.** A live, unmistakable "listening" indicator whenever audio capture is on.
  Default **off**; opt-in; per-meeting control.
- **Source-agnostic.** Audio emits the same `CaptureEvent` contract; the pipeline doesn't special-case it.

## 1. The key insight: capture two channels, don't diarize one
The naive design mixes everything into one stream and tries to recover "who spoke" with acoustic
diarization — hard, and never clean. Instead capture the **two streams separately**:

| Channel | Source | API | Speaker |
|---|---|---|---|
| **You** | microphone | `AVAudioEngine` input tap | `speaker:"you"` |
| **Them** | system audio out | `SCStream` with `capturesAudio` (macOS 13+) | `speaker:"them"` |

This gives **speaker attribution for free** — the single biggest audio-quality lever — with no
diarization model. System audio via ScreenCaptureKit needs **no virtual audio device** (BlackHole/
Soundflower are obsolete) and is bundled under the Screen Recording permission; the mic needs the
Microphone permission. (Separating multiple *remote* speakers within the "them" channel is a v2
acoustic-diarization enhancer, not v1.)

## 2. Pipeline
```
 mic  ─ AVAudioEngine tap ──┐
                            ├─ per-channel ring buffer (bounded, RAM only)
 sys  ─ SCStream audio ─────┘
            │  AVAudioConverter → 16 kHz mono Float32
            ▼
        VAD (voice-activity) → cut into utterances (silence-bounded, ~700 ms)
            │
            ▼
        transcription (per utterance, per channel)
            │
            ▼
   CaptureEvent { source:"audio", speaker:"you"|"them", app:<meeting app>,
                  window_id:<meeting>, text:<utterance>, conf?, t }
            │
            ▼
        Stage 2 segmenter  →  conversation episode  →  index / distill / graph
```
The transcript flows into the **existing** Stage-2 segmenter: consecutive utterances sharing a
`window_id` (the meeting) coalesce into one conversation episode, exactly as OCR snapshots coalesce.

## 3. Transcription — tiered, like embeddings/LLM
| Tier | Backend | Quality | Privacy | Setup |
|---|---|---|---|---|
| **default** | Apple Speech (`SFSpeechRecognizer`, `requiresOnDeviceRecognition`) | good | on-device | zero |
| **better** | WhisperKit (whisper-v3-turbo, CoreML) | high, multilingual, punctuated | on-device | model download |
| **best** | cloud streaming (Whisper / others, BYO key) | highest, lowest local cost | leaves device → opt-in only | a key |

Config mirrors the existing tiering: `audio.transcriber = apple | whisperkit | cloud`. Cloud is
**opt-in, transcribe-then-delete, explicit** — never the default. WER is the fidelity metric we tune
against (see `capture-quality.md` §Measurement).

## 4. When to capture — meeting-gated, never always-on
Always-listening is creepy and wasteful. Capture only a real conversation, detected by:
- **Meeting app active** — a conferencing app is frontmost/running (Zoom, Google Meet in-browser,
  Teams, FaceTime, Slack/Discord huddle), **and**
- **Two-way audio active** — system output *and* mic input are both live (a call), which distinguishes
  a meeting from music/video playback.
- **Explicit override** — a "record this meeting" toggle the user can force on/off.

Default off. When armed, the gate above decides *when*. This keeps us from transcribing Spotify or
your every muttered word.

## 5. Consent, indicator, legal
Recording conversations is legally sensitive (two-party-consent jurisdictions). Mitigations:
- A persistent **🔴 listening** indicator (menu bar + dashboard status) whenever audio is live.
- Transcribe-then-delete (no raw audio at rest) shrinks the blast radius.
- Default off, explicit opt-in, per-meeting control; the product surfaces the responsibility rather
  than auto-recording silently.

## 6. Schema — one additive field
`CaptureEvent` gains an optional `speaker?: "you" | "them"` (and optional `conf?`). The pipeline stays
source-agnostic and ignores it; **distill** and **retrieval** use it to render "you said… / they
said…" and to attribute decisions. No other changes — audio rides the existing contract.

## 7. The helper
A native Swift helper **`audio`**, sibling to `screen` — spawned by `continuum start`, emits NDJSON
`CaptureEvent`s on stdout, same as `screen`. Reuses the daemon's serialized ingest queue. Built on
first run like the others (`ensureHelper`). Config: `capture.audio = false` (default) → `true`.

## 8. Robustness / failure modes
- **No permission** → emit nothing, log once, never block the rest of capture.
- **Backpressure** (transcription slower than audio) → bounded ring buffer drops oldest PCM; capture
  never blocks and memory never grows unbounded. We'd rather lose a second of audio than wedge.
- **Music/keyboard/noise** → VAD + meeting-gate suppress non-speech.
- **Mixed languages** → WhisperKit multilingual, or Apple Speech locale; configurable.
- **Overlap (both talk at once)** → separate channels transcribe in parallel; no collision.

## 9. Phasing
- **v0.3** — `audio` helper: system + mic channels, VAD utterance segmentation, Apple Speech on-device,
  meeting-gating, listening indicator, `speaker` field, episodes in the pipeline.
- **v0.4** — WhisperKit tier (quality + multilingual + punctuation); calendar/participant enrichment.
- **v1** — acoustic diarization of remote speakers; cloud streaming tier; **cross-modal fusion**
  (see `capture-quality.md`) — the slides you saw + the discussion you heard in one episode.

See [`capture-quality.md`](capture-quality.md) for the cross-cutting quality model and metrics, and
[`ingestion-pipeline.md`](ingestion-pipeline.md) for the pipeline this feeds.
