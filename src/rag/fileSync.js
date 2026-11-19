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

export async function scanMarkdownFiles(dir, cwd = process.cwd()) {
  const result = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await scanMarkdownFiles(fullPath, cwd);
        result.push(...subFiles);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.md' || ext === '.txt') {
          const relPath = path.relative(cwd, fullPath).replace(/\\/g, '/');
          result.push(relPath);
        }
      }
    }
  } catch {}
  return result;
}

export function isIntendedFreeTierFile(relPath) {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();

  // 1. Canonical Story Bible (strictly the 4 core canonical files)
  const canonicalBibleFiles = new Set([
    'story-bible/plot-overview.md',
    'story-bible/plot-overview.txt',
    'story-bible/characters.md',
    'story-bible/characters.txt',
    'story-bible/locations.md',
    'story-bible/locations.txt',
    'story-bible/world-and-lore.md',
    'story-bible/world-and-lore.txt'
  ]);
  if (canonicalBibleFiles.has(normalized)) {
    return true;
  }
  if (normalized.startsWith('story-bible/')) {
    return false;
  }

  // 2. Project Chapters: strictly project/chapter-XX/{chapter,plan,summary}.{md,txt}
  const projectMatch = normalized.match(/^project\/chapter-\d+\/([^/]+)$/);
  if (projectMatch) {
    const filename = projectMatch[1];
    const validChapterFilenames = new Set([
      'chapter.md', 'chapter.txt',
      'plan.md', 'plan.txt',
      'summary.md', 'summary.txt'
    ]);
    return validChapterFilenames.has(filename);
  }
  if (normalized.startsWith('project/')) {
    return false;
  }

  // 3. Condensed memory: strictly .condensed/story-so-far.{md,txt}
  // and .condensed/chapters/chapter-XX/{plan,prose}.{md,txt}
  if (normalized === '.condensed/story-so-far.md' || normalized === '.condensed/story-so-far.txt') {
    return true;
  }
  const condensedMatch = normalized.match(/^\.condensed\/chapters\/chapter-\d+\/([^/]+)$/);
  if (condensedMatch) {
    const filename = condensedMatch[1];
    return filename === 'plan.md' || filename === 'plan.txt' || filename === 'prose.md' || filename === 'prose.txt';
  }
  if (normalized.startsWith('.condensed/')) {
    return false;
  }

  // 4. Archive sessions: strictly conversations/archive/session-*.{md,txt}
  const archiveMatch = normalized.match(/^conversations\/archive\/session-[^/]+\.(md|txt)$/);
  if (archiveMatch) {
    return true;
  }
  if (normalized.startsWith('conversations/')) {
    return false;
  }

  return false;
}

export async function getTrackedFiles(cwd = process.cwd(), config = {}) {
  const tracked = [];

  // 1. story-bible/** (recursive: supports nested lore folders e.g. story-bible/factions/clans.md)
  const bibleDir = path.join(cwd, 'story-bible');
  const bibleFiles = await scanMarkdownFiles(bibleDir, cwd);
  tracked.push(...bibleFiles);

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

  // 3. .condensed/** (recursive: story-so-far.md, chapters/chapter-XX/plan.md, prose.md)
  const condensedDir = path.join(cwd, '.condensed');
  const condensedFiles = await scanMarkdownFiles(condensedDir, cwd);
  tracked.push(...condensedFiles);

  // 4. conversations/archive/*.md, *.txt
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

  // Free Tier Filtering:
  // If apiTier is explicitly 'free' (or when isPaid is false and apiTier is present),
  // omit any file pasted other than the actual files intended for use in free tier.
  const isPaid = config?.apiTier === 'paid' || config?.apiTier === 'developer';
  const isExplicitFreeTier = config?.apiTier === 'free' || (Boolean(config?.apiTier) && !isPaid);

  if (isExplicitFreeTier) {
    return tracked.filter((relPath) => isIntendedFreeTierFile(relPath));
  }

  return tracked;
}

