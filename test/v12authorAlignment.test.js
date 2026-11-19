import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  parseBeatsFromPlan,
  runContinuityCritic
} from '../src/workflows/writeChapter.js';
import {
  saveCondensedBeatPlan,
  saveCondensedBeatProse,
  updateStorySoFar,
  getCondensedBeatPlans,
  getCondensedBeatProse,
  loadStorySoFar
} from '../src/config/condensedManager.js';
import {
  PLAN_CHAPTER_SYSTEM_PROMPT,
  PLAN_SINGLE_BEAT_SYSTEM_PROMPT,
  WRITE_BEAT_SYSTEM_PROMPT,
  CONTINUITY_CRITIC_SYSTEM_PROMPT,
  CONDENSE_BEAT_PLAN_SYSTEM_PROMPT,
  CONDENSE_BEAT_PROSE_SYSTEM_PROMPT,
  CHAPTER_SUMMARY_SYSTEM_PROMPT,
  UPDATE_STORY_SO_FAR_SYSTEM_PROMPT
} from '../src/llm/prompts.js';

test('1. Inline Dialogue Tagging: Prompts mandate [Speaker to Listener (delivery)]: "Line"', () => {
  assert.match(PLAN_CHAPTER_SYSTEM_PROMPT, /MANDATORY INLINE DIALOGUE TAGGING/);
  assert.match(PLAN_CHAPTER_SYSTEM_PROMPT, /\[Speaker to Listener \(delivery\/tone\/physical cue\)\]: "Verbatim line"/);
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /MANDATORY INLINE DIALOGUE TAGGING/);
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /\[Non-verbal \/ silent interaction/);
});

test('2. parseBeatsFromPlan extracts inline dialogue tags with speaker, listener, and delivery cue', () => {
  const planWithDialogueTags = `# Chapter 3: The Broken Sluice

## Chapter Summary
Debu and Amba confront the lock-keeper.

## Chapter Instructions
Keep dialogue terse, restrained, and heavy with unspoken stakes.

## Beats

### Beat 1: Confrontation at the Sluice Gate
- **Characters:** Debu, Lock-keeper Haren, Amba
- **Setting:** Hooghly Lock Gate at twilight
- **Beat Outline:**
Debu stands by the iron wheel while Haren inspects the broken copper pins.
[Debu to Haren (firmly, keeping his hand on the rope)]: "The evening tide will not wait for your ledger."
Haren rubs the rust between his fingers without looking up.
[Haren to Debu (curtly, spitting into the canal)]: "Then row through the shallows if your skiff can bear the mud."
Amba steps onto the timber plank between them.
[Amba to Haren (quietly, offering three copper coins)]: "Take the toll and lift the gate."
- **Author's Notes:** Convey the suffocating economic pressure on rivermen. Subtext: Debu cannot afford another hour of delay.
- **Beat Instructions:** Spare, grounded prose. Focus on physical textures of cold iron and river salt.
`;

  const beats = parseBeatsFromPlan(planWithDialogueTags);
  assert.equal(beats.length, 1);
  const beat = beats[0];
  assert.equal(beat.num, 1);
  assert.equal(beat.title, 'Confrontation at the Sluice Gate');
  assert.equal(beat.characters, 'Debu, Lock-keeper Haren, Amba');
  assert.equal(beat.setting, 'Hooghly Lock Gate at twilight');
  assert.ok(beat.authorNotes.includes('economic pressure on rivermen'));
  assert.ok(beat.instructions.includes('Spare, grounded prose'));

  // Verify extracted dialogue tags
  assert.ok(Array.isArray(beat.dialogueTags));
  assert.equal(beat.dialogueTags.length, 3);

  assert.equal(beat.dialogueTags[0].speaker, 'Debu');
  assert.equal(beat.dialogueTags[0].listener, 'Haren');
  assert.equal(beat.dialogueTags[0].delivery, 'firmly, keeping his hand on the rope');
  assert.equal(beat.dialogueTags[0].line, 'The evening tide will not wait for your ledger.');

  assert.equal(beat.dialogueTags[1].speaker, 'Haren');
  assert.equal(beat.dialogueTags[1].listener, 'Debu');
  assert.equal(beat.dialogueTags[1].delivery, 'curtly, spitting into the canal');
  assert.equal(beat.dialogueTags[1].line, 'Then row through the shallows if your skiff can bear the mud.');

  assert.equal(beat.dialogueTags[2].speaker, 'Amba');
  assert.equal(beat.dialogueTags[2].listener, 'Haren');
  assert.equal(beat.dialogueTags[2].delivery, 'quietly, offering three copper coins');
  assert.equal(beat.dialogueTags[2].line, 'Take the toll and lift the gate.');
});

test('3. Strict Minimalist Grounding in WRITE_BEAT_SYSTEM_PROMPT: bans unprompted metaphors, fluff, and invented props', () => {
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /SUPREME PRECEDENCE OF AUTHOR'S NOTES & BEAT OUTLINE/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /STRICT MINIMALIST GROUNDING/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /Do NOT write unprompted figurative language \(similes, metaphors\)/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /NEVER manufacture AI-invented props, actions, or secondary characters/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /INSTRUCTIONS HIERARCHY/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /Beat-Specific Instructions & Author's Notes \(Supreme Precedence/);
});

