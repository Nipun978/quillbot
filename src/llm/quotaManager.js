import { recordDailyTokens, getDailyTokens } from '../config/stateManager.js';

export const GROQ_OFFICIAL_QUOTAS = {
  'openai/gpt-oss-120b': {
    free: { rpm: 30, tpm: 8000, rpd: 1000, tpd: 200000 },
    developer: { rpm: 1000, tpm: 250000, rpd: Infinity, tpd: Infinity }
  },
  'openai/gpt-oss-20b': {
    free: { rpm: 30, tpm: 8000, rpd: 1000, tpd: 200000 },
    developer: { rpm: 1000, tpm: 250000, rpd: Infinity, tpd: Infinity }
  },
  'llama-3.1-8b-instant': {
    free: { rpm: 30, tpm: 6000, rpd: 14400, tpd: 500000 },
    developer: { rpm: 1000, tpm: 250000, rpd: Infinity, tpd: Infinity }
  },
  'llama-3.3-70b-versatile': {
    free: { rpm: 30, tpm: 12000, rpd: 1000, tpd: 100000 },
    developer: { rpm: 1000, tpm: 250000, rpd: Infinity, tpd: Infinity }
  }
};

export const DEFAULT_QUOTA = {
  free: { rpm: 30, tpm: 6000, rpd: 1000, tpd: 100000 },
  developer: { rpm: 1000, tpm: 250000, rpd: Infinity, tpd: Infinity }
};

export function getHeaderValue(headers, key) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    return headers.get(key) || headers.get(key.toLowerCase()) || undefined;
  }
  const lower = key.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      return headers[k];
    }
  }
  return undefined;
}

export async function probeApiKey({ apiKey, model = 'openai/gpt-oss-20b', clientFactory = null }) {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, error: 'API key is empty' };
  }

  try {
    let client;
    if (clientFactory) {
      client = clientFactory({ apiKey: apiKey.trim() });
    } else {
      const { Groq } = await import('groq-sdk');
      client = new Groq({ apiKey: apiKey.trim() });
    }

    const reqPromise = client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'probe' }],
      max_tokens: 1
    });

    let resData;
    let resHeaders;

    if (typeof reqPromise.withResponse === 'function') {
      const withRes = await reqPromise.withResponse();
      resData = withRes.data;
      resHeaders = withRes.response?.headers;
    } else {
      const direct = await reqPromise;
      resData = direct.data || direct;
      resHeaders = direct.headers || direct.response?.headers;
    }

    const limitTokensRaw = getHeaderValue(resHeaders, 'x-ratelimit-limit-tokens');
    const remainingTokensRaw = getHeaderValue(resHeaders, 'x-ratelimit-remaining-tokens');
    const resetTokens = getHeaderValue(resHeaders, 'x-ratelimit-reset-tokens') || '';
    const limitRequestsRaw = getHeaderValue(resHeaders, 'x-ratelimit-limit-requests');
    const remainingRequestsRaw = getHeaderValue(resHeaders, 'x-ratelimit-remaining-requests');
    const resetRequests = getHeaderValue(resHeaders, 'x-ratelimit-reset-requests') || '';

    const limitTokens = limitTokensRaw ? parseInt(limitTokensRaw, 10) : undefined;
    const remainingTokens = remainingTokensRaw ? parseInt(remainingTokensRaw, 10) : undefined;
    const limitRequests = limitRequestsRaw ? parseInt(limitRequestsRaw, 10) : undefined;
    const remainingRequests = remainingRequestsRaw ? parseInt(remainingRequestsRaw, 10) : undefined;

    const official = GROQ_OFFICIAL_QUOTAS[model] || DEFAULT_QUOTA;

    let tier = 'free';
    if (limitTokens !== undefined && limitTokens >= official.developer.tpm) {
      tier = 'developer';
    } else if (limitTokens !== undefined && limitTokens > official.free.tpm) {
      tier = 'developer';
    }

    const tierQuota = tier === 'developer' ? official.developer : official.free;

    const limits = {
      tpm: limitTokens ?? tierQuota.tpm,
      rpd: limitRequests ?? tierQuota.rpd,
      rpm: tierQuota.rpm,
      tpd: tierQuota.tpd
    };

    const remaining = {
      tpm: remainingTokens ?? limits.tpm,
      rpd: remainingRequests ?? limits.rpd
    };

    return {
      valid: true,
      tier,
      limits,
      remaining,
      limitTpm: limits.tpm,
      limitRpd: limits.rpd,
      resetTokens,
      resetRequests
    };
  } catch (err) {
    return {
      valid: false,
      error: err?.message || 'Invalid API Key',
      status: err?.status || (err?.message?.includes('401') ? 401 : undefined)
    };
  }
}

