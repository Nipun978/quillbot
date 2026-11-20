import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANNING_CREATIVITY_TIERS,
  PLANNING_CREATIVITY_LEVELS,
  resolvePlanningTemperature,
  getExecutionProfile,
  getDefaultConfig,
  loadConfig
} from '../src/config/configManager.js';
import {
  buildPlanningCreativityDirective,
  buildCreativityDirective,
  PLAN_CHAPTER_SYSTEM_PROMPT,
  PLAN_SINGLE_BEAT_SYSTEM_PROMPT,
  WRITE_BEAT_SYSTEM_PROMPT,
  CONTINUITY_CRITIC_SYSTEM_PROMPT
} from '../src/llm/prompts.js';
import { parseBeatsFromPlan, runContinuityCritic } from '../src/workflows/writeChapter.js';

test('1. Planning Creativity Tiers: Schema, levels, and temperature resolution (0.1 to 0.9)', () => {
  assert.deepEqual(PLANNING_CREATIVITY_LEVELS, ['off', 'low', 'balanced', 'expressive', 'highly expressive']);

  assert.equal(resolvePlanningTemperature('off'), 0.1);
  assert.equal(resolvePlanningTemperature('low'), 0.3);
  assert.equal(resolvePlanningTemperature('balanced'), 0.5);
  assert.equal(resolvePlanningTemperature('expressive'), 0.7);
  assert.equal(resolvePlanningTemperature('highly expressive'), 0.9);

  // Case-insensitive and whitespace handling
  assert.equal(resolvePlanningTemperature('  BALANCED  '), 0.5);
  assert.equal(resolvePlanningTemperature('EXPRESSIVE'), 0.7);
  assert.equal(resolvePlanningTemperature('unknown_level'), 0.5);

  // Verify labels
  assert.ok(PLANNING_CREATIVITY_TIERS.balanced.label.includes('Recommended'));
  assert.ok(PLANNING_CREATIVITY_TIERS.off.label.includes('Literal'));
});

test('2. getExecutionProfile resolves planning temperature dynamically while keeping write temperature at 0.3', () => {
  // Free tier user with 'balanced' planning creativity
  const freeBalanced = getExecutionProfile('PLAN_BEAT', {
    apiTier: 'free',
    generation: { planningCreativity: 'balanced' }
  });
  assert.equal(freeBalanced.temperaturePlan, 0.5);
  assert.equal(freeBalanced.temperatureWrite, 0.3);

  // Free tier user with 'highly expressive' (accessible to all users)
  const freeExpressive = getExecutionProfile('PLAN_BEAT', {
    apiTier: 'free',
    generation: { planningCreativity: 'highly expressive' }
  });
  assert.equal(freeExpressive.temperaturePlan, 0.9);

  // Explicit override passed to getExecutionProfile
  const overridden = getExecutionProfile('PLAN_CHAPTER', {
    apiTier: 'free',
    generation: { planningCreativity: 'low' }
  }, 'expressive');
  assert.equal(overridden.temperaturePlan, 0.7);

  // Writing workflow: temperatureWrite is ALWAYS 0.3 and does not take planning creativity
  const writeProfile = getExecutionProfile('WRITE_BEAT', {
    apiTier: 'free',
    generation: { planningCreativity: 'highly expressive' }
  });
  assert.equal(writeProfile.temperatureWrite, 0.3);
});

test('3. buildPlanningCreativityDirective guides purposeful sensory grounding and forbids unprompted hallucinations', () => {
  const balancedDirective = buildPlanningCreativityDirective('balanced');
  assert.match(balancedDirective, /PURPOSEFUL ENRICHMENT DIRECTIVE/i);
  assert.match(balancedDirective, /subtle, evocative sensory micro-details/i);
  assert.match(balancedDirective, /ZERO PLOT & CHARACTER HALLUCINATION/i);
  assert.match(balancedDirective, /PURPOSEFUL SENSORY DETAILS ONLY/i);
  assert.match(balancedDirective, /structured in sequential numbered points \(1\., 2\., 3\.\.\.\)/i);

  const offDirective = buildPlanningCreativityDirective('off');
  assert.match(offDirective, /Strict \/ Literal Execution/i);
  assert.match(offDirective, /Zero embellishment/i);

  const expressiveDirective = buildPlanningCreativityDirective('expressive');
  assert.match(expressiveDirective, /Rich Atmospheric Cadence/i);

  const highlyExpressiveDirective = buildPlanningCreativityDirective('highly expressive');
  assert.match(highlyExpressiveDirective, /Vivid Atmospheric & Sensory Immersion/i);
});

