import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { createSpinner } from '../ui/renderer.js';

/**
 * Checks whether the given base URL points to a local Ollama instance
 */
export function isLocalOllama(baseUrl = '') {
  try {
    const url = new URL(baseUrl);
    return (
      url.hostname === '127.0.0.1' ||
      url.hostname === 'localhost' ||
      url.hostname === '::1' ||
      url.hostname === '0.0.0.0'
    );
  } catch {
    return (
      baseUrl.includes('127.0.0.1') ||
      baseUrl.includes('localhost') ||
      baseUrl.includes('0.0.0.0')
    );
  }
}

/**
 * Probes the Ollama /api/tags endpoint with a short timeout
 */
export async function probeOllama(baseUrl = 'http://127.0.0.1:11434', timeoutMs = 2000) {
  try {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const res = await fetch(`${cleanBase}/api/tags`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Spawns the `ollama serve` background process detached so it stays alive
 */
export function startOllamaProcess() {
  try {
    const child = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32'
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Polls the Ollama endpoint until it responds or maxWaitMs expires
 */
export async function waitForOllama(baseUrl = 'http://127.0.0.1:11434', maxWaitMs = 12000) {
  const cleanBase = baseUrl.replace(/\/$/, '');
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 600));
    const isUp = await probeOllama(cleanBase, 1500);
    if (isUp) {
      return true;
    }
  }
  return false;
}

/**
 * Automatically pulls an embedding model from Ollama if not present
 */
export async function pullOllamaModel(baseUrl = 'http://127.0.0.1:11434', model = 'embeddinggemma') {
  const cleanBase = baseUrl.replace(/\/$/, '');
  const spinner = createSpinner(`Pulling Ollama model '${model}'... (one-time setup)`).start();

  try {
    const res = await fetch(`${cleanBase}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: false })
    });

    if (res.ok) {
      spinner.succeed(`Ollama model '${model}' downloaded successfully.`);
      return true;
    } else {
      const errText = await res.text();
      spinner.warn(`Failed to auto-pull '${model}': ${errText}. Run 'ollama pull ${model}' manually.`);
      return false;
    }
  } catch (err) {
    spinner.warn(`Error pulling '${model}': ${err.message}. Run 'ollama pull ${model}' manually.`);
    return false;
  }
}

/**
 * Ensures Ollama server is running. If not running on local address,
 * starts `ollama serve` automatically in background and waits for it.
 */
export async function ensureOllamaRunning({
  baseUrl = 'http://127.0.0.1:11434',
  model = 'embeddinggemma',
  autoPull = true
} = {}) {
  const cleanBase = baseUrl.replace(/\/$/, '');
  const isUp = await probeOllama(cleanBase, 2000);

  if (isUp) {
    return { ok: true, alreadyRunning: true };
  }

  // If remote address, we cannot auto-start
  if (!isLocalOllama(cleanBase)) {
    return {
      ok: false,
      error: `Could not connect to remote Ollama server at ${cleanBase}.`
    };
  }

  const spinner = createSpinner("Ollama not running. Starting 'ollama serve' in background...").start();
  const spawned = startOllamaProcess();

  if (!spawned) {
    spinner.fail("Could not spawn 'ollama serve'. Ensure Ollama is installed and in your PATH.");
    return {
      ok: false,
      error: 'Ollama command not found in PATH.'
    };
  }

  const ready = await waitForOllama(cleanBase, 12000);
  if (ready) {
    spinner.succeed("Ollama server started successfully ('ollama serve').");
    return { ok: true, autoStarted: true };
  } else {
    spinner.warn("Launched 'ollama serve', but server did not respond within timeout.");
    return {
      ok: false,
      error: `Could not connect to Ollama at ${cleanBase} after auto-start attempt.`
    };
  }
}
