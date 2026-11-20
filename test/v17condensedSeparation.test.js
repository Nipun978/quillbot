import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ensureCondensedDirectories,
  saveCondensedBeatPlan,
  saveCondensedBeatProse,
  getCondensedBeatPlans,
  getCondensedBeatProse,
  updateStorySoFar,
  loadStoryContextForChapter,
  loadWritingContinuityContext,
  parseCondensedBeats
} from '../src/config/condensedManager.js';
import {
  CONDENSE_BEAT_PLAN_SYSTEM_PROMPT,
  CONDENSE_BEAT_PROSE_SYSTEM_PROMPT,
  UPDATE_STORY_SO_FAR_SYSTEM_PROMPT,
  CHAPTER_SUMMARY_SYSTEM_PROMPT,
  WRITE_BEAT_SYSTEM_PROMPT
} from '../src/llm/prompts.js';

test('1. Prompt separation: CONDENSE prompts enforce Facts, Key Dialogue, and Sensory Anchors with distinct budgets', () => {
  assert.ok(CONDENSE_BEAT_PLAN_SYSTEM_PROMPT.includes('Facts & Milestones'));
  assert.ok(CONDENSE_BEAT_PLAN_SYSTEM_PROMPT.includes('Key Dialogue & Interactions'));
  assert.ok(CONDENSE_BEAT_PLAN_SYSTEM_PROMPT.includes('Sensory & Atmospheric Anchors'));

  assert.ok(CONDENSE_BEAT_PROSE_SYSTEM_PROMPT.includes('Facts & Milestones'));
  assert.ok(CONDENSE_BEAT_PROSE_SYSTEM_PROMPT.includes('Key Dialogue & Interactions'));
  assert.ok(CONDENSE_BEAT_PROSE_SYSTEM_PROMPT.includes('Sensory & Atmospheric Anchors'));
  assert.ok(CONDENSE_BEAT_PROSE_SYSTEM_PROMPT.includes('CROSS-REFERENCE BLUEPRINT & PROSE'));

  assert.ok(CHAPTER_SUMMARY_SYSTEM_PROMPT.includes('Facts & Milestones'));
  assert.ok(CHAPTER_SUMMARY_SYSTEM_PROMPT.includes('Sensory & Atmospheric Anchors'));
  assert.ok(CHAPTER_SUMMARY_SYSTEM_PROMPT.includes('End State'));

  assert.ok(UPDATE_STORY_SO_FAR_SYSTEM_PROMPT.includes('Facts & Milestones'));
  assert.ok(UPDATE_STORY_SO_FAR_SYSTEM_PROMPT.includes('Sensory & Atmospheric Anchors'));

  assert.ok(WRITE_BEAT_SYSTEM_PROMPT.includes('CONTINUITY INTEGRITY & CONTEXT HIERARCHY'));
  assert.ok(WRITE_BEAT_SYSTEM_PROMPT.includes('HARD CANON MILESTONES'));
  assert.ok(WRITE_BEAT_SYSTEM_PROMPT.includes('CONTINUITY TEXTURE'));
});

