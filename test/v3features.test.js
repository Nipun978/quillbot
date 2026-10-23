import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  parseChapterBeats,
  serializeChapterBeats,
  commitBeatToChapter,
  getBeatProseFromChapter,
  getCompletedBeatsInChapter,
  getProseBeforeBeat,
  runWriteChapterWorkflow
} from '../src/workflows/writeChapter.js';
import {
  updateBeatInPlan,
  runPlanChapterWorkflow
} from '../src/workflows/planChapter.js';
import {
  parseChapterSelection,
  runExportWorkflow
} from '../src/workflows/exportManuscript.js';
import {
  isLocalOllama,
  probeOllama,
  ensureOllamaRunning
} from '../src/rag/ollamaManager.js';
import { OllamaEmbedder } from '../src/rag/embedder.js';

test('Requirement 1: Ollama auto-start manager detects local URL and checks connectivity', async () => {
  assert.equal(isLocalOllama('http://127.0.0.1:11434'), true);
  assert.equal(isLocalOllama('http://localhost:11434'), true);
  assert.equal(isLocalOllama('http://192.168.1.50:11434'), false);
  assert.equal(isLocalOllama('https://remote.ollama.ai'), false);

  // probeOllama should return boolean
  const running = await probeOllama('http://127.0.0.1:11434', 1500);
  assert.equal(typeof running, 'boolean');

  // ensureOllamaRunning returns ok: true if running
  if (running) {
    const res = await ensureOllamaRunning({ baseUrl: 'http://127.0.0.1:11434', model: 'embeddinggemma' });
    assert.equal(res.ok, true);
    assert.equal(res.alreadyRunning, true);
  }

  // OllamaEmbedder checkConnection with autoStart enabled
  const embedder = new OllamaEmbedder({ ollama: { baseUrl: 'http://127.0.0.1:11434', embeddingModel: 'embeddinggemma' } });
  if (running) {
    const check = await embedder.checkConnection({ autoStart: true });
    assert.equal(check.ok, true);
  }
});

