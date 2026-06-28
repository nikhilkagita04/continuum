// Retrieval — fuses the cheap tier (Stage 3 hybrid index) with the graph tier
// (Stage 4 temporal KG), then optionally grounds an answer with an LLM.
import { assembleContext, contextText } from './context.mjs';
import { routeSearch } from './stage3/index.mjs';

export async function answerQuery(query, { index, graph, llm, k = 6, now = 0, group = 'default', reranker = null, rerankPool = 20 } = {}) {
  const hits = await index.search(query, { k, now, ...routeSearch(query), ...(reranker ? { reranker, pool: rerankPool } : {}) });   // recency routing; optional semantic rerank
  const facts = graph ? ((await graph.search(query, group, k)).results || []) : [];
  const context = [
    ...facts.map((f) => `fact: ${f.fact}`),                 // structured/temporal first
    contextText(assembleContext(hits)),                     // then recall — chrome-trimmed, de-duped, capped
  ].join('\n');
  const answer = llm ? await llm('Answer using only the context. If it is not there, say you do not know.', `Context:\n${context}\n\nQuestion: ${query}`, 300) : null;
  return { hits, facts, answer };
}
