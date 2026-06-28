# Continuum

[![ci](https://github.com/nikhilkagita04/continuum/actions/workflows/ci.yml/badge.svg)](https://github.com/nikhilkagita04/continuum/actions/workflows/ci.yml)

**Your whole desktop context — everything you've seen, read, typed, and heard — as a single MCP your agent can use to understand you and how you work.**

Every agent starts blank, so *you* become the courier — re-pasting and re-explaining across a dozen apps a day. Continuum remembers what happens across your apps, on-device and private, and serves it to any agent over **MCP**. Ask Claude *"what was I just doing in X?"* and it already knows.

<p align="center"><a href="https://youtu.be/WnltmAaom7E"><img src="docs/assets/demo.png" width="100%" alt="Ask Claude what you were doing in another app — and it answers from your captured context"></a></p>

<p align="center"><strong><a href="https://youtu.be/WnltmAaom7E">▶ Watch the demo</a></strong></p>

## Get started

Hand it to your coding agent — paste this into **Claude Code, Codex, or Cursor**:

> Set up Continuum so you can see my desktop context: install it (`npm i -g continuum-core`), start
> capture in the background (`continuum start &` — I'll grant Screen Recording when macOS prompts),
> then add the Continuum MCP server from `continuum mcp-config`. From then on, use its `recall`,
> `catch_up`, and `profile` tools on your own judgment to understand what I'm building, how I think,
> and my taste — not only when I explicitly ask about my activity.

Then just ask it *"what was I doing in X?"* — that's the whole setup.

Prefer by hand? (needs **Node 18+**)

```bash
npm i -g continuum-core
continuum verify       # prove it works in 30s — no keys, no setup
continuum start        # live capture (grant Screen Recording once)
continuum dashboard    # your timeline + search at localhost:3939
continuum mcp-install  # connect it to Claude Desktop, then restart Claude
```

## What you get

- **Sees your screen** — on-device OCR of the focused window (deduped to content, not noise).
- **Understands who you are** — an out-of-band *dreaming* pass consolidates the raw firehose into small, cited memory files (who you are · projects · people · taste · decisions) your agent reads to genuinely understand you, not just recall moments (`continuum dream` · `continuum memory`).
- **Learns how you work** — standing preferences like *"be concise"* or *"run the tests before the PR"* apply to every agent automatically; you stay in control (dashboard or `continuum preferences`).
- **Local-first & read-only to agents** — your memory lives in `~/.continuum` and the agent only *reads* it (a prompt-injected agent can't poison it). Capture, search, and indexing run on-device; only the snippets your question needs — and the scheduled *dream* digest — are sent to the model you choose, through best-effort secret/PII redaction. We don't claim *nothing* leaves; we tell you exactly what does.

**Free & local:** capture, retrieval (hybrid lexical + local embeddings + RRF), and preferences run on-device for free. **Deep memory (dreaming)** needs a *capable* model — a strong local instruct model, or an **OpenAI / Anthropic** key.

## How it works

<p align="center"><img src="docs/assets/pipeline.svg" width="100%" alt="two tiers: a live firehose (capture → segment → index → recall) and an out-of-band dreaming pass (dream → memory → profile)"></p>

**Two tiers over one episode store.** Continuum captures your screen and groups it into **episodes**. The **live tier** indexes them so any agent can answer *"what was I doing?"* over MCP (`recall` / `catch_up`) — local and free. An out-of-band **dreaming** pass reads the same episodes and consolidates them into the durable memory files your agent reads to *understand* you (`profile`): *verify · organize · enrich*, grounded in the source moments. The LLM never touches the capture path. The stages are importable modules (a useful tool is ~20 lines, see [`examples/`](examples/)). Deep dive: [architecture](docs/architecture/ingestion-pipeline.md).

## Develop

From a clone of the repo:

```bash
npm test                                                   # full suite, no network
swiftc daemon/stage1/screen.swift -o daemon/stage1/screen  # build the capture helper
```

`continuum eval` reports capture-quality metrics over local fixtures. Contributions under [DCO](https://developercertificate.org/) (`git commit -s`). License: Apache-2.0.
