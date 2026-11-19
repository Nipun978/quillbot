import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseIssueIndices } from '../src/ui/reviewPrompt.js';
import { parseBeatsFromPlan, runContinuityCritic } from '../src/workflows/writeChapter.js';
import {
  WRITE_BEAT_SYSTEM_PROMPT,
  CONTINUITY_CRITIC_SYSTEM_PROMPT,
  PLAN_CHAPTER_SYSTEM_PROMPT,
  PLAN_SINGLE_BEAT_SYSTEM_PROMPT
} from '../src/llm/prompts.js';

test('1. Dialogue Tagging: parseBeatsFromPlan extracts simple "a to b (how): dialogue" tags', () => {
  const planMarkdown = `# Chapter 1: The Rising River

## Chapter Summary
Debu and Padma meet at the ghats.

## Chapter Instructions
Keep dialogue spare and observant.

## Beats

### Beat 1: River Encounter
- **Characters:** Debu, Padma
- **Setting:** Padma River ghats, dusk
- **Beat Outline:** Debu anchors his skiff. Padma stands near the steps.
Debu to Padma (lightly): "You again."
Padma to Debu (softly, with a faint smile): "The river is higher than yesterday."
Non-verbal / silent interaction: Debu nods and checks the mooring line.
Debu to Padma: "It will crest before dawn."
- **Author's Notes:** Ground their familiar bond.
- **Beat Instructions:** Subdued tone.
`;

  const beats = parseBeatsFromPlan(planMarkdown);
  assert.equal(beats.length, 1);
  const beat = beats[0];
  assert.equal(beat.dialogueTags.length, 3);

  // Tag 1: simple with cue
  assert.equal(beat.dialogueTags[0].speaker, 'Debu');
  assert.equal(beat.dialogueTags[0].listener, 'Padma');
  assert.equal(beat.dialogueTags[0].delivery, 'lightly');
  assert.equal(beat.dialogueTags[0].line, 'You again.');

  // Tag 2: simple with multi-word cue
  assert.equal(beat.dialogueTags[1].speaker, 'Padma');
  assert.equal(beat.dialogueTags[1].listener, 'Debu');
  assert.equal(beat.dialogueTags[1].delivery, 'softly, with a faint smile');
  assert.equal(beat.dialogueTags[1].line, 'The river is higher than yesterday.');

  // Tag 3: simple without cue
  assert.equal(beat.dialogueTags[2].speaker, 'Debu');
  assert.equal(beat.dialogueTags[2].listener, 'Padma');
  assert.equal(beat.dialogueTags[2].delivery, '');
  assert.equal(beat.dialogueTags[2].line, 'It will crest before dawn.');
});

test('2. Dialogue Tagging: parseBeatsFromPlan also preserves bracketed [a to b (how)]: "dialogue"', () => {
  const planMarkdown = `### Beat 1: Foggy Crossing
- **Characters:** Kael, Mara
- **Setting:** Bridge, dawn
- **Beat Outline:**
[Kael to Mara (wryly)]: "The toll is three coppers."
[Mara to Kael]: "I have two."
`;
  const beats = parseBeatsFromPlan(planMarkdown);
  assert.equal(beats.length, 1);
  assert.equal(beats[0].dialogueTags.length, 2);
  assert.equal(beats[0].dialogueTags[0].speaker, 'Kael');
  assert.equal(beats[0].dialogueTags[0].delivery, 'wryly');
  assert.equal(beats[0].dialogueTags[0].line, 'The toll is three coppers.');
  assert.equal(beats[0].dialogueTags[1].speaker, 'Mara');
  assert.equal(beats[0].dialogueTags[1].delivery, '');
  assert.equal(beats[0].dialogueTags[1].line, 'I have two.');
});

