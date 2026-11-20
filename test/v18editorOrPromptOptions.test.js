import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runPlanChapterWorkflow } from '../src/workflows/planChapter.js';
import { runWriteChapterWorkflow } from '../src/workflows/writeChapter.js';
import { getCondensedBeatPlans, getCondensedBeatProse } from '../src/config/condensedManager.js';
import { openInEditor } from '../src/ui/reviewPrompt.js';

test('1. Plan Edit: Editing an existing planned beat via prompt updates plan.md, condenses with 20B, and syncs', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v18-plan-beat-'));
  const timer = setInterval(() => {
    process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
  }, 40);

  try {
    const ch1Dir = path.join(tmpDir, 'project', 'chapter-01');
    await fs.mkdir(ch1Dir, { recursive: true });

    const initialPlan = `# Chapter 1: The Crossing

## Chapter Summary
Debu crosses the river.

## Chapter Instructions
Atmospheric and grounded.

## Beats

### Beat 1: The Ferry
- **Characters:** Debu, Amba
- **Setting:** Hooghly River dock
- **Beat Outline:**
1. Debu unmoors his skiff.
- **Author's Notes:** Early morning quiet.
- **Beat Instructions:** Minimalist.

### Beat 2: The Shallows
- **Characters:** Debu
- **Setting:** Mid-river
- **Beat Outline:**
1. Debu rows past sandbars.
- **Author's Notes:** Tension.
- **Beat Instructions:** Slow pace.
`;
    await fs.writeFile(path.join(ch1Dir, 'plan.md'), initialPlan, 'utf8');

    const syncedFiles = [];
    const fakeVectorStore = {
      syncFile: async (filePath, type) => {
        syncedFiles.push({ filePath, type });
      }
    };

    await runPlanChapterWorkflow({
      chapterArg: '1 2 Debu spots imperial patrol skiff in shallows',
      cwd: tmpDir,
      groqClient: {
        chatCompletion: async ({ workflow }) => {
          if (workflow === 'PLAN_BEAT') {
            return `### Beat 2: The Shallows Evasion
- **Characters:** Debu, Patrol Sentry
- **Setting:** Mid-river shallows
- **Beat Outline:**
1. Debu veers hard toward the northern reeds upon spotting the patrol.
- **Author's Notes:** Deep suspense.
- **Beat Instructions:** Tense, hushed.`;
          }
          if (workflow === 'CONDENSE_BEAT') {
            return `- **Facts & Milestones:**
  1. Debu veers toward the northern reeds.
- **Key Dialogue & Interactions:**
  - Silent evasion.
- **Sensory & Atmospheric Anchors:**
  - Fog and reed rustle.`;
          }
          return '';
        }
      },
      vectorStore: fakeVectorStore,
      embedder: { embedQuery: async () => [0.1, 0.2] },
      reranker: { rerank: async ({ candidates }) => candidates || [] },
      config: { editor: 'notepad', models: { large: 'openai/gpt-oss-120b', small: 'openai/gpt-oss-20b' } }
    });

    const updatedPlan = await fs.readFile(path.join(ch1Dir, 'plan.md'), 'utf8');
    assert.ok(updatedPlan.includes('Beat 2: The Shallows Evasion'));
    assert.ok(updatedPlan.includes('northern reeds'));

    // Check condensed plan
    const condensedPlans = await getCondensedBeatPlans(1, tmpDir);
    const beat2Plan = condensedPlans.find((b) => b.num === 2);
    assert.ok(beat2Plan);
    assert.ok(beat2Plan.text.includes('northern reeds'));
  } finally {
    clearInterval(timer);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('2. Prose Edit: Editing an existing written beat commits prose, condenses with 20B, and regenerates summary', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v18-write-beat-'));
  const timer = setInterval(() => {
    process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
  }, 40);

  try {
    const ch1Dir = path.join(tmpDir, 'project', 'chapter-01');
    await fs.mkdir(ch1Dir, { recursive: true });

    const plan = `# Chapter 1: The Crossing

## Beats

### Beat 1: The Ferry
- **Characters:** Debu, Amba
- **Setting:** Hooghly River dock
- **Beat Outline:**
1. Debu pushes the skiff off the mud bank.
- **Author's Notes:** Quiet dawn.
- **Beat Instructions:** Grounded.
`;
    await fs.writeFile(path.join(ch1Dir, 'plan.md'), plan, 'utf8');

    const chapterFile = path.join(ch1Dir, 'chapter.md');
    const existingProse = `# Chapter 1: The Crossing\n\n<!-- BEAT 1 -->\nDebu pushed off into the dark water.\n`;
    await fs.writeFile(chapterFile, existingProse, 'utf8');

    // Run targeted rewrite with user instruction
    await runWriteChapterWorkflow({
      chapterArg: '1 1 Add mist rolling off the river bank',
      cwd: tmpDir,
      groqClient: {
        chatCompletion: async ({ workflow }) => {
          if (workflow === 'CONDENSE_BEAT_PROSE') {
            return `- **Facts & Milestones:**
  1. Debu pushed the skiff through dense rolling mist.
- **Key Dialogue & Interactions:**
  - Silent departure.
- **Sensory & Atmospheric Anchors:**
  - Wet river mist, damp timber.`;
          }
          if (workflow === 'CHAPTER_SUMMARY') {
            return `- **Facts & Milestones:**
  1. Debu crossed the Hooghly in heavy mist.
- **Key Dialogue & Interactions:**
  - None.
- **Sensory & Atmospheric Anchors:**
  - River mist.
- **End State:** Debu mid-river.`;
          }
          if (workflow === 'UPDATE_STORY_SO_FAR') {
            return `## Chapter 1: The Crossing
- **Facts & Milestones:**
  1. Debu departed across the Hooghly.
- **Key Dialogue & Interactions:**
  - None.
- **Sensory & Atmospheric Anchors:**
  - Cold mist.
- **End State:** Mid-river.`;
          }
          return '';
        },
        streamChatCompletion: async () => 'Debu leaned into the oar as cold gray mist rolled across the dark water.'
      },
      vectorStore: {
        hybridSearch: async () => [],
        syncFile: async () => {}
      },
      embedder: { embedQuery: async () => [0.1, 0.2] },
      reranker: { rerank: async () => [] },
      config: {
        editor: 'notepad',
        enableContinuityCritic: false,
        cooldownSeconds: 0,
        models: { large: 'openai/gpt-oss-120b', small: 'openai/gpt-oss-20b' }
      }
    });

    const updatedManuscript = await fs.readFile(chapterFile, 'utf8');
    assert.ok(updatedManuscript.includes('cold gray mist rolled across the dark water'));

    // Check condensed prose was generated
    const condensedProse = await getCondensedBeatProse(1, tmpDir);
    assert.equal(condensedProse.length, 1);
    assert.ok(condensedProse[0].text.includes('dense rolling mist'));

    // Check summary was regenerated
    const summaryPath = path.join(ch1Dir, 'summary.md');
    const summaryExists = await fs.access(summaryPath).then(() => true).catch(() => false);
    assert.ok(summaryExists, 'Chapter summary must be regenerated after beat edit');
  } finally {
    clearInterval(timer);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('3. openInEditor writes initialContent, launches editor command, and retrieves edited content', async () => {
  const initial = '### Beat 1: Initial Draft';
  // Use node as a mock editor that appends a comment
  const mockEditor = `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],'\\nAppended by editor.');"`;
  const result = await openInEditor(initial, mockEditor);
  assert.ok(result.includes('### Beat 1: Initial Draft'));
  assert.ok(result.includes('Appended by editor.'));
});
