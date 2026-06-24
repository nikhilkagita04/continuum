# MCP server — design

Status: **finalized & implemented (v0.5)** · 2026-06-24

The MCP server is Continuum's primary surface: it's how an agent comes to **understand the user** —
what they're building, how they think and write, their taste — and tailors its help, deciding for
itself when to reach for the memory. Two "users": the **agent** consumes the *tools* (ergonomics for
an LLM), the **human** owns the *trust model* (what their agent can see, and their control over it).

Arrived at via two critique rounds (see §5). Core principle: **understanding > recall**, agent-judgment,
**grounded-never-fabricated**, and human trust as a first-class part of the surface.

## 1. Three tools — sharp, non-overlapping, named for the agent's intent
Three so an LLM picks correctly among *find a thing* / *what's happening now* / *who is this person*.
More tools = worse selection.

| Tool | Intent | Returns |
|---|---|---|
| `recall(query, since?, until?, apps?, sources?, k?)` | "find the specific moment / how they did X / what was decided" | ranked, snippet-capped, attributed results |
| `catch_up(window?)` | "orient me in what they're doing *now*" (no query; `window`=`today`/`24h`/`7d`/`week`) | recent episodes, newest-first, deduped |
| `profile(topic?)` | "understand *who this person is* so I tailor my help" — projects, people/tools, working style, taste | a synthesized brief, grounded in cited moments |

## 2. Return schema (every result)
```jsonc
{ "when": "2h ago · Tue 03:14 PM", "app": "Slack", "who": "you|others|system",
  "type": "document|ai-chat|message|social-post|meeting|…",
  "text": "<≤280-char scrubbed snippet>", "id": "ep_…" }   // citation handle
```
Clean, attributed, low-token. Progressive disclosure: snippets by default; the agent narrows with
another `recall` for depth rather than fetching full episodes.

## 3. Understanding by default
The `initialize` response carries a freshly-computed, **cheap heuristic user snapshot** in
`instructions` (current apps/projects/recurring people & topics), so the agent starts every session
already knowing roughly who you are — `profile`/`recall` are for depth. Plus the framing: *treat this
as getting to know a teammate; use judgment; never fabricate; cite.*

`profile` degrades honestly: **heuristic** on the free tier (top apps/types, recurring entities, and
your own authored text as a voice signal), **LLM-synthesized** when a model is configured (every claim
grounded in cited moments, labeled inference, never invented).

## 4. The trust layer (what makes it shippable)
A tool that reads your whole life is only acceptable if the human stays in control:
- **Egress scrub** — defense-in-depth redaction (PII + secret-shaped strings: API keys, tokens, JWTs)
  on *everything returned over MCP*, because the consumer may be a cloud model. On top of capture-time exclusion.
- **Honor exclusions** — apps the user excluded are never returned via MCP.
- **Pause / scope** — `mcp.paused` cuts the agent off; `mcp.sinceDays` limits it to a recent window. Human-owned, in config / the dashboard.
- **Auditability** — every query is appended to `~/.continuum/mcp-queries.log` and shown in the dashboard's Privacy view: *"what your agent asked your memory, and when."*
- **Read-only** — the server only reads; deletion stays human-only in the dashboard.

## 5. How we got here (two critique rounds)
- **v1** (search/recent/meeting/profile, 5 tools): cut for **tool sprawl** (LLM can't choose), an
  **expensive/tier-fragile `profile`**, **flat text-dump returns**, no time scoping/citations, and
  **no human trust layer**.
- **v2** (3 tools + structure + trust): cut for **token bloat** (full episodes), **egress** being the
  real privacy boundary (not capture), a **too-thin heuristic profile**, and that the agent should
  **understand you by default**, not only on demand.
- **v3** (this): snippet returns + progressive disclosure, **egress scrub**, **auto-snapshot in
  instructions**, tiered profile, and the full trust layer.

## 6. Implementation
- `daemon/mcp.mjs` — transport-free core (recall / catch_up / profile / snapshot / scrub / mapResult),
  pure over `(index, episodes)`; unit-tested in `daemon/mcp.test.mjs`.
- `daemon/mcp-server.mjs` — thin stdio JSON-RPC wrapper: rebuilds the index on store change, routes
  tool calls, applies exclusions + pause/scope, writes the audit log, formats responses.
- Works fully offline (hashed embeddings); a model only *enriches* `profile`.
