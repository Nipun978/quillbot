import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  WRITE_BEAT_SYSTEM_PROMPT,
  CONTINUITY_CRITIC_SYSTEM_PROMPT,
  UPDATE_STORY_SO_FAR_SYSTEM_PROMPT
} from '../src/llm/prompts.js';
import { runContinuityCritic } from '../src/workflows/writeChapter.js';
import {
  updateStorySoFar,
  loadStorySoFar,
  loadStoryContextForChapter
} from '../src/config/condensedManager.js';
import { determineSourceMetadata } from '../src/rag/chunker.js';
import {
  loadReferenceMaterialsContext,
  promptAndIngestReferenceMaterials
} from '../src/workflows/initProject.js';

test('1. Anti-Bracket Prose Rule in WRITE_BEAT_SYSTEM_PROMPT', () => {
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /CRITICAL PROSE DIALOGUE RULE \(ZERO RAW PLANNING TAGS\)/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /NEVER output raw planning bracket tags/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /The bracket notation is strictly a planning blueprint for human review/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /transform these into natural, immersive literary dialogue/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /narrate the physical gesture, posture, or silence naturally in prose/);
});

test('2. Continuity Critic checks and catches leaked planning brackets in prose', async () => {
  assert.match(CONTINUITY_CRITIC_SYSTEM_PROMPT, /RAW PLANNING TAG LEAKAGE/);
  assert.match(CONTINUITY_CRITIC_SYSTEM_PROMPT, /raw_dialogue_tags_leaked/);

  const mockGroqPass = {
    jsonCompletion: async () => ({
      checklist: {
        planFollowed: true,
        authorVisionMet: true,
        instructionsFollowed: true,
        grammarCorrect: true
      },
      passed: true,
      severity: 'none',
      issues: []
    })
  };

  const beat = {
    num: 4,
    title: 'Familiarity',
    characters: 'Debu, Padma',
    setting: 'Padmaghat ghats',
    beatOutline: '[Debu to Padma (lightly)]: "You again."',
    authorNotes: 'Growing intimacy'
  };

  // Case A: Prose with leaked dialogue brackets
  const leakedProse = `Debu arrived at the ghats and stopped by his boat.\n[Debu to Padma (lightly, with mild surprise)]: "You again."\nPadma turned quietly.`;
  const resultLeaked = await runContinuityCritic({
    beatProse: leakedProse,
    beat,
    tier1Chunks: [{ text: 'canon' }],
    groqClient: mockGroqPass,
    sessionId: 'test_session'
  });

  assert.equal(resultLeaked.passed, false);
  assert.equal(resultLeaked.checklist.planFollowed, false);
  assert.equal(resultLeaked.severity, 'major');
  const bracketIssue = resultLeaked.issues.find((i) => i.type === 'raw_dialogue_tags_leaked');
  assert.ok(bracketIssue, 'Expected raw_dialogue_tags_leaked issue');
  assert.ok(bracketIssue.description.includes('Raw planning dialogue tags detected in prose'));

  // Case B: Prose with leaked non-verbal bracket
  const leakedNonVerbal = `Debu asked where she lived.\n[Non-verbal / silent interaction: Padma shakes her head.]\nShe looked toward the river.`;
  const resultNonVerbal = await runContinuityCritic({
    beatProse: leakedNonVerbal,
    beat,
    tier1Chunks: [{ text: 'canon' }],
    groqClient: mockGroqPass,
    sessionId: 'test_session'
  });

  assert.equal(resultNonVerbal.passed, false);
  assert.equal(resultNonVerbal.checklist.planFollowed, false);

  // Case C: Clean literary prose without bracket tags
  const cleanProse = `Debu arrived at the ghats and rested his oars against the mud bank. "You again," he said lightly, with mild surprise.\nPadma looked up from the stone steps. "I know," she murmured softly.`;
  const resultClean = await runContinuityCritic({
    beatProse: cleanProse,
    beat,
    tier1Chunks: [{ text: 'canon' }],
    groqClient: mockGroqPass,
    sessionId: 'test_session'
  });

  assert.equal(resultClean.passed, true);
  assert.equal(resultClean.checklist.planFollowed, true);
  assert.equal(resultClean.issues.length, 0);
});

