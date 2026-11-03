import { Groq } from 'groq-sdk';
import { logLlmPayload } from '../config/logger.js';
import { QuotaManager, quotaManager as defaultQuotaManager } from './quotaManager.js';

export class GroqClient {
  constructor(config, cwd = process.cwd(), quotaManager = null) {
    this.config = config;
    this.cwd = cwd;
    this.apiKey = config.groqApiKey;
    this.client = new Groq({ apiKey: this.apiKey });
    this.quotaManager = quotaManager || new QuotaManager(config, cwd);
    this.onRetryWait = null; // optional hook for testing
  }

  updateConfig(config) {
    this.config = config;
    this.apiKey = config.groqApiKey;
    this.client = new Groq({ apiKey: this.apiKey });
    if (this.quotaManager) {
      this.quotaManager.updateConfig(config);
    }
  }

  resolveModel(modelKeyOrId) {
    if (modelKeyOrId === 'small') {
      return this.config.models.small || 'openai/gpt-oss-20b';
    }
    if (modelKeyOrId === 'large') {
      return this.config.models.large || 'openai/gpt-oss-120b';
    }
    return modelKeyOrId;
  }

  async _countdownWait(seconds, model, requestedWait) {
    let spinner = null;
    try {
      const { createSpinner } = await import('../ui/renderer.js');
      spinner = createSpinner(`Rate limit reached (429) on ${model}. Groq requested wait: ${requestedWait}s. Retrying in ${seconds}s...`).start();
    } catch {}

    for (let s = seconds; s > 0; s--) {
      if (spinner) {
        spinner.text = `Rate limit reached (429) on ${model}. Groq requested wait: ${requestedWait}s. Retrying in ${s}s...`;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (spinner) {
      spinner.stop();
    }
  }

  async _executeWithRetry(fn, { model, workflow, maxRetries = 3 }) {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        const is429 = err?.status === 429 ||
                      err?.message?.includes('429') ||
                      err?.message?.toLowerCase().includes('rate limit') ||
                      err?.message?.toLowerCase().includes('rate_limit');

        if (is429 && attempt < maxRetries) {
          attempt++;
          const retryHeader = (typeof err.headers?.get === 'function' ? err.headers.get('retry-after') : err.headers?.['retry-after']) ||
                              (typeof err.response?.headers?.get === 'function' ? err.response.headers.get('retry-after') : err.response?.headers?.['retry-after']);
          const msgMatch = (err.message || '').match(/try again in ([\d\.]+)s/i);
          const waitSeconds = Math.ceil(parseFloat(retryHeader || msgMatch?.[1] || '8'));
          const targetWait = waitSeconds + 1;

          if (typeof this.onRetryWait === 'function') {
            await this.onRetryWait(targetWait, model, waitSeconds, attempt);
          } else {
            await this._countdownWait(targetWait, model, waitSeconds);
          }
          continue;
        }
        throw err;
      }
    }
  }

  async chatCompletion({
    model = 'large',
    messages = [],
    temperature = 0.7,
    maxTokens = 4096,
    sessionId = 'current',
    workflow = 'chatCompletion'
  }) {
    const resolvedModel = this.resolveModel(model);
    try {
      return await this._executeWithRetry(async () => {
        const createPromise = this.client.chat.completions.create({
          model: resolvedModel,
          messages,
          temperature,
          max_tokens: maxTokens
        });

        let response;
        let headers;
        if (typeof createPromise.withResponse === 'function') {
          const withRes = await createPromise.withResponse();
          response = withRes.data;
          headers = withRes.response?.headers;
        } else {
          response = await createPromise;
          headers = response?.headers || response?.response?.headers;
        }

        const usage = response?.usage;
        if (this.quotaManager) {
          await this.quotaManager.recordHeaders(resolvedModel, headers, usage, this.cwd);
        }

        const result = response?.choices?.[0]?.message?.content || '';
        await logLlmPayload({
          cwd: this.cwd,
          sessionId,
          workflow,
          model: resolvedModel,
          temperature,
          maxTokens,
          messages,
          response: result
        });
        return result;
      }, { model: resolvedModel, workflow });
    } catch (err) {
      await logLlmPayload({
        cwd: this.cwd,
        sessionId,
        workflow,
        model: resolvedModel,
        temperature,
        maxTokens,
        messages,
        error: err
      });
      this._handleGroqError(err, resolvedModel);
    }
  }

