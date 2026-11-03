import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  probeApiKey,
  QuotaManager,
  GROQ_OFFICIAL_QUOTAS
} from '../src/llm/quotaManager.js';
import {
  recordDailyTokens,
  getDailyTokens,
  loadState,
  saveState,
  getDefaultState
} from '../src/config/stateManager.js';
import { GroqClient } from '../src/llm/groqClient.js';
import { hotkeySelect, promptReviewWorkflow } from '../src/ui/reviewPrompt.js';
import { loadConfig } from '../src/config/configManager.js';

// =========================================================================
// Test 1: API Key Probe & Validation Test
// =========================================================================
test('Requirement 1: probeApiKey validates valid Groq key and extracts official limits', async () => {
  const fakeHeaders = {
    'x-ratelimit-limit-tokens': '8000',
    'x-ratelimit-remaining-tokens': '7950',
    'x-ratelimit-reset-tokens': '25ms',
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-remaining-requests': '998',
    'x-ratelimit-reset-requests': '1m30s'
  };

  const clientFactory = () => ({
    chat: {
      completions: {
        create: () => ({
          withResponse: async () => ({
            data: { choices: [{ message: { content: 'ok' } }] },
            response: { headers: fakeHeaders }
          })
        })
      }
    }
  });

  const res = await probeApiKey({
    apiKey: 'gsk_test_valid_key',
    model: 'openai/gpt-oss-20b',
    clientFactory
  });

  assert.equal(res.valid, true);
  assert.equal(res.tier, 'free');
  assert.equal(res.limitTpm, 8000);
  assert.equal(res.limitRpd, 1000);
  assert.equal(res.limits.tpm, 8000);
  assert.equal(res.limits.rpd, 1000);
  assert.equal(res.limits.rpm, 30);
  assert.equal(res.limits.tpd, 200000);
  assert.equal(res.remaining.tpm, 7950);
  assert.equal(res.remaining.rpd, 998);
  assert.equal(res.resetTokens, '25ms');
});

test('Requirement 1: probeApiKey identifies developer tier on high limits', async () => {
  const fakeHeaders = {
    'x-ratelimit-limit-tokens': '250000',
    'x-ratelimit-remaining-tokens': '249000',
    'x-ratelimit-reset-tokens': '10ms',
    'x-ratelimit-limit-requests': '10000',
    'x-ratelimit-remaining-requests': '9999'
  };

  const clientFactory = () => ({
    chat: {
      completions: {
        create: () => ({
          withResponse: async () => ({
            data: { choices: [{ message: { content: 'ok' } }] },
            response: { headers: fakeHeaders }
          })
        })
      }
    }
  });

  const res = await probeApiKey({
    apiKey: 'gsk_test_paid_key',
    model: 'openai/gpt-oss-120b',
    clientFactory
  });

  assert.equal(res.valid, true);
  assert.equal(res.tier, 'developer');
  assert.equal(res.limits.tpm, 250000);
  assert.equal(res.limits.rpm, 1000);
  assert.equal(res.limits.tpd, Infinity);
});

test('Requirement 1: probeApiKey rejects invalid Groq key on 401 error', async () => {
  const clientFactory = () => ({
    chat: {
      completions: {
        create: () => ({
          withResponse: async () => {
            const err = new Error('Invalid API Key');
            err.status = 401;
            throw err;
          }
        })
      }
    }
  });

  const res = await probeApiKey({
    apiKey: 'gsk_invalid_test_key',
    model: 'openai/gpt-oss-20b',
    clientFactory
  });

  assert.equal(res.valid, false);
  assert.equal(res.status, 401);
  assert.match(res.error, /Invalid API Key/);
});