export class QuotaManager {
  constructor(config = {}, cwd = process.cwd()) {
    this.config = config;
    this.cwd = cwd;
    this.tier = config.apiTier || 'free';
    this.modelStats = new Map();
    this.lastGenerationTime = null;
    this.onCooldownWait = null; // optional test hook
  }

  updateConfig(config) {
    this.config = config;
    if (config.apiTier) {
      this.tier = config.apiTier;
    }
  }

  isPaidTier() {
    return this.tier === 'developer' || this.tier === 'paid';
  }

  recordGenerationEnd() {
    this.lastGenerationTime = Date.now();
  }

  getRemainingCooldown(cooldownSeconds = 45) {
    if (this.isPaidTier() || !this.lastGenerationTime || cooldownSeconds <= 0) {
      return 0;
    }
    const elapsedSec = Math.floor((Date.now() - this.lastGenerationTime) / 1000);
    return Math.max(0, cooldownSeconds - elapsedSec);
  }

  async enforceGenerationCooldown({ cooldownSeconds = 45, isPaid = false, onWait = null }) {
    if (isPaid || this.isPaidTier() || cooldownSeconds <= 0) {
      return 0;
    }

    const remaining = this.getRemainingCooldown(cooldownSeconds);
    if (remaining <= 0) {
      return 0;
    }

    const waitHandler = onWait || this.onCooldownWait;
    if (typeof waitHandler === 'function') {
      await waitHandler(remaining, cooldownSeconds);
    } else {
      let spinner = null;
      try {
        const { createSpinner } = await import('../ui/renderer.js');
        spinner = createSpinner(`Rate limit buffer: enforcing ${cooldownSeconds}s cooldown between consecutive generations. Ready in ${remaining}s...`).start();
      } catch {}

      for (let s = remaining; s > 0; s--) {
        if (spinner) {
          spinner.text = `Rate limit buffer: enforcing ${cooldownSeconds}s cooldown between consecutive generations. Ready in ${s}s...`;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (spinner) {
        spinner.stop();
      }
    }

    this.lastGenerationTime = null;
    return remaining;
  }

  _getModelStats(model) {
    if (!this.modelStats.has(model)) {
      const official = GROQ_OFFICIAL_QUOTAS[model] || DEFAULT_QUOTA;
      const tierQuota = this.isPaidTier() ? official.developer : official.free;
      this.modelStats.set(model, {
        limitTpm: tierQuota.tpm,
        remainingTpm: tierQuota.tpm,
        resetTokens: '',
        limitRpd: tierQuota.rpd,
        remainingRpd: tierQuota.rpd,
        resetRequests: '',
        limitRpm: tierQuota.rpm,
        limitTpd: tierQuota.tpd,
        requestTimestamps: []
      });
    }
    return this.modelStats.get(model);
  }

  async recordHeaders(model, headers, usage = null, cwd = this.cwd) {
    const stats = this._getModelStats(model);

    if (headers) {
      const limitTokens = getHeaderValue(headers, 'x-ratelimit-limit-tokens');
      const remTokens = getHeaderValue(headers, 'x-ratelimit-remaining-tokens');
      const resetTokens = getHeaderValue(headers, 'x-ratelimit-reset-tokens');
      const limitRequests = getHeaderValue(headers, 'x-ratelimit-limit-requests');
      const remRequests = getHeaderValue(headers, 'x-ratelimit-remaining-requests');
      const resetRequests = getHeaderValue(headers, 'x-ratelimit-reset-requests');

      if (limitTokens !== undefined) stats.limitTpm = parseInt(limitTokens, 10);
      if (remTokens !== undefined) stats.remainingTpm = parseInt(remTokens, 10);
      if (resetTokens !== undefined) stats.resetTokens = resetTokens;
      if (limitRequests !== undefined) stats.limitRpd = parseInt(limitRequests, 10);
      if (remRequests !== undefined) stats.remainingRpd = parseInt(remRequests, 10);
      if (resetRequests !== undefined) stats.resetRequests = resetRequests;
    }

    // Record request timestamp for rolling 60s RPM tracking
    const now = Date.now();
    stats.requestTimestamps.push(now);
    stats.requestTimestamps = stats.requestTimestamps.filter((t) => now - t < 60000);

    // Record daily tokens in stateManager
    const tokens = usage?.total_tokens ?? ((usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0));
    try {
      await recordDailyTokens(model, tokens, cwd);
    } catch {
      // Non-fatal if state file inaccessible
    }

    return stats;
  }

  getRollingRpm(model) {
    const stats = this._getModelStats(model);
    const now = Date.now();
    stats.requestTimestamps = stats.requestTimestamps.filter((t) => now - t < 60000);
    return stats.requestTimestamps.length;
  }

  getModelSnapshot(model) {
    const stats = this._getModelStats(model);
    const now = Date.now();
    stats.requestTimestamps = stats.requestTimestamps.filter((t) => now - t < 60000);
    return { ...stats, rollingRpm: stats.requestTimestamps.length };
  }

  async getDashboardData(cwd = this.cwd) {
    const smallModel = this.config?.models?.small || 'openai/gpt-oss-20b';
    const largeModel = this.config?.models?.large || 'openai/gpt-oss-120b';
    const targetModels = new Set([smallModel, largeModel, ...this.modelStats.keys()]);

    const result = {
      tier: this.tier,
      isPaid: this.isPaidTier(),
      models: []
    };

    for (const model of targetModels) {
      const stats = this._getModelStats(model);
      const usedRpm = this.getRollingRpm(model);
      const remainingRpm = Math.max(0, stats.limitRpm - usedRpm);

      let daily = { tokens: 0, requests: 0 };
      try {
        daily = await getDailyTokens(model, cwd);
      } catch {}

      const usedTpd = daily.tokens || 0;
      const remainingTpd = stats.limitTpd === Infinity ? Infinity : Math.max(0, stats.limitTpd - usedTpd);

      const usedRpd = daily.requests || 0;
      const remainingRpd = stats.remainingRpd !== undefined
        ? stats.remainingRpd
        : (stats.limitRpd === Infinity ? Infinity : Math.max(0, stats.limitRpd - usedRpd));

      const usedTpm = Math.max(0, stats.limitTpm - stats.remainingTpm);

      let label = 'Model';
      if (model === smallModel && model === largeModel) {
        label = 'Primary';
      } else if (model === smallModel) {
        label = 'Small / Fast';
      } else if (model === largeModel) {
        label = 'Large / Prose & Plan';
      }

      result.models.push({
        model,
        label,
        limitTpm: stats.limitTpm,
        usedTpm,
        remainingTpm: stats.remainingTpm,
        resetTokens: stats.resetTokens,
        limitTpd: stats.limitTpd,
        usedTpd,
        remainingTpd,
        limitRpm: stats.limitRpm,
        usedRpm,
        remainingRpm,
        limitRpd: stats.limitRpd,
        usedRpd,
        remainingRpd,
        resetRequests: stats.resetRequests
      });
    }

    return result;
  }
}

// Global default instance for convenience
export const quotaManager = new QuotaManager();

export function recordHeaders(model, headers, usage = null, cwd = process.cwd()) {
  return quotaManager.recordHeaders(model, headers, usage, cwd);
}

export function isPaidTier() {
  return quotaManager.isPaidTier();
}

export function recordGenerationEnd() {
  return quotaManager.recordGenerationEnd();
}

export function getRemainingCooldown(cooldownSeconds = 45) {
  return quotaManager.getRemainingCooldown(cooldownSeconds);
}

export function enforceGenerationCooldown(options = {}) {
  return quotaManager.enforceGenerationCooldown(options);
}

export function getDashboardData(cwd = process.cwd()) {
  return quotaManager.getDashboardData(cwd);
}
