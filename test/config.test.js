import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  getStatePath,
  hasState,
  loadState,
  saveState,
  updateFileHash,
  setActiveBeat
} from '../src/config/stateManager.js';
import {
  loadConfig,
  saveConfig,
  ensureProjectDirectories,
  loadInstructions
} from '../src/config/configManager.js';

test('stateManager initializes and updates state correctly', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-state-'));
  try {
    const initialState = await loadState(tmpDir);
    assert.equal(initialState.activeChapter, 1);
    assert.equal(initialState.activeBeat, 1);
    assert.deepEqual(initialState.fileHashes, {});

    await updateFileHash('story-bible/characters.md', 'hash123', tmpDir);
    const updated = await loadState(tmpDir);
    assert.equal(updated.fileHashes['story-bible/characters.md'], 'hash123');

    await setActiveBeat(2, 4, tmpDir);
    const stateAfterBeat = await loadState(tmpDir);
    assert.equal(stateAfterBeat.activeChapter, 2);
    assert.equal(stateAfterBeat.activeBeat, 4);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('configManager ensures directories and loads instructions', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-cfg-'));
  try {
    await ensureProjectDirectories(tmpDir);

    const cfg = await loadConfig(tmpDir);
    assert.equal(cfg.models.small, 'openai/gpt-oss-20b');
    assert.equal(cfg.models.large, 'openai/gpt-oss-120b');
    assert.equal(cfg.ollama.embeddingModel, 'embeddinggemma');

    const instr = await loadInstructions(tmpDir);
    assert.match(instr, /Quillbot Literary Prose/);

    const statBible = await fs.stat(path.join(tmpDir, 'story-bible'));
    assert.ok(statBible.isDirectory());

    const statArchive = await fs.stat(path.join(tmpDir, 'conversations', 'archive'));
    assert.ok(statArchive.isDirectory());

    const statProject = await fs.stat(path.join(tmpDir, 'project'));
    assert.ok(statProject.isDirectory());
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