test('3. Structured Multi-Line story-so-far.md generation with Milestones & End State', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-ssf-'));
  try {
    const mockGroq = {
      chatCompletion: async () => `1. [Debu, Jameel]: Debu rents boat, nets six fish, pays rent, barters for rice, and brings two fish home to Amba.\n2. [Debu, Padma]: Debu encounters Padma washing hands at ghats; she releases small fish back into the water.\n- **End State:** Debu stands by his moored boat while Padma watches the river from the stone steps.`
    };

    await updateStorySoFar({
      chapterNum: 1,
      chapterTitle: 'The River’s Quiet',
      summaryText: 'Detailed 250-word summary of Chapter 1...',
      groqClient: mockGroq,
      cwd: tmpDir
    });

    const content = await loadStorySoFar(tmpDir);
    assert.ok(content.includes('Chapter 1 (The River’s Quiet):'));
    assert.ok(content.includes('1. [Debu, Jameel]: Debu rents boat'));
    assert.ok(content.includes('2. [Debu, Padma]: Debu encounters Padma'));
    assert.ok(content.includes('- **End State:** Debu stands by his moored boat'));

    // Test updating/replacing existing chapter non-destructively
    const mockGroqUpdated = {
      chatCompletion: async () => `1. [Debu, Jameel]: Revised milestone entry.\n- **End State:** Updated end state.`
    };

    await updateStorySoFar({
      chapterNum: 1,
      chapterTitle: 'The River’s Quiet',
      summaryText: 'Revised summary...',
      groqClient: mockGroqUpdated,
      cwd: tmpDir
    });

    const updatedContent = await loadStorySoFar(tmpDir);
    assert.ok(updatedContent.includes('Revised milestone entry'));
    assert.ok(updatedContent.includes('Updated end state'));
    // Should NOT have duplicate Chapter 1 headings
    const matches = updatedContent.match(/(?:##\s*Chapter\s+1|-\s*\*\*Chapter\s+1)/g);
    assert.equal(matches.length, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('4. loadStoryContextForChapter extracts multi-line chapter blocks for chapters 1..N-2', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-macro-'));
  try {
    const condensedDir = path.join(tmpDir, '.condensed');
    const projectDir = path.join(tmpDir, 'project');
    await fs.mkdir(condensedDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, 'chapter-02'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'chapter-03'), { recursive: true });

    // Scaffolding summaries
    await fs.writeFile(path.join(projectDir, 'chapter-02', 'summary.md'), 'Full 250-word summary of Chapter 2.');
    await fs.writeFile(path.join(projectDir, 'chapter-03', 'summary.md'), 'Full 250-word summary of Chapter 3.');

    // Multi-line story-so-far.md
    const ssfText = `# Story So Far

## Chapter 1 (The River's Quiet):
1. Debu nets fish and meets Padma at the ghats.
2. Padma returns the small fish to the water.
- **End State:** Both stand together on the riverbank.

## Chapter 2 (The Rising Tide):
1. Monsoon rains swell the Padma River.
2. Debu repairs the thatched roof with Padma.
- **End State:** The house remains dry under torrential rain.
`;
    await fs.writeFile(path.join(condensedDir, 'story-so-far.md'), ssfText, 'utf8');

    // Context for Chapter 3: Needs Chapter 2 full summary, and Chapter 1 from story-so-far
    const ctxCh3 = await loadStoryContextForChapter({ currentChapterNum: 3, cwd: tmpDir });
    assert.ok(ctxCh3.previousChapterSummary.includes('Full 250-word summary of Chapter 2.'));
    assert.ok(ctxCh3.storySoFar.includes("## Chapter 1 (The River's Quiet):"));
    assert.ok(ctxCh3.storySoFar.includes('Debu nets fish and meets Padma'));
    assert.ok(ctxCh3.storySoFar.includes('- **End State:** Both stand together'));
    // Chapter 2 must NOT be in storySoFar because Chapter 2 summary is sent in full
    assert.equal(ctxCh3.storySoFar.includes('Chapter 2 (The Rising Tide)'), false);

    // Context for Chapter 4: Needs Chapter 3 summary, and Chapters 1 & 2 from story-so-far
    await fs.writeFile(
      path.join(condensedDir, 'story-so-far.md'),
      `${ssfText}\n## Chapter 3 (The Ferry Crossing):\n1. Ferryman strikes.\n- **End State:** Crossing completed.\n`,
      'utf8'
    );
    const ctxCh4 = await loadStoryContextForChapter({ currentChapterNum: 4, cwd: tmpDir });
    assert.ok(ctxCh4.previousChapterSummary.includes('Full 250-word summary of Chapter 3.'));
    assert.ok(ctxCh4.storySoFar.includes("## Chapter 1 (The River's Quiet):"));
    assert.ok(ctxCh4.storySoFar.includes("## Chapter 2 (The Rising Tide):"));
    assert.equal(ctxCh4.storySoFar.includes('Chapter 3 (The Ferry Crossing)'), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('5. Reference Materials: Authority Tier 1 chunker metadata and context loader gating', async () => {
  // Test chunker metadata assignment
  const metaRef = determineSourceMetadata('story-bible/references/folklore-history.md');
  assert.equal(metaRef.source_type, 'story-bible-reference');
  assert.equal(metaRef.authority_tier, 1);
  assert.equal(metaRef.chapter_num, 0);

  // Test loading reference materials context
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-ref-'));
  try {
    const refDir = path.join(tmpDir, 'story-bible', 'references');
    await fs.mkdir(refDir, { recursive: true });

    await fs.writeFile(
      path.join(refDir, 'padma-river-customs.md'),
      '# River Customs\n1. Ferrymen throw a pinch of salt into the Padma before setting sail.\n2. No night nets on full moon.',
      'utf8'
    );

    // Free Tier: Gated out entirely!
    const freeContext = await loadReferenceMaterialsContext(tmpDir, { apiTier: 'free' });
    assert.equal(freeContext, '', 'Free tier must not retrieve or load reference context');

    // Paid Tier: Successfully loaded
    const paidContext = await loadReferenceMaterialsContext(tmpDir, { apiTier: 'paid' });
    assert.ok(paidContext.includes('### Reference: padma-river-customs.md'));
    assert.ok(paidContext.includes('Ferrymen throw a pinch of salt'));
    assert.ok(paidContext.includes('No night nets on full moon'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('6. promptAndIngestReferenceMaterials: Free tier skips ingestion, Paid tier allows', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-ingest-'));
  try {
    // Free tier: returns empty array without any prompts or writes
    const freeRes = await promptAndIngestReferenceMaterials({
      cwd: tmpDir,
      config: { apiTier: 'free' }
    });
    assert.deepEqual(freeRes, []);

    // Create an external reference note to import
    const externalNotePath = path.join(tmpDir, 'external_notes.txt');
    await fs.writeFile(externalNotePath, 'Bengali boat carpentry traditions and timber species.', 'utf8');

    // Create a mock source in story-bible/references/
    const refDir = path.join(tmpDir, 'story-bible', 'references');
    await fs.mkdir(refDir, { recursive: true });
    await fs.copyFile(externalNotePath, path.join(refDir, 'boat-carpentry.md'));

    const loaded = await loadReferenceMaterialsContext(tmpDir, { apiTier: 'paid' });
    assert.ok(loaded.includes('### Reference: boat-carpentry.md'));
    assert.ok(loaded.includes('Bengali boat carpentry traditions'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('7. RAG retrieval gating: Free tier never retrieves references, Paid tier retrieves them', async () => {
  // Test filtering in vectorStore
  const createMockQuery = () => {
    const q = {
      where: () => q,
      limit: () => q,
      toArray: async () => [
        { id: '1', source_type: 'story-bible', source_path: 'story-bible/characters.md', authority_tier: 1 },
        { id: '2', source_type: 'story-bible-reference', source_path: 'story-bible/references/customs.md', authority_tier: 1 }
      ]
    };
    return q;
  };

  const mockTable = {
    countRows: async () => 2,
    vectorSearch: () => createMockQuery(),
    search: () => createMockQuery()
  };

  const { VectorStore } = await import('../src/rag/vectorStore.js');
  const store = new VectorStore({ cwd: os.tmpdir() });
  store.table = mockTable;

  // Free Tier Search
  const freeResults = await store.hybridSearch({
    queryText: 'customs',
    queryVector: [0.1],
    isPaid: false
  });
  assert.equal(freeResults.some((c) => c.source_type === 'story-bible-reference'), false, 'Free tier must not retrieve reference chunks');
  assert.equal(freeResults.some((c) => String(c.source_path).includes('references/')), false);

  // Paid Tier Search
  const paidResults = await store.hybridSearch({
    queryText: 'customs',
    queryVector: [0.1],
    isPaid: true
  });
  assert.equal(paidResults.some((c) => c.source_type === 'story-bible-reference'), true, 'Paid tier must retrieve reference chunks');
});

test('8. /sync command & getTrackedFiles: Free tier omits any pasted file other than intended files, Paid tier syncs all', async () => {
  const { isIntendedFreeTierFile, getTrackedFiles, syncAllFiles } = await import('../src/rag/fileSync.js');

  // 1. Test isIntendedFreeTierFile unit rules
  // Core 4 Story Bible files
  assert.equal(isIntendedFreeTierFile('story-bible/characters.md'), true);
  assert.equal(isIntendedFreeTierFile('story-bible/locations.md'), true);
  assert.equal(isIntendedFreeTierFile('story-bible/plot-overview.md'), true);
  assert.equal(isIntendedFreeTierFile('story-bible/world-and-lore.md'), true);
  assert.equal(isIntendedFreeTierFile('story-bible/characters.txt'), true);

  // Pasted files into story-bible/ must be rejected in free tier
  assert.equal(isIntendedFreeTierFile('story-bible/references/folklore.md'), false);
  assert.equal(isIntendedFreeTierFile('story-bible/references/notes.txt'), false);
  assert.equal(isIntendedFreeTierFile('story-bible/custom_pasted_reference.md'), false);
  assert.equal(isIntendedFreeTierFile('story-bible/research_notes.txt'), false);

  // Chapter files: only chapter, plan, summary allowed
  assert.equal(isIntendedFreeTierFile('project/chapter-01/chapter.md'), true);
  assert.equal(isIntendedFreeTierFile('project/chapter-01/plan.md'), true);
  assert.equal(isIntendedFreeTierFile('project/chapter-01/summary.md'), true);
  assert.equal(isIntendedFreeTierFile('project/chapter-01/pasted_notes.txt'), false);
  assert.equal(isIntendedFreeTierFile('project/pasted_root.md'), false);

  // Condensed memory files
  assert.equal(isIntendedFreeTierFile('.condensed/story-so-far.md'), true);
  assert.equal(isIntendedFreeTierFile('.condensed/chapters/chapter-01/plan.md'), true);
  assert.equal(isIntendedFreeTierFile('.condensed/chapters/chapter-01/prose.md'), true);
  assert.equal(isIntendedFreeTierFile('.condensed/extra_pasted.md'), false);

  // Archive sessions
  assert.equal(isIntendedFreeTierFile('conversations/archive/session-20261118120000.md'), true);
  assert.equal(isIntendedFreeTierFile('conversations/archive/session-1.txt'), true);
  assert.equal(isIntendedFreeTierFile('conversations/archive/arbitrary_pasted_note.md'), false);

  // 2. Test getTrackedFiles & syncAllFiles with real directory structure
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-sync-gating-'));
  try {
    // Setup canonical intended files
    await fs.mkdir(path.join(tmpDir, 'story-bible'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'project', 'chapter-01'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.condensed', 'chapters', 'chapter-01'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'conversations', 'archive'), { recursive: true });

    await fs.writeFile(path.join(tmpDir, 'story-bible', 'characters.md'), '# Characters\nKael.', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'story-bible', 'world-and-lore.md'), '# World\nThe river Padma.', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'project', 'chapter-01', 'chapter.md'), '# Chapter 1\nKael walked.', 'utf8');
    await fs.writeFile(path.join(tmpDir, '.condensed', 'story-so-far.md'), '# Story\n- Chapter 1.', 'utf8');

    // Setup pasted files not intended for free tier
    const refDir = path.join(tmpDir, 'story-bible', 'references');
    await fs.mkdir(refDir, { recursive: true });
    await fs.writeFile(path.join(refDir, 'padma_customs.md'), '# River Customs\nSalt pinch.', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'story-bible', 'pasted_world_notes.md'), '# Pasted Notes\nSecret clan.', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'project', 'chapter-01', 'pasted_chapter_notes.txt'), 'Notes on beat 1.', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'conversations', 'archive', 'pasted_external.md'), 'External brainstorm.', 'utf8');

    // Free Tier Tracking: omits all 4 pasted files
    const freeTracked = await getTrackedFiles(tmpDir, { apiTier: 'free' });
    assert.ok(freeTracked.includes('story-bible/characters.md'));
    assert.ok(freeTracked.includes('story-bible/world-and-lore.md'));
    assert.ok(freeTracked.includes('project/chapter-01/chapter.md'));
    assert.ok(freeTracked.includes('.condensed/story-so-far.md'));

    assert.equal(freeTracked.includes('story-bible/references/padma_customs.md'), false);
    assert.equal(freeTracked.includes('story-bible/pasted_world_notes.md'), false);
    assert.equal(freeTracked.includes('project/chapter-01/pasted_chapter_notes.txt'), false);
    assert.equal(freeTracked.includes('conversations/archive/pasted_external.md'), false);

    // Paid Tier Tracking: includes all files
    const paidTracked = await getTrackedFiles(tmpDir, { apiTier: 'paid' });
    assert.ok(paidTracked.includes('story-bible/references/padma_customs.md'));
    assert.ok(paidTracked.includes('story-bible/pasted_world_notes.md'));
    assert.ok(paidTracked.includes('project/chapter-01/pasted_chapter_notes.txt'));
    assert.ok(paidTracked.includes('conversations/archive/pasted_external.md'));

    // Test syncAllFiles with Free Tier
    const mockStore = {
      chunks: [],
      deletedPaths: [],
      deletedQueries: [],
      deleteBySourcePath: async (p) => { mockStore.deletedPaths.push(p); },
      deleteWhere: async (q) => { mockStore.deletedQueries.push(q); },
      addChunks: async (chunks) => { mockStore.chunks.push(...chunks); },
      rebuildFtsIndex: async () => {}
    };
    const mockEmbedder = {
      embedTexts: async (texts) => texts.map(() => new Array(768).fill(0.01))
    };

    const freeSyncRes = await syncAllFiles({
      cwd: tmpDir,
      vectorStore: mockStore,
      embedder: mockEmbedder,
      config: { apiTier: 'free' }
    });

    assert.equal(freeSyncRes.hasChanges, true);
    assert.equal(freeSyncRes.omittedCount, 4);
    assert.ok(freeSyncRes.omittedFiles.includes('story-bible/references/padma_customs.md'));
    assert.ok(freeSyncRes.omittedFiles.includes('story-bible/pasted_world_notes.md'));
    assert.ok(freeSyncRes.omittedFiles.includes('project/chapter-01/pasted_chapter_notes.txt'));
    assert.ok(freeSyncRes.omittedFiles.includes('conversations/archive/pasted_external.md'));

    // Chunks indexed must ONLY be from canonical free tier files
    const indexedSources = new Set(mockStore.chunks.map((c) => c.source_path));
    assert.ok(indexedSources.has('story-bible/characters.md'));
    assert.ok(indexedSources.has('story-bible/world-and-lore.md'));
    assert.ok(indexedSources.has('project/chapter-01/chapter.md'));
    assert.ok(indexedSources.has('.condensed/story-so-far.md'));
    assert.equal(indexedSources.has('story-bible/references/padma_customs.md'), false);
    assert.equal(indexedSources.has('story-bible/pasted_world_notes.md'), false);
    assert.equal(indexedSources.has('project/chapter-01/pasted_chapter_notes.txt'), false);
    assert.equal(indexedSources.has('conversations/archive/pasted_external.md'), false);

    // Verify purge of references was executed
    assert.ok(mockStore.deletedQueries.includes("source_type = 'story-bible-reference'"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
