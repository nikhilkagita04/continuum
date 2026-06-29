# Continuum ingestion pipeline — design

Status: design draft · Last updated: 2026-06-22

How Continuum ingests *everything you do on a laptop* (screen, accessibility tree,
audio, clipboard, files) and turns it into durable, queryable knowledge — without
running an LLM on the raw firehose.

---

## The one law

**Never put an LLM on the capture hot path.** Capture must be microsecond-cheap and
never block. The expensive intelligence (summarization, graph extraction) runs
*async, batched, on idle*, over **distilled** input — never raw frames.

Two planes:

- **Data plane (hot):** capture → dedup → embed. Sub-millisecond, on-device, never
  blocks, no LLM. Bounded, disk-backed queue with backpressure.
- **Intelligence plane (cold):** summarize → selectively graph-extract. Async,
  batched, idle-scheduled, budget-bounded. The *only* place an LLM runs.

---

## The funnel (volume reduction is the whole trick)

| Stage | What | Cost | Volume/day |
|-------|------|------|-----------|
| 1 · capture | event-driven listeners | ~0 | ~29k raw frames (if naively 1 fps) |
| 2 · dedup + segment | on-device, sub-ms, no LLM | µs–ms | ~300 episodes (95%+ dropped) |
| 3 · embed + index | local embedding model | ms | ~300 vectors (all searchable) |
| 4 · distill → graph | async, batched, LLM | $ | ~30 LLM calls (1000× fewer than raw) |

The expensive step runs **1000× less often** than the cheap step. That is what makes
"track everything" scalable.

---

## Capture cadence — event-driven, not a timer

Do **not** poll at a fixed interval. Human context changes on *second* timescales,
not milliseconds; a high-frequency poll just captures redundant frames.

- **Event-driven** where the OS provides it: `AXObserver` notifications
  (focus/value/window), `FSEvents`, pasteboard change-count, app-activation. ~0 cost
  when idle.
- **Change-triggered + debounced** for the screen: OCR only when the accessibility
  tree can't read the app *and* pixels meaningfully changed (perceptual-hash diff).
  Hard-cap (≤1 OCR/sec).
- **Streaming** for audio: on-device transcription during calls only.

### Per-source verdict (ranked by signal-per-cost)

| Source | Verdict | Why |
|--------|---------|-----|
| Screen + OCR (Vision) | **Primary** | Universal — captures what you actually see, in *any* app (browser, Electron, native). Change-triggered + focused-window, on-device. |
| Accessibility (AX) tree | **Accelerator** | Cheap structured text where an app exposes it well (some native apps). Optional; AX is unreliable for browsers/web apps. |
| Files (FSEvents) | **Complement** | What you *write* — clean, high-signal. Opt-in dirs. |
| Clipboard | **Complement** | What you copy is almost always meaningful. |
| Audio | **On-demand** | Streaming on-device transcription during meetings (roadmap). |

---

## Stage 2 — dedup + segmentation (where cleverness, not money, is spent)

### 2a · Dedup cascade (cheapest filter first; coalesce, don't just drop)

| Level | Mechanism | Cost | Kills |
|-------|-----------|------|-------|
| 0 | OS change events only | ~0 | idle redundancy |
| 1 | exact hash of *normalized* content (strip timestamp/cursor/scroll/focus-ring) → LRU | µs | literal repeats |
| 2 | SimHash over token-shingles (Hamming < 3/64); pHash for OCR images (Hamming < 5/64) | sub-ms | near-duplicates |

A near-dup **coalesces** into the current state (`representative=latest`,
`first_seen`, `last_seen`, `update_count`) — it doesn't get discarded. Dedup feeds
segmentation.

### 2b · Segmentation — online state machine + batch refinement

Boundaries:
- **Hard (structural):** app switch · window/doc/URL-host change · idle gap ·
  lock/wake · calendar meeting edges.
- **Soft (semantic):** rolling content embedding drifts past a cosine threshold from
  the segment centroid (same app, new subject).

