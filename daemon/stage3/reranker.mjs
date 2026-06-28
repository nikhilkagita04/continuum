// Cross-encoder reranker — the semantic second stage. The hybrid index recalls a wide candidate pool
// cheaply (bge-m3 + BM25 + RRF); this reorders the top-N by true query↔passage relevance, recovering the
// answer-bearing moment that first-stage retrieval ranked too low (measured: answer-bearing recall jumps
// r@5 0.67 → r@50 0.93, i.e. ~26 pts of hit@5 sit in the pool, reachable only by SEMANTIC reordering —
// lexical reranking could not move it).
//
// Runs FULLY ON-DEVICE via Transformers.js + ONNX (no egress — the local-first promise holds). Model is
// loaded lazily on first use and cached, so importing this module costs nothing until reranking happens.
// Default ms-marco-MiniLM-L-6-v2 (22M, 6-layer): fast on Apple Silicon, the standard English cross-encoder.

let _tok = null, _mdl = null, _loading = null;

async function load(model_id, dtype) {
  if (_mdl) return;
  if (!_loading) _loading = (async () => {
    const t = await import('@huggingface/transformers');
    _tok = await t.AutoTokenizer.from_pretrained(model_id);
    _mdl = await t.AutoModelForSequenceClassification.from_pretrained(model_id, { dtype });
  })();
  await _loading;
}

// Returns async (query, docs[]) -> number[] relevance scores (higher = more relevant). Batched in one
// forward pass. Texts are truncated; the model's own tokenizer truncation caps sequence length.
export function crossEncoderReranker({ model_id = 'Xenova/ms-marco-MiniLM-L-6-v2', dtype = 'q8', maxChars = 400 } = {}) {
  return async (query, docs) => {
    if (!docs.length) return [];
    await load(model_id, dtype);
    const inputs = _tok(new Array(docs.length).fill(String(query)), {
      text_pair: docs.map((d) => String(d || '').slice(0, maxChars)),
      padding: true, truncation: true,
    });
    const { logits } = await _mdl(inputs);
    const data = Array.from(logits.data), n = docs.length, dim = data.length / n;
    // num_labels==1 → the logit IS the relevance score; num_labels==2 → take the positive class.
    return Array.from({ length: n }, (_, i) => (dim === 1 ? data[i] : data[i * dim + (dim - 1)]));
  };
}