test('4. Expanded Continuity & Plan Critic: returns 4-point checklist and validates plan, vision, instructions, and grammar', async () => {
  // Test Mock Critic with issues
  const mockCriticWithIssues = {
    jsonCompletion: async () => ({
      checklist: {
        planFollowed: false,
        authorVisionMet: false,
        instructionsFollowed: true,
        grammarCorrect: false
      },
      passed: false,
      severity: 'major',
      issues: [
        {
          type: 'plan_discrepancy',
          category: 'plan_discrepancy',
          description: 'Debu never spoke his planned dialogue line to Haren.',
          quote: 'Debu turned away silently.',
          fixSuggestion: 'Inject planned line [Debu to Haren]: "The evening tide will not wait for your ledger."'
        },
        {
          type: 'purpose_vision',
          category: 'purpose_vision',
          description: 'Prose felt comical instead of conveying the suffocating economic pressure required by Author Notes.',
          quote: 'Haren chuckled merrily.',
          fixSuggestion: 'Anchor Haren\'s posture in cold bureaucracy rather than comedic warmth.'
        },
        {
          type: 'grammar_spelling',
          category: 'grammar_spelling',
          description: 'Typo in dialogue: "shoudl" instead of "should".',
          quote: 'we shoudl wait',
          fixSuggestion: 'Change "shoudl" to "should".'
        }
      ]
    })
  };

  const beat = {
    num: 1,
    title: 'The Sluice Gate',
    characters: 'Debu, Haren',
    setting: 'Hooghly Canal',
    beatOutline: 'Debu asks Haren to open gate.',
    authorNotes: 'High economic anxiety.',
    instructions: 'Terse sentences.'
  };

  const result = await runContinuityCritic({
    beatProse: 'Debu looked at the gate and walked away.',
    beat,
    chapterInstructions: 'Cold realism.',
    globalInstructions: 'Past tense.',
    groqClient: mockCriticWithIssues
  });

  assert.equal(result.passed, false);
  assert.equal(result.severity, 'major');
  assert.equal(result.checklist.planFollowed, false);
  assert.equal(result.checklist.authorVisionMet, false);
  assert.equal(result.checklist.instructionsFollowed, true);
  assert.equal(result.checklist.grammarCorrect, false);
  assert.equal(result.issues.length, 3);
  assert.equal(result.issues[0].category, 'plan_discrepancy');
  assert.equal(result.issues[1].category, 'purpose_vision');
  assert.equal(result.issues[2].category, 'grammar_spelling');

  // Test Mock Critic with clean pass
  const mockCleanCritic = {
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

  const cleanResult = await runContinuityCritic({
    beatProse: 'Debu stepped forward. "The evening tide will not wait for your ledger."',
    beat,
    groqClient: mockCleanCritic
  });

  assert.equal(cleanResult.passed, true);
  assert.equal(cleanResult.severity, 'none');
  assert.equal(cleanResult.checklist.planFollowed, true);
  assert.equal(cleanResult.checklist.authorVisionMet, true);
  assert.equal(cleanResult.checklist.instructionsFollowed, true);
  assert.equal(cleanResult.checklist.grammarCorrect, true);
  assert.equal(cleanResult.issues.length, 0);
});

test('5. Numbered Chronological Logs: saveCondensedBeatPlan, saveCondensedBeatProse, and updateStorySoFar enforce factual structure', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-v12-condense-'));
  try {
    const mockClient = {
      chatCompletion: async ({ workflow }) => {
        if (workflow === 'CONDENSE_BEAT') {
          return '1. [Debu, Haren]: Debu demands the sluice gate be lifted for the evening tide.\n2. [Amba]: Pays three copper coins to secure passage.';
        }
        if (workflow === 'CONDENSE_BEAT_PROSE') {
          return '1. [Debu, Haren]: Haren inspected the rusted pins and refused passage.\n2. [Amba]: Intervened with three copper coins, forcing the gate open.';
        }
        if (workflow === 'UPDATE_STORY_SO_FAR') {
          return '1. [Debu, Amba]: Passed through the Hooghly sluice gate into the salt marshes.\n2. [Haren]: Recorded their transit in the toll registry.';
        }
        return 'Fallback';
      }
    };

    // 1. Save condensed beat plan
    await saveCondensedBeatPlan({
      chapterNum: 1,
      beatNum: 1,
      beatTitle: 'The Sluice Gate',
      planText: 'Full plan details here...',
      groqClient: mockClient,
      cwd: tmpDir
    });

    const plans = await getCondensedBeatPlans(1, tmpDir);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].num, 1);
    assert.ok(plans[0].text.includes('1. [Debu, Haren]: Debu demands the sluice gate be lifted'));

    // 2. Save condensed beat prose
    await saveCondensedBeatProse({
      chapterNum: 1,
      beatNum: 1,
      beatTitle: 'The Sluice Gate',
      proseText: 'Full prose text here...',
      groqClient: mockClient,
      cwd: tmpDir
    });

    const proses = await getCondensedBeatProse(1, tmpDir);
    assert.equal(proses.length, 1);
    assert.equal(proses[0].num, 1);
    assert.ok(proses[0].text.includes('1. [Debu, Haren]: Haren inspected the rusted pins'));

    // 3. Update story-so-far
    await updateStorySoFar({
      chapterNum: 1,
      chapterTitle: 'The Broken Sluice',
      summaryText: 'Summary text here...',
      groqClient: mockClient,
      cwd: tmpDir
    });

    const ssf = await loadStorySoFar(tmpDir);
    assert.ok(ssf.includes('Chapter 1 (The Broken Sluice):'));
    assert.ok(ssf.includes('1. [Debu, Amba]: Passed through the Hooghly sluice gate'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
