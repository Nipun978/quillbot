import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBeatsFromPlan, getLastNWords } from '../src/workflows/writeChapter.js';
import { validatePlanFormat } from '../src/workflows/planChapter.js';
import { buildHierarchyContext } from '../src/llm/prompts.js';
import { completer, SLASH_COMMANDS } from '../src/ui/repl.js';

test('parseBeatsFromPlan extracts all beats and fields correctly', () => {
  const samplePlan = `# Chapter 1: The Gathering Shadows

## Chapter Summary
Jonathan prepares the mountain keep for the winter siege.

## Beats

### Beat 1: The Watchtower Warning
- **Characters:** Jonathan, Scout Rowan
- **Location:** North Watchtower
- **Action:** Rowan arrives exhausted with news of rider tracks in the valley.
- **Goal/Hook:** Jonathan orders the gates locked.

### Beat 2: Council in the Great Hall
- **Characters:** Jonathan, Eleanor, Captain Drake
- **Location:** Great Hall of Havenbrook
- **Action:** The council disputes whether to send riders or fortify.
- **Goal/Hook:** An eerie silence falls over the valley.`;

  const validation = validatePlanFormat(samplePlan);
  assert.equal(validation.valid, true);
  assert.equal(validation.beatCount, 2);

  const beats = parseBeatsFromPlan(samplePlan);
  assert.equal(beats.length, 2);

  assert.equal(beats[0].num, 1);
  assert.equal(beats[0].title, 'The Watchtower Warning');
  assert.equal(beats[0].characters, 'Jonathan, Scout Rowan');
  assert.equal(beats[0].location, 'North Watchtower');
  assert.equal(beats[0].action, 'Rowan arrives exhausted with news of rider tracks in the valley.');
  assert.equal(beats[0].goalHook, 'Jonathan orders the gates locked.');

  assert.equal(beats[1].num, 2);
  assert.equal(beats[1].title, 'Council in the Great Hall');
  assert.equal(beats[1].characters, 'Jonathan, Eleanor, Captain Drake');
  assert.equal(beats[1].location, 'Great Hall of Havenbrook');
});

test('getLastNWords returns exact tail words for continuity window', () => {
  const text = 'one two three four five six seven eight nine ten';
  assert.equal(getLastNWords(text, 5), 'six seven eight nine ten');
  assert.equal(getLastNWords(text, 15), 'one two three four five six seven eight nine ten');
  assert.equal(getLastNWords('', 5), '');
});

test('buildHierarchyContext outputs strict XML hierarchy', () => {
  const xml = buildHierarchyContext({
    instructions: 'Third person limited.',
    tier1Chunks: [{ source_path: 'story-bible/characters.md', text: 'Canon character info' }],
    tier2Chunks: [{ source_path: 'project/chapter-01/chapter.md', text: 'Past manuscript excerpt' }],
    pastChapterSummaries: 'Chapter 1 was intense.',
    tier3Chunks: [{ source_path: 'conversations/archive/session.md', text: 'Old brainstorm' }],
    rollingSummary: 'Discussion recap'
  });

  assert.match(xml, /<system_instructions>[\s\S]*Third person limited\.[\s\S]*<\/system_instructions>/);
  assert.match(xml, /<hierarchy_of_truth_rules>/);
  assert.match(xml, /<story_bible_canon>[\s\S]*Canon character info[\s\S]*<\/story_bible_canon>/);
  assert.match(xml, /<past_chapters>[\s\S]*Chapter 1 was intense[\s\S]*<\/past_chapters>/);
  assert.match(xml, /<past_conversations>[\s\S]*Discussion recap[\s\S]*<\/past_conversations>/);
});

test('completer autocompletes slash commands cleanly', () => {
  const [hits1, line1] = completer('/w');
  assert.deepEqual(hits1, ['/write']);
  assert.equal(line1, '/w');

  const [hits2, line2] = completer('/b');
  assert.deepEqual(hits2, ['/bible']);
  assert.equal(line2, '/b');

  const [allHits] = completer('/');
  assert.deepEqual(allHits, SLASH_COMMANDS);
});