Two tiers (lambda/kappa pattern):
- **Tier A (online, deterministic, no LLM):** produces candidate episodes in real time
  → immediately embeddable. Per-window accumulators (split attention / two monitors).
- **Tier B (batch, on idle):** re-segments — merges over-split fragments, splits
  run-ons — via embedding change-point detection; daily rollup may use one LLM call to
  group segments into a work-block. Corrects Tier A *before* anything expensive runs.

Online loop:
```
on deduped_event e:
  seg = open_segments[e.window_id]            # per-window
  if seg is None: open_segments[e.window_id] = new_segment(e); return
  if e.app != seg.app or e.url_host != seg.url_host          # hard
     or (e.t - seg.last_active) > IDLE
     or (seg.tokens > MIN and drift(e, seg.centroid) > DRIFT) # soft
     or seg.duration > MAX:                                   # cap
       emit(close(seg)); open_segments[e.window_id] = new_segment(e)
  else:
       coalesce(seg, e)                        # extend, dedup, update centroid
```

Starting thresholds (tune empirically): `IDLE = 90 s` · `DRIFT cosine < 0.6` ·
`MIN = 5 s active or token floor` (else drop/merge) · `MAX = 15–30 min or N tokens`
(else chunk) · app-switch debounce so alt-tab thrashing doesn't shatter segments.

### 2c · Episode schema (Stage 2 output)
```
Episode { id, start, end, active_duration,
          app, window_title, url_host,        # PII-stripped
          source_mix:[ax|ocr|audio], text,    # fused, deduped
          participants,                       # from calendar/contacts
          content_hash,                       # idempotency
          salience }                          # drives Stage 4 escalation
```

`salience` (cheap features now; learned later via the correction loop): active dwell ·
input intensity (typed/edited vs passively viewed) · recurrence · app class
(doc/code/email ≫ video) · explicit acts (copied/saved/shared).

---

## Stage 4 — distillation + selective-graph policy

### 4a · Escalation ladder (pyramid: width = volume, height = cost)
- **T0 · embed + index** — all ~300/day, free, local. Always searchable.
- **T1 · tag / classify** — most episodes; NER + topic/app classification; cheap.
- **T2 · summarize** — salient episodes + rollups; one LLM pass per topic cluster.
- **T3 · graph extract** — ~30/day; entity/relation/temporal extraction into the KG.
  **Runs only on T2 summaries, never raw episodes.**
- **T4 · on-demand** — query-time extraction when the graph lacks needed structure;
  pay only when asked.

A priority queue by `salience` drains against a fixed daily LLM budget; the tail stays
at T0.

### 4b · Rollup hierarchy (cost logarithmic in time horizon)
A time-pyramid (like time-series downsampling): recent = full resolution, old =
progressively compressed.
- **Daily:** cluster ~300 episodes by topic (cheap embedding clustering, no LLM) → one
  LLM pass per cluster → themes, decisions, open loops. ~5–15 calls. Feeds the graph.
- **Weekly:** synthesize 7 dailies → progress, recurring people/projects.
- **Monthly/quarterly:** synthesize weeklies → trajectory, long arcs.

### 4c · Incremental temporal knowledge graph
Extraction writes entities/relations with `valid_at` = event time. **Contradiction
handling** sets `invalid_at` on superseded edges (keeps history) — this is the
knowledge-update / temporal-reasoning capability. Entity resolution runs at rollup
time (~once/day), not per episode.

### 4d · Retrieval fuses tiers
vector (T0, recall) ⊕ graph traversal (T3, structured/temporal/multi-hop) ⊕ rollup
summaries ("this week") ⊕ recency/salience boosting ⊕ T4 lazy-extraction if structure
is missing.

---

## Cross-cutting (the stuff that bites in prod)

1. **PII boundary is in Stage 2.** Redact at `close()`, before embed/persist. Never
   capture `AXSecureTextField`; regex+NER scrub emails/cards/SSNs.
