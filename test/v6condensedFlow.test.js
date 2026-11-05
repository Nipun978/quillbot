import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  getCondensedDir,
  ensureCondensedDirectories,
  saveCondensedBeatPlan,
  saveCondensedBeatProse,
  getCondensedBeatPlans,
  getCondensedBeatProse,
  updateStorySoFar,
  loadStoryContextForChapter,
  loadPlanningContinuityContext,
  loadWritingContinuityContext,
  parseCondensedBeats
} from '../src/config/condensedManager.js';
import { runPlanChapterWorkflow } from '../src/workflows/planChapter.js';
import { runWriteChapterWorkflow } from '../src/workflows/writeChapter.js';

test('1. Exact .condensed folder layout: only story-so-far.md and chapters/chapter-XX/{plan.md, prose.md}', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v6-layout-'));
  try {
    await ensureCondensedDirectories(tmpDir, 7);

    const chDir = path.join(getCondensedDir(tmpDir), 'chapters', 'chapter-07');
    const chStat = await fs.stat(chDir);
    assert.ok(chStat.isDirectory(), 'chapter-07 directory must exist in .condensed');

    // Beats subfolder must NOT exist
    const beatsDir = path.join(chDir, 'beats');
    let beatsDirExists = false;
    try {
      await fs.access(beatsDir);
      beatsDirExists = true;
    } catch {}
    assert.equal(beatsDirExists, false, 'beats/ subfolder must NOT exist in .condensed chapter directory');

    // Simulate saving beat plan and beat prose
    await saveCondensedBeatPlan({
      chapterNum: 7,
      beatNum: 1,
      beatTitle: 'The Ambush',
      planText: '### Beat 1: The Ambush\n- **Action:** Enemies strike from the fog.',
      cwd: tmpDir
    });

    await saveCondensedBeatProse({
      chapterNum: 7,
      beatNum: 1,
      beatTitle: 'The Ambush',
      proseText: 'Cold arrows whistled out of the marshland fog as Jonathan drew his blade.',
      cwd: tmpDir
    });

    const entries = await fs.readdir(chDir);
    assert.deepEqual(entries.sort(), ['plan.md', 'prose.md'], 'Chapter folder must strictly contain ONLY plan.md and prose.md');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('2. saveCondensedBeatPlan and saveCondensedBeatProse invoke 20b model and format beats cleanly', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v6-condense-'));
  try {
    const invoked = [];
    const fake20bClient = {
      chatCompletion: async ({ model, workflow }) => {
        invoked.push({ model, workflow });
        if (workflow === 'CONDENSE_BEAT') {
          return 'Beat 2 (The Vault): Jonathan opens the rusted seal with his father dagger.';
        }
        if (workflow === 'CONDENSE_BEAT_PROSE') {
          return 'Beat 2 (The Vault): Jonathan forced the iron latch open and secured the ancient map.';
        }
        return 'Condensed fallback';
      }
    };

    // 1. Save Beat 2 Plan
    await saveCondensedBeatPlan({
      chapterNum: 3,
      beatNum: 2,
      beatTitle: 'The Vault',
      planText: 'Jonathan picks the lock while Rowan keeps guard.',
      groqClient: fake20bClient,
      cwd: tmpDir
    });

    // 2. Save Beat 2 Prose
    await saveCondensedBeatProse({
      chapterNum: 3,
      beatNum: 2,
      beatTitle: 'The Vault',
      proseText: 'The heavy brass latch surrendered with a hollow grind, releasing centuries of stale air.',
      groqClient: fake20bClient,
      cwd: tmpDir
    });

    assert.equal(invoked.length, 2);
    assert.equal(invoked[0].model, 'small', 'Must use 20B small model');
    assert.equal(invoked[0].workflow, 'CONDENSE_BEAT');
    assert.equal(invoked[1].model, 'small', 'Must use 20B small model');
    assert.equal(invoked[1].workflow, 'CONDENSE_BEAT_PROSE');

    // Verify stored content
    const plans = await getCondensedBeatPlans(3, tmpDir);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].num, 2);
    assert.ok(plans[0].text.includes('Jonathan opens the rusted seal'));

    const proses = await getCondensedBeatProse(3, tmpDir);
    assert.equal(proses.length, 1);
    assert.equal(proses[0].num, 2);
    assert.ok(proses[0].text.includes('Jonathan forced the iron latch open'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('3. Requirement 5: Planning Beat 4 of Chapter 7 retrieves Ch 6 summary + Ch 1-5 pointers + Beat 3 plan + Beats 1-2 condensed plans', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v6-plan-ctx-'));
  try {
    // 1. Setup story-so-far.md
    await ensureCondensedDirectories(tmpDir, 7);
    const storySoFarInitial = `# Story So Far
- **Chapter 1 (The Departure):** Jonathan leaves Blackwood.
- **Chapter 2 (The Marsh):** Escapes through the marshland.
- **Chapter 3 (The Crypt):** Solves the cipher in the crypt.
- **Chapter 4 (The Citadel):** Infiltrates the outer citadel.
- **Chapter 5 (The Escape):** Flees the garrison patrols.
- **Chapter 6 (The High Pass):** Climbs into the snowy mountain peaks.
`;
    await fs.writeFile(path.join(getCondensedDir(tmpDir), 'story-so-far.md'), storySoFarInitial, 'utf8');

    // 2. Setup Chapter 6 summary.md
    const ch6Dir = path.join(tmpDir, 'project', 'chapter-06');
    await fs.mkdir(ch6Dir, { recursive: true });
    await fs.writeFile(
      path.join(ch6Dir, 'summary.md'),
      'Canonical 250-word detailed summary of Chapter 6. Jonathan and Rowan braved the avalanche and established their camp beneath the frozen spire.',
      'utf8'
    );

    // 3. Setup Chapter 7 plan.md in .condensed
    await saveCondensedBeatPlan({
      chapterNum: 7,
      beatNum: 1,
      beatTitle: 'The Gate',
      planText: 'Jonathan breaches the perimeter gate.',
      cwd: tmpDir
    });
    await saveCondensedBeatPlan({
      chapterNum: 7,
      beatNum: 2,
      beatTitle: 'The Courtyard',
      planText: 'They evade the perimeter sentries in the courtyard.',
      cwd: tmpDir
    });

    // 4. Test macro context for Chapter 7
    const macroCtx = await loadStoryContextForChapter({ currentChapterNum: 7, cwd: tmpDir });
    assert.ok(macroCtx.previousChapterSummary.includes('Canonical 250-word detailed summary of Chapter 6'));
    assert.ok(macroCtx.storySoFar.includes('Chapter 1 (The Departure)'));
    assert.ok(macroCtx.storySoFar.includes('Chapter 5 (The Escape)'));
    // Chapter 6 should NOT be in storySoFar because its full summary is sent
    assert.equal(macroCtx.storySoFar.includes('Chapter 6 (The High Pass)'), false);

    // 5. Test micro continuity context for planning Beat 4
    const allBeatsInPlan = [
      { num: 1, title: 'The Gate', action: 'Breach gate' },
      { num: 2, title: 'The Courtyard', action: 'Evade sentries' },
      {
        num: 3,
        title: 'The Armory',
        action: 'Jonathan unlocks the armory door and gathers crossbow bolts while Rowan secures the passage.',
        goalHook: 'An alarm bell rings in the distance.',
        rawBlock: '### Beat 3: The Armory\n- **Action:** Jonathan unlocks the armory door.\n- **Goal/Hook:** An alarm bell rings.'
      }
    ];

    const planCtx = await loadPlanningContinuityContext({
      chapterNum: 7,
      activeBeatNum: 4,
      allBeatsInPlan,
      cwd: tmpDir
    });

    // Beat 3 plan must be sent in full
    assert.ok(planCtx.previousBeatPlan.includes('### Beat 3: The Armory'));
    assert.ok(planCtx.previousBeatPlan.includes('An alarm bell rings'));

    // Beats 1 and 2 must be sent condensed
    assert.equal(planCtx.priorCondensedPlans.length, 2);
    assert.ok(planCtx.priorCondensedPlans[0].includes('Beat 1'));
    assert.ok(planCtx.priorCondensedPlans[1].includes('Beat 2'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('4. Requirement 6: Writing Beat 4 of Chapter 7 sends prior condensed prose, verbatim seam, active plan, and next beat foresight', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v6-write-ctx-'));
  try {
    await ensureCondensedDirectories(tmpDir, 7);

    // 1. Setup prior condensed prose in .condensed/chapters/chapter-07/prose.md
    await saveCondensedBeatProse({
      chapterNum: 7,
      beatNum: 1,
      beatTitle: 'The Gate',
      proseText: 'Jonathan severed the iron chains at the outer gate.',
      cwd: tmpDir
    });
    await saveCondensedBeatProse({
      chapterNum: 7,
      beatNum: 2,
      beatTitle: 'The Courtyard',
      proseText: 'They slipped past sleeping guard dogs across the frozen courtyard.',
      cwd: tmpDir
    });
    await saveCondensedBeatProse({
      chapterNum: 7,
      beatNum: 3,
      beatTitle: 'The Armory',
      proseText: 'Jonathan retrieved the enchanted crossbow bolts before the distant bell tolled.',
      cwd: tmpDir
    });

    // 2. Setup condensed plan for Beat 5 (next beat foresight)
    await saveCondensedBeatPlan({
      chapterNum: 7,
      beatNum: 5,
      beatTitle: 'The Rooftop Escape',
      planText: 'They climb the drainage pipe onto the snowy slate roofs.',
      cwd: tmpDir
    });

    // 3. Setup chapter.md with Beat 3 prose to verify verbatim trailing snippet
    const ch7Dir = path.join(tmpDir, 'project', 'chapter-07');
    await fs.mkdir(ch7Dir, { recursive: true });
    const chapterFile = path.join(ch7Dir, 'chapter.md');
    await fs.writeFile(
      chapterFile,
      `<!-- BEAT 1 -->
Prose for Beat 1.
<!-- BEAT 2 -->
Prose for Beat 2.
<!-- BEAT 3 -->
Jonathan reached into the iron chest, his fingers tightening around the cold, rune-carved bolts as the distant tower bell tolled midnight.
`,
      'utf8'
    );

    const beatsList = [
      { num: 1, title: 'The Gate' },
      { num: 2, title: 'The Courtyard' },
      { num: 3, title: 'The Armory' },
      { num: 4, title: 'The Great Hall' },
      { num: 5, title: 'The Rooftop Escape' }
    ];

    const writeCtx = await loadWritingContinuityContext({
      chapterNum: 7,
      activeBeatNum: 4,
      beatsList,
      cwd: tmpDir,
      chapterFile
    });

    // 1. Prior condensed prose for Beats 1-3
    assert.equal(writeCtx.priorCondensedProse.length, 3);
    assert.ok(writeCtx.priorCondensedProse[0].includes('Beat 1'));
    assert.ok(writeCtx.priorCondensedProse[2].includes('enchanted crossbow bolts'));

    // 2. Verbatim trailing words from Beat 3
    assert.ok(writeCtx.lastProseSnippet.includes('cold, rune-carved bolts as the distant tower bell tolled midnight'));

    // 3. Next beat foresight (Beat 5)
    assert.ok(writeCtx.nextBeatCondensedPlan.includes('Beat 5'));
    assert.ok(writeCtx.nextBeatCondensedPlan.includes('The Rooftop Escape'));
    assert.equal(writeCtx.isFinaleBeat, false);

    // 4. Test Finale Beat (Beat 5 of 5)
    const finaleCtx = await loadWritingContinuityContext({
      chapterNum: 7,
      activeBeatNum: 5,
      beatsList,
      cwd: tmpDir,
      chapterFile
    });
    assert.equal(finaleCtx.isFinaleBeat, true);
    assert.equal(finaleCtx.nextBeatCondensedPlan, null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('5. updateStorySoFar appends or updates chapter pointers under 50 words', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v6-ssf-'));
  try {
    const fakeGroq = {
      chatCompletion: async () => '- Jonathan secures the lost archive; Rowan deciphers the blood covenant; Lord Sterling prepares for war.'
    };

    await updateStorySoFar({
      chapterNum: 1,
      chapterTitle: 'The Ingress',
      summaryText: 'Jonathan and Rowan decipher the forbidden ledger in the cathedral crypts.',
      groqClient: fakeGroq,
      cwd: tmpDir
    });

    const ssfPath = path.join(getCondensedDir(tmpDir), 'story-so-far.md');
    const ssf = await fs.readFile(ssfPath, 'utf8');
    assert.ok(ssf.includes('- **Chapter 1 (The Ingress):**'));
    assert.ok(ssf.includes('Jonathan secures the lost archive'));

    // Update Chapter 1
    const fakeGroqUpdate = {
      chatCompletion: async () => '- Updated pointers for Chapter 1 with new discoveries.'
    };

    await updateStorySoFar({
      chapterNum: 1,
      chapterTitle: 'The Ingress',
      summaryText: 'Revised summary.',
      groqClient: fakeGroqUpdate,
      cwd: tmpDir
    });

    const updatedSsf = await fs.readFile(ssfPath, 'utf8');
    assert.ok(updatedSsf.includes('Updated pointers for Chapter 1'));
    // Ensure no duplicate entry for Chapter 1
    const matches = updatedSsf.match(/- \*\*Chapter 1/g);
    assert.equal(matches.length, 1, 'There must be strictly one entry per chapter in story-so-far.md');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('6. Empty LLM responses fall back gracefully without creating empty entries', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v6-empty-fallback-'));
  try {
    // LLM client returns empty string (simulating reasoning exhaustion or empty response)
    const emptyGroq = {
      chatCompletion: async () => ''
    };

    // Pre-populate story-so-far.md with default placeholder
    const condensedDir = getCondensedDir(tmpDir);
    await ensureCondensedDirectories(tmpDir);
    await fs.writeFile(
      path.join(condensedDir, 'story-so-far.md'),
      '# Story So Far\n\n(No chapters written yet.)\n',
      'utf8'
    );

    // 1. Plan fallback
    const planResult = await saveCondensedBeatPlan({
      chapterNum: 1,
      beatNum: 1,
      beatTitle: 'The River Bank',
      planText: '### Beat 1: The River Bank\n- **Action:** Debu searches the reeds for Padma.\n- **Goal/Hook:** Finds the dropped leaf.',
      groqClient: emptyGroq,
      cwd: tmpDir
    });
    assert.ok(planResult.includes('The River Bank'));
    assert.ok(!planResult.endsWith(': '));

    // 2. Prose fallback
    const proseResult = await saveCondensedBeatProse({
      chapterNum: 1,
      beatNum: 1,
      beatTitle: 'The River Bank',
      proseText: 'Their footsteps sank into the soft mud, muffled by the thin layer of night dew.',
      groqClient: emptyGroq,
      cwd: tmpDir
    });
    assert.ok(proseResult.includes('The River Bank'));
    assert.ok(proseResult.includes('footsteps sank'));
    assert.ok(!proseResult.endsWith(': '));

    // 3. Story So Far fallback
    const ssfResult = await updateStorySoFar({
      chapterNum: 1,
      chapterTitle: 'The River Bank',
      summaryText: 'Debu searches along the river and finds Padma safe. They exchange vows before Amba.',
      groqClient: emptyGroq,
      cwd: tmpDir
    });
    assert.ok(ssfResult.includes('- **Chapter 1 (The River Bank):**'));
    assert.ok(ssfResult.includes('Debu searches along the river'));
    // Placeholder must be gone
    assert.ok(!ssfResult.includes('(No chapters written yet.)'));
    // Must not be empty after colon
    assert.ok(!ssfResult.includes('- **Chapter 1 (The River Bank):**\n'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});


