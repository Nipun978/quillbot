import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SLASH_COMMANDS, completer } from '../src/ui/repl.js';
import { formatReadableLine, createReadableStreamPrinter } from '../src/ui/renderer.js';
import { getTrackedFiles } from '../src/rag/fileSync.js';
import { determineSourceMetadata, chunkDocument } from '../src/rag/chunker.js';
import { VectorStore } from '../src/rag/vectorStore.js';
import { runBibleQuery, runGeneralQuery } from '../src/workflows/chatBible.js';

test('Deprecate /chat: removed from SLASH_COMMANDS and completer', () => {
  assert.equal(SLASH_COMMANDS.includes('/chat'), false, '/chat must not exist in SLASH_COMMANDS');
  const [hits] = completer('/c');
  assert.equal(hits.includes('/chat'), false, 'completer must not suggest /chat');
  assert.deepEqual(hits, ['/config']);
});

test('Readable formatter strips raw markdown syntax cleanly across streamed chunks', () => {
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

  assert.equal(stripAnsi(formatReadableLine('### Character Summary')), 'Character Summary');
  assert.equal(stripAnsi(formatReadableLine('* **Name:** Kael `Stormborn`')), '- Name: Kael Stormborn');
  assert.equal(stripAnsi(formatReadableLine('He carries __the Ember Blade__ and *ancient* lore.')), 'He carries the Ember Blade and ancient lore.');
  assert.equal(stripAnsi(formatReadableLine('```markdown')), '');

  const printed = [];
  const printer = createReadableStreamPrinter((chunk) => printed.push(chunk));
  printer.push('## Over');
  printer.push('view\n* **Trait:** ');
  printer.push('Brave\nPlain tail');
  printer.flush();

  const combined = stripAnsi(printed.join(''));
  assert.equal(combined, 'Overview\n- Trait: Brave\nPlain tail');
});

