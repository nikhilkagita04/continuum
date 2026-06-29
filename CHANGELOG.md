# Changelog

All notable changes. Dates are when the work landed; npm releases are tagged per version.

## 0.9.0 — trust & security hardening + always-dated context (2026-06-29)
A hardening pass that makes the local memory safe to put behind any agent, and puts an unambiguous date
on every fact.
- **Always-dated, attributed results.** Every `recall`/`catch_up`/`profile` result now carries a machine
  ISO + a human calendar date ("as of Jun 18, 2026"), an owner, a provenance tier (raw OCR is
  `observed-untrusted` — the agent quotes it, never treats it as instructions), and a stable citation id.
  The MCP server renders the date + citation, and a `/api/moment` route opens the cited source moment.
- **One audited egress chokepoint.** All outbound network goes through a single `egress.mjs` — a
  fail-closed endpoint allowlist + an append-only ledger of what left the machine — and a CI test
  **fails the build** if any other module makes a network call. The dreaming digest is scrubbed before it leaves.
- **Encryption at rest (opt-in).** AES-256-GCM with a macOS-keychain key (`capture.encryptAtRest`); the
  on-disk store becomes ciphertext, reads stay migration-tolerant, with an honest threat model documented.
- **Robust loads + an optional re-rank hook.** `loadEpisodes` skips a single corrupt line instead of
  reading the whole store as empty; `recall` accepts an optional `rerank(query, hits)` hook + per-request
  `searchOpts`, over version-pinned default fusion weights.

## 0.8.0 — SOTA capture quality + honesty/safety hardening (2026-06-28)
A capture-quality pass (the measured bottleneck — facts were present in noisy OCR token-soup but not
cleanly *answerable*) plus a hardening pass that removes everything that shouldn't ship.

- **Capture quality → SOTA.** Episode-level fact-recall **~0.86 → ~0.97** across 14 web + 17 native
  surfaces + synthetic comms; capture→answer **~0.40 → 0.73** (web) / **0.79** (native, above the
  0.75 bar). Fixes, each measured + unit-tested:
  - **Completeness** — the OCR line filter dropped short single-word facts (names/numbers/labels); relaxed to keep any 3+ char content line. (0.80 → 0.96)
  - **Reading order** — recursive **XY-cut** column/block layout replaces the naive (row,x) sort, so sidebars/columns/overlays no longer interleave.
  - **Chrome** — stop deleting short *content* as if it were nav chrome; drop only garbled tab-strip noise.
  - **Repetition** — segmenter coalescing now uses word-subsequence + token-Jaccard (with a **numeric guard** so a differing number is never silently merged away); typed fields collapse to one clean episode.
  - **Non-English** — auto-detect language (CJK/Cyrillic/Arabic) + Unicode-aware fact matching.
  - **Ship-parity** — the `.app` now bundles the OCR `screen` binary (not the AX-only path).
