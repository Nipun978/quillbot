import { ensureOllamaRunning, pullOllamaModel } from './ollamaManager.js';

export class OllamaEmbedder {
  constructor(config = {}) {
    this.baseUrl = (config.ollama?.baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.model = config.ollama?.embeddingModel || 'embeddinggemma';
    this.dimensions = config.ollama?.embeddingDimensions || 768;
    this.batchSize = 20;
  }

  updateConfig(config = {}) {
    this.baseUrl = (config.ollama?.baseUrl || this.baseUrl).replace(/\/$/, '');
    this.model = config.ollama?.embeddingModel || this.model;
    this.dimensions = config.ollama?.embeddingDimensions || this.dimensions;
  }

  async checkConnection({ autoStart = true } = {}) {
    if (autoStart) {
      const ensureRes = await ensureOllamaRunning({ baseUrl: this.baseUrl, model: this.model });
      if (!ensureRes.ok) {
        return {
          ok: false,
          error: ensureRes.error || `Could not connect to Ollama at ${this.baseUrl}.`
        };
      }
    }

    try {
      const tagsRes = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });
      if (!tagsRes.ok) {
        return {
          ok: false,
          error: `Ollama responded with HTTP ${tagsRes.status} at ${this.baseUrl}`
        };
      }
      let data = await tagsRes.json();
      let models = (data.models || []).map((m) => m.name);
      let hasModel = models.some(
        (name) => name === this.model || name.startsWith(`${this.model}:`)
      );

      if (!hasModel && autoStart) {
        // Automatically attempt to pull the model if missing
        await pullOllamaModel(this.baseUrl, this.model);
        const retryTags = await fetch(`${this.baseUrl}/api/tags`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5000)
        });
        if (retryTags.ok) {
          data = await retryTags.json();
          models = (data.models || []).map((m) => m.name);
          hasModel = models.some(
            (name) => name === this.model || name.startsWith(`${this.model}:`)
          );
        }
      }

      if (!hasModel) {
        return {
          ok: false,
          error: `Model '${this.model}' is not pulled in Ollama. Found: [${models.join(', ')}]. Run 'ollama pull ${this.model}'.`
        };
      }

      // Quick test embed
      const testRes = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: ['health check']
        }),
        signal: AbortSignal.timeout(10000)
      });

      if (!testRes.ok) {
        return {
          ok: false,
          error: `Ollama /api/embed failed with HTTP ${testRes.status}`
        };
      }

      const testData = await testRes.json();
      const dim = testData.embeddings?.[0]?.length;
      if (dim && dim !== this.dimensions) {
        this.dimensions = dim;
      }

      return { ok: true, dimensions: this.dimensions };
    } catch (err) {
      return {
        ok: false,
        error: `Could not connect to Ollama at ${this.baseUrl}: ${err.message}. Ensure Ollama is running ('ollama serve').`
      };
    }
  }

  async embedTexts(texts = []) {
    if (!texts || texts.length === 0) {
      return [];
    }

    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => (t || ' ').trim() || ' ');
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: batch
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama embed call failed (HTTP ${response.status}): ${errorText}`);
      }

      const json = await response.json();
      if (!json.embeddings || !Array.isArray(json.embeddings)) {
        throw new Error(`Invalid response from Ollama /api/embed: missing embeddings array`);
      }

      for (const emb of json.embeddings) {
        allEmbeddings.push(emb);
      }
    }

    return allEmbeddings;
  }

  async embedQuery(text) {
    const embeddings = await this.embedTexts([text]);
    return embeddings[0] || new Array(this.dimensions).fill(0);
  }
}
