import { Groq } from 'groq-sdk';
import { logLlmPayload } from '../config/logger.js';

export class GroqClient {
  constructor(config, cwd = process.cwd()) {
    this.config = config;
    this.cwd = cwd;
    this.apiKey = config.groqApiKey;
    this.client = new Groq({ apiKey: this.apiKey });
  }

  updateConfig(config) {
    this.config = config;
    this.apiKey = config.groqApiKey;
    this.client = new Groq({ apiKey: this.apiKey });
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
      const response = await this.client.chat.completions.create({
        model: resolvedModel,
        messages,
        temperature,
        max_tokens: maxTokens
      });
      const result = response.choices[0]?.message?.content || '';
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
      const response = await this.client.chat.completions.create({
        model: resolvedModel,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' }
      });
      const content = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(content);
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
    } catch (err) {
      if (err instanceof SyntaxError) {
        // Fallback: attempt to parse JSON from markdown code block
        const text = err.message;
        const match = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/{[\s\S]*}/);
        if (match) {
          const parsed = JSON.parse(match[1] || match[0]);
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
      const stream = await this.client.chat.completions.create({
        model: resolvedModel,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true
      });

      let fullText = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          fullText += delta;
          onChunk(delta);
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
        response: fullText
      });
      return fullText;
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
