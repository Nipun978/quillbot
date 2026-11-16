import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  getDefaultConfig,
  loadConfig,
  saveConfig,
  getCreativityTemperatures,
  getExecutionProfile,
  DEFAULT_INSTRUCTIONS,
  REASONING_LEVELS,
  INVARIANT_TEMPERATURES
} from '../src/config/configManager.js';
import {
  buildCreativityDirective,
  buildHierarchyContext,
  INIT_OVERVIEW_SYSTEM_PROMPT,
  INIT_CHARACTERS_SYSTEM_PROMPT,
  INIT_LOCATIONS_SYSTEM_PROMPT,
  INIT_WORLD_LORE_SYSTEM_PROMPT,
  PLAN_CHAPTER_HEADER_SYSTEM_PROMPT,
  PLAN_CHAPTER_SYSTEM_PROMPT,
  PLAN_SINGLE_BEAT_SYSTEM_PROMPT,
  WRITE_BEAT_SYSTEM_PROMPT,
  GENERATE_INIT_QUESTIONS_SYSTEM_PROMPT,
  GENERATE_BEAT_QUESTIONS_SYSTEM_PROMPT,
  CONDENSE_BEAT_PLAN_SYSTEM_PROMPT,
  CONDENSE_BEAT_PROSE_SYSTEM_PROMPT,
  CONDENSE_PLAN_SYSTEM_PROMPT,
  CONDENSE_PROSE_SYSTEM_PROMPT,
  CHAPTER_SUMMARY_SYSTEM_PROMPT,
  UPDATE_STORY_SO_FAR_SYSTEM_PROMPT,
  CONTINUITY_CRITIC_SYSTEM_PROMPT
} from '../src/llm/prompts.js';
import { parseBeatsFromPlan, parseBeatClarifications } from '../src/workflows/writeChapter.js';
import { VectorStore } from '../src/rag/vectorStore.js';

test('Permanent Fidelity: Invariant temperatures locked for deterministic zero-invention execution', () => {
  assert.equal(INVARIANT_TEMPERATURES.temperaturePlan, 0.1);
  assert.equal(INVARIANT_TEMPERATURES.temperatureWrite, 0.3);
  assert.equal(INVARIANT_TEMPERATURES.temperatureSummaries, 0.1);

  const temps = getCreativityTemperatures('off');
  assert.equal(temps.temperaturePlan, 0.1);
  assert.equal(temps.temperatureWrite, 0.3);
  assert.equal(temps.temperatureSummaries, 0.1);

  // Fallbacks also return invariant temperatures
  const anyLevel = getCreativityTemperatures('any_level');
  assert.equal(anyLevel.temperaturePlan, 0.1);
  assert.equal(anyLevel.temperatureWrite, 0.3);
});

test('Permanent Fidelity: buildCreativityDirective injects strict zero-extrapolation constraints', () => {
  const directive = buildCreativityDirective();
  assert.match(directive, /PERMANENT FIDELITY DIRECTIVE: STRICT FIDELITY MODE \(ZERO INVENTED DETAILS\)/);
  assert.match(directive, /ZERO EXTRAPOLATION/i);
  assert.match(directive, /NEVER alter the moral alignment/i);
  assert.match(directive, /NEVER invent unmentioned characters/i);
  assert.match(directive, /strictly factual and bare/i);
});

test('Dialogue Speaker Attribution & Integrity: Enforced in planning and writing system prompts', () => {
  // Single beat planning
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /STRICT DIALOGUE FIDELITY & PRESERVED SILENCE/);
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /preserve them VERBATIM in quotes/);
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /NEVER invent conversational filler, pleasantries, greetings/);
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /explicitly specify WHO is speaking to WHOM and why/);

  // Full chapter planning
  assert.match(PLAN_CHAPTER_SYSTEM_PROMPT, /STRICT DIALOGUE FIDELITY & PRESERVED SILENCE/);
  assert.match(PLAN_CHAPTER_SYSTEM_PROMPT, /preserve them VERBATIM in quotes/);
  assert.match(PLAN_CHAPTER_SYSTEM_PROMPT, /NEVER invent conversational filler, pleasantries, greetings/);

  // Beat writing prose prompt
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /1\. SUPREME PRECEDENCE OF AUTHOR'S NOTES & BEAT OUTLINE:/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /2\. BAN PURPLE PROSE & EXPLANATORY FILLER:/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /3\. STRICT DIALOGUE FIDELITY & PRESERVED SILENCE:/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /4\. AI STYLE HARMONIZATION:/);
  assert.match(WRITE_BEAT_SYSTEM_PROMPT, /unmistakable clarity regarding who is speaking/);
});

