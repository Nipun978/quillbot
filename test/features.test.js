import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConversationManager } from '../src/workflows/conversationMgr.js';
import { logLlmPayload, logConversationEvent, getConversationLogPath } from '../src/config/logger.js';
import { parseBeatsFromPlan } from '../src/workflows/writeChapter.js';
import { buildInstructionsContent, getDefaultConfig } from '../src/config/configManager.js';
import { SLASH_COMMANDS, completer } from '../src/ui/repl.js';

test('logger logs LLM payload and conversation events to logs/conversations.log', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-logger-'));
  try {
    await logLlmPayload({
      cwd: tmpDir,
      sessionId: 'conv_test_123',
      workflow: 'TEST_PROMPT',
      model: 'openai/gpt-oss-120b',
      temperature: 0.7,
      maxTokens: 1024,
      messages: [
        { role: 'system', content: 'You are a writing assistant.' },
        { role: 'user', content: 'Write about the forest.' }
      ],
      response: 'The pines creaked beneath the gathering storm.'
    });

    await logConversationEvent({
      cwd: tmpDir,
      sessionId: 'conv_test_123',
      eventType: 'TEST_EVENT',
      details: { note: 'Testing log output' }
    });

    const logPath = getConversationLogPath(tmpDir);
    const content = await fs.readFile(logPath, 'utf8');

    assert.ok(content.includes('WORKFLOW: TEST_PROMPT'));
    assert.ok(content.includes('conv_test_123'));
    assert.ok(content.includes('openai/gpt-oss-120b'));
    assert.ok(content.includes('You are a writing assistant.'));
    assert.ok(content.includes('Write about the forest.'));
    assert.ok(content.includes('The pines creaked beneath the gathering storm.'));
    assert.ok(content.includes('EVENT: TEST_EVENT'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('ConversationManager auto-archives current.json and resets to empty session when starting new conversation', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-conv-'));
  try {
    const fakeGroq = {
      chatCompletion: async () => 'compressed summary'
    };
    const config = { generation: { slidingChatWindowTurns: 8 } };
    const mgr = new ConversationManager({ cwd: tmpDir, groqClient: fakeGroq, config });
    await mgr.init();

    // Add some turns to current.json
    await mgr.addTurn('user', 'What happened in the watchtower?');
    await mgr.addTurn('assistant', 'Rowan reported rider tracks in the snow.');

    assert.equal(mgr.current.turns.length, 2);
    assert.equal(mgr.hasUnarchivedContent(), true);

    // Call startNewSession() without having explicitly archived
    const freshSession = await mgr.startNewSession();

    // Verify current.json is now emptied
    assert.equal(freshSession.turns.length, 0);
    assert.equal(freshSession.rollingSummary, '');
    assert.equal(mgr.hasUnarchivedContent(), false);

    // Verify current.json on disk is also empty session
    const currentOnDisk = JSON.parse(await fs.readFile(path.join(tmpDir, 'conversations', 'current.json'), 'utf8'));
    assert.equal(currentOnDisk.turns.length, 0);
    assert.equal(currentOnDisk.id, freshSession.id);

    // Verify archive folder contains the previous session json and md
    const archiveFiles = await fs.readdir(path.join(tmpDir, 'conversations', 'archive'));
    const jsonArchives = archiveFiles.filter((f) => f.endsWith('.json'));
    const mdArchives = archiveFiles.filter((f) => f.endsWith('.md'));

    assert.equal(jsonArchives.length, 1);
    assert.equal(mdArchives.length, 1);

    const archivedContent = JSON.parse(await fs.readFile(path.join(tmpDir, 'conversations', 'archive', jsonArchives[0]), 'utf8'));
    assert.equal(archivedContent.turns.length, 2);
    assert.equal(archivedContent.turns[0].content, 'What happened in the watchtower?');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('ConversationManager archiveCurrentAndReset explicitly archives and empties current', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-conv2-'));
  try {
    const fakeGroq = { chatCompletion: async () => '' };
    const config = { generation: { slidingChatWindowTurns: 8 } };
    const mgr = new ConversationManager({ cwd: tmpDir, groqClient: fakeGroq, config });
    await mgr.init();

    await mgr.addTurn('user', 'Plan beat 1');
    const res = await mgr.archiveCurrentAndReset();
    assert.equal(res, true);

    assert.equal(mgr.current.turns.length, 0);
    assert.equal(mgr.hasUnarchivedContent(), false);

    const archiveFiles = await fs.readdir(path.join(tmpDir, 'conversations', 'archive'));
    assert.equal(archiveFiles.filter((f) => f.endsWith('.json')).length, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('parseBeatsFromPlan parses multi-paragraph Action and Goal/Hook correctly without tables', () => {
  const paragraphPlan = `# Chapter 1: The Gathering Shadows

## Chapter Summary
Jonathan prepares the mountain keep for the winter siege as ominous signs mount in the valley.

## Beats

### Beat 1: The Watchtower Warning
- **Characters:** Jonathan, Scout Rowan
- **Location:** North Watchtower
- **Action:** Rowan arrives exhausted with news of rider tracks in the valley.
The frost has begun to bite into the stones of the parapet, and the wind carries the smell of smoke from the distant foothills. Jonathan inspects the frozen tracks himself.
- **Goal/Hook:** Jonathan orders the gates locked and bells sounded across the keep.
The garrison stirs into motion as dusk falls.

### Beat 2: Council in the Great Hall
- **Characters:** Jonathan, Eleanor, Captain Drake
- **Location:** Great Hall of Havenbrook
- **Action:** The council disputes whether to send riders or fortify the inner courtyard. Eleanor advocates sending word to the capital.
- **Goal/Hook:** An eerie silence falls over the valley, interrupted by a horn blast.`;

  const beats = parseBeatsFromPlan(paragraphPlan);
  assert.equal(beats.length, 2);
  assert.equal(beats[0].num, 1);
  assert.equal(beats[0].title, 'The Watchtower Warning');
  assert.ok(beats[0].action.includes('Rowan arrives exhausted with news of rider tracks in the valley.'));
  assert.ok(beats[0].action.includes('The frost has begun to bite into the stones of the parapet'));
  assert.ok(beats[0].goalHook.includes('The garrison stirs into motion as dusk falls.'));

  assert.equal(beats[1].num, 2);
  assert.ok(beats[1].action.includes('Eleanor advocates sending word to the capital.'));
});

test('configManager supports projectTitle and writingStyle in config and instructions', () => {
  const defaults = getDefaultConfig();
  assert.equal(typeof defaults.projectTitle, 'string');
  assert.equal(typeof defaults.writingStyle, 'string');

  const customInstr = buildInstructionsContent({
    projectTitle: 'Shadows of Havenbrook',
    writingStyle: 'First-person, noir tone, cynical humor',
    enhancedWritingStyle: '1. Narrative Point of View & Distance: Deep first-person with heavy cynical interiority filter.'
  });

  assert.ok(customInstr.includes('# Shadows of Havenbrook — Literary Prose & Pacing Instructions'));
  assert.ok(customInstr.includes('## Author Writing Style Preferences & Enhanced Prose Guide'));
  assert.ok(customInstr.includes('Deep first-person with heavy cynical interiority filter.'));
  assert.ok(customInstr.includes('First-person, noir tone, cynical humor'));
});

test('repl resolveCommandArguments directly resolves /bible without prompting lore query', async () => {
  const { resolveCommandArguments } = await import('../src/ui/repl.js');
  const res = await resolveCommandArguments('/bible', process.cwd());
  assert.equal(res, '/bible');
});

test('repl SLASH_COMMANDS includes /archive and autocompletes', () => {
  assert.ok(SLASH_COMMANDS.includes('/archive'));
  const [hits] = completer('/arc');
  assert.deepEqual(hits, ['/archive']);
});

test('createBackup creates timestamped backup in .quillbot/backups/', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-backup-'));
  try {
    const testFile = path.join(tmpDir, 'test.md');
    await fs.writeFile(testFile, 'Original canon text', 'utf8');

    const { createBackup } = await import('../src/config/backupManager.js');
    const backupPath = await createBackup(testFile, tmpDir);

    assert.ok(backupPath);
    const backupContent = await fs.readFile(backupPath, 'utf8');
    assert.equal(backupContent, 'Original canon text');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('commitBeatToChapter preserves earlier beats and allows non-destructive revisions', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-test-chapter-'));
  try {
    const { commitBeatToChapter } = await import('../src/workflows/writeChapter.js');
    const chapterDir = path.join(tmpDir, 'project', 'chapter-01');
    const chapterFile = path.join(chapterDir, 'chapter.md');

    // 1. Commit Beat 1
    await commitBeatToChapter({
      chapterFile,
      chapterDir,
      beatNum: 1,
      finalProse: 'Jonathan climbs to the north parapet through the howling wind.',
      cwd: tmpDir
    });

    let content = await fs.readFile(chapterFile, 'utf8');
    assert.ok(content.includes('<!-- BEAT 1 -->'));
    assert.ok(content.includes('Jonathan climbs to the north parapet'));

    // 2. Commit Beat 2: verify Beat 1 is completely preserved and untouched
    await commitBeatToChapter({
      chapterFile,
      chapterDir,
      beatNum: 2,
      finalProse: 'Rowan unrolls the grease-stained map on the council table.',
      cwd: tmpDir
    });

    content = await fs.readFile(chapterFile, 'utf8');
    assert.ok(content.includes('<!-- BEAT 1 -->'));
    assert.ok(content.includes('Jonathan climbs to the north parapet'));
    assert.ok(content.includes('<!-- BEAT 2 -->'));
    assert.ok(content.includes('Rowan unrolls the grease-stained map'));

    // 3. Re-commit revised Beat 1: verify ONLY Beat 1 is replaced, and Beat 2 is completely preserved!
    await commitBeatToChapter({
      chapterFile,
      chapterDir,
      beatNum: 1,
      finalProse: 'Jonathan stands vigilant on the icy parapet, watching the valley.',
      cwd: tmpDir
    });

    content = await fs.readFile(chapterFile, 'utf8');
    // Beat 1 should have new prose
    assert.ok(content.includes('Jonathan stands vigilant on the icy parapet'));
    // Old Beat 1 text should not be duplicated
    assert.equal(content.includes('Jonathan climbs to the north parapet'), false);
    // Beat 2 MUST still be intact
    assert.ok(content.includes('<!-- BEAT 2 -->'));
    assert.ok(content.includes('Rowan unrolls the grease-stained map'));

    // Verify backups were generated
    const backupDir = path.join(tmpDir, '.quillbot', 'backups');
    const backups = await fs.readdir(backupDir);
    assert.ok(backups.length >= 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

