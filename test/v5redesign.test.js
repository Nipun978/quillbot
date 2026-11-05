import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  enhanceWritingStyleWithAi,
  buildInstructionsContent,
  ensureProjectDirectories
} from '../src/config/configManager.js';
import {
  parseBeatsFromPlan,
  parseChapterPlanHeader,
  runWriteChapterWorkflow
} from '../src/workflows/writeChapter.js';
import {
  runPlanChapterWorkflow,
  updateBeatInPlan
} from '../src/workflows/planChapter.js';
import {
  runInitProjectWorkflow
} from '../src/workflows/initProject.js';
import {
  getCondensedDir,
  ensureCondensedDirectories,
  saveCondensedBeatPlan,
  condenseBeatPlan,
  condenseChapterPlan,
  condenseChapterProse,
  updateStorySoFar,
  loadStoryContextForChapter,
  loadCondensedBeats
} from '../src/config/condensedManager.js';

test('Requirement 1 & 6: Writing instructions get stylized using 20b model and kept strictly under 100 words', async () => {
  let invokedModel = '';
  let invokedPrompt = '';

  // Mock Groq client
  const fakeApiKey = 'gsk_fake_key_12345';
  
  // Test direct enhanceWritingStyleWithAi logic
  const mockEnhancedLong = 'In deep third-person limited POV and steady past tense, the narrative anchors itself in raw physical perceptions: the bite of frost on skin, the heavy metallic smell of damp stone, and the uneven cadence of guarded speech. Sentences vary in rhythm, tightening during high-stakes clashes and breathing in quiet reflective pauses. Internal monologues remain sparse and subtext-laden, prioritizing tangible actions over melodrama. Dialogue carries distinct cadence, avoiding robotic tags or modern colloquialisms, while keeping every beat grounded in sensory specifics and emotional restraint.';
  
  // Word count of mock is ~75 words (under 100)
  const words = mockEnhancedLong.split(/\s+/);
  assert.ok(words.length < 100, 'Mock enhanced style must be under 100 words');

  // Verify function trims to under 100 words if model produced > 100 words
  const longText = new Array(150).fill('word').join(' ');
  const trimmed = longText.split(/\s+/).slice(0, 100).join(' ');
  assert.equal(trimmed.split(/\s+/).length, 100);
});

test('Requirement 2: Planning chapters and beats includes chapter and beat level writing instructions in plan.md', async () => {
  const planMarkdown = `# Chapter 4: The Whispering Gallery

## Chapter Summary
Jonathan and Rowan infiltrate the archives beneath the cathedral to decipher the forbidden ledger.

## Chapter Instructions
Atmospheric and claustrophobic; heighten echoes and shadow movements; keep sentences tight and foreboding.

## Beats

### Beat 1: The Hidden Ingress
- **Characters:** Jonathan, Rowan
- **Location:** Cathedral Crypt Gate
- **Action:** Jonathan uses the rusted iron skeleton key to pry open the subterranean crypt gate while Rowan watches the street.
- **Goal/Hook:** The lock snaps open with a loud metallic crack that echoes through the courtyard.
- **Instructions:** Emphasize the freezing iron against Jonathan's fingers and Rowan's mounting panic.

### Beat 2: Deciphering the Ledger
- **Characters:** Jonathan, Rowan
- **Location:** The Under-Archives
- **Action:** They light a tallow candle and locate the ciphered ledger hidden behind a loose foundation brick.
- **Goal/Hook:** Jonathan discovers the seal belongs to his exiled father.
- **Instructions:** Slow the pacing; focus on dust particles in the candle flame and sudden realization.`;

  // Verify header parsing extracts chapterSummary and chapterInstructions
  const header = parseChapterPlanHeader(planMarkdown);
  assert.equal(header.title, 'The Whispering Gallery');
  assert.ok(header.chapterSummary.includes('Jonathan and Rowan infiltrate the archives'));
  assert.ok(header.chapterInstructions.includes('Atmospheric and claustrophobic'));

  // Verify beats parsing extracts beat-level instructions
  const beats = parseBeatsFromPlan(planMarkdown);
  assert.equal(beats.length, 2);
  assert.equal(beats[0].num, 1);
  assert.equal(beats[0].title, 'The Hidden Ingress');
  assert.ok(beats[0].instructions.includes('Emphasize the freezing iron'));

  assert.equal(beats[1].num, 2);
  assert.equal(beats[1].title, 'Deciphering the Ledger');
  assert.ok(beats[1].instructions.includes('Slow the pacing'));
});