test('Reasoning Execution Profile: Gating, baseline medium for scenes, and 120B open questions profile', () => {
  assert.deepEqual(REASONING_LEVELS, ['low', 'medium', 'high']);

  // Free Tier - Scene planning/writing defaults to 'medium' baseline with 4096 tokens
  const freeProfile = getExecutionProfile('WRITE_BEAT', { apiTier: 'free', generation: { defaultReasoningEffort: 'low' } });
  assert.equal(freeProfile.reasoningEffort, 'medium');
  assert.equal(freeProfile.maxTokens, 4096);
  assert.equal(freeProfile.temperatureWrite, 0.3);

  // Free Tier attempting 'high' for scenes gets clamped to 'medium'
  const freeHighAttempt = getExecutionProfile('PLAN_BEAT', { apiTier: 'free', generation: { defaultReasoningEffort: 'high' } });
  assert.equal(freeHighAttempt.reasoningEffort, 'medium');
  assert.equal(freeHighAttempt.maxTokens, 4096);

  // Paid Tier can unlock 'high' reasoning for scenes
  const paidHigh = getExecutionProfile('WRITE_BEAT', { apiTier: 'paid', generation: { defaultReasoningEffort: 'high' } });
  assert.equal(paidHigh.reasoningEffort, 'high');
  assert.equal(paidHigh.maxTokens, 4096);

  // 120B Open Questions Workflows: ALWAYS run at 'high' reasoning with 3072 tokens for both Free and Paid
  const initQuestionsFree = getExecutionProfile('INIT_QUESTIONS', { apiTier: 'free' });
  assert.equal(initQuestionsFree.reasoningEffort, 'high');
  assert.equal(initQuestionsFree.maxTokens, 3072);

  const beatQuestionsPaid = getExecutionProfile('PLAN_BEAT_QUESTIONS', { apiTier: 'paid' });
  assert.equal(beatQuestionsPaid.reasoningEffort, 'high');
  assert.equal(beatQuestionsPaid.maxTokens, 3072);
});

test('Reasoning Config Persistence: Paid tier gating and auto-clamping on load', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-reasoning-test-'));
  try {
    const defaults = getDefaultConfig();
    assert.equal(defaults.generation.defaultReasoningEffort, 'medium');
    assert.equal(defaults.generation.temperaturePlan, 0.1);
    assert.equal(defaults.generation.temperatureWrite, 0.3);

    // Free tier: save with 'medium' -> stays 'medium'
    const medConfig = {
      ...defaults,
      apiTier: 'free',
      generation: { ...defaults.generation, defaultReasoningEffort: 'medium' }
    };
    await saveConfig(medConfig, tmpDir);
    const loadedMed = await loadConfig(tmpDir);
    assert.equal(loadedMed.generation.defaultReasoningEffort, 'medium');

    // Free tier: attempting 'high' auto-clamps to 'medium'
    const highFreeConfig = {
      ...defaults,
      apiTier: 'free',
      generation: { ...defaults.generation, defaultReasoningEffort: 'high' }
    };
    await saveConfig(highFreeConfig, tmpDir);
    const loadedHighFree = await loadConfig(tmpDir);
    assert.equal(loadedHighFree.generation.defaultReasoningEffort, 'medium');

    // Paid tier: 'high' is retained
    const highPaidConfig = {
      ...defaults,
      apiTier: 'paid',
      generation: { ...defaults.generation, defaultReasoningEffort: 'high' }
    };
    await saveConfig(highPaidConfig, tmpDir);
    const loadedHighPaid = await loadConfig(tmpDir);
    assert.equal(loadedHighPaid.generation.defaultReasoningEffort, 'high');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Open Questions & Clarifications: Prompt architecture and beat directives parser', () => {
  assert.match(GENERATE_INIT_QUESTIONS_SYSTEM_PROMPT, /RULES FOR QUESTIONS:/);
  assert.match(GENERATE_INIT_QUESTIONS_SYSTEM_PROMPT, /STRICTLY NO GENERIC QUESTIONS/);
  assert.match(GENERATE_INIT_QUESTIONS_SYSTEM_PROMPT, /3 to 5/);

  assert.match(GENERATE_BEAT_QUESTIONS_SYSTEM_PROMPT, /1 to 2 sharp, highly targeted clarifying questions PER BEAT/);
  assert.match(GENERATE_BEAT_QUESTIONS_SYSTEM_PROMPT, /SCENE MECHANICS & SPEAKER STAKES/);

  // Test parseBeatClarifications
  const samplePlanWithClarifications = `# Chapter 1: The Crossing

## Beats

### Beat 1: The Ferry Slip Negotiation
- **Characters:** Debu, Inspector
- **Location:** Padmaghat Pier
- **Action:** Debu pays the copper toll.
- **Goal/Hook:** Secure crossing rights.

### Beat 2: Encounter at the Bank
- **Characters:** Debu, Padma
- **Location:** Riverbank
- **Action:** Debu offers shelter.
- **Goal/Hook:** Establish rapport.

## Author Clarifications & Beat Directives

### Beat 1: The Ferry Slip Negotiation
- **Q1:** Does Debu mention the strike?
  **Answer:** No, Debu stays silent about the union dispute.
- **Q2:** What coin does he hand over?
  **Answer:** A tarnished 1942 anna piece.

### Beat 2: Encounter at the Bank
- **Q1:** Does Padma accept his umbrella?
  **Answer:** Yes, she takes it reluctantly.
`;

  const beat1Clarify = parseBeatClarifications(samplePlanWithClarifications, 1);
  assert.ok(beat1Clarify.includes('Debu stays silent about the union dispute'));
  assert.ok(beat1Clarify.includes('tarnished 1942 anna piece'));

  const beat2Clarify = parseBeatClarifications(samplePlanWithClarifications, 2);
  assert.ok(beat2Clarify.includes('Yes, she takes it reluctantly'));

  // Ensure parseBeatsFromPlan does not swallow the Author Clarifications section into Beat 2
  const beats = parseBeatsFromPlan(samplePlanWithClarifications);
  assert.equal(beats.length, 2);
  assert.doesNotMatch(beats[1].rawBlock, /Author Clarifications/);
});

