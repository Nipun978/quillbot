import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStoryBibleContext,
  buildHierarchyContext,
  INIT_OVERVIEW_SYSTEM_PROMPT,
  INIT_CHARACTERS_SYSTEM_PROMPT,
  INIT_LOCATIONS_SYSTEM_PROMPT,
  INIT_WORLD_LORE_SYSTEM_PROMPT,
  PLAN_SINGLE_BEAT_SYSTEM_PROMPT,
  CONDENSE_BEAT_PROSE_SYSTEM_PROMPT,
  CONDENSE_BEAT_PLAN_SYSTEM_PROMPT,
  UPDATE_STORY_SO_FAR_SYSTEM_PROMPT,
  GENERAL_QUERY_IMPROVISE_SYSTEM_PROMPT,
  BIBLE_QUERY_IMPROVISE_SYSTEM_PROMPT
} from '../src/llm/prompts.js';
import { buildInstructionsContent } from '../src/config/configManager.js';
import { chunkDocument } from '../src/rag/chunker.js';

test('Context Separation: Story Bible prompts enforce objective 3rd-person archival reference without first-person fiction', () => {
  // INIT_OVERVIEW must require objective 3rd-person and forbid 1st-person
  assert.ok(INIT_OVERVIEW_SYSTEM_PROMPT.includes('objective, third-person archival reference prose'));
  assert.ok(INIT_OVERVIEW_SYSTEM_PROMPT.includes("Do NOT write in first-person ('I', 'me', 'my')"));

  // Characters, Locations, Lore must mandate objective reference
  assert.ok(INIT_CHARACTERS_SYSTEM_PROMPT.includes('objective, third-person encyclopedic prose'));
  assert.ok(INIT_CHARACTERS_SYSTEM_PROMPT.includes("Do NOT write in first-person ('I')"));
  assert.ok(INIT_LOCATIONS_SYSTEM_PROMPT.includes('objective, third-person archival prose'));
  assert.ok(INIT_WORLD_LORE_SYSTEM_PROMPT.includes('objective, third-person archival prose'));
});

test('Context Separation: Beat planning and condensed files mandate objective 3rd-person character names', () => {
  // Beat planning must mandate objective 3rd-person
  assert.ok(PLAN_SINGLE_BEAT_SYSTEM_PROMPT.includes('objective third-person using character proper names'));
  assert.ok(PLAN_SINGLE_BEAT_SYSTEM_PROMPT.includes("Do NOT write in first-person ('I')"));

  // Beat prose condensation must strictly forbid 'I' and 'the narrator'
  assert.ok(CONDENSE_BEAT_PROSE_SYSTEM_PROMPT.includes('objective third-person using character proper names'));
  assert.ok(CONDENSE_BEAT_PROSE_SYSTEM_PROMPT.includes("NEVER use first-person ('I', 'me', 'my') or meta-narrator phrasing ('the narrator'"));

  // Beat plan and story-so-far condensation
  assert.ok(CONDENSE_BEAT_PLAN_SYSTEM_PROMPT.includes('objective third-person using character proper names'));
  assert.ok(UPDATE_STORY_SO_FAR_SYSTEM_PROMPT.includes('objective third-person using character proper names'));
});

test('Anti-Hallucination: Search query improviser forbids inventing chapters, scenes, or speculative causes', () => {
  assert.ok(GENERAL_QUERY_IMPROVISE_SYSTEM_PROMPT.includes('CRITICAL ANTI-HALLUCINATION RULE'));
  assert.ok(GENERAL_QUERY_IMPROVISE_SYSTEM_PROMPT.includes('Never invent, guess, or extrapolate chapter numbers'));
  assert.ok(GENERAL_QUERY_IMPROVISE_SYSTEM_PROMPT.includes('speculative plot causes'));

  assert.ok(BIBLE_QUERY_IMPROVISE_SYSTEM_PROMPT.includes('CRITICAL ANTI-HALLUCINATION RULE'));
  assert.ok(BIBLE_QUERY_IMPROVISE_SYSTEM_PROMPT.includes('Never invent, guess, or extrapolate unmentioned characters'));
});

