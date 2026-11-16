import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { truncateAtSentenceBoundary } from '../src/config/configManager.js';
import { getTrackedFiles } from '../src/rag/fileSync.js';
import { estimateTokenCount, chunkDocument } from '../src/rag/chunker.js';
import { VectorStore } from '../src/rag/vectorStore.js';
import { CrossEncoderReranker } from '../src/rag/reranker.js';
import { runWriteChapterWorkflow } from '../src/workflows/writeChapter.js';
import { ensureCondensedDirectories } from '../src/config/condensedManager.js';

test('Issue 1: truncateAtSentenceBoundary truncates cleanly at sentence boundaries', () => {
  // 1. Text within word limit is preserved
  const shortText = 'Crisp, visceral prose with deep point-of-view.';
  assert.equal(truncateAtSentenceBoundary(shortText, 100), shortText);

  // 2. Text exceeding word limit stops at the last complete sentence
  const sentence1 = 'Prioritize micro-expressions over internal monologues and ground every scene in physical reality.';
  const sentence2 = 'Use sensory texture to convey emotional subtext rather than abstract naming of feelings.';
  const sentence3 = 'Avoid purple prose, unnecessary adjectives, and melodrama whenever dialogue can carry the weight.';
  const sentence4 = 'Ensure that the world feels ancient, worn, and tactile.';
  const longText = `${sentence1} ${sentence2} ${sentence3} ${sentence4}`;

  // If maxWords allows sentence 1 and 2 (~25 words), it should truncate before sentence 3
  const truncated = truncateAtSentenceBoundary(longText, 26);
  assert.equal(truncated, `${sentence1} ${sentence2}`);
  assert.ok(truncated.endsWith('.'), 'Must end with sentence boundary punctuation');
  assert.ok(!truncated.includes('Avoid purple prose'), 'Must not include truncated fragment of sentence 3');

  // 3. Fallback when there is a giant run-on sentence without punctuation
  const runOn = 'word '.repeat(120).trim();
  const truncatedRunOn = truncateAtSentenceBoundary(runOn, 50);
  assert.ok(truncatedRunOn.endsWith('.'));
  assert.equal(truncatedRunOn.replace('.', '').trim().split(/\s+/).length, 50);
});