test('LanceDB Self-Healing: Error detection and corruption recovery', async () => {
  const store = new VectorStore({}, process.cwd());
  assert.equal(typeof store._isCorruptError, 'function');

  // Verify corruption detection matches user error signature
  const userErr = new Error('LanceError(IO): Invalid format: magic number does not match, C:\\manifest.rs:57:13');
  assert.ok(store._isCorruptError(userErr));

  const formatErr = new Error('invalid format: corrupted manifest');
  assert.ok(store._isCorruptError(formatErr));

  const normalErr = new Error('Table not found');
  assert.ok(!store._isCorruptError(normalErr));
});

test('Minimalist Instructions: DEFAULT_INSTRUCTIONS is concise (< 75 words) and enforces precedence & zero hallucination', () => {
  const words = DEFAULT_INSTRUCTIONS.trim().split(/\s+/).filter(Boolean);
  assert.ok(words.length < 75, `DEFAULT_INSTRUCTIONS word count (${words.length}) must be < 75 words`);
  assert.match(DEFAULT_INSTRUCTIONS, /Precedence Hierarchy/i);
  assert.match(DEFAULT_INSTRUCTIONS, /Beat Instructions > Chapter Instructions > Global Style/i);
  assert.match(DEFAULT_INSTRUCTIONS, /Past Chapter Progress > Story Bible Lore/i);
  assert.match(DEFAULT_INSTRUCTIONS, /Zero Hallucination/i);
});