  async jsonCompletion({
    model = 'small',
    messages = [],
    temperature = 0.2,
    maxTokens = 4096,
    sessionId = 'current',
    workflow = 'jsonCompletion'
  }) {
    const resolvedModel = this.resolveModel(model);
    try {
      return await this._executeWithRetry(async () => {
        const createPromise = this.client.chat.completions.create({
          model: resolvedModel,
          messages,
          temperature,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' }
        });

        let response;
        let headers;
        if (typeof createPromise.withResponse === 'function') {
          const withRes = await createPromise.withResponse();
          response = withRes.data;
          headers = withRes.response?.headers;
        } else {
          response = await createPromise;
          headers = response?.headers || response?.response?.headers;
        }

        const usage = response?.usage;
        if (this.quotaManager) {
          await this.quotaManager.recordHeaders(resolvedModel, headers, usage, this.cwd);
        }

        const content = response?.choices?.[0]?.message?.content || '{}';
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (jsonErr) {
          // Fallback: attempt to parse JSON from markdown code block
          const match = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/{[\s\S]*}/);
          if (match) {
            parsed = JSON.parse(match[1] || match[0]);
          } else {
            throw jsonErr;
          }
        }

        await logLlmPayload({
          cwd: this.cwd,
          sessionId,
          workflow,
          model: resolvedModel,
          temperature,
          maxTokens,
          messages,
          response: parsed
        });
        return parsed;
      }, { model: resolvedModel, workflow });
    } catch (err) {
      await logLlmPayload({
        cwd: this.cwd,
        sessionId,
        workflow,
        model: resolvedModel,
        temperature,
        maxTokens,
        messages,
        error: err
      });
      this._handleGroqError(err, resolvedModel);
    }
  }

  async streamChatCompletion({
    model = 'large',
    messages = [],
    temperature = 0.7,
    maxTokens = 4096,
    onChunk = () => {},
    sessionId = 'current',
    workflow = 'streamChatCompletion'
  }) {
    const resolvedModel = this.resolveModel(model);
    try {
      return await this._executeWithRetry(async () => {
        const createPromise = this.client.chat.completions.create({
          model: resolvedModel,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true
        });

        let stream;
        let headers;
        if (typeof createPromise.withResponse === 'function') {
          const withRes = await createPromise.withResponse();
          stream = withRes.data;
          headers = withRes.response?.headers;
        } else {
          stream = await createPromise;
          headers = stream?.headers || stream?.response?.headers;
        }

        let fullText = '';
        let lastUsage = null;
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullText += delta;
            onChunk(delta);
          }
          if (chunk.usage || chunk.x_groq?.usage) {
            lastUsage = chunk.usage || chunk.x_groq?.usage;
          }
        }

        const usage = lastUsage || {
          total_tokens: Math.ceil(fullText.length / 4) + messages.reduce((acc, m) => acc + Math.ceil((m.content?.length || 0) / 4), 0)
        };

        if (this.quotaManager) {
          await this.quotaManager.recordHeaders(resolvedModel, headers, usage, this.cwd);
        }

        await logLlmPayload({
          cwd: this.cwd,
          sessionId,
          workflow,
          model: resolvedModel,
          temperature,
          maxTokens,
          messages,
          response: fullText
        });
        return fullText;
      }, { model: resolvedModel, workflow });
    } catch (err) {
      await logLlmPayload({
        cwd: this.cwd,
        sessionId,
        workflow,
        model: resolvedModel,
        temperature,
        maxTokens,
        messages,
        error: err
      });
      this._handleGroqError(err, resolvedModel);
    }
  }

  _handleGroqError(err, model) {
    const message = err?.message || String(err);
    if (message.includes('401') || message.includes('invalid_api_key')) {
      throw new Error(`Groq Authentication Failed: Invalid API key. Please run /config or check .quillbot/config.json.`);
    }
    if (message.includes('429') || message.includes('rate_limit')) {
      throw new Error(`Groq Rate Limit Exceeded on model '${model}'. Please wait a moment and retry.`);
    }
    if (message.includes('model_not_found') || message.includes('does not exist')) {
      throw new Error(`Groq model '${model}' not found on your account. Check model names via /config.`);
    }
    throw new Error(`Groq API Error (${model}): ${message}`);
  }
}
