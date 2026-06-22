// Retrieval — fuses the cheap tier (Stage 3 hybrid index) with the graph tier
// (Stage 4 temporal KG), then optionally grounds an answer with an LLM.
export async function answerQuery(query, { index, graph, llm, k = 6, now = 0, group = 'default' } = {}) {
  const hits = await index.search(query, { k, now });
  const facts = graph ? ((await graph.search(query, group, k)).results || []) : [];
  const context = [
    ...facts.map((f) => `fact: ${f.fact}`),                 // structured/temporal first
    ...hits.map((h) => h.ep.text),                          // then raw recall
  ].join('\n');
  const answer = llm ? await llm('Answer using only the context. If it is not there, say you do not know.', `Context:\n${context}\n\nQuestion: ${query}`, 300) : null;
  return { hits, facts, answer };
}