test('3. Critic Check: Continuity Critic catches both raw bracketed tags AND unbracketed dialogue planning tags in prose', async () => {
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
    num: 1,
    title: 'River Encounter',
    characters: 'Debu, Padma',
    setting: 'Padmaghat ghats',
    beatOutline: 'Debu to Padma (lightly): "You again."'
  };

  // Case A: Leaked unbracketed planning tag
  const leakedSimpleTagProse = `Debu stepped off the boat onto wet planking.\nDebu to Padma (lightly): "You again."\nPadma looked up from her net.`;
  const criticResSimple = await runContinuityCritic({
    beatProse: leakedSimpleTagProse,
    beat,
    groqClient: mockGroqPass
  });
  assert.equal(criticResSimple.passed, false);
  assert.equal(criticResSimple.checklist.planFollowed, false);
  assert.ok(criticResSimple.issues.some((i) => i.type === 'raw_dialogue_tags_leaked'));

  // Case B: Leaked bracketed planning tag
  const leakedBracketProse = `Debu stepped off the boat onto wet planking.\n[Debu to Padma (lightly)]: "You again."\nPadma looked up.`;
  const criticResBracket = await runContinuityCritic({
    beatProse: leakedBracketProse,
    beat,
    groqClient: mockGroqPass
  });
  assert.equal(criticResBracket.passed, false);
  assert.equal(criticResBracket.checklist.planFollowed, false);
  assert.ok(criticResBracket.issues.some((i) => i.type === 'raw_dialogue_tags_leaked'));

  // Case C: Clean literary prose passes without leak
  const cleanProse = `Debu stepped off the boat onto wet planking.\n"You again," Debu said lightly.\nPadma looked up from her net.`;
  const criticResClean = await runContinuityCritic({
    beatProse: cleanProse,
    beat,
    groqClient: mockGroqPass
  });
  assert.equal(criticResClean.passed, true);
  assert.equal(criticResClean.checklist.planFollowed, true);
});

test('4. Critic Selection: parseIssueIndices correctly parses diverse user input patterns', () => {
  const total = 6;

  // Defaults and "all"
  assert.deepEqual(parseIssueIndices('', total), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(parseIssueIndices('all', total), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(parseIssueIndices('ALL', total), [0, 1, 2, 3, 4, 5]);

  // Space-separated list: "1 2 6"
  assert.deepEqual(parseIssueIndices('1 2 6', total), [0, 1, 5]);

  // Comma-separated list: "1, 3, 5"
  assert.deepEqual(parseIssueIndices('1, 3, 5', total), [0, 2, 4]);

  // Mixed delimiters: "1, 2 4; 6"
  assert.deepEqual(parseIssueIndices('1, 2 4; 6', total), [0, 1, 3, 5]);

  // Range syntax: "1-4"
  assert.deepEqual(parseIssueIndices('1-4', total), [0, 1, 2, 3]);

  // Range and discrete: "1-3, 5"
  assert.deepEqual(parseIssueIndices('1-3, 5', total), [0, 1, 2, 4]);

  // Out of bounds filtering: "2 8 9" with total = 6 -> [1]
  assert.deepEqual(parseIssueIndices('2 8 9', total), [1]);

  // Invalid strings fallback to all
  assert.deepEqual(parseIssueIndices('gibberish', total), [0, 1, 2, 3, 4, 5]);
});

test('5. Prompt System Instructions: Prompts mandate simpler dialogue tagging and zero raw tags in prose', () => {
  assert.match(PLAN_CHAPTER_SYSTEM_PROMPT, /Speaker to Listener \(how\): "Verbatim line"/);
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /Speaker to Listener \(how\): "Verbatim line"/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /CRITICAL PROSE DIALOGUE RULE \(ZERO RAW PLANNING TAGS\)/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /raw planning tags \(e\.g\. Speaker to Listener \(how\): "Line"\)/);
  assert.match(CONTINUITY_CRITIC_SYSTEM_PROMPT, /RAW PLANNING TAG LEAKAGE/);
});

test('6. Two-step Planning Guidance: Merges events outline and author notes/instructions', () => {
  const events = 'Debu arrives at the ghats and discovers the river rose 3 cubits.';
  const notes = 'Keep tone somber. Debu has not slept in 2 days. Padma must seem guarded.';

  const combinedGuidance = [
    events ? `Beat Events & Plot Outline:\n${events}` : '',
    notes ? `Author's Notes & Beat Instructions:\n${notes}` : ''
  ].filter(Boolean).join('\n\n');

  assert.ok(combinedGuidance.includes('Beat Events & Plot Outline:'));
  assert.ok(combinedGuidance.includes('Debu arrives at the ghats'));
  assert.ok(combinedGuidance.includes("Author's Notes & Beat Instructions:"));
  assert.ok(combinedGuidance.includes('Keep tone somber'));
  assert.ok(combinedGuidance.includes('Padma must seem guarded'));
});

test('7. Post-Beat Planning Menu: planChapter source code verifies currentBeatNum >= 1 triggers options menu', async () => {
  const planChapterSource = await fs.readFile(path.join(process.cwd(), 'src/workflows/planChapter.js'), 'utf8');
  assert.match(planChapterSource, /if\s*\(currentBeatNum\s*>=\s*1\s*&&\s*process\.stdin\.isTTY\)/);
  assert.match(planChapterSource, /choices:\s*\[\s*\{\s*name:\s*`Plan Beat \$\{currentBeatNum \+ 1\}`/);
  assert.match(planChapterSource, /Start Writing Chapter/);
  assert.match(planChapterSource, /Finish Chapter/);
});
