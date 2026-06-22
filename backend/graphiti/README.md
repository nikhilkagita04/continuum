# Graph tier — temporal knowledge graph (optional, advanced)

The free tier runs entirely on the local hybrid index (capture → segment → vector recall).
This sidecar adds the **temporal knowledge graph** — entity/relation extraction with
bi-temporal edges (so "X changed to Y" is modelled, not overwritten) — on top of
[Graphiti](https://github.com/getzep/graphiti) (Apache-2.0, self-hostable).

It's **optional and advanced**: graph extraction needs a graph DB, an embedder, and a
**frontier LLM** (Claude/GPT-class — open models can't satisfy the strict extraction
schemas). That's why the graph is the paid/Pro capability, not the free default.

## Run the sidecar

```bash
# 1. graph DB (Docker is easiest)
docker run -d -p 7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5

# 2. python env (needs Python 3.10+)
python3 -m venv .venv && source .venv/bin/activate
pip install graphiti-core fastapi uvicorn anthropic

# 3. keys — one OpenAI key runs embeddings + extraction
export OPENAI_API_KEY=sk-...              # (optional: GRAPHITI_LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY for Claude extraction)
export NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=password

# 4. run it (from this directory)
uvicorn sidecar:app --port 8000
```

The sidecar exposes `/add`, `/search`, `/health`. `GRAPHITI_LLM_PROVIDER` selects the
extraction model: `openai` (default, gpt-4o-mini) or `anthropic` (Claude).

## Enable it in Continuum

In `~/.continuum/config.json`:

```json
{
  "graph": { "enabled": true, "url": "http://localhost:8000" },
  "llm":   { "provider": "openai" }
}
```

The pipeline's `distill` step then writes daily rollups into the graph, and retrieval
fuses graph facts with vector recall. `group_id` maps to a per-user / per-workspace
bucket, so memories stay isolated. Self-hosted graph + on-device capture keeps the
privacy story intact end-to-end.