2. **Crash safety:** WAL the open-segment accumulators; `content_hash` makes
   re-processing idempotent (no double-emit).
3. **Backpressure:** disk-backed bounded queue; under pressure drop *lowest-salience*
   first; never block capture.
4. **Event-time, not arrival-time:** audio lags screen by seconds — use a reordering
   window + watermark to fuse AX + audio + OCR into one episode by when things happened.
5. **Battery budget:** only real cost in the data plane is the drift embedding — make
   it optional/throttled, NPU-batched. Rule-based boundaries alone get ~80%.
6. **Regenerable & versioned:** rollups are derived; version the prompt/model to re-run.
7. **Idle-aware scheduling:** heavy distillation on charge+idle; local-model fallback ≈ $0.

### Failure modes → mitigations
- **Over-segmentation** (alt-tab debugging) → app-switch debounce + min-segment merge + Tier-B re-merge.
- **Run-on** (all day in one IDE) → max-size chunking + drift splitting.
- **Volatile-UI noise** (notifications, clocks, ads) → normalization + region/subtree masking.

---

## Privacy

Capture and indexing run **on-device**; raw episodes never leave the machine. Only the small
consolidated memory and the snippets a query needs go to the model you configure, through best-effort
redaction — and you stay in control of what is captured and what is shared.

---

## Implementation status

End-to-end skeleton implemented under `daemon/`. The intelligence-plane seams
(embedder, LLM, graph) are dependency-injected, so the whole pipeline runs and tests
offline with zero network; real adapters swap in for live use.

| Stage | File | Tests |
|-------|------|-------|
| 1 · capture (event-driven) | `daemon/stage1/capture.swift` → compiled `capture` | builds (live run needs Accessibility permission) |
| 2 · dedup + segment | `daemon/stage2/segmenter.mjs` | 19 ✅ |
| 3 · embed + index | `daemon/stage3/index.mjs` | 4 ✅ |
| 4 · distill → graph | `daemon/stage4/distill.mjs` | 5 ✅ |
| retrieval (fuse tiers) | `daemon/retrieval.mjs` | (covered e2e) |
| orchestrator | `daemon/pipeline.mjs` | 6 ✅ (e2e) |
| store (persistence) | `daemon/store.mjs` | 2 ✅ |
| adapters (real + mock) | `daemon/adapters.mjs`, `daemon/util.mjs` | — |

**36/36 tests pass.** The Swift helper emits NDJSON `CaptureEvent`s; everything
downstream is source-agnostic Node.

### Runbook
```bash
# offline tests (no network, no permissions)
for t in stage2/segmenter stage3/index stage4/distill pipeline; do node daemon/$t.test.mjs; done

# live, local-only (grant Accessibility first; uses the deterministic local embedder)
swiftc daemon/stage1/capture.swift -o daemon/stage1/capture
./daemon/stage1/capture | node daemon/pipeline.mjs

# with real embeddings / LLM / graph — wire adapters in pipeline.mjs:
#   ollamaEmbedder() (local, free) or openaiEmbedder({apiKey})  # Stage 3 vectors
#   llmClient({provider:'openai', apiKey: OPENAI_API_KEY})  # Stage 4 summaries + answers
#   graphClient('http://localhost:8000')              # Stage 4 graph (graphiti sidecar)
```

An earlier 9-second polling loop is superseded by `stage1/capture.swift`
(event-driven) → `pipeline.mjs`.

## Open questions / what to tune

- Segmentation thresholds (IDLE / DRIFT / MIN / MAX) — needs real-usage tuning.
- Salience model: hand-weighted → learned (correction loop).
- Local vs hosted for T2 summarization (cost vs quality).
- Graph store: validated end-to-end on Neo4j + (Anthropic | OpenAI) extraction; open
  models can't satisfy the strict extraction schemas. See `backend/graphiti/`.
- How aggressively to compress old detail (retention policy per tier).