test('2. saveCondensedBeatPlan saves and parses multi-part structured beat plan', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v17-plan-'));
  try {
    const fakeClient = {
      chatCompletion: async ({ model, workflow }) => {
        assert.equal(model, 'small');
        assert.equal(workflow, 'CONDENSE_BEAT');
        return `- **Facts & Milestones:**
  1. Debu unmoors his wooden skiff from the southern dock and pushes into the river fog.
- **Key Dialogue & Interactions:**
  - Debu to Amba: "Wait by the banyan tree until dusk." (softly, urgent)
- **Sensory & Atmospheric Anchors:**
  - Wet cedar planking, dense gray morning river fog, cold river spray.`;
      }
    };

    const result = await saveCondensedBeatPlan({
      chapterNum: 1,
      beatNum: 1,
      beatTitle: 'The Morning Ferry',
      planText: '### Beat 1: The Morning Ferry\n- **Setting:** Hooghly River dock\n- **Beat Outline:**\n1. Debu unmoors the boat.\n2. Debu to Amba (softly): "Wait by the banyan tree until dusk."',
      groqClient: fakeClient,
      cwd: tmpDir
    });

    assert.ok(result.includes('Beat 1 (The Morning Ferry):'));
    assert.ok(result.includes('Facts & Milestones:'));
    assert.ok(result.includes('Key Dialogue & Interactions:'));
    assert.ok(result.includes('Sensory & Atmospheric Anchors:'));

    const storedPlans = await getCondensedBeatPlans(1, tmpDir);
    assert.equal(storedPlans.length, 1);
    assert.equal(storedPlans[0].num, 1);
    assert.equal(storedPlans[0].title, 'The Morning Ferry');
    assert.ok(storedPlans[0].text.includes('Wet cedar planking'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('3. saveCondensedBeatProse receives both Beat Plan and Narrative Prose, enabling precise extraction', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v17-prose-'));
  try {
    let capturedUserContent = '';
    const fakeClient = {
      chatCompletion: async ({ model, workflow, messages }) => {
        assert.equal(model, 'small');
        assert.equal(workflow, 'CONDENSE_BEAT_PROSE');
        capturedUserContent = messages[1].content;
        return `- **Facts & Milestones:**
  1. Debu steered past the treacherous shallows, evading the imperial patrol boat stationed near the sandbar.
- **Key Dialogue & Interactions:**
  - Debu to Amba: "Keep your head down." (tense murmur)
- **Sensory & Atmospheric Anchors:**
  - Smudge of yellow lantern light across murky brown water; biting wind off the sandbar.`;
      }
    };

    const planBlueprint = `### Beat 2: Shallows Evasion
- **Characters:** Debu, Amba
- **Setting:** Sandbar shallows
- **Beat Outline:**
1. Debu navigates past patrol skiff into reeds.
2. Debu to Amba (whispered): "Keep your head down."`;

    const executedProse = `The shallow hooghly waters hissed beneath the hull as Debu leaned hard against the rudder pole.
"Keep your head down," he murmured.
A lantern flickered through the reeds from the patrol skiff.`;

    const result = await saveCondensedBeatProse({
      chapterNum: 1,
      beatNum: 2,
      beatTitle: 'Shallows Evasion',
      proseText: executedProse,
      planText: planBlueprint,
      groqClient: fakeClient,
      cwd: tmpDir
    });

    // Verify both plan and prose were delivered to 20B model
    assert.ok(capturedUserContent.includes('--- BEAT PLAN (Author\'s Blueprint) ---'));
    assert.ok(capturedUserContent.includes('Shallows Evasion'));
    assert.ok(capturedUserContent.includes('--- NARRATIVE PROSE (Manuscript) ---'));
    assert.ok(capturedUserContent.includes('The shallow hooghly waters hissed'));

    // Verify formatted result
    assert.ok(result.includes('Beat 2 (Shallows Evasion):'));
    assert.ok(result.includes('Facts & Milestones:'));
    assert.ok(result.includes('Sensory & Atmospheric Anchors:'));
    assert.ok(result.includes('murky brown water'));

    const storedProse = await getCondensedBeatProse(1, tmpDir);
    assert.equal(storedProse.length, 1);
    assert.equal(storedProse[0].num, 2);
    assert.ok(storedProse[0].text.includes('imperial patrol boat'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('4. Fallback generation creates clean structured schema when model returns empty or error', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v17-fallback-'));
  try {
    const errorClient = {
      chatCompletion: async () => {
        throw new Error('503 Service Unavailable');
      }
    };

    // Plan fallback
    const planFallback = await saveCondensedBeatPlan({
      chapterNum: 2,
      beatNum: 1,
      beatTitle: 'The Landing',
      planText: 'Debu pulls the boat onto the silt bank and unloads the heavy jute sacks.',
      groqClient: errorClient,
      cwd: tmpDir
    });
    assert.ok(planFallback.includes('Facts & Milestones:'));
    assert.ok(planFallback.includes('Key Dialogue & Interactions:'));
    assert.ok(planFallback.includes('Sensory & Atmospheric Anchors:'));
    assert.ok(planFallback.includes('Debu pulls the boat onto the silt bank'));

    // Prose fallback
    const proseFallback = await saveCondensedBeatProse({
      chapterNum: 2,
      beatNum: 1,
      beatTitle: 'The Landing',
      proseText: 'Cold mud sucked at Debu\'s bare feet as he hauled the hull high above the waterline.',
      groqClient: errorClient,
      cwd: tmpDir
    });
    assert.ok(proseFallback.includes('Facts & Milestones:'));
    assert.ok(proseFallback.includes('Key Dialogue & Interactions:'));
    assert.ok(proseFallback.includes('Sensory & Atmospheric Anchors:'));
    assert.ok(proseFallback.includes('Cold mud sucked at Debu'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('5. updateStorySoFar records structured sections and loadStoryContextForChapter extracts them', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v17-story-so-far-'));
  try {
    const fakeClient = {
      chatCompletion: async ({ model, workflow }) => {
        assert.equal(model, 'small');
        assert.equal(workflow, 'UPDATE_STORY_SO_FAR');
        return `- **Facts & Milestones:**
  1. Debu successfully transported Amba across the river and secured safe harbor in Padmaghat.
- **Key Dialogue & Interactions:**
  - Debu to Amba: "The village elder will take you in."
- **Sensory & Atmospheric Anchors:**
  - Wet riverbank clay, ringing monastery bells in the distance.
- **End State:** Debu at the docks; Amba resting inside the elder's courtyard.`;
      }
    };

    const summaryText = `Chapter 1 completed. Debu and Amba reached Padmaghat safely after avoiding the river patrol.`;

    await updateStorySoFar({
      chapterNum: 1,
      chapterTitle: 'The Crossing',
      summaryText,
      groqClient: fakeClient,
      cwd: tmpDir
    });

    const ctx = await loadStoryContextForChapter({
      currentChapterNum: 3,
      cwd: tmpDir
    });

    assert.ok(ctx.storySoFar.includes('Chapter 1 (The Crossing):'));
    assert.ok(ctx.storySoFar.includes('Facts & Milestones:'));
    assert.ok(ctx.storySoFar.includes('Key Dialogue & Interactions:'));
    assert.ok(ctx.storySoFar.includes('Sensory & Atmospheric Anchors:'));
    assert.ok(ctx.storySoFar.includes('End State:'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('6. loadWritingContinuityContext feeds structured beats cleanly into scene progression', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v17-write-ctx-'));
  try {
    await ensureCondensedDirectories(tmpDir, 4);

    await saveCondensedBeatProse({
      chapterNum: 4,
      beatNum: 1,
      beatTitle: 'Gate Approach',
      proseText: 'Jonathan reached the stone portal under cover of the storm.',
      groqClient: {
        chatCompletion: async () => `- **Facts & Milestones:**
  1. Jonathan reaches the stone portal undetected.
- **Key Dialogue & Interactions:**
  - Jonathan to Himself: "Almost through."
- **Sensory & Atmospheric Anchors:**
  - Freezing sleet, slick moss on granite blocks.`
      },
      cwd: tmpDir
    });

    const writeCtx = await loadWritingContinuityContext({
      chapterNum: 4,
      activeBeatNum: 2,
      beatsList: [{ num: 1, title: 'Gate Approach' }, { num: 2, title: 'Inner Courtyard' }],
      cwd: tmpDir
    });

    assert.equal(writeCtx.priorCondensedProse.length, 1);
    const firstPrior = writeCtx.priorCondensedProse[0];
    assert.ok(firstPrior.includes('Beat 1'));
    assert.ok(firstPrior.includes('Facts & Milestones:'));
    assert.ok(firstPrior.includes('Freezing sleet'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
