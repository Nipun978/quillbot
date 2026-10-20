import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers';

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

export class CrossEncoderReranker {
  constructor(config = {}) {
    this.modelId = config.rag?.rerankerModel || 'Xenova/ms-marco-MiniLM-L-6-v2';
    this.topK = config.rag?.rerankTopK || 5;
    this.tokenizer = null;
    this.model = null;
    this.loadingPromise = null;
  }

  async _load() {
    if (this.tokenizer && this.model) return;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      this.tokenizer = await AutoTokenizer.from_pretrained(this.modelId);
      this.model = await AutoModelForSequenceClassification.from_pretrained(this.modelId);
    })();

    await this.loadingPromise;
    this.loadingPromise = null;
  }

  async rerank({
    queryText,
    candidates = [],
    topK = this.topK,
    authorityBoosts = { 1: 1.25, 2: 1.10, 3: 1.00 }
  }) {
    if (!candidates || candidates.length === 0) return [];
    if (!queryText || !queryText.trim()) {
      return candidates.slice(0, topK);
    }

    try {
      await this._load();

      // Only rerank the top candidates (up to 15)
      const subset = candidates.slice(0, 15);
      const scored = [];

      for (const item of subset) {
        const docText = item.text || item.raw_text || '';
        // Truncate document text to reasonable token length for cross-encoder
        const truncatedDoc = docText.slice(0, 1500);

        const inputs = await this.tokenizer(queryText, {
          text_pair: truncatedDoc,
          padding: true,
          truncation: true
        });

        const output = await this.model(inputs);
        const rawLogit = output.logits?.data?.[0] ?? 0;
        const normScore = sigmoid(rawLogit);

        const tier = Number(item.authority_tier) || 3;
        const boost = authorityBoosts[tier] ?? 1.0;
        const finalScore = normScore * boost;

        scored.push({
          ...item,
          rerankScore: finalScore,
          rawLogit
        });
      }

      scored.sort((a, b) => b.rerankScore - a.rerankScore);
      return scored.slice(0, topK);
    } catch (err) {
      // Fallback: if reranking fails, return topK candidates from RRF order
      return candidates.slice(0, topK);
    }
  }
}