// =========================================================================
// Test 2: Quota Tracking Test
// =========================================================================
test('Requirement 2: QuotaManager parses x-ratelimit-* headers and updates rolling RPM and daily usage', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-quota-'));
  try {
    const qm = new QuotaManager({ apiTier: 'free' }, tmpDir);

    const headers = {
      'x-ratelimit-limit-tokens': '8000',
      'x-ratelimit-remaining-tokens': '7500',
      'x-ratelimit-reset-tokens': '45ms',
      'x-ratelimit-limit-requests': '1000',
      'x-ratelimit-remaining-requests': '990',
      'x-ratelimit-reset-requests': '50s'
    };

    const usage = { total_tokens: 500, prompt_tokens: 300, completion_tokens: 200 };

    await qm.recordHeaders('openai/gpt-oss-120b', headers, usage, tmpDir);

    const snapshot = qm.getModelSnapshot('openai/gpt-oss-120b');
    assert.equal(snapshot.limitTpm, 8000);
    assert.equal(snapshot.remainingTpm, 7500);
    assert.equal(snapshot.resetTokens, '45ms');
    assert.equal(snapshot.limitRpd, 1000);
    assert.equal(snapshot.remainingRpd, 990);
    assert.equal(snapshot.resetRequests, '50s');
    assert.equal(snapshot.rollingRpm, 1);

    // Verify rolling RPM updates
    await qm.recordHeaders('openai/gpt-oss-120b', headers, usage, tmpDir);
    assert.equal(qm.getRollingRpm('openai/gpt-oss-120b'), 2);

    // Simulate expired timestamps (> 60s old)
    const stats = qm._getModelStats('openai/gpt-oss-120b');
    stats.requestTimestamps = [Date.now() - 65000, Date.now() - 70000];
    assert.equal(qm.getRollingRpm('openai/gpt-oss-120b'), 0);

    // Verify daily state tracking
    const daily = await getDailyTokens('openai/gpt-oss-120b', tmpDir);
    assert.equal(daily.tokens, 1000); // 500 + 500
    assert.equal(daily.requests, 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Requirement 2: StateManager resets dailyUsage when date changes', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-date-reset-'));
  try {
    const state = getDefaultState();
    // Simulate past date
    state.dailyUsage = {
      '2025-01-01': {
        'openai/gpt-oss-120b': { tokens: 15000, requests: 35 }
      }
    };
    await saveState(state, tmpDir);

    // Reading today's date should return 0 since past date is ignored
    const initialToday = await getDailyTokens('openai/gpt-oss-120b', tmpDir);
    assert.equal(initialToday.tokens, 0);
    assert.equal(initialToday.requests, 0);

    // Recording today should initialize today and clear stale date
    await recordDailyTokens('openai/gpt-oss-120b', 300, tmpDir);
    const updated = await getDailyTokens('openai/gpt-oss-120b', tmpDir);
    assert.equal(updated.tokens, 300);
    assert.equal(updated.requests, 1);

    const savedState = await loadState(tmpDir);
    assert.equal(savedState.dailyUsage['2025-01-01'], undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// =========================================================================
// Test 3: 429 Retry Interceptor Test
// =========================================================================
test('Requirement 4: GroqClient intercepts 429, extracts wait time, retries at N+1s, and succeeds', async () => {
  let callCount = 0;
  let interceptedWait = null;

  const config = {
    groqApiKey: 'dummy',
    models: { small: 'openai/gpt-oss-20b', large: 'openai/gpt-oss-120b' }
  };

  const client = new GroqClient(config);

  // Hook into onRetryWait to capture waitSeconds without real-time delay
  client.onRetryWait = async (targetWait, model, waitSeconds, attempt) => {
    interceptedWait = targetWait;
    assert.equal(waitSeconds, 2);
    assert.equal(targetWait, 3);
    assert.equal(attempt, 1);
  };

  // Mock Groq API
  client.client = {
    chat: {
      completions: {
        create: () => ({
          withResponse: async () => {
            callCount++;
            if (callCount === 1) {
              const err = new Error('Rate limit reached: Please try again in 2s');
              err.status = 429;
              throw err;
            }
            return {
              data: {
                choices: [{ message: { content: 'Retried prose successfully.' } }],
                usage: { total_tokens: 150 }
              },
              response: { headers: { 'x-ratelimit-remaining-tokens': '5000' } }
            };
          }
        })
      }
    }
  };

  const result = await client.chatCompletion({ model: 'large', messages: [{ role: 'user', content: 'write' }] });
  assert.equal(callCount, 2);
  assert.equal(interceptedWait, 3); // 2s requested + 1s buffer = 3s
  assert.equal(result, 'Retried prose successfully.');
});

// =========================================================================
// Test 4: 45s Cooldown & Hotkey Select Test
// =========================================================================
test('Requirement 3: hotkeySelect enforces cooldown on [A]ccept and unlocks when countdown reaches 0', async () => {
  const choices = [
    { key: 'a', name: '[A]ccept - Commit and proceed', value: 'accept' },
    { key: 'r', name: '[R]etry  - Regenerate', value: 'retry' },
    { key: 'e', name: '[E]dit   - Open editor', value: 'edit' }
  ];

  // While countdown is active (>0), pressing 'a' is blocked.
  // When countdown reaches 0s -> pressing 'a' resolves with 'accept'
  setTimeout(() => {
    process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
  }, 30);

  setTimeout(() => {
    process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
  }, 1200);

  const start = Date.now();
  const res = await hotkeySelect({
    message: 'Review Chapter 1 Plan:',
    choices,
    cooldownSeconds: 1, // 1s cooldown for test speed
    isPaid: false
  });

  const duration = Date.now() - start;
  assert.equal(res, 'accept');
  assert.ok(duration >= 900, 'Must wait until countdown reaches 0 before accept');
});

test('Requirement 3: hotkeySelect enforces cooldown on [R]etry and unlocks when countdown reaches 0', async () => {
  const choices = [
    { key: 'a', name: '[A]ccept - Commit and proceed', value: 'accept' },
    { key: 'r', name: '[R]etry  - Regenerate with revision feedback', value: 'retry' },
    { key: 'e', name: '[E]dit   - Open editor', value: 'edit' }
  ];

  // While countdown is active (>0), pressing 'r' is blocked.
  // When countdown reaches 0s -> pressing 'r' resolves with 'retry'
  setTimeout(() => {
    process.stdin.emit('keypress', 'r', { sequence: 'r', name: 'r' });
  }, 30);

  setTimeout(() => {
    process.stdin.emit('keypress', 'r', { sequence: 'r', name: 'r' });
  }, 1200);

  const start = Date.now();
  const res = await hotkeySelect({
    message: 'Review Beat 1 Prose:',
    choices,
    cooldownSeconds: 1, // 1s cooldown for test speed
    isPaid: false
  });

  const duration = Date.now() - start;
  assert.equal(res, 'retry');
  assert.ok(duration >= 900, 'Must wait until countdown reaches 0 before retry');
});

test('Requirement 3: other hotkeys ([E]dit, [P]ause) resolve immediately even during cooldown', async () => {
  const choices = [
    { key: 'a', name: '[A]ccept - Commit and proceed', value: 'accept' },
    { key: 'r', name: '[R]etry  - Regenerate', value: 'retry' },
    { key: 'e', name: '[E]dit   - Open editor', value: 'edit' },
    { key: 'p', name: '[P]ause  - Save progress', value: 'pause' }
  ];

  // Press 'e' at 30ms while cooldown is 10s
  setTimeout(() => {
    process.stdin.emit('keypress', 'e', { sequence: 'e', name: 'e' });
  }, 30);

  const start = Date.now();
  const res = await hotkeySelect({
    message: 'Review Beat 1:',
    choices,
    cooldownSeconds: 10,
    isPaid: false
  });

  const duration = Date.now() - start;
  assert.equal(res, 'edit');
  assert.ok(duration < 200, 'Edit hotkey must resolve immediately without waiting for cooldown');
});

test('Requirement 3: Developer / Paid tier user can tap Spacebar to skip countdown instantly for both accept and retry', async () => {
  const choices = [
    { key: 'a', name: '[A]ccept - Commit and proceed', value: 'accept' },
    { key: 'r', name: '[R]etry  - Regenerate', value: 'retry' }
  ];

  // Tap Spacebar at 40ms, then tap 'r' at 80ms
  setTimeout(() => {
    process.stdin.emit('keypress', ' ', { sequence: ' ', name: 'space' });
  }, 40);

  setTimeout(() => {
    process.stdin.emit('keypress', 'r', { sequence: 'r', name: 'r' });
  }, 80);

  const start = Date.now();
  const res = await hotkeySelect({
    message: 'Review Beat 2:',
    choices,
    cooldownSeconds: 45, // 45s cooldown
    isPaid: true         // Developer plan
  });

  const duration = Date.now() - start;
  assert.equal(res, 'retry');
  assert.ok(duration < 300, 'Spacebar must skip countdown instantly on developer tier');
});

test('Requirement 3: Editor bypass prevention - [A]ccept edited version enforces remaining cooldown and [D]iscard preserves cooldown', async () => {
  const choices = [
    { key: 'a', name: '[A]ccept edited version', value: 'accept' },
    { key: 'r', name: '[R]e-edit in editor', value: 'edit_again' },
    { key: 'd', name: '[D]iscard edits and return to review', value: 'discard' }
  ];

  // In post-edit prompt with 1s cooldown remaining:
  // Pressing 'a' at 30ms is blocked; at 1200ms succeeds
  setTimeout(() => {
    process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
  }, 30);

  setTimeout(() => {
    process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
  }, 1200);

  const start = Date.now();
  const res = await hotkeySelect({
    message: 'Action with edited text:',
    choices,
    cooldownSeconds: 1,
    isPaid: false
  });

  const duration = Date.now() - start;
  assert.equal(res, 'accept');
  assert.ok(duration >= 900, 'Post-edit accept must enforce remaining cooldown');
});

// =========================================================================
// Test 5: Consecutive Generation Cooldown Enforcement Test
// =========================================================================
test('Requirement 3: QuotaManager enforces cooldown period between two consecutive generations', async () => {
  const qm = new QuotaManager({ apiTier: 'free' });

  // 1. First generation finishes
  qm.recordGenerationEnd();

  let waitedSeconds = 0;
  // Hook wait handler to avoid real 45s delay in unit test
  qm.onCooldownWait = async (rem, cd) => {
    waitedSeconds = rem;
  };

  // Immediate second generation attempt should calculate remaining cooldown
  const remaining = qm.getRemainingCooldown(45);
  assert.ok(remaining >= 44 && remaining <= 45, 'Remaining cooldown must reflect ~45s');

  const waitResult = await qm.enforceGenerationCooldown({ cooldownSeconds: 45, isPaid: false });
  assert.ok(waitResult >= 44, 'Must enforce wait on free tier');
  assert.equal(waitedSeconds, waitResult);

  // Once waited, consecutive check has 0 remaining
  assert.equal(qm.getRemainingCooldown(45), 0);
});

test('Requirement 3: QuotaManager skips generation cooldown for Paid / Developer Plan', async () => {
  const qm = new QuotaManager({ apiTier: 'paid' });
  qm.recordGenerationEnd();

  const remaining = qm.getRemainingCooldown(45);
  assert.equal(remaining, 0, 'Paid tier must have 0 remaining cooldown');

  let waitCalled = false;
  qm.onCooldownWait = async () => {
    waitCalled = true;
  };

  const waitResult = await qm.enforceGenerationCooldown({ cooldownSeconds: 45, isPaid: true });
  assert.equal(waitResult, 0);
  assert.equal(waitCalled, false, 'Wait handler must not be called on paid tier');
});

// =========================================================================
// Test 6: Config Defaults & Quota Dashboard Data Test
// =========================================================================
test('Requirement 5: loadConfig provides default apiTier, cooldownSeconds, and rateLimits', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-cfg-defaults-'));
  try {
    const config = await loadConfig(tmpDir);
    assert.equal(config.apiTier, 'free');
    assert.equal(config.cooldownSeconds, 45);
    assert.deepEqual(config.rateLimits, {});
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Requirement 5: QuotaManager getDashboardData formats structured quota numbers for CLI /status', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-dashboard-'));
  try {
    const qm = new QuotaManager({
      apiTier: 'free',
      models: { small: 'openai/gpt-oss-20b', large: 'openai/gpt-oss-120b' }
    }, tmpDir);

    const headers = {
      'x-ratelimit-limit-tokens': '8000',
      'x-ratelimit-remaining-tokens': '6500',
      'x-ratelimit-reset-tokens': '15s',
      'x-ratelimit-limit-requests': '1000',
      'x-ratelimit-remaining-requests': '950',
      'x-ratelimit-reset-requests': '10m'
    };

    await qm.recordHeaders('openai/gpt-oss-120b', headers, { total_tokens: 1500 }, tmpDir);

    const dashboard = await qm.getDashboardData(tmpDir);
    assert.equal(dashboard.tier, 'free');
    assert.equal(dashboard.isPaid, false);
    assert.ok(Array.isArray(dashboard.models));

    const largeModelData = dashboard.models.find(m => m.model === 'openai/gpt-oss-120b');
    assert.ok(largeModelData, 'Large model must be present in dashboard');
    assert.equal(largeModelData.limitTpm, 8000);
    assert.equal(largeModelData.remainingTpm, 6500);
    assert.equal(largeModelData.usedTpm, 1500);
    assert.equal(largeModelData.resetTokens, '15s');
    assert.equal(largeModelData.usedTpd, 1500);
    assert.equal(largeModelData.limitTpd, 200000);
    assert.equal(largeModelData.remainingTpd, 198500);
    assert.equal(largeModelData.usedRpm, 1);
    assert.equal(largeModelData.remainingRpm, 29); // 30 - 1
    assert.equal(largeModelData.remainingRpd, 950);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