export async function syncAllFiles({
  cwd = process.cwd(),
  vectorStore,
  embedder,
  config = {},
  force = false,
  _repairAttempts = 0
}) {
  try {
    const state = await loadState(cwd);
    let currentHashes = force ? {} : (state.fileHashes || {});
    const isPaid = config?.apiTier === 'paid' || config?.apiTier === 'developer';
    const isExplicitFreeTier = config?.apiTier === 'free' || (Boolean(config?.apiTier) && !isPaid);

    // Get all unscoped files on disk to detect omitted files for free tier reporting
    const allDiskFiles = await getTrackedFiles(cwd, { apiTier: 'paid' });
    const diskFiles = await getTrackedFiles(cwd, config);
    const diskFileSet = new Set(diskFiles);

    // Detect omitted files
    const omittedFiles = isExplicitFreeTier
      ? allDiskFiles.filter((f) => !diskFileSet.has(f))
      : [];

    let hasChanges = force;
    let indexedCount = 0;
    let deletedCount = 0;

    // 1. Detect deleted files (if not forcing a clean rebuild)
    if (!force) {
      for (const recordedPath of Object.keys(currentHashes)) {
        if (!diskFileSet.has(recordedPath)) {
          if (vectorStore && typeof vectorStore.deleteBySourcePath === 'function') {
            await vectorStore.deleteBySourcePath(recordedPath);
          }
          delete currentHashes[recordedPath];
          hasChanges = true;
          deletedCount++;
        }
      }
    }

    // If free tier, also purge any reference chunks that might exist in vectorStore
    if (isExplicitFreeTier && vectorStore && typeof vectorStore.deleteWhere === 'function') {
      await vectorStore.deleteWhere("source_type = 'story-bible-reference'");
    }

    // 2. Detect new or modified files
    for (const relPath of diskFiles) {
      const fullPath = path.join(cwd, relPath);
      const hash = await computeFileHash(fullPath);
      if (!hash) continue;

      if (force || currentHashes[relPath] !== hash) {
        // Re-index this file
        if (vectorStore && typeof vectorStore.deleteBySourcePath === 'function') {
          await vectorStore.deleteBySourcePath(relPath);
        }

        const content = await fs.readFile(fullPath, 'utf8');
        const chunks = chunkDocument({
          relativePath: relPath,
          content,
          chunkSizeTokens: config.rag?.chunkSizeTokens || 400,
          chunkOverlapTokens: config.rag?.chunkOverlapTokens || 60
        });

        if (chunks.length > 0) {
          // Embed semantic content (section title + raw body) without noisy [File: ... | Type: ... | Tier: ...] header tags
          const textsToEmbed = chunks.map((c) => {
            const body = c.raw_text || c.text;
            return c.section_title ? `${c.section_title}\n${body}` : body;
          });
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
      if (vectorStore && typeof vectorStore.rebuildFtsIndex === 'function') {
        await vectorStore.rebuildFtsIndex();
      }
    }

    return {
      hasChanges,
      indexedCount,
      deletedCount,
      omittedCount: omittedFiles.length,
      omittedFiles
    };
  } catch (err) {
    if (
      _repairAttempts < 1 &&
      vectorStore &&
      typeof vectorStore._isCorruptError === 'function' &&
      vectorStore._isCorruptError(err)
    ) {
      console.warn('[fileSync] LanceDB corruption detected during file sync. Auto-recovering index and re-syncing...');
      await vectorStore.repairCorruptedIndex();
      return await syncAllFiles({
        cwd,
        vectorStore,
        embedder,
        config,
        force: true,
        _repairAttempts: _repairAttempts + 1
      });
    }
    throw err;
  }
}

export function startFileWatcher({
  cwd = process.cwd(),
  vectorStore,
  embedder,
  config = {},
  onSync = () => {}
}) {
  const watchTargets = [
    path.join(cwd, 'story-bible'),
    path.join(cwd, 'project'),
    path.join(cwd, '.condensed'),
    path.join(cwd, 'conversations', 'archive')
  ];
  let debounceTimeout = null;

  const triggerSync = (changedPath = '') => {
    if (changedPath) {
      const ext = path.extname(changedPath).toLowerCase();
      if (ext !== '.md' && ext !== '.txt') return;
    }
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

  const watcher = chokidar.watch(watchTargets, {
    ignored: (filePath) => {
      const normalized = filePath.replace(/\\/g, '/');
      return (
        normalized.includes('/.quillbot') ||
        normalized.includes('/.git') ||
        normalized.includes('/node_modules')
      );
    },
    ignoreInitial: true,
    persistent: true
  });

  watcher
    .on('add', triggerSync)
    .on('change', triggerSync)
    .on('unlink', triggerSync);

  return watcher;
}