test('Requirement 2: Writing a beat out of order inserts it in correct numerical order (e.g. Beat 1 before Beat 2)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-order-'));
  try {
    const chapterDir = path.join(tmpDir, 'project', 'chapter-01');
    const chapterFile = path.join(chapterDir, 'chapter.md');

    // 1. Commit Beat 2 first
    await commitBeatToChapter({
      chapterFile,
      chapterDir,
      beatNum: 2,
      finalProse: 'Rowan signals from the forest verge that riders approach.',
      cwd: tmpDir
    });

    let content = await fs.readFile(chapterFile, 'utf8');
    assert.ok(content.includes('<!-- BEAT 2 -->'));
    assert.ok(content.includes('Rowan signals from the forest'));

    // 2. Commit Beat 1 second
    await commitBeatToChapter({
      chapterFile,
      chapterDir,
      beatNum: 1,
      finalProse: 'Jonathan stands on the battlements as the dusk wind rises.',
      cwd: tmpDir
    });

    content = await fs.readFile(chapterFile, 'utf8');
    const beat1Pos = content.indexOf('<!-- BEAT 1 -->');
    const beat2Pos = content.indexOf('<!-- BEAT 2 -->');

    // BEAT 1 MUST APPEAR BEFORE BEAT 2 IN THE MANUSCRIPT
    assert.ok(beat1Pos !== -1, 'Beat 1 must be present');
    assert.ok(beat2Pos !== -1, 'Beat 2 must be present');
    assert.ok(beat1Pos < beat2Pos, `Beat 1 index (${beat1Pos}) must be before Beat 2 index (${beat2Pos})`);

    // 3. Commit Beat 4, then Beat 3
    await commitBeatToChapter({
      chapterFile,
      chapterDir,
      beatNum: 4,
      finalProse: 'The heavy iron portcullis slams shut.',
      cwd: tmpDir
    });

    await commitBeatToChapter({
      chapterFile,
      chapterDir,
      beatNum: 3,
      finalProse: 'Captain Drake draws his broadsword with a ringing scrape.',
      cwd: tmpDir
    });

    content = await fs.readFile(chapterFile, 'utf8');
    const pos1 = content.indexOf('<!-- BEAT 1 -->');
    const pos2 = content.indexOf('<!-- BEAT 2 -->');
    const pos3 = content.indexOf('<!-- BEAT 3 -->');
    const pos4 = content.indexOf('<!-- BEAT 4 -->');

    assert.ok(pos1 < pos2 && pos2 < pos3 && pos3 < pos4, 'All beats must be in exact ascending order: 1, 2, 3, 4');

    const completed = await getCompletedBeatsInChapter(chapterFile);
    assert.deepEqual(completed.completedNums, [1, 2, 3, 4]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Requirement 3: Editing an already written beat retrieves previous draft and updates it in place', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-edit-beat-'));
  try {
    const chapterDir = path.join(tmpDir, 'project', 'chapter-01');
    const chapterFile = path.join(chapterDir, 'chapter.md');

    // Initialize Beats 1 and 2
    await commitBeatToChapter({
      chapterFile,
      chapterDir,
      beatNum: 1,
      finalProse: 'Draft 1: Jonathan looks over the parapet.',
      cwd: tmpDir
    });
    await commitBeatToChapter({
      chapterFile,
      chapterDir,
      beatNum: 2,
      finalProse: 'Rowan brings the encrypted dispatch.',
      cwd: tmpDir
    });

    // Check beat retrieval gets previous draft
    const previousDraft = await getBeatProseFromChapter(chapterFile, 1);
    assert.equal(previousDraft, 'Draft 1: Jonathan looks over the parapet.');

    // Edit Beat 1 with improved prose
    await commitBeatToChapter({
      chapterFile,
      chapterDir,
      beatNum: 1,
      finalProse: 'Improved Draft 2: Jonathan grips the frost-rimed battlements, watching riders in the mist.',
      cwd: tmpDir
    });

    const content = await fs.readFile(chapterFile, 'utf8');
    assert.ok(content.includes('Improved Draft 2: Jonathan grips the frost-rimed battlements'));
    assert.equal(content.includes('Draft 1: Jonathan looks over the parapet.'), false);
    // Beat 2 remains intact and in correct order
    assert.ok(content.includes('Rowan brings the encrypted dispatch.'));
    assert.ok(content.indexOf('<!-- BEAT 1 -->') < content.indexOf('<!-- BEAT 2 -->'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Requirement 4: Writing a chapter already completed enters edit mode and allows editing beats', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-chapter-edit-'));
  try {
    const chapterDir = path.join(tmpDir, 'project', 'chapter-01');
    await fs.mkdir(chapterDir, { recursive: true });

    const planFile = path.join(chapterDir, 'plan.md');
    const chapterFile = path.join(chapterDir, 'chapter.md');

    const planContent = `# Chapter 1: The Watch
### Beat 1: Parapet
- **Characters:** Jonathan
- **Location:** Parapet
- **Action:** Watching mist
- **Goal/Hook:** Bell rings

### Beat 2: Gates
- **Characters:** Rowan
- **Location:** Gates
- **Action:** Locking gates
- **Goal/Hook:** Night falls`;
    await fs.writeFile(planFile, planContent, 'utf8');

    // Both beats are already completed
    await commitBeatToChapter({
      chapterFile,
      chapterDir,
      beatNum: 1,
      finalProse: 'Jonathan on the parapet.',
      cwd: tmpDir
    });
    await commitBeatToChapter({
      chapterFile,
      chapterDir,
      beatNum: 2,
      finalProse: 'Rowan at the gates.',
      cwd: tmpDir
    });

    // Mock Groq client that provides improved prose
    let invokedPrompt = '';
    const mockGroq = {
      streamChatCompletion: async ({ messages }) => {
        const userMsg = messages.find((m) => m.role === 'user');
        invokedPrompt = userMsg ? userMsg.content : '';
        return 'Revised prose: Jonathan stares through the heavy snowfall.';
      },
      chatCompletion: async () => 'Summary of chapter 1.',
      jsonCompletion: async () => ({ passed: true, severity: 'none', issues: [] })
    };

    const mockVectorStore = {
      hybridSearch: async () => [],
      deleteBySourcePath: async () => {},
      addChunks: async () => {},
      rebuildFtsIndex: async () => {}
    };
    const mockEmbedder = {
      embedQuery: async () => new Array(768).fill(0),
      embedTexts: async () => []
    };
    const mockReranker = {
      rerank: async () => []
    };

    // Auto-accept by simulating stdin keypress 'a'
    setTimeout(() => {
      process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
    }, 50);

    // Run write chapter for beat 1 on completed chapter (targeted beat revision)
    await runWriteChapterWorkflow({
      chapterArg: '1 1 Make it more atmospheric',
      cwd: tmpDir,
      groqClient: mockGroq,
      vectorStore: mockVectorStore,
      embedder: mockEmbedder,
      reranker: mockReranker,
      config: { writingStyle: 'Literary Fantasy', editor: 'none', generation: { enableContinuityCritic: false } }
    });

    // Check that previous draft of beat 1 was included in the revision prompt!
    assert.ok(invokedPrompt.includes('### PREVIOUS DRAFT OF BEAT 1 (TO BE REVISED & IMPROVED):'), 'Prompt must contain previous draft section');
    assert.ok(invokedPrompt.includes('Jonathan on the parapet.'), 'Prompt must contain previous beat draft text');
    assert.ok(invokedPrompt.includes('Make it more atmospheric'), 'Prompt must contain user edit instruction');

    // Check chapter.md was updated non-destructively
    const updatedContent = await fs.readFile(chapterFile, 'utf8');
    assert.ok(updatedContent.includes('Revised prose: Jonathan stares through the heavy snowfall.'));
    assert.ok(updatedContent.includes('Rowan at the gates.'));
    assert.ok(updatedContent.indexOf('<!-- BEAT 1 -->') < updatedContent.indexOf('<!-- BEAT 2 -->'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Requirement 5: parseChapterSelection parses single chapters, ranges, lists, and formats', () => {
  assert.deepEqual(parseChapterSelection('1'), [1]);
  assert.deepEqual(parseChapterSelection('chapter 2'), [2]);
  assert.deepEqual(parseChapterSelection('1-3'), [1, 2, 3]);
  assert.deepEqual(parseChapterSelection('1 - 3'), [1, 2, 3]);
  assert.deepEqual(parseChapterSelection('chapters 2 to 4'), [2, 3, 4]);
  assert.deepEqual(parseChapterSelection('1, 3, 5'), [1, 3, 5]);
  assert.deepEqual(parseChapterSelection('1-3 --txt'), [1, 2, 3]);
  assert.deepEqual(parseChapterSelection('--scene-breaks'), null);
  assert.deepEqual(parseChapterSelection('all'), null);
  assert.deepEqual(parseChapterSelection(''), null);
  assert.deepEqual(parseChapterSelection(null), null);
});

test('Requirement 5: runExportWorkflow exports specific chapter or chapter range', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-export-range-'));
  try {
    // Set up chapters 1, 2, 3
    for (let ch = 1; ch <= 3; ch++) {
      const padded = String(ch).padStart(2, '0');
      const dir = path.join(tmpDir, 'project', `chapter-${padded}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'plan.md'), `# Chapter ${ch}: Title ${ch}\n\nPlan...`, 'utf8');
      await fs.writeFile(path.join(dir, 'chapter.md'), `# Chapter Manuscript\n\n<!-- BEAT 1 -->\nChapter ${ch} prose content.`, 'utf8');
    }

    // 1. Export only Chapter 2
    const resSingle = await runExportWorkflow({
      arg: '2',
      cwd: tmpDir,
      config: { projectTitle: 'Kingdom of Dawn' }
    });

    assert.ok(resSingle, 'Export result should be returned');
    assert.equal(resSingle.chaptersExported, 1);
    assert.equal(resSingle.chapterRange, 'Chapter 2');
    assert.ok(resSingle.outputPath.endsWith('kingdom-of-dawn-chapter-02.md'));

    const singleContent = await fs.readFile(resSingle.outputPath, 'utf8');
    assert.ok(singleContent.includes('Chapter 2: Title 2'));
    assert.equal(singleContent.includes('Chapter 1: Title 1'), false);
    assert.equal(singleContent.includes('Chapter 3: Title 3'), false);

    // 2. Export Range: Chapters 1-2
    const resRange = await runExportWorkflow({
      arg: '1-2',
      cwd: tmpDir,
      config: { projectTitle: 'Kingdom of Dawn' }
    });

    assert.ok(resRange, 'Export result should be returned');
    assert.equal(resRange.chaptersExported, 2);
    assert.equal(resRange.chapterRange, 'Chapters 1–2');
    assert.ok(resRange.outputPath.endsWith('kingdom-of-dawn-chapters-01-to-02.md'));

    const rangeContent = await fs.readFile(resRange.outputPath, 'utf8');
    assert.ok(rangeContent.includes('Chapter 1: Title 1'));
    assert.ok(rangeContent.includes('Chapter 2: Title 2'));
    assert.equal(rangeContent.includes('Chapter 3: Title 3'), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Requirement 6: updateBeatInPlan updates existing beat in place or inserts in numerical order', () => {
  const initialPlan = `# Chapter 1: The Dark Forest

## Chapter Summary
Jonathan prepares to enter the ancient woods.

## Beats

### Beat 1: The Treeline
- **Characters:** Jonathan
- **Location:** Forest Verge
- **Action:** Jonathan hesitates at the treeline.
- **Goal/Hook:** A raven cries.

### Beat 3: The Ambush
- **Characters:** Jonathan, Bandits
- **Location:** Deep Woods
- **Action:** Bandits spring from the brush.
- **Goal/Hook:** Jonathan is disarmed.`;

  // 1. Insert Beat 2 between Beat 1 and Beat 3
  const newBeat2 = `### Beat 2: Path of Thorns
- **Characters:** Jonathan
- **Location:** Thicket
- **Action:** Jonathan hacks through thorny vines.
- **Goal/Hook:** He hears footsteps behind him.`;

  const updatedPlanWith2 = updateBeatInPlan(initialPlan, 2, newBeat2);
  const pos1 = updatedPlanWith2.indexOf('### Beat 1:');
  const pos2 = updatedPlanWith2.indexOf('### Beat 2:');
  const pos3 = updatedPlanWith2.indexOf('### Beat 3:');

  assert.ok(pos1 !== -1 && pos2 !== -1 && pos3 !== -1);
  assert.ok(pos1 < pos2 && pos2 < pos3, 'Beat 2 must be sorted between Beat 1 and Beat 3');
  assert.ok(updatedPlanWith2.includes('Path of Thorns'));

  // 2. Update existing Beat 1 in place
  const revisedBeat1 = `### Beat 1: The Cold Treeline
- **Characters:** Jonathan, Rowan
- **Location:** Forest Verge
- **Action:** Jonathan and Rowan survey the mist.
- **Goal/Hook:** Rowan spots distant lantern smoke.`;

  const revisedPlan = updateBeatInPlan(updatedPlanWith2, 1, revisedBeat1);
  assert.ok(revisedPlan.includes('The Cold Treeline'));
  assert.equal(revisedPlan.includes('Jonathan hesitates at the treeline'), false);
  // Beat 2 and Beat 3 must remain intact
  assert.ok(revisedPlan.includes('Path of Thorns'));
  assert.ok(revisedPlan.includes('The Ambush'));
});

test('Requirement 6: Planning an already planned beat retrieves current draft into prompt context and updates plan.md', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-plan-beat-'));
  try {
    const chapterDir = path.join(tmpDir, 'project', 'chapter-01');
    await fs.mkdir(chapterDir, { recursive: true });
    const planFile = path.join(chapterDir, 'plan.md');

    const initialPlan = `# Chapter 1: Castle Gate

## Chapter Summary
The fortress prepares for the winter siege.

## Beats

### Beat 1: Parapet Vigil
- **Characters:** Jonathan
- **Location:** North Parapet
- **Action:** Jonathan watches the valley mist.
- **Goal/Hook:** Bell tolls.

### Beat 2: Council Meeting
- **Characters:** Jonathan, Eleanor
- **Location:** Great Hall
- **Action:** Debate over rations.
- **Goal/Hook:** Eleanor storms out.`;

    await fs.writeFile(planFile, initialPlan, 'utf8');

    let invokedPrompt = '';
    const fakeGroq = {
      chatCompletion: async ({ messages }) => {
        const userMsg = messages.find((m) => m.role === 'user');
        invokedPrompt = userMsg ? userMsg.content : '';
        return `### Beat 1: Parapet Vigil
- **Characters:** Jonathan, Rowan
- **Location:** North Parapet
- **Action:** Jonathan and Rowan spot scout riders through the freezing valley mist.
- **Goal/Hook:** The alarm bell tolls three times.`;
      }
    };

    const mockVectorStore = {
      hybridSearch: async () => [],
      deleteBySourcePath: async () => {},
      addChunks: async () => {},
      rebuildFtsIndex: async () => {}
    };
    const mockEmbedder = {
      embedQuery: async () => new Array(768).fill(0),
      embedTexts: async () => []
    };
    const mockReranker = {
      rerank: async () => []
    };

    // Auto-accept review prompt
    setTimeout(() => {
      process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
    }, 50);

    // Run /plan 1 1 with edit guidance
    await runPlanChapterWorkflow({
      chapterArg: '1 1 Add Rowan to the scene and sharpen the alarm bell',
      cwd: tmpDir,
      groqClient: fakeGroq,
      vectorStore: mockVectorStore,
      embedder: mockEmbedder,
      reranker: mockReranker,
      conversationMgr: { getRollingSummary: () => '' },
      config: { writingStyle: 'Literary Fantasy', editor: 'none' }
    });

    // Check that existing beat draft was passed into LLM prompt
    assert.ok(invokedPrompt.includes('<current_beat_draft_to_revise>'), 'Prompt must include current beat draft section');
    assert.ok(invokedPrompt.includes('Jonathan watches the valley mist.'), 'Prompt must contain previous draft text');
    assert.ok(invokedPrompt.includes('Add Rowan to the scene'), 'Prompt must contain user revision guidance');

    // Check plan.md was updated non-destructively
    const updatedPlan = await fs.readFile(planFile, 'utf8');
    assert.ok(updatedPlan.includes('spot scout riders through the freezing valley mist'));
    assert.equal(updatedPlan.includes('Jonathan watches the valley mist.'), false);
    // Beat 2 must be completely preserved!
    assert.ok(updatedPlan.includes('### Beat 2: Council Meeting'));
    assert.ok(updatedPlan.includes('Debate over rations.'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Requirement 6: Planning an already planned chapter edits the full plan with previous plan in context', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-plan-full-edit-'));
  try {
    const chapterDir = path.join(tmpDir, 'project', 'chapter-01');
    await fs.mkdir(chapterDir, { recursive: true });
    const planFile = path.join(chapterDir, 'plan.md');

    const initialPlan = `# Chapter 1: The First Snow

## Chapter Summary
The castle prepares for winter.

## Beats

### Beat 1: Gates
- **Characters:** Jonathan
- **Location:** Gates
- **Action:** Locking gates.
- **Goal/Hook:** Cold wind.`;

    await fs.writeFile(planFile, initialPlan, 'utf8');

    let invokedPrompt = '';
    const fakeGroq = {
      chatCompletion: async ({ messages }) => {
        const userMsg = messages.find((m) => m.role === 'user');
        invokedPrompt = userMsg ? userMsg.content : '';
        return `# Chapter 1: The Bitter Frost

## Chapter Summary
The castle prepares for an impending siege as winter sets in.

## Beats

### Beat 1: Gates of Havenbrook
- **Characters:** Jonathan, Drake
- **Location:** Outer Gate
- **Action:** Drake commands the guards to lower the portcullis.
- **Goal/Hook:** A raven arrives with an omen.`;
      }
    };

    const mockVectorStore = {
      hybridSearch: async () => [],
      deleteBySourcePath: async () => {},
      addChunks: async () => {},
      rebuildFtsIndex: async () => {}
    };
    const mockEmbedder = {
      embedQuery: async () => new Array(768).fill(0),
      embedTexts: async () => []
    };
    const mockReranker = {
      rerank: async () => []
    };

    // Auto-accept review prompt
    setTimeout(() => {
      process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
    }, 50);

    // Run /plan 1 with full chapter revision guidance
    await runPlanChapterWorkflow({
      chapterArg: '1 Deepen tension and introduce Captain Drake early',
      cwd: tmpDir,
      groqClient: fakeGroq,
      vectorStore: mockVectorStore,
      embedder: mockEmbedder,
      reranker: mockReranker,
      conversationMgr: { getRollingSummary: () => '' },
      config: { writingStyle: 'Epic Fantasy', editor: 'none' }
    });

    // Check prompt contains the existing chapter plan for editing
    assert.ok(invokedPrompt.includes('### EXISTING CHAPTER 1 PLAN (FOR REVISION & IMPROVEMENT):'));
    assert.ok(invokedPrompt.includes('The castle prepares for winter.'));
    assert.ok(invokedPrompt.includes('Deepen tension and introduce Captain Drake early'));

    // Check plan.md was updated
    const updatedPlan = await fs.readFile(planFile, 'utf8');
    assert.ok(updatedPlan.includes('# Chapter 1: The Bitter Frost'));
    assert.ok(updatedPlan.includes('Gates of Havenbrook'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Requirement 6: /plan <ch> add appends a new beat to an existing chapter plan', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-plan-add-'));
  try {
    const chapterDir = path.join(tmpDir, 'project', 'chapter-01');
    await fs.mkdir(chapterDir, { recursive: true });
    const planFile = path.join(chapterDir, 'plan.md');

    const initialPlan = `# Chapter 1: The Keep

## Chapter Summary
Winter begins.

## Beats

### Beat 1: Keep
- **Characters:** Jonathan
- **Location:** Hall
- **Action:** Stoking hearth.
- **Goal/Hook:** Knock on door.`;

    await fs.writeFile(planFile, initialPlan, 'utf8');

    let targetBeatNumberAssigned = null;
    const fakeGroq = {
      chatCompletion: async ({ messages }) => {
        const userMsg = messages.find((m) => m.role === 'user')?.content || '';
        const match = userMsg.match(/(?:OBJECTIVE FOR (?:NEW )?BEAT|Generate the beat block for Beat)\s+(\d+)/i);
        if (match) targetBeatNumberAssigned = parseInt(match[1], 10);

        return `### Beat 2: Stranger in the Hall
- **Characters:** Jonathan, Mystery Rider
- **Location:** Great Hall
- **Action:** An unannounced courier delivers a seal-broken letter.
- **Goal/Hook:** The wax seal depicts the traitor's crest.`;
      }
    };

    const mockVectorStore = {
      hybridSearch: async () => [],
      deleteBySourcePath: async () => {},
      addChunks: async () => {},
      rebuildFtsIndex: async () => {}
    };
    const mockEmbedder = {
      embedQuery: async () => new Array(768).fill(0),
      embedTexts: async () => []
    };
    const mockReranker = {
      rerank: async () => []
    };

    // Auto-accept review prompt
    setTimeout(() => {
      process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
    }, 50);

    // Run /plan 1 add
    await runPlanChapterWorkflow({
      chapterArg: '1 add A mysterious rider arrives',
      cwd: tmpDir,
      groqClient: fakeGroq,
      vectorStore: mockVectorStore,
      embedder: mockEmbedder,
      reranker: mockReranker,
      conversationMgr: { getRollingSummary: () => '' },
      config: { writingStyle: 'Epic Fantasy', editor: 'none' }
    });

    assert.equal(targetBeatNumberAssigned, 2, 'Should target Beat 2 when Beat 1 exists');

    const updatedPlan = await fs.readFile(planFile, 'utf8');
    assert.ok(updatedPlan.includes('### Beat 1: Keep'));
    assert.ok(updatedPlan.includes('### Beat 2: Stranger in the Hall'));
    assert.ok(updatedPlan.includes('The wax seal depicts the traitor\'s crest.'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

