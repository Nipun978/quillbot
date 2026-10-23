import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getDefaultConfig } from '../src/config/configManager.js';
import { CONTINUITY_CRITIC_SYSTEM_PROMPT } from '../src/llm/prompts.js';
import {
  getProseBeforeBeat,
  getFirstNWords,
  getBeatProseFromChapter,
  runContinuityCritic,
  commitBeatToChapter,
  runWriteChapterWorkflow
} from '../src/workflows/writeChapter.js';
import {
  cleanChapterProse,
  extractChapterTitle,
  countWords,
  sanitizeTitle,
  assembleManuscript,
  runExportWorkflow
} from '../src/workflows/exportManuscript.js';
import { promptReviewWorkflow, hotkeySelect } from '../src/ui/reviewPrompt.js';
import { SLASH_COMMANDS, completer, resolveCommandArguments } from '../src/ui/repl.js';

test('Feature 1: getProseBeforeBeat slices continuity strictly before target beat', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-continuity-'));
  try {
    const chapterFile = path.join(tmpDir, 'chapter.md');
    const chapterContent = `# Chapter Manuscript

<!-- BEAT 1 -->
The cold mountain mist clung to Jonathan's cloaked shoulders as he reached the crest of Blackwood Ridge. Below him, the lights of Oakhaven flickered like dying embers.

<!-- BEAT 2 -->
Rowan stepped out from the shadows of the ancient oak tree, holding a rusted lantern. His breath plumed in the freezing night air.

<!-- BEAT 3 -->
Together, they pried open the heavy stone doorway of the crypt. A gust of stagnant air escaped the depths.
`;
    await fs.writeFile(chapterFile, chapterContent, 'utf8');

    // 1. Beat 1 target: should have no preceding prose
    const proseBefore1 = await getProseBeforeBeat(chapterFile, 1, 350);
    assert.equal(proseBefore1, '');

    // 2. Beat 2 target: should contain prose from Beat 1, NOT Beat 2 or 3
    const proseBefore2 = await getProseBeforeBeat(chapterFile, 2, 350);
    assert.ok(proseBefore2.includes('crest of Blackwood Ridge'));
    assert.ok(proseBefore2.includes('dying embers'));
    assert.equal(proseBefore2.includes('Rowan stepped out'), false);
    assert.equal(proseBefore2.includes('crypt'), false);

    // 3. Beat 3 target: should contain prose from Beat 2 ending, NOT Beat 3
    const proseBefore3 = await getProseBeforeBeat(chapterFile, 3, 350);
    assert.ok(proseBefore3.includes('freezing night air'));
    assert.equal(proseBefore3.includes('pried open the heavy stone doorway'), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Feature 1: getBeatProseFromChapter and getFirstNWords extract downstream scene anchor', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-anchor-'));
  try {
    const chapterFile = path.join(tmpDir, 'chapter.md');
    const chapterContent = `<!-- BEAT 1 -->
First beat text here.

<!-- BEAT 2 -->
Rowan unrolls the parchment across the wooden table with deliberate care. The ink has faded, but the mountain path is clearly marked in crimson.

<!-- BEAT 3 -->
The third beat begins with the sound of approaching hoofbeats.
`;
    await fs.writeFile(chapterFile, chapterContent, 'utf8');

    const beat2Prose = await getBeatProseFromChapter(chapterFile, 2);
    assert.ok(beat2Prose.startsWith('Rowan unrolls the parchment'));
    assert.ok(beat2Prose.includes('crimson'));
    assert.equal(beat2Prose.includes('<!-- BEAT'), false);

    const anchor10Words = getFirstNWords(beat2Prose, 10);
    assert.equal(anchor10Words, 'Rowan unrolls the parchment across the wooden table with deliberate');

    // Missing beat returns empty
    const beat4Prose = await getBeatProseFromChapter(chapterFile, 4);
    assert.equal(beat4Prose, '');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Feature 1: Targeted single-beat rewrite executes only targeted beat and updates chapter.md', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-targeted-rewrite-'));
  try {
    const chapterDir = path.join(tmpDir, 'project', 'chapter-01');
    await fs.mkdir(chapterDir, { recursive: true });

    const planFile = path.join(chapterDir, 'plan.md');
    const planContent = `# Chapter 1: The Gathering Storm

## Chapter Summary
A tense evening in Havenbrook as Jonathan and Rowan plan their escape.

## Beats

### Beat 1: Watchtower Vigil
- **Characters:** Jonathan
- **Location:** North Parapet
- **Action:** Jonathan watches the mist gather over the valley.
- **Goal/Hook:** A lantern flickers on the path below.

### Beat 2: Council in the Crypt
- **Characters:** Jonathan, Rowan
- **Location:** The Undercroft
- **Action:** Rowan presents the stolen seal to Jonathan.
- **Goal/Hook:** Footsteps approach outside the door.
`;
    await fs.writeFile(planFile, planContent, 'utf8');

    const chapterFile = path.join(chapterDir, 'chapter.md');
    await fs.writeFile(chapterFile, `# Chapter Manuscript\n\n<!-- BEAT 1 -->\nOriginal Beat 1 prose.\n\n<!-- BEAT 2 -->\nOriginal Beat 2 prose.\n`, 'utf8');

    // Mock Groq client
    let generatedCount = 0;
    const fakeGroq = {
      streamChatCompletion: async ({ messages }) => {
        generatedCount++;
        // Check that downstream anchor is included if beat 1 is rewritten while beat 2 exists
        const userMsg = messages.find((m) => m.role === 'user')?.content || '';
        assert.ok(userMsg.includes('TARGET BEAT TO WRITE NOW'));
        return 'Brand new rewritten Beat 1 prose with sensory depth.';
      },
      jsonCompletion: async () => ({ passed: true, severity: 'none', issues: [] }),
      chatCompletion: async () => 'Canonical updated chapter summary.'
    };

    // Auto-accept by simulating stdin keypress 'a'
    const origHotkeySelect = hotkeySelect;
    setTimeout(() => {
      process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
    }, 40);

    await runWriteChapterWorkflow({
      chapterArg: '1 1', // rewrite Chapter 1 Beat 1
      cwd: tmpDir,
      groqClient: fakeGroq,
      vectorStore: {
        hybridSearch: async () => [],
        deleteBySourcePath: async () => {},
        addChunks: async () => {},
        rebuildFtsIndex: async () => {}
      },
      embedder: { embedQuery: async () => [], embedTexts: async () => [] },
      reranker: { rerank: async () => [] },
      conversationMgr: { getRollingSummary: () => '' },
      config: { generation: { enableContinuityCritic: false, continuityTailWords: 350 } }
    });

    assert.equal(generatedCount, 1);

    const updatedChapter = await fs.readFile(chapterFile, 'utf8');
    // Beat 1 should be replaced
    assert.ok(updatedChapter.includes('Brand new rewritten Beat 1 prose'));
    assert.equal(updatedChapter.includes('Original Beat 1 prose'), false);
    // Beat 2 should still be completely intact!
    assert.ok(updatedChapter.includes('<!-- BEAT 2 -->'));
    assert.ok(updatedChapter.includes('Original Beat 2 prose'));

    // Check summary was regenerated
    const summaryFile = path.join(chapterDir, 'summary.md');
    const summaryContent = await fs.readFile(summaryFile, 'utf8');
    assert.ok(summaryContent.includes('Canonical updated chapter summary'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Feature 2: enableContinuityCritic is enabled by default in config', () => {
  const cfg = getDefaultConfig();
  assert.equal(cfg.generation.enableContinuityCritic, true);
});

test('Feature 2: CONTINUITY_CRITIC_SYSTEM_PROMPT is exported and defines JSON schema', () => {
  assert.ok(CONTINUITY_CRITIC_SYSTEM_PROMPT.includes('canon_contradiction'));
  assert.ok(CONTINUITY_CRITIC_SYSTEM_PROMPT.includes('beat_bleed'));
  assert.ok(CONTINUITY_CRITIC_SYSTEM_PROMPT.includes('scene_discontinuity'));
  assert.ok(CONTINUITY_CRITIC_SYSTEM_PROMPT.includes('fixSuggestion'));
});

test('Feature 2: runContinuityCritic audits draft and handles pass/fail states', async () => {
  // Test passing critic check
  const fakeGroqPass = {
    jsonCompletion: async () => ({
      passed: true,
      severity: 'none',
      issues: []
    })
  };

  const passRes = await runContinuityCritic({
    beatProse: 'Jonathan sat by the hearth.',
    beat: { num: 1, title: 'Hearth' },
    groqClient: fakeGroqPass
  });

  assert.equal(passRes.passed, true);
  assert.equal(passRes.issues.length, 0);

  // Test failing critic check with flagged issues
  const fakeGroqFail = {
    jsonCompletion: async () => ({
      passed: false,
      severity: 'major',
      issues: [
        {
          type: 'canon_contradiction',
          description: 'Jonathan was declared dead in chapter 1',
          quote: 'Jonathan sat by the hearth',
          fixSuggestion: 'Use Rowan instead of Jonathan'
        }
      ]
    })
  };

  const failRes = await runContinuityCritic({
    beatProse: 'Jonathan sat by the hearth.',
    beat: { num: 1, title: 'Hearth' },
    groqClient: fakeGroqFail
  });

  assert.equal(failRes.passed, false);
  assert.equal(failRes.issues.length, 1);
  assert.equal(failRes.issues[0].type, 'canon_contradiction');
  assert.equal(failRes.issues[0].fixSuggestion, 'Use Rowan instead of Jonathan');

  // Test network failure resilience (fails open)
  const fakeGroqError = {
    jsonCompletion: async () => {
      throw new Error('Groq rate limit exceeded');
    }
  };

  const errRes = await runContinuityCritic({
    beatProse: 'Jonathan sat by the hearth.',
    beat: { num: 1, title: 'Hearth' },
    groqClient: fakeGroqError
  });
  assert.equal(errRes.passed, true);
  assert.ok(errRes.error);
});

test('Feature 2: promptReviewWorkflow provides [F]ix hotkey when critic issues exist and formats feedback', async () => {
  const criticIssues = [
    {
      type: 'canon_contradiction',
      description: 'Elena has dark hair in the Story Bible, not blonde',
      quote: 'Her blonde hair blew in the wind',
      fixSuggestion: 'Change hair color to dark raven'
    }
  ];

  // Emit 'f' keypress
  setTimeout(() => {
    process.stdin.emit('keypress', 'f', { sequence: 'f', name: 'f' });
  }, 30);

  const reviewResult = await promptReviewWorkflow({
    draftContent: 'Elena ran through the meadow. Her blonde hair blew in the wind.',
    itemLabel: 'Beat 1 Prose',
    criticIssues
  });

  assert.equal(reviewResult.action, 'retry');
  assert.ok(reviewResult.feedback.includes('Elena has dark hair in the Story Bible'));
  assert.ok(reviewResult.feedback.includes('Change hair color to dark raven'));
  assert.ok(reviewResult.feedback.includes('Her blonde hair blew in the wind'));
});

test('Feature 3: cleanChapterProse strips beat markers and headers, supports scene breaks', () => {
  const raw = `# Chapter Manuscript

<!-- BEAT 1 -->
Paragraph 1 of beat 1.
Paragraph 2 of beat 1.

<!-- BEAT 2 -->
Paragraph 1 of beat 2.
`;

  // Standard clean
  const cleanStandard = cleanChapterProse(raw, { useSceneBreaks: false });
  assert.equal(cleanStandard.includes('# Chapter Manuscript'), false);
  assert.equal(cleanStandard.includes('<!-- BEAT'), false);
  assert.ok(cleanStandard.includes('Paragraph 1 of beat 1.\nParagraph 2 of beat 1.\n\nParagraph 1 of beat 2.'));

  // Scene breaks clean
  const cleanSceneBreaks = cleanChapterProse(raw, { useSceneBreaks: true });
  assert.ok(cleanSceneBreaks.includes('* * *'));
});

test('Feature 3: extractChapterTitle, countWords, and sanitizeTitle work reliably', () => {
  const plan = `# Chapter 3: The Broken Crown\n\n## Chapter Summary\nSummary text.`;
  assert.equal(extractChapterTitle(plan, 3), 'The Broken Crown');
  assert.equal(extractChapterTitle('', 4), 'Chapter 4');

  assert.equal(countWords('One two three four five'), 5);
  assert.equal(countWords(''), 0);

  assert.equal(sanitizeTitle('My Epic Novel: Blood & Silver!'), 'my-epic-novel-blood-silver');
});

test('Feature 3: assembleManuscript formats Markdown and Plain Text correctly', () => {
  const chapters = [
    { num: 1, title: 'The Start', prose: 'First chapter text here.' },
    { num: 2, title: 'The End', prose: 'Second chapter text here.' }
  ];

  // Markdown
  const md = assembleManuscript({
    projectTitle: 'Echoes of Oakhaven',
    chapters,
    isTxt: false
  });
  assert.ok(md.includes('# Echoes of Oakhaven'));
  assert.ok(md.includes('# Chapter 1: The Start'));
  assert.ok(md.includes('First chapter text here.'));
  assert.ok(md.includes('# Chapter 2: The End'));

  // Plain Text
  const txt = assembleManuscript({
    projectTitle: 'Echoes of Oakhaven',
    chapters,
    isTxt: true
  });
  assert.ok(txt.includes('ECHOES OF OAKHAVEN'));
  assert.ok(txt.includes('CHAPTER 1: THE START'));
  assert.ok(txt.includes('CHAPTER 2: THE END'));
});

test('Feature 3: runExportWorkflow compiles all chapters into exports/ directory and outputs stats', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-export-'));
  try {
    // Set up Chapter 1
    const ch1Dir = path.join(tmpDir, 'project', 'chapter-01');
    await fs.mkdir(ch1Dir, { recursive: true });
    await fs.writeFile(path.join(ch1Dir, 'plan.md'), '# Chapter 1: The Shadowed Parapet\n\n## Beats\n', 'utf8');
    await fs.writeFile(path.join(ch1Dir, 'chapter.md'), '# Chapter Manuscript\n\n<!-- BEAT 1 -->\nJonathan watched the horizon.', 'utf8');

    // Set up Chapter 2
    const ch2Dir = path.join(tmpDir, 'project', 'chapter-02');
    await fs.mkdir(ch2Dir, { recursive: true });
    await fs.writeFile(path.join(ch2Dir, 'plan.md'), '# Chapter 2: Into the Lowlands\n\n## Beats\n', 'utf8');
    await fs.writeFile(path.join(ch2Dir, 'chapter.md'), '# Chapter Manuscript\n\n<!-- BEAT 1 -->\nRowan led the horses through the swamp.', 'utf8');

    // 1. Export Markdown
    const exportResMd = await runExportWorkflow({
      arg: '',
      cwd: tmpDir,
      config: { projectTitle: 'Chronicles of Valen' }
    });

    assert.ok(exportResMd);
    assert.equal(exportResMd.chaptersExported, 2);
    assert.ok(exportResMd.totalWords > 0);
    assert.ok(exportResMd.outputPath.endsWith('chronicles-of-valen-manuscript.md'));

    const exportedMdContent = await fs.readFile(exportResMd.outputPath, 'utf8');
    assert.ok(exportedMdContent.includes('# Chronicles of Valen'));
    assert.ok(exportedMdContent.includes('# Chapter 1: The Shadowed Parapet'));
    assert.ok(exportedMdContent.includes('Jonathan watched the horizon.'));
    assert.ok(exportedMdContent.includes('# Chapter 2: Into the Lowlands'));
    assert.ok(exportedMdContent.includes('Rowan led the horses through the swamp.'));

    // 2. Export Plain Text
    const exportResTxt = await runExportWorkflow({
      arg: 'txt',
      cwd: tmpDir,
      config: { projectTitle: 'Chronicles of Valen' }
    });

    assert.ok(exportResTxt);
    assert.ok(exportResTxt.outputPath.endsWith('chronicles-of-valen-manuscript.txt'));
    const exportedTxtContent = await fs.readFile(exportResTxt.outputPath, 'utf8');
    assert.ok(exportedTxtContent.includes('CHRONICLES OF VALEN'));
    assert.ok(exportedTxtContent.includes('CHAPTER 1: THE SHADOWED PARAPET'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CLI Integration: SLASH_COMMANDS includes /export and autocompletes', () => {
  assert.ok(SLASH_COMMANDS.includes('/export'));
  const [hits] = completer('/exp');
  assert.deepEqual(hits, ['/export']);
});