- **Honesty / safety hardening** (removing what shouldn't ship):
  - **Audio capture removed** (measured 237% CPU) — sources + binaries deleted.
  - **Backend HydraDB mirror + Graphiti sidecar deleted** — no capture is mirrored off-device.
  - **Browser-extension `<all_urls>` path disabled** — no second, unscoped capture channel.
  - **Private-by-default exclusions expanded** beyond credential managers to private messaging (Messages/WhatsApp/Signal/Telegram/Discord/FaceTime) + personal content (Mail/Notes); opt-in via `CONTINUUM_INCLUDE`.
- **Eval, runnable + honest.** Committed the capture-quality gate (**local-by-default** fact-gen, no bulk upload) and an S0 retrieval/answer harness with a **cross-family, deterministic gate-of-record** (`measure.mjs`); aggregate-only baseline records under `daemon/eval/baselines/`.
- **Packaging.** `files[]` is now an **explicit allowlist** (no recursive `daemon/**` glob).

## 0.7.1
- Diagram: renamed "Segment" → "Episodes" (the artifact, not the stage) so the two-tier fork reads itself.
- Dreaming model guard tightened: error message now says "capable model (8B+ general instruct)" rather than "Pro only", keeping the free local path open.

## 0.7.0 — consolidated memory + dreaming
The second half of the memory architecture. The episodic firehose (capture → segment → index) stays
live and local; a new **dreaming** pass consolidates it into the durable, file-based memory an agent
reads to actually *understand* you — not just recall moments.
- **Tier-2 memory** (`continuum memory`) — small, cited markdown files (`about` · `projects` · `people`
  · `taste` · `decisions` · `preferences`) under `~/.continuum/memory/`. **Read-only to agents** — written
  only by dreaming + human curation, so a prompt-injected agent can't poison it. Production primitives:
  immutable versions (audit + rollback), content-hash preconditions, redact.
- **Dreaming** (`continuum dream`) — an out-of-band *verify · organize · enrich · dedup* pass over the
  episode digest, grounded in episode ids, merging with existing memory. Model-agnostic.
- **MCP** — `profile()` now serves the consolidated memory (grounded, consistent, instant), falling
  back to the on-the-fly profile when nothing's been dreamed yet; `initialize` leads with the dreamed
  "about".
- **Tiering** — capture, retrieval, and preferences are free/local. Dreaming needs a *capable* model
  (a strong local instruct model, or a frontier key for Pro) — measured: a small coder model produces
  unusable summaries, a frontier model produces excellent, cited memory. Consolidated memory beat raw
  episodic retrieval on understanding questions (43% → 60%).
- New two-tier architecture diagram. 19 new test assertions.

## 0.6.2 — trustworthy eval + recency-aware retrieval
A measurement-honesty pass. Diagnosing a low answer-correctness number showed the *eval* was lying,
not the model: the auto-generated probes were often unanswerable or over-specific, so the model's
correct, honest "I don't have that" got scored wrong.
- **Validated probes.** `measure` now checks every probe is actually answerable from its source before
  scoring (and the generator is told to ask only what the moment supports), so correctness measures the
  system, not the questions. On real data this moved the true number 33% → ~53%.
- **Recency-aware query routing.** The honest eval exposed the real weak spot — recency-sensitive
  factual queries over near-duplicate episodes ("what version did I *just* publish/install/push"),
  where RRF returns a similar episode instead of the most recent. `routeSearch` sends queries with
  recency markers (just / latest / recently / today / last …) to recency-weighted fusion; everything
  else keeps RRF. Wired into `recall` and `answerQuery`.
- **Cleaner answer context.** `assembleContext` trims browser-chrome residue, drops near-duplicate
  snippets, and caps length before the model sees it.

## 0.6.1 — capture quality + retrieval, measured end-to-end
A measurement-driven pass that moved real numbers: retrieval hit@5 ~60% → ~95%, MRR 0.50 → 0.93,
and capture unique-token ratio 0.70 → 0.84. The lesson: fixing capture beat any embedding upgrade
(garbage in, garbage out).
- **`continuum measure`** — scores retrieval/answer quality over *your own* captured memory: it writes
  probe questions from your real episodes (ground truth = the source), then reports hit@k / MRR,
  answer correctness, groundedness, necessity, and latency, plus the weakest probes. Needs a model
  (Ollama free, or a key). The dial every capture/retrieval change is now gated on.
- **Capture cleanup.** A **progressive-typing coalescer** collapses the keystroke-by-keystroke OCR
  garble that piled up when you type into an app (it was ~19% of episodes, e.g. one 3993-token blob at
  0.03 unique-token ratio). A browser-only **chrome filter** drops tab strips, bookmark bars, and nav
  toolbars (never touching code/terminal). New **`continuum clean`** salvages or deletes already-polluted
  episodes (backs up first). New `CONTINUUM_OCR_MINHEIGHT` knob.
- **Retrieval: Reciprocal Rank Fusion by default.** Fuse the lexical + semantic rankings (RRF),
  with recency/salience as light tie-breakers; weighted mode stays available for recency-dialed use.
  A/B on a real corpus: hashed→bge-m3→+RRF took hit@5 87% → 93% → 100%. Recommended embedder upgrade:
  `ollama pull bge-m3`. (An LLM reranker was tested and *dropped* — it damages an already-strong stage.)

## 0.6.0 — preferences: learn how you want your agents to work
Beyond *who you are*, Continuum now learns *how you want your agent to work for you* — the standing
instructions you'd otherwise repeat in every session ("be concise", "run the tests before the PR",
"do lightweight research and cite sources", "prefer X over Y") — and, once you approve them, applies
them to every agent automatically.
- **Open, model-agnostic engine** (`daemon/preferences.mjs`). *Stated* preferences are extracted with
  **no model at all** (free, zero-setup) from what you've actually said — canonical directive rules
  plus dynamic "Prefer X over Y", with frequency + your own authored text driving confidence, every
  candidate grounded in episode ids. *Inferred* preferences come from the configured model — **Ollama
  is decent, free and local**; a frontier model (Pro) is sharpest. Grounded JSON, never invented.