test('RAG indexes .condensed files alongside story-bible, project, and conversations', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-condensed-rag-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'story-bible'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'project', 'chapter-01'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.condensed', 'chapters', 'chapter-01'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'conversations', 'archive'), { recursive: true });

    await fs.writeFile(path.join(tmpDir, 'story-bible', 'characters.md'), '# Kael\nA wanderer.', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'project', 'chapter-01', 'chapter.md'), '# Chapter 1\nKael crossed the bridge.', 'utf8');
    await fs.writeFile(path.join(tmpDir, '.condensed', 'story-so-far.md'), '# Story So Far\n- Ch 1: Bridge crossed.', 'utf8');
    await fs.writeFile(path.join(tmpDir, '.condensed', 'chapters', 'chapter-01', 'plan.md'), 'Beat 1: Crossing.', 'utf8');
    await fs.writeFile(path.join(tmpDir, '.condensed', 'chapters', 'chapter-01', 'prose.md'), 'Beat 1: Kael crossed safely.', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'conversations', 'archive', 'session-1.md'), 'Discussed bridge fog.', 'utf8');

    const tracked = await getTrackedFiles(tmpDir);
    assert.ok(tracked.includes('story-bible/characters.md'));
    assert.ok(tracked.includes('project/chapter-01/chapter.md'));
    assert.ok(tracked.includes('.condensed/story-so-far.md'));
    assert.ok(tracked.includes('.condensed/chapters/chapter-01/plan.md'));
    assert.ok(tracked.includes('.condensed/chapters/chapter-01/prose.md'));
    assert.ok(tracked.includes('conversations/archive/session-1.md'));

    assert.deepEqual(determineSourceMetadata('.condensed/story-so-far.md'), {
      source_type: 'condensed-story-so-far',
      authority_tier: 2,
      chapter_num: 0
    });
    assert.deepEqual(determineSourceMetadata('.condensed/chapters/chapter-01/plan.md'), {
      source_type: 'condensed-plan',
      authority_tier: 2,
      chapter_num: 1
    });
    assert.deepEqual(determineSourceMetadata('.condensed/chapters/chapter-01/prose.md'), {
      source_type: 'condensed-prose',
      authority_tier: 2,
      chapter_num: 1
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('VectorStore.hybridSearch filters strictly to story-bible when scoped and returns all sources when unscoped', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v8-scope-'));
  const store = new VectorStore({}, tmpDir);
  try {
    await store.init();
    const mkVec = (val) => {
      const v = new Array(768).fill(0.01);
      v[0] = val;
      return v;
    };

    const c1 = chunkDocument({
      relativePath: 'story-bible/characters.md',
      content: '# Kael\nKael is a storm-warden from the northern spires.'
    })[0];
    const c2 = chunkDocument({
      relativePath: '.condensed/story-so-far.md',
      content: '# Story So Far\nChapter 1: Kael lost his cloak at the northern bridge.'
    })[0];
    const c3 = chunkDocument({
      relativePath: 'project/chapter-01/chapter.md',
      content: '# Chapter 1\nKael shivered on the icy northern bridge.'
    })[0];

    await store.addChunks([
      { ...c1, vector: mkVec(0.9) },
      { ...c2, vector: mkVec(0.9) },
      { ...c3, vector: mkVec(0.9) }
    ]);

    const bibleOnly = await store.hybridSearch({
      queryText: 'Kael northern',
      queryVector: mkVec(0.9),
      sourceTypes: ['story-bible'],
      authorityTiers: [1]
    });
    assert.equal(bibleOnly.length, 1);
    assert.equal(bibleOnly[0].source_type, 'story-bible');
    assert.equal(bibleOnly[0].source_path, 'story-bible/characters.md');

    const allSources = await store.hybridSearch({
      queryText: 'Kael northern',
      queryVector: mkVec(0.9)
    });
    assert.equal(allSources.length, 3);
    const paths = allSources.map((r) => r.source_path);
    assert.ok(paths.includes('story-bible/characters.md'));
    assert.ok(paths.includes('.condensed/story-so-far.md'));
    assert.ok(paths.includes('project/chapter-01/chapter.md'));
  } finally {
    await store.close();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {}
  }
});

test('/bible query always improvises via 20B model and restricts Hybrid RAG to Story Bible files', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-bible-query-'));
  try {
    await fs.mkdir(path.join(tmpDir, '.quillbot'), { recursive: true });
    let improvisedCalledWith = null;
    let searchOptsSeen = null;
    let embeddedQuery = null;
    let largeMessages = null;
    const recordedTurns = [];

    const mockGroq = {
      chatCompletion: async ({ model, workflow, messages }) => {
        improvisedCalledWith = { model, workflow, messages };
        return 'Kael storm-warden northern spires canon lore';
      },
      streamChatCompletion: async ({ model, workflow, messages, onChunk }) => {
        largeMessages = { model, workflow, messages };
        onChunk('Kael comes from the northern spires, as noted in story-bible/characters.md.');
        return 'Kael comes from the northern spires, as noted in story-bible/characters.md.';
      }
    };

    const mockEmbedder = {
      embedQuery: async (q) => {
        embeddedQuery = q;
        return new Array(768).fill(0.1);
      }
    };

    const mockVectorStore = {
      hybridSearch: async (opts) => {
        searchOptsSeen = opts;
        return [
          {
            id: 'story-bible/characters.md#chunk_0',
            source_path: 'story-bible/characters.md',
            source_type: 'story-bible',
            authority_tier: 1,
            section_title: 'Kael',
            text: 'Kael comes from the northern spires.'
          },
          {
            id: 'project/chapter-01/chapter.md#chunk_0',
            source_path: 'project/chapter-01/chapter.md',
            source_type: 'chapter',
            authority_tier: 2,
            section_title: 'Ch 1',
            text: 'Should be excluded from Story Bible scope.'
          }
        ];
      }
    };

    const mockReranker = {
      rerank: async ({ candidates }) => candidates
    };

    const mockConvMgr = {
      current: { id: 'conv_test' },
      getRecentTurns: () => [], // empty history: must STILL improvise via 20B
      getRollingSummary: () => '',
      addTurn: async (role, content) => recordedTurns.push({ role, content })
    };

    await runBibleQuery({
      query: 'query where is kael from',
      cwd: tmpDir,
      groqClient: mockGroq,
      vectorStore: mockVectorStore,
      embedder: mockEmbedder,
      reranker: mockReranker,
      conversationMgr: mockConvMgr,
      config: { rag: { rerankTopK: 5 } }
    });

    assert.equal(improvisedCalledWith.model, 'small');
    assert.equal(improvisedCalledWith.workflow, 'IMPROVISE_BIBLE_QUERY');
    assert.equal(embeddedQuery, 'Kael storm-warden northern spires canon lore');
    assert.deepEqual(searchOptsSeen.sourceTypes, ['story-bible']);
    assert.deepEqual(searchOptsSeen.authorityTiers, [1]);

    const sysContent = largeMessages.messages[0].content;
    assert.ok(sysContent.includes('story-bible/characters.md'));
    assert.equal(sysContent.includes('Should be excluded from Story Bible scope.'), false);
    assert.ok(sysContent.includes('Do NOT use raw markdown syntax'));

    assert.equal(recordedTurns[0].content, '/bible query where is kael from');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Free-text general questions always improvise via 20B model and query all sources without restrictions', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-general-query-'));
  try {
    await fs.mkdir(path.join(tmpDir, '.quillbot'), { recursive: true });
    let improvisedCalledWith = null;
    let searchOptsSeen = null;
    let largeMessages = null;
    const recordedTurns = [];

    const mockGroq = {
      chatCompletion: async ({ model, workflow }) => {
        improvisedCalledWith = { model, workflow };
        return 'Kael cloak Chapter 1 condensed summary bridge';
      },
      streamChatCompletion: async ({ model, workflow, messages, onChunk }) => {
        largeMessages = { model, workflow, messages };
        onChunk('In Chapter 1, Kael lost his cloak at the bridge.');
        return 'In Chapter 1, Kael lost his cloak at the bridge.';
      }
    };

    const mockEmbedder = {
      embedQuery: async () => new Array(768).fill(0.1)
    };

    const mockVectorStore = {
      hybridSearch: async (opts) => {
        searchOptsSeen = opts;
        return [
          {
            id: 'story-bible/characters.md#chunk_0',
            source_path: 'story-bible/characters.md',
            source_type: 'story-bible',
            authority_tier: 1,
            section_title: 'Kael',
            text: 'Kael wears an ash-grey cloak.'
          },
          {
            id: '.condensed/story-so-far.md#chunk_0',
            source_path: '.condensed/story-so-far.md',
            source_type: 'condensed-story-so-far',
            authority_tier: 2,
            section_title: 'Story So Far',
            text: 'Ch 1: Kael lost his cloak on the bridge.'
          }
        ];
      }
    };

    const mockReranker = {
      rerank: async ({ candidates }) => candidates
    };

    const mockConvMgr = {
      current: { id: 'conv_test' },
      getRecentTurns: () => [],
      getRollingSummary: () => 'Author wants tight continuity.',
      addTurn: async (role, content) => recordedTurns.push({ role, content })
    };

    await runGeneralQuery({
      query: 'what happened to his cloak?',
      cwd: tmpDir,
      groqClient: mockGroq,
      vectorStore: mockVectorStore,
      embedder: mockEmbedder,
      reranker: mockReranker,
      conversationMgr: mockConvMgr,
      config: {}
    });

    assert.equal(improvisedCalledWith.model, 'small');
    assert.equal(improvisedCalledWith.workflow, 'IMPROVISE_GENERAL_QUERY');
    assert.equal(searchOptsSeen.sourceTypes, undefined, 'General queries must search all sources');
    assert.equal(searchOptsSeen.authorityTiers, undefined, 'General queries must search all tiers');

    const sysContent = largeMessages.messages[0].content;
    assert.ok(sysContent.includes('<story_bible_canon>'));
    assert.ok(sysContent.includes('<past_chapters>'));
    assert.ok(sysContent.includes('Kael lost his cloak on the bridge.'));
    assert.ok(sysContent.includes('Do NOT use raw markdown syntax'));

    assert.equal(recordedTurns[0].content, 'what happened to his cloak?');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
