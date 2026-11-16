import { Groq } from 'groq-sdk';
import { logLlmPayload } from '../config/logger.js';
import { QuotaManager, quotaManager as defaultQuotaManager } from './quotaManager.js';

const UTILITY_REASONING_WORKFLOWS = new Set([
  'INIT_CONDENSE',
  'CONDENSE_BEAT',
  'CONDENSE_BEAT_PROSE',
  'UPDATE_STORY_SO_FAR',
  'IMPROVISE_BIBLE_QUERY',
  'IMPROVISE_GENERAL_QUERY',
  'QUERY_REWRITE',
  'CONTINUITY_CRITIC',
  'COMPRESS_CONVERSATION_TURNS',
  'BIBLE_SAVE_EXTRACT',
  'CHAPTER_SUMMARY'
]);

function isReasoningModel(modelId = '') {
  const lower = String(modelId).toLowerCase();
  return lower.includes('gpt-oss') || lower.includes('deepseek-r1') || lower.includes('qwq') || lower.includes('reasoning');
}

function isTransientNetworkError(err) {
  const status = err?.status ?? err?.response?.status;
  if ([408, 500, 502, 503, 504].includes(Number(status))) {
    return true;
  }
  const msg = `${err?.name || ''} ${err?.message || ''} ${err?.cause?.message || ''} ${err?.cause?.code || ''} ${err?.code || ''}`.toLowerCase();
  return (
    msg.includes('connection error') ||
    msg.includes('apiconnectionerror') ||
    msg.includes('apiconnectiontimeouterror') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('eai_again') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed')
  );
}

export class GroqClient {
  constructor(config, cwd = process.cwd(), quotaManager = null) {
    this.config = config;
    this.cwd = cwd;
    this.apiKey = config.groqApiKey;
    this.baseURL = config.groqBaseUrl || config.baseUrl || undefined;
    this.retryBaseDelayMs = config.retryBaseDelayMs !== undefined ? Number(config.retryBaseDelayMs) : 1000;
    this.client = new Groq({
      apiKey: this.apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {})
    });
    this.quotaManager = quotaManager || new QuotaManager(config, cwd);
    this.onRetryWait = null; // optional hook for testing
  }

  updateConfig(config) {
    this.config = config;
    this.apiKey = config.groqApiKey;
    this.baseURL = config.groqBaseUrl || config.baseUrl || undefined;
    if (config.retryBaseDelayMs !== undefined) {
      this.retryBaseDelayMs = Number(config.retryBaseDelayMs);
    }
    this.client = new Groq({
      apiKey: this.apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {})
    });
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

  _resolveReasoningEffort(resolvedModel, explicitEffort, workflow) {
    if (explicitEffort) return explicitEffort;
    if (isReasoningModel(resolvedModel) && UTILITY_REASONING_WORKFLOWS.has(workflow)) {
      return 'low';
    }
    return undefined;
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

        if (isTransientNetworkError(err) && attempt < maxRetries) {
          attempt++;
          const backoffMs = Math.min(this.retryBaseDelayMs * Math.pow(2, attempt - 1), 8000);
          if (backoffMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
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
    reasoningEffort = undefined,
    sessionId = 'current',
    workflow = 'chatCompletion'
  }) {
    const resolvedModel = this.resolveModel(model);
    let effectiveMaxTokens = maxTokens;
    let effectiveEffort = this._resolveReasoningEffort(resolvedModel, reasoningEffort, workflow);
    let boostedAfterLength = false;

    try {
      return await this._executeWithRetry(async () => {
        while (true) {
          const payload = {
            model: resolvedModel,
            messages,
            temperature,
            max_tokens: effectiveMaxTokens,
            ...(effectiveEffort ? { reasoning_effort: effectiveEffort } : {})
          };

          const createPromise = this.client.chat.completions.create(payload);

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

          const choice = response?.choices?.[0];
          const finishReason = choice?.finish_reason;
          let result = choice?.message?.content || '';
          if (typeof result === 'string' && result.includes('</think>')) {
            const afterThink = result.slice(result.indexOf('</think>') + 8).trim();
            if (afterThink) {
              result = afterThink;
            }
          }

          // Recover transparently if a reasoning model spent its entire budget on hidden thinking tokens
          if (!result.trim() && finishReason === 'length' && !boostedAfterLength) {
            boostedAfterLength = true;
            effectiveMaxTokens = Math.max(effectiveMaxTokens * 2, 2048);
            if (isReasoningModel(resolvedModel)) {
              effectiveEffort = 'low';
            }
            continue;
          }

          await logLlmPayload({
            cwd: this.cwd,
            sessionId,
            workflow,
            model: resolvedModel,
            temperature,
            maxTokens: effectiveMaxTokens,
            messages,
            response: result
          });
          return result;
        }
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
    reasoningEffort = undefined,
    sessionId = 'current',
    workflow = 'jsonCompletion'
  }) {
    const resolvedModel = this.resolveModel(model);
    let effectiveMaxTokens = maxTokens;
    let effectiveEffort = this._resolveReasoningEffort(resolvedModel, reasoningEffort, workflow);
    let boostedAfterLength = false;

    try {
      return await this._executeWithRetry(async () => {
        while (true) {
          const createPromise = this.client.chat.completions.create({
            model: resolvedModel,
            messages,
            temperature,
            max_tokens: effectiveMaxTokens,
            response_format: { type: 'json_object' },
            ...(effectiveEffort ? { reasoning_effort: effectiveEffort } : {})
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

          const choice = response?.choices?.[0];
          const finishReason = choice?.finish_reason;
          const content = choice?.message?.content || '';

          if (!content.trim()) {
            if (finishReason === 'length' && !boostedAfterLength) {
              boostedAfterLength = true;
              effectiveMaxTokens = Math.max(effectiveMaxTokens * 2, 2048);
              if (isReasoningModel(resolvedModel)) {
                effectiveEffort = 'low';
              }
              continue;
            }
            throw new Error(`Empty JSON response from model '${resolvedModel}' (finish_reason: ${finishReason || 'unknown'})`);
          }

          let parsed;
          try {
            parsed = JSON.parse(content);
          } catch (jsonErr) {
            // Fallback: attempt to parse JSON from markdown code block
            const match = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/{[\s\S]*}/);
            if (match) {
              parsed = JSON.parse(match[1] || match[0]);
            } else if (finishReason === 'length' && !boostedAfterLength) {
              boostedAfterLength = true;
              effectiveMaxTokens = Math.max(effectiveMaxTokens * 2, 2048);
              if (isReasoningModel(resolvedModel)) {
                effectiveEffort = 'low';
              }
              continue;
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
            maxTokens: effectiveMaxTokens,
            messages,
            response: parsed
          });
          return parsed;
        }
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
    reasoningEffort = undefined,
    onChunk = () => {},
    sessionId = 'current',
    workflow = 'streamChatCompletion'
  }) {
    const resolvedModel = this.resolveModel(model);
    const effectiveEffort = this._resolveReasoningEffort(resolvedModel, reasoningEffort, workflow);
    try {
      return await this._executeWithRetry(async () => {
        const createPromise = this.client.chat.completions.create({
          model: resolvedModel,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
          ...(effectiveEffort ? { reasoning_effort: effectiveEffort } : {})
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
