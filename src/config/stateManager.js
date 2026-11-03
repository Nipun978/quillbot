import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_DIR = '.quillbot';
const STATE_FILE = 'state.json';

export function getStatePath(cwd = process.cwd()) {
  return path.join(cwd, STATE_DIR, STATE_FILE);
}

export async function hasState(cwd = process.cwd()) {
  try {
    await fs.access(getStatePath(cwd));
    return true;
  } catch {
    return false;
  }
}

export function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

export function getDefaultState() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return {
    initialized: true,
    activeChapter: 1,
    activeBeat: 1,
    activeConversationId: `conv_${timestamp}`,
    fileHashes: {},
    dailyUsage: {}
  };
}

export async function loadState(cwd = process.cwd()) {
  const filePath = getStatePath(cwd);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...getDefaultState(),
      ...parsed,
      fileHashes: parsed.fileHashes || {},
      dailyUsage: parsed.dailyUsage || {}
    };
  } catch {
    return getDefaultState();
  }
}

export async function saveState(state, cwd = process.cwd()) {
  const dirPath = path.join(cwd, STATE_DIR);
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = getStatePath(cwd);
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

export async function updateFileHash(relativePath, hash, cwd = process.cwd()) {
  const state = await loadState(cwd);
  state.fileHashes[relativePath] = hash;
  await saveState(state, cwd);
  return state;
}

export async function removeFileHash(relativePath, cwd = process.cwd()) {
  const state = await loadState(cwd);
  delete state.fileHashes[relativePath];
  await saveState(state, cwd);
  return state;
}

export async function setActiveBeat(chapter, beat, cwd = process.cwd()) {
  const state = await loadState(cwd);
  state.activeChapter = Number(chapter);
  state.activeBeat = Number(beat);
  await saveState(state, cwd);
  return state;
}

export async function recordDailyTokens(model, tokens = 0, cwd = process.cwd()) {
  const state = await loadState(cwd);
  const today = getTodayDateString();
  if (!state.dailyUsage || typeof state.dailyUsage !== 'object') {
    state.dailyUsage = {};
  }
  // Automatically reset old dates on date change
  if (!state.dailyUsage[today]) {
    state.dailyUsage = { [today]: {} };
  }
  if (!state.dailyUsage[today][model]) {
    state.dailyUsage[today][model] = { tokens: 0, requests: 0 };
  }
  state.dailyUsage[today][model].tokens += (Number(tokens) || 0);
  state.dailyUsage[today][model].requests += 1;
  await saveState(state, cwd);
  return state.dailyUsage[today][model];
}

export async function getDailyTokens(model, cwd = process.cwd()) {
  const state = await loadState(cwd);
  const today = getTodayDateString();
  if (!state.dailyUsage || !state.dailyUsage[today] || !state.dailyUsage[today][model]) {
    return { tokens: 0, requests: 0 };
  }
  return state.dailyUsage[today][model];
}
