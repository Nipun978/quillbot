import fs from 'node:fs/promises';
import path from 'node:path';

export function getLogDir(cwd = process.cwd()) {
  return path.join(cwd, 'logs');
}

export function getConversationLogPath(cwd = process.cwd()) {
  return path.join(getLogDir(cwd), 'conversations.log');
}

export async function ensureLogDir(cwd = process.cwd()) {
  const dir = getLogDir(cwd);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {}
  return dir;
}

/**
 * Log LLM payloads (system prompts, context, user input, model params, and model response)
 */
export async function logLlmPayload({
  cwd = process.cwd(),
  sessionId = 'global',
  workflow = 'LLM_REQUEST',
  model = '',
  temperature = 0.7,
  maxTokens = 4096,
  messages = [],
  response = '',
  error = null
}) {
  try {
    await ensureLogDir(cwd);
    const logPath = getConversationLogPath(cwd);
    const timestamp = new Date().toISOString();

    const formattedMessages = (messages || []).map((m, idx) => {
      const roleHeader = `--- [Message ${idx + 1} | Role: ${m.role?.toUpperCase() || 'UNKNOWN'}] ---`;
      return `${roleHeader}\n${m.content || '(empty)'}`;
    }).join('\n\n');

    const divider = '='.repeat(80);
    const sectionDivider = '-'.repeat(40);

    let logText = `\n${divider}\n`;
    logText += `[${timestamp}] WORKFLOW: ${workflow}\n`;
    logText += `Session ID:   ${sessionId}\n`;
    logText += `Model:        ${model}\n`;
    logText += `Temperature:  ${temperature} | MaxTokens: ${maxTokens}\n`;
    logText += `Message Count: ${messages?.length || 0}\n`;
    logText += `${sectionDivider} OUTGOING MESSAGES ${sectionDivider}\n\n`;
    logText += `${formattedMessages}\n\n`;

    if (error) {
      logText += `${sectionDivider} ERROR OCCURRED ${sectionDivider}\n`;
      logText += `${error?.stack || error?.message || String(error)}\n`;
    } else {
      logText += `${sectionDivider} RECEIVED RESPONSE ${sectionDivider}\n\n`;
      logText += typeof response === 'object' ? JSON.stringify(response, null, 2) : (response || '(empty)');
      logText += '\n';
    }

    logText += `${divider}\n`;

    await fs.appendFile(logPath, logText, 'utf8');
  } catch (err) {
    // Non-blocking log failure
    console.error(`[Logger Warning] Failed to write log: ${err.message}`);
  }
}

/**
 * Log high-level conversation lifecycle events (new session, archive, turns added)
 */
export async function logConversationEvent({
  cwd = process.cwd(),
  sessionId = 'unknown',
  eventType = 'EVENT',
  details = {}
}) {
  try {
    await ensureLogDir(cwd);
    const logPath = getConversationLogPath(cwd);
    const timestamp = new Date().toISOString();
    const divider = '-'.repeat(60);

    let logText = `\n${divider}\n`;
    logText += `[${timestamp}] EVENT: ${eventType} | Session: ${sessionId}\n`;
    logText += `Details: ${JSON.stringify(details, null, 2)}\n`;
    logText += `${divider}\n`;

    await fs.appendFile(logPath, logText, 'utf8');
  } catch {}
}