test('4. buildCreativityDirective enforces strict plan-bound prose and bans ungrounded physical inventions', () => {
  const writingDirective = buildCreativityDirective('off');
  assert.match(writingDirective, /STRICT PLAN-BOUND PROSE/i);
  assert.match(writingDirective, /approved beat plan already contains all intended creative, sensory, and physical anchors/i);
  assert.match(writingDirective, /Do NOT hallucinate new physical props, unprompted characters, unmentioned locations, or ungrounded physical actions/i);
  assert.match(writingDirective, /Beat-Specific Instructions & Author's Notes > Chapter-Level Instructions > Global Writing Style/);
});

test('5. Prompts enforce sequential numbered Beat Outlines and strict plan fidelity', () => {
  // Plan Chapter & Plan Single Beat
  assert.match(PLAN_CHAPTER_SYSTEM_PROMPT, /DETERMINISTIC BEAT OUTLINE \(SEQUENTIAL NUMBERED STEPS & PURPOSEFUL CREATIVITY\)/);
  assert.match(PLAN_CHAPTER_SYSTEM_PROMPT, /structured as sequential numbered steps \(1\., 2\., 3\.\.\.\)/);
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /DETERMINISTIC BEAT OUTLINE \(SEQUENTIAL NUMBERED STEPS & PURPOSEFUL CREATIVITY\)/);
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /structured as sequential numbered steps \(1\., 2\., 3\.\.\.\)/);

  // Write Beat
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /execute EVERY numbered step of the Beat Outline in sequence/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /Do NOT hallucinate ANY physical or sensory details not rooted in the approved beat plan/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /NEVER manufacture AI-invented props, actions, or secondary characters, unmentioned room furnishings/);

  // Continuity Critic
  assert.match(CONTINUITY_CRITIC_SYSTEM_PROMPT, /UNGROUNDED PHYSICAL & SENSORY INVENTIONS/);
  assert.match(CONTINUITY_CRITIC_SYSTEM_PROMPT, /ungrounded_physical_invention/);
  assert.match(CONTINUITY_CRITIC_SYSTEM_PROMPT, /Natural prose connective tissue/);
});

test('6. parseBeatsFromPlan extracts sequential numbered outline steps and dialogue tags', () => {
  const planMarkdown = `# Chapter 1: The Ferry Crossing

## Chapter Summary
Debu meets Padma at the ferry crossing at dawn.

## Beats

### Beat 1: The Riverbank Meeting
- **Characters:** Debu, Padma
- **Setting:** Padmaghat Ferry Pier, early morning mist
- **Beat Outline:**
1. Debu drags his cedar-ribbed skiff onto the wet gravel, the river fog smelling faintly of river silt and cold rain.
2. Debu to Padma (lightly): "You again."
3. Padma wipes river damp from her palms against her cotton sari and steps onto the wooden plank.
4. Padma to Debu (softly, with a faint smile): "The river is higher than yesterday."
5. Non-verbal / silent interaction: Debu secures the mooring rope around the banyan root without answering immediately.
- **Author's Notes:** Ground their quiet familiarity; unspoken economic anxiety.
- **Beat Instructions:** Spare, evocative prose; focus on river chill and timber textures.
`;

  const beats = parseBeatsFromPlan(planMarkdown);
  assert.equal(beats.length, 1);
  const beat = beats[0];
  assert.equal(beat.num, 1);
  assert.equal(beat.title, 'The Riverbank Meeting');
  assert.equal(beat.characters, 'Debu, Padma');
  assert.equal(beat.setting, 'Padmaghat Ferry Pier, early morning mist');

  // Verify extracted dialogue tags
  assert.equal(beat.dialogueTags.length, 2);
  assert.equal(beat.dialogueTags[0].speaker, 'Debu');
  assert.equal(beat.dialogueTags[0].line, 'You again.');
  assert.equal(beat.dialogueTags[1].speaker, 'Padma');
  assert.equal(beat.dialogueTags[1].line, 'The river is higher than yesterday.');

  // Verify extracted outline steps
  assert.ok(Array.isArray(beat.outlineSteps));
  assert.equal(beat.outlineSteps.length, 5);
  assert.equal(beat.outlineSteps[0].stepNum, 1);
  assert.ok(beat.outlineSteps[0].text.includes('cedar-ribbed skiff'));
  assert.equal(beat.outlineSteps[4].stepNum, 5);
  assert.ok(beat.outlineSteps[4].text.includes('Non-verbal / silent interaction'));
});

test('7. runContinuityCritic flags ungrounded physical inventions and updates checklist', async () => {
  const mockCriticWithInvention = {
    jsonCompletion: async () => ({
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
          type: 'ungrounded_physical_invention',
          category: 'plan_discrepancy',
          description: 'Drafted prose introduces an invented brass telescope not specified in the beat plan or Story Bible.',
          quote: 'Debu pulled an ornate brass telescope from his leather satchel.',
          fixSuggestion: 'Remove the invented telescope and stick to the skiff mooring actions specified in the plan.'
        }
      ]
    })
  };

  const beat = {
    num: 1,
    title: 'The Riverbank Meeting',
    characters: 'Debu, Padma',
    setting: 'Padmaghat Ferry Pier',
    beatOutline: '1. Debu drags skiff.\n2. Debu to Padma: "You again."'
  };

  const prose = 'Debu pulled an ornate brass telescope from his leather satchel and looked out.';
  const criticResult = await runContinuityCritic({
    beatProse: prose,
    beat,
    groqClient: mockCriticWithInvention,
    sessionId: 'test_critic_invention'
  });

  assert.equal(criticResult.passed, false);
  assert.equal(criticResult.checklist.planFollowed, false);
  assert.equal(criticResult.issues.length, 1);
  assert.equal(criticResult.issues[0].type, 'ungrounded_physical_invention');
  assert.ok(criticResult.issues[0].description.includes('brass telescope'));
});
