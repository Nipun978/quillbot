import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chunkDocument, determineSourceMetadata } from '../src/rag/chunker.js';
import { VectorStore } from '../src/rag/vectorStore.js';
import { OllamaEmbedder } from '../src/rag/embedder.js';
import { CrossEncoderReranker } from '../src/rag/reranker.js';
import { computeFileHash, getTrackedFiles, syncAllFiles } from '../src/rag/fileSync.js';

test('chunker assigns metadata and context headers properly', () => {
  const metaBible = determineSourceMetadata('story-bible/characters.md');
  assert.equal(metaBible.source_type, 'story-bible');
  assert.equal(metaBible.authority_tier, 1);

  const metaProj = determineSourceMetadata('project/chapter-02/chapter.md');
  assert.equal(metaProj.source_type, 'chapter');
  assert.equal(metaProj.authority_tier, 2);
  assert.equal(metaProj.chapter_num, 2);

  const metaSummary = determineSourceMetadata('project/chapter-02/summary.md');
  assert.equal(metaSummary.source_type, 'chapter-summary');
  assert.equal(metaSummary.authority_tier, 2);

  const metaConv = determineSourceMetadata('conversations/archive/session-01.md');
  assert.equal(metaConv.source_type, 'conversation');
  assert.equal(metaConv.authority_tier, 3);

  const markdown = `## Lord Jonathan
Jonathan is the brooding lord of Havenbrook. He fears the coming mist.

## Lady Eleanor
Eleanor guards the ancient archives. She knows the secrets of the silver spire.`;

  const chunks = chunkDocument({
    relativePath: 'story-bible/characters.md',
    content: markdown,
    chunkSizeTokens: 400
  });

  assert.equal(chunks.length, 2);
  assert.match(chunks[0].text, /\[File: story-bible\/characters\.md \| Section: Lord Jonathan \| Type: story-bible \| Tier: 1\]/);
  assert.match(chunks[0].text, /brooding lord/);
  assert.match(chunks[1].text, /Lady Eleanor/);
});

test('vectorStore handles LanceDB table, FTS and RRF search', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-lancedb-'));
  const store = new VectorStore({}, tmpDir);
  try {
    await store.init();

    const dummyVector = new Array(768).fill(0.05);

    await store.addChunks([
      {
        id: 'story-bible/characters.md#chunk_0',
        source_path: 'story-bible/characters.md',
        source_type: 'story-bible',
        authority_tier: 1,
        chapter_num: 0,
        section_title: 'Lord Jonathan',
        text: '[File: story-bible/characters.md | Section: Lord Jonathan | Type: story-bible | Tier: 1]\nJonathan is the brooding lord of Havenbrook.',
        vector: dummyVector
      },
      {
        id: 'project/chapter-01/chapter.md#chunk_0',
        source_path: 'project/chapter-01/chapter.md',
        source_type: 'chapter',
        authority_tier: 2,
        chapter_num: 1,
        section_title: 'Scene 1',
        text: '[File: project/chapter-01/chapter.md | Section: Scene 1 | Type: chapter | Tier: 2]\nThe horses galloped through the Havenbrook gate.',
        vector: dummyVector
      }
    ]);

    const results = await store.hybridSearch({
      queryText: 'Havenbrook',
      queryVector: dummyVector,
      vectorTopK: 5,
      bm25TopK: 5
    });

    assert.ok(results.length > 0);
    // Story bible (tier 1) has 1.25x boost over chapter (tier 2: 1.10x)
    assert.equal(results[0].authority_tier, 1);
  } finally {
    await store.close();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {}
  }
});

test('reranker scores candidates and applies tier boosts', async () => {
  const reranker = new CrossEncoderReranker();

  const candidates = [
    {
      id: 'doc1',
      authority_tier: 1,
      text: 'Jonathan is the ruler of Havenbrook castle in the mountains.'
    },
    {
      id: 'doc2',
      authority_tier: 3,
      text: 'A random note about bread baking in the morning.'
    }
  ];

  const reranked = await reranker.rerank({
    queryText: 'Who rules Havenbrook castle?',
    candidates,
    topK: 2
  });

  assert.equal(reranked.length, 2);
  assert.equal(reranked[0].id, 'doc1');
  assert.ok(reranked[0].rerankScore > reranked[1].rerankScore);
});

test('fileSync tracks hashes and indexes files incrementally', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-sync-'));
  try {
    const bibleDir = path.join(tmpDir, 'story-bible');
    await fs.mkdir(bibleDir, { recursive: true });
    await fs.writeFile(path.join(bibleDir, 'characters.md'), '# Characters\n\nHero', 'utf8');

    const tracked = await getTrackedFiles(tmpDir);
    assert.deepEqual(tracked, ['story-bible/characters.md']);

    const store = new VectorStore({}, tmpDir);
    await store.init();
    const embedder = {
      embedTexts: async (texts) => texts.map(() => new Array(768).fill(0.05)),
      embedQuery: async () => new Array(768).fill(0.05)
    };

    const syncRes = await syncAllFiles({
      cwd: tmpDir,
      vectorStore: store,
      embedder,
      config: {}
    });

    assert.equal(syncRes.hasChanges, true);
    assert.equal(syncRes.indexedCount, 1);

    // Second sync should have no changes
    const syncRes2 = await syncAllFiles({
      cwd: tmpDir,
      vectorStore: store,
      embedder,
      config: {}
    });
    assert.equal(syncRes2.hasChanges, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