test('POV & Tense Reconciliation: buildInstructionsContent reconciles Section 2 without contradictory rules', () => {
  // 1. Author specifies First-Person Present Tense
  const fpInstructions = buildInstructionsContent({
    projectTitle: 'Padmaghat',
    writingStyle: 'First-person close POV, present tense. Sensory-rich river prose.'
  });
  assert.ok(fpInstructions.includes('First-Person (matching Author Writing Style Preferences)'));
  assert.ok(fpInstructions.includes('Present Tense (consistent throughout)'));
  assert.equal(fpInstructions.includes('Default POV: Close Third-Person Limited'), false);
  assert.equal(fpInstructions.includes('Tense: Past Tense (consistent throughout)'), false);

  // 2. Author specifies Third-Person Past Tense or default
  const tpInstructions = buildInstructionsContent({
    projectTitle: 'Padmaghat',
    writingStyle: 'Third-person limited, atmospheric past tense.'
  });
  assert.ok(tpInstructions.includes('Close Third-Person Limited'));
  assert.ok(tpInstructions.includes('Past Tense (consistent throughout)'));
});

test('Formatting & RAG: chunkDocument and context builders strip standalone horizontal rules (---) and avoid double separators', () => {
  const markdownWithDividers = `# Locations
## The River
The river flows like a silver thread through Padmaghat.
---
## The Fisherman's Wharf
Driftwood and lanterns cover the wharf.
---
`;

  const chunks = chunkDocument({
    relativePath: 'story-bible/locations.md',
    content: markdownWithDividers
  });

  // Verify no chunk text ends with standalone ---
  for (const c of chunks) {
    assert.equal(/^\s*---\s*$/m.test(c.text), false, `Chunk ${c.title} contains standalone --- line`);
  }

  // Verify buildStoryBibleContext does not produce double --- separators
  const bibleContext = buildStoryBibleContext([
    { source_path: 'story-bible/locations.md', section_title: 'The River', text: 'River text here' },
    { source_path: 'story-bible/locations.md', section_title: 'Wharf', text: 'Wharf text here' }
  ]);
  assert.equal(/---\s*\r?\n\s*\r?\n\s*---/.test(bibleContext), false);
  assert.ok(bibleContext.includes('River text here'));
  assert.ok(bibleContext.includes('Wharf text here'));

  // Verify buildHierarchyContext does not produce double --- separators
  const hierContext = buildHierarchyContext({
    tier1Chunks: [
      { source_path: 'story-bible/characters.md', section_title: 'Debu', text: 'Debu profile' },
      { source_path: 'story-bible/characters.md', section_title: 'Padma', text: 'Padma profile' }
    ]
  });
  assert.equal(/---\s*\r?\n\s*\r?\n\s*---/.test(hierContext), false);
});

test('Grounding Integrity: chatBible enforces MANUSCRIPT GROUNDING RULE and deduplicates tier 2 summaries', async () => {
  const fs = await import('node:fs/promises');
  const chatBibleSrc = await fs.readFile('src/workflows/chatBible.js', 'utf8');

  // Verify manuscript grounding rule exists
  assert.ok(chatBibleSrc.includes('MANUSCRIPT GROUNDING RULE: You may ONLY state that a character, event, or object "appears in the written manuscript"'));
  assert.ok(chatBibleSrc.includes('If they are only mentioned in <story_bible_canon>, state explicitly that they exist in the planned Story Bible outline but have NOT YET appeared'));

  // Verify tier2 deduplication against loadWrittenProgressSummary
  assert.ok(chatBibleSrc.includes('isAlreadyInSummary'));
  assert.ok(chatBibleSrc.includes("endsWith('summary.md') || p.endsWith('story-so-far.md')"));
  assert.ok(chatBibleSrc.includes('seenTier2'));
  assert.ok(chatBibleSrc.includes('seenTier1'));
});