test('Truth Precedence: buildHierarchyContext places Past Chapters above Story Bible and documents precedence', () => {
  const xml = buildHierarchyContext({
    instructions: 'Close third-person.',
    tier1Chunks: [{ source_path: 'story-bible/characters.md', text: 'Baseline global character profile' }],
    tier2Chunks: [{ source_path: 'project/chapter-01/chapter.md', text: 'Specific past manuscript progression' }],
    pastChapterSummaries: 'Chapter 1: Debu left the wharf.'
  });

  const pastChapterIndex = xml.indexOf('<past_chapters>');
  const storyBibleIndex = xml.indexOf('<story_bible_canon>');
  assert.ok(pastChapterIndex < storyBibleIndex, '<past_chapters> must appear before <story_bible_canon> in prompt hierarchy');
  assert.match(xml, /Past Chapters & Progress \(Highest Precedence/i);
  assert.match(xml, /Story Bible Canon \(Global Baseline Lore/i);
  assert.match(xml, /Beat-Specific Instructions > Chapter-Level Instructions > Global Writing Style/i);
});

test('RAG Authority Multipliers: Past Chapters get 1.10x boost, Story Bible gets 1.05x boost', async () => {
  const store = new VectorStore({}, process.cwd());
  let capturedBoosts = null;
  // Mock table and hybridSearch execution
  store.table = {
    countRows: async () => 2,
    vectorSearch: () => ({ limit: () => ({ toArray: async () => [] }) }),
    search: () => ({ limit: () => ({ toArray: async () => [] }) })
  };

  // Inspect default authorityBoosts in method signature/invocation
  const fnStr = store.hybridSearch.toString();
  assert.ok(fnStr.includes('1: 1.05'), 'Story Bible tier 1 must have 1.05 boost');
  assert.ok(fnStr.includes('2: 1.10'), 'Past chapter tier 2 must have 1.10 boost');
  assert.ok(fnStr.includes('3: 0.95'), 'Notes tier 3 must have 0.95 boost');
});

test('Flexible Plot Overview: Discards 3-act academic structure in favor of chronological milestones', () => {
  // Prohibit rigid 3-act structure and academic essay themes
  assert.doesNotMatch(INIT_OVERVIEW_SYSTEM_PROMPT, /Act I, Act II, Act III/);
  assert.doesNotMatch(INIT_OVERVIEW_SYSTEM_PROMPT, /## 4\. Thematic Motifs & Core Resonance/);

  // Require clean, flexible chronological milestones and author fidelity
  assert.match(INIT_OVERVIEW_SYSTEM_PROMPT, /# Story Overview:/);
  assert.match(INIT_OVERVIEW_SYSTEM_PROMPT, /## 1\. Core Premise & Conflict/);
  assert.match(INIT_OVERVIEW_SYSTEM_PROMPT, /## 2\. Narrative Timeline & Chronological Milestones/);
  assert.match(INIT_OVERVIEW_SYSTEM_PROMPT, /## 3\. Key Factions, Social Rules & Dynamics/);
  assert.match(INIT_OVERVIEW_SYSTEM_PROMPT, /## 4\. Core Canon Constraints & Boundaries/);
  assert.match(INIT_OVERVIEW_SYSTEM_PROMPT, /DISCARD RIGID 3-ACT STRUCTURES & ACADEMIC ESSAYS/i);
});

test('Characters Prompt: Enforces strict author intent and forbids character morality inversion', () => {
  assert.match(INIT_CHARACTERS_SYSTEM_PROMPT, /NEVER INVERT OR DISTORT CHARACTER MORALITY/i);
  assert.match(INIT_CHARACTERS_SYSTEM_PROMPT, /STRICT ADHERENCE TO AUTHOR INTENT/i);
  assert.match(INIT_CHARACTERS_SYSTEM_PROMPT, /GROUNDED PHYSICAL SPECIFICS/i);
  assert.match(INIT_CHARACTERS_SYSTEM_PROMPT, /Do NOT turn an innocent, naive, or tragic character into a calculating villain/i);
});

test('Locations and Lore: Technical architectural references rather than purple prose', () => {
  assert.match(INIT_LOCATIONS_SYSTEM_PROMPT, /TECHNICAL SETTING REFERENCE, NOT PURPLE PROSE/i);
  assert.match(INIT_LOCATIONS_SYSTEM_PROMPT, /Layout & Landmarks/i);
  assert.match(INIT_WORLD_LORE_SYSTEM_PROMPT, /TECHNICAL REFERENCE, NOT PURPLE PROSE/i);
});

test('Chapter & Beat Planning: Enforces streamlined blueprint, author notes, and dialogue fidelity', () => {
  // Single beat planning rules
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /STREAMLINED BEAT BLUEPRINT/i);
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /DETERMINISTIC BEAT OUTLINE/i);
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /AUTHOR'S NOTES/i);
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /NO SCREENPLAY JARGON OR CAMERA ANGLES/i);
  assert.match(PLAN_SINGLE_BEAT_SYSTEM_PROMPT, /NO ACADEMIC OBSTACLE ESSAYS/i);

  // Full chapter planning rules
  assert.match(PLAN_CHAPTER_SYSTEM_PROMPT, /STREAMLINED BEAT BLUEPRINT/i);
  assert.match(PLAN_CHAPTER_SYSTEM_PROMPT, /DETERMINISTIC BEAT OUTLINE/i);
  assert.match(PLAN_CHAPTER_HEADER_SYSTEM_PROMPT, /AUTHOR-FAITHFUL SUMMARY/i);

  // 1. Verify parser handles new streamlined beat format (Author's Notes & Beat Outline)
  const streamlinedPlan = `# Chapter 1: The River's Quiet

## Chapter Summary
Debu meets Padma at the ghats.

## Chapter Instructions
Restrained tone, quiet pacing.

## Beats

### Beat 1: Routine at Dawn
- **Characters:** Debu, Jameel, Amba
- **Setting:** Padmaghat Ghats, Dawn
- **Beat Outline:** Debu wakes up. Walks out to work. Rents a boat from Jameel. Catches 6 fish. Gives 2 to Jameel as rent. Exchanges 2 for rice. Brings back 2 home. Amba makes Fish Curry.
- **Author's Notes:** Ground Debu's daily economic struggle without melodrama.
- **Beat Instructions:** Plain, unadorned pacing.

### Beat 2: Encounter
- **Characters:** Debu, Padma
- **Setting:** Stone Ghats, Morning
- **Beat Outline:** The next day, when Debu was pulling his nets, his eyes met Padma. She was sitting. Washing her hands. Looking at the water slipping through. He pulled the boat on the shore. Padma was still there. No one had ever seen her before in the village. No words are spoken.
- **Author's Notes:** Pure non-verbal encounter. Build curiosity through eye contact and the quiet movement of water.
- **Beat Instructions:** Slow tempo, heavy silence.

### Beat 3: Curiosity
- **Characters:** Debu, Padma
- **Setting:** Shore Slipway, Evening
- **Beat Outline:** Padma approaches him: "Can I have one fish." She picks the smallest one and frees it up in the river. Debu asks: "Why did you do this?" Padma answers: "It wanted to live." Debu: "But it's food." Padma: "You people just take from the river."
- **Author's Notes:** Establish Padma's reverence for river life against Debu's pragmatic survival.
- **Beat Instructions:** Taut dialogue with pauses.`;

  const beats = parseBeatsFromPlan(streamlinedPlan);
  assert.equal(beats.length, 3);
  assert.equal(beats[0].num, 1);
  assert.equal(beats[0].title, 'Routine at Dawn');
  assert.equal(beats[0].setting, 'Padmaghat Ghats, Dawn');
  assert.ok(beats[0].beatOutline.includes('Debu wakes up'));
  assert.ok(beats[0].authorNotes.includes("Ground Debu's daily economic struggle"));
  assert.ok(beats[0].instructions.includes('Plain, unadorned pacing'));

  assert.equal(beats[1].num, 2);
  assert.equal(beats[1].title, 'Encounter');
  assert.ok(beats[1].beatOutline.includes('No words are spoken'));
  assert.ok(beats[1].authorNotes.includes('Pure non-verbal encounter'));

  assert.equal(beats[2].num, 3);
  assert.ok(beats[2].beatOutline.includes('Can I have one fish'));

  // 2. Verify backward compatibility with legacy plans (Action & Goal/Hook)
  const legacyPlan = `### Beat 1: The Ferry Slip Negotiation
- **Characters:** Debu, Ferry Inspector
- **Location:** Padmaghat Ferry Pier
- **Action:** Debu arrives before dawn with the repaired net.
- **Goal/Hook:** Secure crossing rights.
- **Instructions:** Emphasize cold iron scales.`;

  const legacyBeats = parseBeatsFromPlan(legacyPlan);
  assert.equal(legacyBeats.length, 1);
  assert.equal(legacyBeats[0].action, 'Debu arrives before dawn with the repaired net.');
  assert.equal(legacyBeats[0].goalHook, 'Secure crossing rights.');
  assert.equal(legacyBeats[0].location, 'Padmaghat Ferry Pier');
});

test('Summaries & Condensing: Ban purple prose and enforce high-density factual reporting', () => {
  assert.match(CONDENSE_BEAT_PLAN_SYSTEM_PROMPT, /BAN PURPLE PROSE AND LITERARY FLUFF/i);
  assert.match(CONDENSE_BEAT_PROSE_SYSTEM_PROMPT, /BAN PURPLE PROSE/i);
  assert.match(CONDENSE_PLAN_SYSTEM_PROMPT, /BAN AI SLOP & PURPLE PROSE/i);
  assert.match(CONDENSE_PROSE_SYSTEM_PROMPT, /BAN DECORATIVE FLUFF/i);
  assert.match(CHAPTER_SUMMARY_SYSTEM_PROMPT, /ANTI-SLOP & FIDELITY RULES/i);
  assert.match(CHAPTER_SUMMARY_SYSTEM_PROMPT, /Do NOT write purple atmospheric prose/i);
  assert.match(UPDATE_STORY_SO_FAR_SYSTEM_PROMPT, /BAN PURPLE PROSE & STATIC ROUTINES/i);
});

test('Continuity Critic: Flags repetitive scene stalling and character alignment contradictions', () => {
  assert.match(CONTINUITY_CRITIC_SYSTEM_PROMPT, /scene_stalling/);
  assert.match(CONTINUITY_CRITIC_SYSTEM_PROMPT, /NARRATIVE PROGRESSION & ANTI-STALLING/i);
  assert.match(CONTINUITY_CRITIC_SYSTEM_PROMPT, /repeating identical morning\/scenic routines/i);
});

