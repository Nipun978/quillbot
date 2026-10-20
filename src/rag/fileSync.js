import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import chokidar from 'chokidar';
import { chunkDocument } from './chunker.js';
import { loadState, saveState } from '../config/stateManager.js';

export async function computeFileHash(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch {
    return null;
  }
}

export async function getTrackedFiles(cwd = process.cwd()) {
  const tracked = [];

  // 1. story-bible/ (FLAT constraint: only top-level .md and .txt, no subdirectories)
  const bibleDir = path.join(cwd, 'story-bible');
  try {
    const entries = await fs.readdir(bibleDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.md' || ext === '.txt') {
          tracked.push(path.join('story-bible', entry.name).replace(/\\/g, '/'));
        }
      }
    }
  } catch {}

  // 2. project/chapter-XX/*.md, *.txt
  const projectDir = path.join(cwd, 'project');
  try {
    const chEntries = await fs.readdir(projectDir, { withFileTypes: true });
    for (const ch of chEntries) {
      if (ch.isDirectory() && ch.name.toLowerCase().startsWith('chapter-')) {
        const chPath = path.join(projectDir, ch.name);
        const files = await fs.readdir(chPath, { withFileTypes: true });
        for (const file of files) {
          if (file.isFile()) {
            const ext = path.extname(file.name).toLowerCase();
            if (ext === '.md' || ext === '.txt') {
              tracked.push(path.join('project', ch.name, file.name).replace(/\\/g, '/'));
            }
          }
        }
      }
    }
  } catch {}

  // 3. conversations/archive/*.md, *.txt
  const archiveDir = path.join(cwd, 'conversations', 'archive');
  try {
    const entries = await fs.readdir(archiveDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.md' || ext === '.txt') {
          tracked.push(path.join('conversations', 'archive', entry.name).replace(/\\/g, '/'));
        }
      }
    }
  } catch {}

  return tracked;
}

export async function syncAllFiles({
  cwd = process.cwd(),
  vectorStore,
  embedder,
  config = {}
}) {
  const state = await loadState(cwd);
  const currentHashes = state.fileHashes || {};
  const diskFiles = await getTrackedFiles(cwd);
  const diskFileSet = new Set(diskFiles);

  let hasChanges = false;
  let indexedCount = 0;
  let deletedCount = 0;

  // 1. Detect deleted files
  for (const recordedPath of Object.keys(currentHashes)) {
    if (!diskFileSet.has(recordedPath)) {
      await vectorStore.deleteBySourcePath(recordedPath);
      delete currentHashes[recordedPath];
      hasChanges = true;
      deletedCount++;
    }
  }

  // 2. Detect new or modified files
  for (const relPath of diskFiles) {
    const fullPath = path.join(cwd, relPath);
    const hash = await computeFileHash(fullPath);
    if (!hash) continue;

    if (currentHashes[relPath] !== hash) {
      // Re-index this file
      await vectorStore.deleteBySourcePath(relPath);

      const content = await fs.readFile(fullPath, 'utf8');
      const chunks = chunkDocument({
        relativePath: relPath,
        content,
        chunkSizeTokens: config.rag?.chunkSizeTokens || 400,
        chunkOverlapTokens: config.rag?.chunkOverlapTokens || 60
      });

      if (chunks.length > 0) {
        const textsToEmbed = chunks.map((c) => c.text);
        const embeddings = await embedder.embedTexts(textsToEmbed);

        chunks.forEach((c, idx) => {
          c.vector = embeddings[idx];
        });

        await vectorStore.addChunks(chunks);
        indexedCount += chunks.length;
      }

      currentHashes[relPath] = hash;
      hasChanges = true;
    }
  }

  if (hasChanges) {
    state.fileHashes = currentHashes;
    await saveState(state, cwd);
    await vectorStore.rebuildFtsIndex();
  }

  return { hasChanges, indexedCount, deletedCount };
}

export function startFileWatcher({
  cwd = process.cwd(),
  vectorStore,
  embedder,
  config = {},
  onSync = () => {}
}) {
  const bibleDir = path.join(cwd, 'story-bible');
  let debounceTimeout = null;

  const triggerSync = () => {
    if (debounceTimeout) clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(async () => {
      try {
        const res = await syncAllFiles({ cwd, vectorStore, embedder, config });
        if (res.hasChanges) {
          onSync(res);
        }
      } catch (err) {
        // Silent error in background watcher
      }
    }, 1000);
  };

  const watcher = chokidar.watch(bibleDir, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    depth: 0 // flat directory constraint
  });

  watcher
    .on('add', triggerSync)
    .on('change', triggerSync)
    .on('unlink', triggerSync);

  return watcher;
}