- **Confidence-tiered, human-curated.** A preference you've clearly **stated yourself more than
  once** is applied automatically (no ceremony for words you've plainly repeated to your agent);
  everything else — inferred, or stated just once — waits as a *suggestion* for your okay. Curate in
  the dashboard's new **Preferences** view (Active + Suggested, with approve / edit / turn-off) or
  from the CLI (`continuum preferences`). Curated set lives in `~/.continuum/preferences.json`.
- **Applied automatically and silently, always free.** Active preferences are injected into the MCP
  `initialize` instructions — so every agent session starts already knowing how you like to work,
  applies them by default, and is told *not* to announce or ask about them. No model needed to
  *apply* them, on any tier. (MCP `instructions` are fixed at connect time, so the `profile` tool
  also returns the active set — that's how a long-running session picks up a preference you approved
  after it started.)
- 20-assertion test; dashboard also honors `PORT`.

## 0.5.0 — MCP server, redesigned for ambient personalization
The agent now comes to *understand you* and tailor its help, deciding for itself when to reach for memory.
- **Three sharp tools** — `recall` (find specific moments; filter by time/app/source), `catch_up`
  (what you're doing now, no query), `profile` (who you are — projects, people, working style, taste).
  Built so an LLM picks the right one and uses them proactively.
- **Understanding by default** — a cheap user snapshot is injected into the MCP `initialize`
  instructions, so the agent starts every session already knowing roughly who you are.
- **Structured, attributed, scrubbed returns** with citation ids, snippet-capped to keep the agent's context lean.
- **Trust layer** — egress redaction of PII + secret-shaped strings (API keys, tokens, JWTs), honored
  app exclusions, `mcp.paused` / `mcp.sinceDays` scope, and a local audit log surfaced in the
  dashboard's Privacy view ("what your agent asked"). Read-only.
- Transport-free core (`daemon/mcp.mjs`) with a 25-assertion test. Design: `docs/architecture/mcp.md`.

## 0.4.1
- **MCP tools reframed for ambient personalization** — the `search_context` / `recent_activity`
  descriptions (and a new server-level `instructions` field) now tell the agent to use your context
  to *understand you* — what you're building, how you think and write, your taste — and tailor its
  help proactively, not just to answer explicit "what was I doing" questions.
- README onboarding leads with **hand-it-to-your-agent** (install + connect in one paste); manual
  setup is the fallback.
- GitHub About, npm description, and README aligned to the single-MCP positioning.

## 0.4.0 — capture quality + audio (verified on real data)
The round that made capture "see (and hear) the screen the way a person does."

- **Audio capture (meetings).** Opt-in (`capture.audio: true`) on-device transcription of **two
  channels** — your microphone (`you`) and system audio (`them`) — so speaker attribution is free, no
  diarization model. Meeting-gated, **transcribe-then-delete** (raw audio is never written), and
  **fused** with what's on screen into one multimodal episode. Verified live: a real call's audio
  transcribed, speaker-tagged, and bound to the Chrome window in a single episode.
- **Capture the whole window, drop the redundancy.** Whole-window capture (no more cropping) with a
  **line-level novelty filter** — the bookmark bar is captured once as context, not re-encoded every
  frame. Plus an OCR glyph-noise filter and a hard **episode-size cap**. Real-data impact:
  unique-token ratio **45% → ~83%**, runaway episodes **17k tokens → capped**, self-capture **→ 0**.
- **Silent capture.** `continuum start` no longer prints per-episode logs (which a terminal would OCR
  back into a feedback loop); `CONTINUUM_VERBOSE=1` restores them.
- **Grounded semantic labeling.** Every episode is tagged `type` (document / ai-chat / social-post /
  message / …) and `owner` (me / other), keyed on the app — labels are a closed enum, never fabricated.
- **`continuum eval` quality harness.** Measures OCR CER/WER, segmentation F1, grounding/hallucination
  rate, and end-to-end recall over checked-in fixtures — so capture changes move a number, not a vibe.
- Dashboard dark-mode text fix.

## 0.3.1 — interim
Mid-round publish of the capture-quality + audio work; superseded by 0.4.0 (audio verified working,
README reframed around the single-MCP promise).

## 0.3.0 — perception pipeline
- The **Screen Scene Graph** design (`docs/architecture/perception.md`) and its staged build: eval
  harness, AX scene-graph capture (additive), semantic labeling, cross-modal fusion, temporal
  scene diffing, and the audio helper. Reviewed against the state of the art (AX-tree gating, on-device
  vision-parser latency, MLLM hallucination) — OCR kept as the grounded floor, AX as an enricher.

## 0.2.x — the dashboard
- A new **Apple-minimal "insights + ask" dashboard** at `localhost:3939`: a daily digest of where your
  time went + ask-your-memory with cited sources, Timeline and Privacy folded behind one menu, follows
  the system light/dark. Near-monochrome, calm, zero-dependency.

## 0.1.x — initial release
- Capture → segment → index → distill pipeline; MCP server (`search_context`, `recent_activity`); CLI
  (`verify` / `start` / `dashboard` / `mcp-install`); hashed local embeddings (zero-setup, on-device).
