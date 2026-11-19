import test from 'node:test';
import assert from 'node:assert/strict';
import { WRITE_BEAT_SYSTEM_PROMPT, CONTINUITY_CRITIC_SYSTEM_PROMPT } from '../src/llm/prompts.js';
import { runContinuityCritic } from '../src/workflows/writeChapter.js';

test('1. WRITE_BEAT_SYSTEM_PROMPT: Mandates literary scene dramatization over mechanical outline expansion', () => {
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /LITERARY SCENE DRAMATIZATION VS MECHANICAL OUTLINE EXPANSION/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /NOT a 1:1 mechanical line-by-line translation/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /Group related actions, spatial blocking, and dialogue exchanges into natural, breathing narrative paragraphs/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /DELIVERY CUES ARE SUBTEXT GUIDANCE, NEVER LITERAL TAG WORDS/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /STRICTLY FORBIDDEN: "Padma said personifying", "Debu said matter-of-fact"/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /NATURAL DIALOGUE CADENCE & ATTRIBUTION VARIETY/);
});

test('2. CONTINUITY_CRITIC_SYSTEM_PROMPT: Distinguishes novel prose from planning tags and forbids inverted syntax fixes', () => {
  assert.match(CONTINUITY_CRITIC_SYSTEM_PROMPT, /Spoken dialogue must be rendered as standard novel dialogue/);
  assert.match(CONTINUITY_CRITIC_SYSTEM_PROMPT, /Do NOT flag standard prose dialogue as a discrepancy/);
  assert.match(CONTINUITY_CRITIC_SYSTEM_PROMPT, /Flag awkward, robotic, or ungrammatical dialogue tags in prose \(e\.g\. "said personifying", "said matter-of-fact"/);
  assert.match(CONTINUITY_CRITIC_SYSTEM_PROMPT, /NEVER ask the author to replace standard novel dialogue with planning tag syntax/);
});

test('3. runContinuityCritic: Discards inverted small-model hallucinations suggesting inline plan tags in prose', async () => {
  const mockGroq = {
    async jsonCompletion() {
      return {
        checklist: {
          planFollowed: false,
          authorVisionMet: true,
          instructionsFollowed: true,
          grammarCorrect: true
        },
        passed: false,
        severity: 'major',
        issues: [
          {
            type: 'plan_discrepancy',
            category: 'plan_discrepancy',
            description: 'Dialogue tags are written as prose instead of inline plan tags, leaking planning syntax into the narrative.',
            quote: 'Padma said flatly, “You again.”',
            fixSuggestion: 'Replace all prose dialogue tags with the required inline format, e.g., Padma to Debu (flatly): "You again."'
          }
        ]
      };
    }
  };

  const prose = 'Debu stepped onto the ghat. "You again," Padma said.';
  const beat = {
    num: 1,
    title: 'Ghat meeting',
    beatOutline: 'Padma to Debu (flatly): "You again."'
  };

  const result = await runContinuityCritic({
    beatProse: prose,
    beat,
    groqClient: mockGroq
  });

  // The false-positive issue should be filtered out
  assert.equal(result.issues.length, 0, 'Inverted small-model hallucination should be filtered out');
  assert.equal(result.checklist.planFollowed, true, 'planFollowed should not be marked false by discarded hallucination');
  assert.equal(result.passed, true, 'Critic should pass when only inverted hallucination was returned');
});

test('4. runContinuityCritic: Deterministically flags robotic delivery cue tags in prose', async () => {
  const mockGroq = {
    async jsonCompletion() {
      return {
        checklist: {
          planFollowed: true,
          authorVisionMet: true,
          instructionsFollowed: true,
          grammarCorrect: true
        },
        passed: true,
        severity: 'none',
        issues: []
      };
    }
  };

  const proseWithRoboticCues = `
    Debu looked at the mud. Padma said matter-of-fact, "There."
    She looked at the river and said personifying, "She's tired."
  `;

  const beat = {
    num: 1,
    title: 'Ghat meeting',
    beatOutline: 'Padma to Debu (matter-of-fact): "There."\nPadma to Debu (personifying): "She\'s tired."'
  };

  const result = await runContinuityCritic({
    beatProse: proseWithRoboticCues,
    beat,
    groqClient: mockGroq
  });

  assert.equal(result.checklist.grammarCorrect, false, 'grammarCorrect should be marked false for robotic delivery tags');
  assert.ok(result.issues.length > 0, 'Robotic tag should be flagged as an issue');
  assert.equal(result.issues[0].category, 'grammar_spelling');
  assert.match(result.issues[0].description, /Robotic planning delivery cue leaked into dialogue tag/);
});