test('Issue 5: getTrackedFiles recursively scans nested subdirectories in story-bible/**', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-nested-bible-'));
  try {
    const bibleDir = path.join(tmpDir, 'story-bible');
    await fs.mkdir(path.join(bibleDir, 'factions'), { recursive: true });
    await fs.mkdir(path.join(bibleDir, 'lore', 'magic'), { recursive: true });

    await fs.writeFile(path.join(bibleDir, 'overview.md'), '# Overview', 'utf8');
    await fs.writeFile(path.join(bibleDir, 'factions', 'northern-clans.md'), '# Northern Clans', 'utf8');
    await fs.writeFile(path.join(bibleDir, 'lore', 'magic', 'elemental.md'), '# Elemental Magic', 'utf8');
    // Non-markdown file that should be ignored
    await fs.writeFile(path.join(bibleDir, 'factions', 'notes.pdf'), 'binary', 'utf8');

    const files = await getTrackedFiles(tmpDir);
    const relativePaths = files.map(f => (typeof f === 'string' ? f : f.relativePath).replace(/\\/g, '/')).sort();

    assert.ok(relativePaths.includes('story-bible/overview.md'));
    assert.ok(relativePaths.includes('story-bible/factions/northern-clans.md'));
    assert.ok(relativePaths.includes('story-bible/lore/magic/elemental.md'));
    assert.ok(!relativePaths.some(p => p.endsWith('.pdf')));
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

test('Issue 6: estimateTokenCount accurately counts tokens across punctuation, dialogue, and Unicode', () => {
  // Empty text
  assert.equal(estimateTokenCount(''), 0);
  assert.equal(estimateTokenCount(null), 0);

  // Dialogue with quotes and punctuation
  const dialogue = '"Stop right there!" she shouted. "Don\'t move a single step."';
  const dialogueTokens = estimateTokenCount(dialogue);
  assert.ok(dialogueTokens >= 12 && dialogueTokens <= 20, `Dialogue tokens (${dialogueTokens}) should be reasonable`);

  // Unicode and accents
  const unicodeText = 'Renée et François sont allés à São Paulo pour déguster des pâtisseries.';
  const unicodeTokens = estimateTokenCount(unicodeText);
  assert.ok(unicodeTokens >= 10 && unicodeTokens <= 25, `Unicode tokens (${unicodeTokens}) should be counted properly`);

  // Whitespace runs
  const spacedText = 'Word      another';
  const spacedTokens = estimateTokenCount(spacedText);
  assert.ok(spacedTokens >= 2);
});

test('Issue 6: chunkDocument splits large content without mid-sentence slicing', () => {
  const content = `# Section 1\n\n` +
    'The snow fell heavily across the silent valley. '.repeat(40) + '\n\n' +
    'Inside the cabin, the fireplace crackled with dry pine logs. '.repeat(30);

  const chunks = chunkDocument({
    relativePath: 'story-bible/environment.md',
    content,
    chunkSizeTokens: 100,
    chunkOverlapTokens: 20
  });

  assert.ok(chunks.length > 1, 'Should create multiple chunks for oversized content');
  for (const chunk of chunks) {
    assert.equal(chunk.source_type, 'story-bible');
    assert.equal(chunk.authority_tier, 1);
    // Every chunk should end with a clean punctuation mark, not mid-word slice
    const rawTrimmed = chunk.raw_text.trim();
    assert.ok(
      rawTrimmed.endsWith('.') || rawTrimmed.endsWith('!') || rawTrimmed.endsWith('?'),
      `Chunk must end at a sentence boundary. Ended with: "${rawTrimmed.slice(-10)}"`
    );
  }
});

test('Issue 7: vectorStore uses calibrated authorityBoosts and Unicode-safe BM25 cleaning', async () => {
  const store = new VectorStore({}, process.cwd());
  let receivedCleanQuery = null;

  // Mock table
  store.table = {
    countRows: async () => 1,
    vectorSearch: () => ({ limit: () => ({ toArray: async () => [] }) }),
    search: (q) => {
      receivedCleanQuery = q;
      return { limit: () => ({ toArray: async () => [] }) };
    }
  };

  await store.hybridSearch({
    queryText: 'Renée & François München!!',
    queryVector: []
  });

  // Unicode letters (é, ç, ü) should NOT be stripped out
  assert.ok(receivedCleanQuery.includes('Renée'), `BM25 clean query must preserve Unicode letters: ${receivedCleanQuery}`);
  assert.ok(receivedCleanQuery.includes('François'), `BM25 clean query must preserve Unicode letters: ${receivedCleanQuery}`);
  assert.ok(receivedCleanQuery.includes('München'), `BM25 clean query must preserve Unicode letters: ${receivedCleanQuery}`);
  assert.ok(!receivedCleanQuery.includes('&') && !receivedCleanQuery.includes('!'), 'BM25 clean query should replace symbols with spaces');
});

test('Issue 7: reranker applies soft additive tie-breaker instead of multiplicative distortion', async () => {
  const reranker = new CrossEncoderReranker();

  // Mock _load and tokenizer/model
  reranker.tokenizer = async (q, opts) => ({});
  reranker.model = async (inputs) => ({
    logits: { data: [0.0] } // sigmoid(0.0) = 0.5
  });

  const candidates = [
    { id: 'tier2_doc', authority_tier: 2, text: 'The identical manuscript text' },
    { id: 'tier1_doc', authority_tier: 1, text: 'The identical story bible text' },
    { id: 'tier3_doc', authority_tier: 3, text: 'The identical note text' }
  ];

  const reranked = await reranker.rerank({
    queryText: 'Find identical text',
    candidates,
    topK: 3
  });

  // Pure sigmoid score = 0.5
  // Tier 2 bonus = +0.02 -> 0.52 (Past Chapter manuscript progress has highest authority)
  // Tier 1 bonus = +0.01 -> 0.51 (Story Bible global baseline canon)
  // Tier 3 bonus = +0.00 -> 0.50 (Archived conversation notes)
  assert.equal(reranked[0].id, 'tier2_doc');
  assert.equal(reranked[1].id, 'tier1_doc');
  assert.equal(reranked[2].id, 'tier3_doc');

  assert.ok(Math.abs(reranked[0].rerankScore - 0.52) < 0.001);
  assert.ok(Math.abs(reranked[1].rerankScore - 0.51) < 0.001);
  assert.ok(Math.abs(reranked[2].rerankScore - 0.50) < 0.001);
});

test('Issues 2, 3 & 4: writeChapter injects instructions, orders KV-cache invariant prefix first, and supplies critic past context', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-write-flow-'));
  try {
    // 1. Setup project structure
    const quillbotDir = path.join(tmpDir, '.quillbot');
    const projectDir = path.join(tmpDir, 'project', 'chapter-02');
    await fs.mkdir(quillbotDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
    await ensureCondensedDirectories(tmpDir, 2);

    // Write custom instructions
    const customInstructions = 'CRITICAL RULE: Never describe characters looking in mirrors. Prioritize olfactory details.';
    await fs.writeFile(path.join(quillbotDir, 'instructions.md'), customInstructions, 'utf8');

    // Write chapter 1 summary
    const ch1Dir = path.join(tmpDir, 'project', 'chapter-01');
    await fs.mkdir(ch1Dir, { recursive: true });
    await fs.writeFile(path.join(ch1Dir, 'summary.md'), '# Chapter 1 Summary\nJonathan escaped the citadel.', 'utf8');

    // Write chapter 2 plan
    const planMd = `### Beat 1: The Mountain Pass
* **Characters:** Jonathan
* **Location:** Crag
* **Action:** Climbing through snow.
* **Goal/Hook:** Reaches the crest.
`;
    await fs.writeFile(path.join(projectDir, 'plan.md'), planMd, 'utf8');

    // Captured variables
    let capturedSystemPrompt = '';
    let capturedUserPrompt = '';
    let capturedCriticPrompt = '';

    const mockGroq = {
      streamChatCompletion: async ({ messages, onChunk }) => {
        const sys = messages.find(m => m.role === 'system');
        const user = messages.find(m => m.role === 'user');
        if (sys) capturedSystemPrompt = sys.content;
        if (user) capturedUserPrompt = user.content;
        const text = 'Jonathan hauled himself up the granite ledge, ice crunching beneath his leather boots.';
        if (onChunk) onChunk(text);
        return text;
      },
      jsonCompletion: async ({ messages }) => {
        const user = messages.find(m => m.role === 'user');
        if (user) capturedCriticPrompt = user.content;
        return { passed: true, severity: 'none', issues: [] };
      },
      chatCompletion: async () => 'Jonathan reached the mountain summit successfully.'
    };

    const mockReranker = {
      rerank: async () => [
        {
          id: 'story-bible/characters.md#chunk_0',
          source_path: 'story-bible/characters.md',
          section_title: 'Jonathan',
          authority_tier: 1,
          raw_text: 'Jonathan is a lone tracker.'
        }
      ]
    };

    const mockVectorStore = {
      hybridSearch: async () => [],
      deleteBySourcePath: async () => {},
      addChunks: async () => {},
      rebuildFtsIndex: async () => {}
    };

    const mockEmbedder = {
      embedQuery: async () => new Array(768).fill(0),
      embedTexts: async (texts) => texts.map(() => new Array(768).fill(0))
    };

    const mockConvMgr = {
      getRollingSummary: () => ''
    };

    // Auto-accept review hotkey simulation
    const timer = setInterval(() => {
      process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
    }, 40);

    try {
      await runWriteChapterWorkflow({
        chapterArg: '2 1',
        cwd: tmpDir,
        groqClient: mockGroq,
        vectorStore: mockVectorStore,
        embedder: mockEmbedder,
        reranker: mockReranker,
        conversationMgr: mockConvMgr,
        config: {
          writingStyle: 'Sparse and evocative.',
          editor: 'none',
          generation: { enableContinuityCritic: true, continuityTailWords: 350 }
        }
      });
    } finally {
      clearInterval(timer);
    }

    // Verify Issue 2: instructions.md is injected into system prompt
    assert.ok(
      capturedSystemPrompt.includes('<global_writing_instructions>'),
      'Must contain <global_writing_instructions> block in system prompt'
    );
    assert.ok(
      capturedSystemPrompt.includes(customInstructions),
      'Must contain actual instructions.md contents in system prompt'
    );

    // Verify Issue 3: KV-cache invariant order
    // <macro_story_continuity> and <chapter_scene_progression> must appear BEFORE <story_bible_lore>
    const macroIndex = capturedUserPrompt.indexOf('<macro_story_continuity>');
    const progressionIndex = capturedUserPrompt.indexOf('<chapter_scene_progression>');
    const loreIndex = capturedUserPrompt.indexOf('<story_bible_lore>');

    assert.ok(macroIndex !== -1, 'Must include <macro_story_continuity>');
    assert.ok(progressionIndex !== -1, 'Must include <chapter_scene_progression>');
    assert.ok(loreIndex !== -1, 'Must include <story_bible_lore>');

    assert.ok(
      macroIndex < loreIndex,
      'Invariant macro continuity must precede dynamic story bible lore for KV cache optimization'
    );
    assert.ok(
      progressionIndex < loreIndex,
      'Invariant chapter scene progression must precede dynamic story bible lore for KV cache optimization'
    );

    // Verify Issue 4: Critic receives pastChapterSummaries
    assert.ok(capturedCriticPrompt !== '', 'Critic should have received a prompt');
    assert.ok(
      capturedCriticPrompt.includes('Jonathan escaped the citadel'),
      'Critic prompt must include previous chapter summary instead of empty string'
    );
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
