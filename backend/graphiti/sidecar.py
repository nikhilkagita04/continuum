# Continuum <-> Graphiti sidecar (graphiti-core 0.29.x). Temporal knowledge graph on Neo4j.
# Embeddings + reranker on OpenAI; extraction LLM = OpenAI (default) or Anthropic. Run from this dir:
#   OPENAI_API_KEY=... NEO4J_PASSWORD=... uvicorn sidecar:app --port 8000
import os
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from fastapi import FastAPI
from pydantic import BaseModel
from graphiti_core import Graphiti
from graphiti_core.nodes import EpisodeType
from graphiti_core.llm_client.openai_client import OpenAIClient
from graphiti_core.llm_client.anthropic_client import AnthropicClient
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient

OAI_KEY = os.environ["OPENAI_API_KEY"]   # embeddings + reranker (Anthropic has no embeddings API)
EMB_MODEL = os.environ.get("GRAPHITI_EMB_MODEL", "text-embedding-3-small")
EMB_DIM = int(os.environ.get("GRAPHITI_EMB_DIM", "1536"))

# The extraction LLM is the cost driver (several calls/episode). Switchable via GRAPHITI_LLM_PROVIDER:
#   anthropic (default) — Claude Sonnet+Haiku; reliable, ~$3-6/question. Use for the canonical run.
#   openai              — gpt-4o-mini; graphiti's native/tuned strict-structured-output path,
#                         ~15-20x cheaper. Use for scale-out (n>1/category) on the $20 OpenAI key.
# Open/local models are NOT an option for extraction: they can't satisfy graphiti's strict
# schemas (EdgeDuplicate/NodeResolutions) → pydantic ValidationError. Use a frontier model.
PROVIDER = os.environ.get("GRAPHITI_LLM_PROVIDER", "openai").lower()
if PROVIDER == "openai":
    LLM_MODEL = os.environ.get("GRAPHITI_LLM_MODEL", "gpt-4o-mini")
    llm = OpenAIClient(config=LLMConfig(api_key=OAI_KEY, model=LLM_MODEL, small_model=LLM_MODEL))
else:
    ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]
    LLM_MODEL = os.environ.get("GRAPHITI_LLM_MODEL", "claude-sonnet-4-6")
    LLM_SMALL = os.environ.get("GRAPHITI_LLM_SMALL", "claude-haiku-4-5-20251001")
    llm = AnthropicClient(config=LLMConfig(api_key=ANTHROPIC_KEY, model=LLM_MODEL, small_model=LLM_SMALL))
emb = OpenAIEmbedder(config=OpenAIEmbedderConfig(api_key=OAI_KEY, embedding_model=EMB_MODEL, embedding_dim=EMB_DIM))
cross = OpenAIRerankerClient(config=LLMConfig(api_key=OAI_KEY, model="gpt-4o-mini"))
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")
graphiti = Graphiti(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, llm_client=llm, embedder=emb, cross_encoder=cross)


@asynccontextmanager
async def lifespan(_app):
    try:
        await graphiti.build_indices_and_constraints()
    except Exception as e:
        print("build_indices warning:", e)
    yield
    try:
        await graphiti.close()
    except Exception:
        pass


app = FastAPI(lifespan=lifespan)


class AddReq(BaseModel):
    text: str
    name: str = "memory"
    group_id: str = "default"
    date: str | None = None


class SearchReq(BaseModel):
    query: str
    k: int = 5
    group_id: str = "default"


@app.post("/add")
async def add(r: AddReq):
    try:
        ref = datetime.fromisoformat(r.date).replace(tzinfo=timezone.utc) if r.date else datetime.now(timezone.utc)
    except Exception:
        ref = datetime.now(timezone.utc)
    await graphiti.add_episode(
        name=r.name, episode_body=r.text, source=EpisodeType.text,
        source_description="continuum capture", reference_time=ref, group_id=r.group_id,
    )
    return {"ok": True}


@app.post("/search")
async def search(r: SearchReq):
    edges = await graphiti.search(r.query, group_ids=[r.group_id], num_results=r.k)
    return {"results": [
        {"uuid": getattr(e, "uuid", None), "fact": getattr(e, "fact", None), "name": getattr(e, "name", None)}
        for e in edges
    ]}


@app.get("/health")
async def health():
    return {"ok": True}