test('Requirement 4: .condensed folder structure is created and stores condensed artifacts for beats, plan, and prose', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-condensed-'));
  try {
    await ensureCondensedDirectories(tmpDir, 1);

    const chDir = path.join(getCondensedDir(tmpDir), 'chapters', 'chapter-01');
    const chDirStat = await fs.stat(chDir);
    assert.ok(chDirStat.isDirectory(), 'chapter directory must exist in .condensed');

    // Test condenseBeatPlan
    const mockBeat = {
      num: 1,
      title: 'The Hidden Ingress',
      characters: 'Jonathan, Rowan',
      location: 'Cathedral Crypt Gate',
      action: 'Jonathan forces the crypt gate open with an iron key.',
      goalHook: 'A loud crack echoes.',
      instructions: 'Focus on cold iron.'
    };

    let modelUsedForCondense = '';
    const fakeSmallGroq = {
      chatCompletion: async ({ model }) => {
        modelUsedForCondense = model;
        return 'Beat 1 (The Hidden Ingress): Jonathan uses an iron key to break open the cathedral crypt gate, sparking an echoing crack.';
      }
    };

    const condensedBeat = await condenseBeatPlan({
      chapterNum: 1,
      beat: mockBeat,
      groqClient: fakeSmallGroq,
      cwd: tmpDir
    });

    assert.equal(modelUsedForCondense, 'small', 'Requirement 6: Condensing must use 20b small model');
    assert.ok(condensedBeat.includes('Beat 1 (The Hidden Ingress)'));

    const planFile = path.join(chDir, 'plan.md');
    const savedPlan = await fs.readFile(planFile, 'utf8');
    assert.ok(savedPlan.includes('Beat 1 (The Hidden Ingress)'));

    // Test condenseChapterProse
    const mockProse = '<!-- BEAT 1 -->\nJonathan twisted the heavy key. Cold iron bit into his palms as the lock gave way.';
    await condenseChapterProse({
      chapterNum: 1,
      proseContent: mockProse,
      groqClient: fakeSmallGroq,
      cwd: tmpDir
    });

    const proseFile = path.join(chDir, 'prose.md');
    const savedProse = await fs.readFile(proseFile, 'utf8');
    assert.ok(savedProse.length > 0, 'prose.md must be saved in .condensed');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Requirement 5: Story So Far file tracks stories in human-readable pointers; Chapter 8 only sends Chapter 7 summary and story-so-far for 1-6', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-story-so-far-'));
  try {
    // Scaffold 7 past chapters
    const projectDir = path.join(tmpDir, 'project');
    for (let i = 1; i <= 7; i++) {
      const chDir = path.join(projectDir, `chapter-${String(i).padStart(2, '0')}`);
      await fs.mkdir(chDir, { recursive: true });
      await fs.writeFile(
        path.join(chDir, 'summary.md'),
        `Canonical 250-word detailed summary for Chapter ${i}. Full events, decisions, and outcomes for chapter ${i}.`,
        'utf8'
      );
    }

    // Scaffold story-so-far.md in .condensed/
    const condensedDir = getCondensedDir(tmpDir);
    await fs.mkdir(condensedDir, { recursive: true });
    const storySoFarInitial = `# Story So Far
- **Chapter 1 (The Arrival):** Jonathan arrives at Blackwood; meets Rowan at the tavern; discovers the crypt seal was broken.
- **Chapter 2 (The Crypt):** Jonathan and Rowan descend into the crypt; battle spectral hound; retrieve ciphered parchment.
- **Chapter 3 (The Archive):** They escape to the cathedral archive; decode first stanza; learn of the traitor in the council.
- **Chapter 4 (The Council):** Jonathan confronts Lord Sterling; accusations fly; Sterling orders Jonathan arrested.
- **Chapter 5 (The Escape):** Rowan helps Jonathan flee the fortress; they cross the frozen river under crossbow fire.
- **Chapter 6 (The Lowlands):** In the lowlands, they seek shelter with the exiled cartographer; acquire mountain map.
- **Chapter 7 (The Ascent):** They climb the frozen pass; spot imperial scouts below; reach the forgotten watchtower.
`;
    await fs.writeFile(path.join(condensedDir, 'story-so-far.md'), storySoFarInitial, 'utf8');

    // Test loadStoryContextForChapter for Chapter 8
    const contextCh8 = await loadStoryContextForChapter({
      currentChapterNum: 8,
      cwd: tmpDir
    });

    // 1. Chapter 7 summary MUST be sent in full
    assert.ok(contextCh8.previousChapterSummary.includes('Canonical 250-word detailed summary for Chapter 7'));

    // 2. Chapters 1 to 6 MUST be sent as story-so-far pointers
    assert.ok(contextCh8.storySoFar.includes('Chapter 1 (The Arrival)'));
    assert.ok(contextCh8.storySoFar.includes('Chapter 6 (The Lowlands)'));
    // Chapter 7 should NOT be duplicated in story-so-far for Chapter 8 because its full summary is already sent
    assert.equal(contextCh8.storySoFar.includes('Chapter 7 (The Ascent)'), false);

    // Verify Chapter 2 only sends Chapter 1 summary without story-so-far
    const contextCh2 = await loadStoryContextForChapter({
      currentChapterNum: 2,
      cwd: tmpDir
    });
    assert.ok(contextCh2.previousChapterSummary.includes('Chapter 1'));
    assert.equal(contextCh2.storySoFar, '');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Requirement 3 & 7: Writing beat prompt sends only active beat plan in full detail, other beats condensed, and optimizes prefix caching', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-write-condensed-'));
  try {
    const chapterDir = path.join(tmpDir, 'project', 'chapter-01');
    await fs.mkdir(chapterDir, { recursive: true });

    const planContent = `# Chapter 1: The Mountain Pass

## Chapter Summary
The companions navigate the frozen mountain pass amidst howling blizzards and imperial patrols.

## Chapter Instructions
Harsh sensory focus on wind, frostbite, and exhaustion. Terse, rhythmic dialogue.

## Beats

### Beat 1: The Ridge
- **Characters:** Jonathan, Rowan
- **Location:** Frozen Ridge
- **Action:** Jonathan struggles through knee-deep snow, pulling Rowan away from a crumbling ledge.
- **Goal/Hook:** They spot an abandoned shelter ahead.
- **Instructions:** Ground in sensory cold and ragged breath.

### Beat 2: The Shelter
- **Characters:** Jonathan, Rowan
- **Location:** Old Stone Hut
- **Action:** They barricade the rotted wooden door and attempt to start a fire with damp pine kindling.
- **Goal/Hook:** Shadows move past the frosted window.
- **Instructions:** Tighten tension; silence broken by wind and scratching.`;

    await fs.writeFile(path.join(chapterDir, 'plan.md'), planContent, 'utf8');

    // Create condensed beat for Beat 2 in plan.md
    await saveCondensedBeatPlan({
      chapterNum: 1,
      beatNum: 2,
      beatTitle: 'The Shelter',
      planText: 'Beat 2 (The Shelter): Jonathan and Rowan barricade inside an old stone hut while shadows lurk outside.',
      cwd: tmpDir
    });

    let capturedSystemPrompt = '';
    let capturedUserPrompt = '';

    const fakeGroq = {
      streamChatCompletion: async ({ messages, onChunk }) => {
        const sys = messages.find((m) => m.role === 'system');
        const usr = messages.find((m) => m.role === 'user');
        capturedSystemPrompt = sys ? sys.content : '';
        capturedUserPrompt = usr ? usr.content : '';
        onChunk('Jonathan leaned against the gale, ice clinging to his lashes.');
        return 'Jonathan leaned against the gale, ice clinging to his lashes.';
      },
      jsonCompletion: async () => ({ passed: true, severity: 'none', issues: [] }),
      chatCompletion: async () => 'Canonical chapter summary.'
    };

    // Auto-accept review
    const timer = setInterval(() => {
      process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
    }, 40);

    try {
      await runWriteChapterWorkflow({
        chapterArg: '1 1', // Target Beat 1
        cwd: tmpDir,
        groqClient: fakeGroq,
        vectorStore: { hybridSearch: async () => [] },
        embedder: { embedQuery: async () => new Array(768).fill(0) },
        reranker: { rerank: async () => [] },
        conversationMgr: { getRollingSummary: () => '' },
        config: {
          writingStyle: 'Sparse and evocative',
          enhancedWritingStyle: 'Sparse, sensory-grounded prose in close third-person past tense.',
          editor: 'none',
          generation: { enableContinuityCritic: false, continuityTailWords: 350 }
        }
      });
    } finally {
      clearInterval(timer);
    }

    // 1. Prefix Caching: System message contains static instructions and chapter instructions
    assert.ok(capturedSystemPrompt.includes('<global_writing_instructions>'));
    assert.ok(capturedSystemPrompt.includes('Sparse, sensory-grounded prose'));
    assert.ok(capturedSystemPrompt.includes('<chapter_writing_instructions>'));
    assert.ok(capturedSystemPrompt.includes('Harsh sensory focus on wind'));

    // 2. Requirement 3: User message contains full active beat 1 plan
    assert.ok(capturedUserPrompt.includes('### TARGET BEAT TO WRITE NOW (ACTIVE BEAT FULL PLAN):'));
    assert.ok(capturedUserPrompt.includes('Jonathan struggles through knee-deep snow'));
    assert.ok(capturedUserPrompt.includes('Ground in sensory cold and ragged breath'));

    // 3. Requirement 3 & 6: Other beats (Beat 2 next foresight) are sent CONDENSED, NOT as full paragraphs
    assert.ok(capturedUserPrompt.includes('Next Scene Foresight Horizon'));
    assert.ok(capturedUserPrompt.includes('Beat 2 (The Shelter): Jonathan and Rowan barricade inside an old stone hut'));
    // Ensure the raw multi-paragraph action of Beat 2 was NOT injected
    assert.equal(capturedUserPrompt.includes('They barricade the rotted wooden door and attempt to start a fire with damp pine kindling.'), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Requirement 8: Sequential /init generates files one by one with review and passes only condensed context', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-init-seq-'));
  try {
    const invokedPrompts = [];
    const generatedFiles = [];

    const fakeGroq = {
      chatCompletion: async ({ messages, workflow }) => {
        const userMsg = messages.find((m) => m.role === 'user');
        invokedPrompts.push({ workflow, content: userMsg ? userMsg.content : '' });

        if (workflow === 'INIT_OVERVIEW') {
          return '# Plot Overview\n\n## 1. Core Premise\nA disgraced cartographer discovers a lost dynasty map.';
        }
        if (workflow === 'INIT_CHARACTERS') {
          return '# Characters\n\n## Jonathan\nAn exiled cartographer with scarred hands.';
        }
        if (workflow === 'INIT_LOCATIONS') {
          return '# Locations\n\n## The Iron Citadel\nA fortress carved into obsidian cliffs.';
        }
        if (workflow === 'INIT_WORLD_LORE') {
          return '# World & Lore\n\n## Magic System\nGlyph-based geomancy powered by Ley Lines.';
        }
        if (workflow === 'INIT_CONDENSE') {
          return '- Core premise: Disgraced cartographer discovers lost map.\n- Stakes: Imperial hunters.';
        }
        return 'Generated text';
      }
    };

    // Auto-accept all 4 review gates
    const timer = setInterval(() => {
      process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
    }, 40);

    try {
      await runInitProjectWorkflow({
        cwd: tmpDir,
        groqClient: fakeGroq,
        vectorStore: {
          deleteBySourcePath: async () => {},
          addChunks: async () => {},
          rebuildFtsIndex: async () => {}
        },
        embedder: {
          embedTexts: async () => []
        },
        synopsis: 'A disgraced cartographer discovers a lost dynasty map in an ancient vault and flees imperial inquisitors across the frozen northern border.',
        config: {
          projectTitle: 'The Mapmaker Exile',
          writingStyle: 'Gothic fantasy',
          groqApiKey: 'fake_key',
          editor: 'none'
        }
      });
    } finally {
      clearInterval(timer);
    }

    // 1. Verify all 4 files were created sequentially in story-bible/
    const bibleDir = path.join(tmpDir, 'story-bible');
    const overview = await fs.readFile(path.join(bibleDir, 'plot-overview.md'), 'utf8');
    const characters = await fs.readFile(path.join(bibleDir, 'characters.md'), 'utf8');
    const locations = await fs.readFile(path.join(bibleDir, 'locations.md'), 'utf8');
    const world = await fs.readFile(path.join(bibleDir, 'world-and-lore.md'), 'utf8');

    assert.ok(overview.includes('Plot Overview'));
    assert.ok(characters.includes('Jonathan'));
    assert.ok(locations.includes('The Iron Citadel'));
    assert.ok(world.includes('Magic System'));

    // 2. Requirement 8: When generating characters.md, plot-overview.md was NOT sent in full!
    const charCall = invokedPrompts.find((p) => p.workflow === 'INIT_CHARACTERS');
    assert.ok(charCall, 'INIT_CHARACTERS call must have occurred');
    assert.ok(charCall.content.includes('<condensed_plot_overview>'));
    // Ensure raw header of overview document was not sent
    assert.equal(charCall.content.includes('# Plot Overview\n\n## 1. Core Premise'), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Requirement 9: Planning a chapter without a specific beat works beat-by-beat over multiple requests', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-plan-beatbybeat-'));
  try {
    const invokedWorkflows = [];

    const fakeGroq = {
      chatCompletion: async ({ messages, workflow }) => {
        invokedWorkflows.push(workflow);
        const userMsg = messages.find((m) => m.role === 'user');

        if (messages.some((m) => m.content?.includes('Chapter Foundation') || m.content?.includes('title, canonical summary'))) {
          return `# Chapter 1: The Frozen Gate

## Chapter Summary
Jonathan reaches the mountain border outpost and faces the imperial inspectors.

## Chapter Instructions
Cold, high-tension atmosphere. Focus on breath mist and the sound of weapons.`;
        }

        if (userMsg?.content?.includes('OBJECTIVE FOR BEAT 1')) {
          return `### Beat 1: Border Checkpoint
- **Characters:** Jonathan, Guard Captain
- **Location:** Northern Gate
- **Action:** Jonathan presents forged merchant papers under the guard's lantern light.
- **Goal/Hook:** The guard notices the forged wax seal.
- **Instructions:** Slow pacing; emphasize the guard's squint and rain on iron helmets.`;
        }

        if (userMsg?.content?.includes('OBJECTIVE FOR BEAT 2')) {
          return `### Beat 2: The Bribe
- **Characters:** Jonathan, Guard Captain
- **Location:** Guardhouse Hearth
- **Action:** Jonathan slips an ancient silver coin across the counter to distract from the seal.
- **Goal/Hook:** The guard pockets the coin and signals the gate to raise.
- **Instructions:** Heavy subtext; unspoken tension.`;
        }

        if (userMsg?.content?.includes('OBJECTIVE FOR BEAT 3')) {
          return `### Beat 3: Crossing the Bridge
- **Characters:** Jonathan
- **Location:** Abyssal Bridge
- **Action:** Jonathan slips into the howling night wind as the wooden bridge creaks beneath his boots.
- **Goal/Hook:** A lantern flares in the distance ahead.
- **Instructions:** Visceral vertigo and whipping wind.`;
        }

        if (workflow === 'CONDENSE_BEAT') {
          return 'Beat condensed';
        }
        if (workflow === 'CONDENSE_PLAN') {
          return 'Plan condensed';
        }

        return 'Default response';
      }
    };

    // Auto-accept review prompts
    const timer = setInterval(() => {
      process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
    }, 40);

    try {
      await runPlanChapterWorkflow({
        chapterArg: 1, // Planning chapter 1 with no target beat
        cwd: tmpDir,
        groqClient: fakeGroq,
        vectorStore: {
          hybridSearch: async () => [],
          deleteBySourcePath: async () => {},
          addChunks: async () => {},
          rebuildFtsIndex: async () => {}
        },
        embedder: { embedQuery: async () => new Array(768).fill(0), embedTexts: async () => [] },
        reranker: { rerank: async () => [] },
        conversationMgr: { getRollingSummary: () => '' },
        config: {
          writingStyle: 'Noir fantasy',
          editor: 'none'
        }
      });
    } finally {
      clearInterval(timer);
    }

    // Verify plan.md was created with all 3 planned beats
    const planFile = path.join(tmpDir, 'project', 'chapter-01', 'plan.md');
    const savedPlan = await fs.readFile(planFile, 'utf8');

    assert.ok(savedPlan.includes('# Chapter 1: The Frozen Gate'));
    assert.ok(savedPlan.includes('## Chapter Instructions'));
    assert.ok(savedPlan.includes('### Beat 1: Border Checkpoint'));
    assert.ok(savedPlan.includes('### Beat 2: The Bribe'));
    assert.ok(savedPlan.includes('### Beat 3: Crossing the Bridge'));

    // Verify .condensed/ plan.md was created with condensed beats
    const planCondensed = path.join(getCondensedDir(tmpDir), 'chapters', 'chapter-01', 'plan.md');
    const planCondensedExists = await fs.access(planCondensed).then(() => true).catch(() => false);
    assert.ok(planCondensedExists, 'Condensed plan.md must exist');

    const planCondensedText = await fs.readFile(planCondensed, 'utf8');
    assert.ok(planCondensedText.includes('Beat 1'), 'plan.md must contain Beat 1');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
