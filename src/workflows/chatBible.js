import fs from 'node:fs/promises';
import path from 'node:path';
import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  QUERY_REWRITE_SYSTEM_PROMPT,
  BIBLE_SAVE_EXTRACT_SYSTEM_PROMPT,
  CREATE_BIBLE_FILE_SYSTEM_PROMPT,
  EDIT_BIBLE_FILE_SYSTEM_PROMPT,
  buildHierarchyContext
} from '../llm/prompts.js';
import { loadInstructions } from '../config/configManager.js';
import { createBackup } from '../config/backupManager.js';
import { createSpinner, printMarkdown } from '../ui/renderer.js';
import { promptReviewWorkflow, openInEditor } from '../ui/reviewPrompt.js';
import { syncAllFiles } from '../rag/fileSync.js';

export async function runBibleQuery({
  query,
  cwd = process.cwd(),
  groqClient,
  vectorStore,
  embedder,
  reranker,
  conversationMgr,
  config
}) {
  const trimmed = (query || '').trim();

  // If /bible is called without arguments, show an interactive submenu
  if (!trimmed) {
    const action = await select({
      message: 'Story Bible Actions:',
      choices: [
        { name: '📖 Consult Story Bible (Ask a question or inquire about lore)', value: 'consult' },
        { name: '➕ Create a new Story Bible file (e.g. magic-system.md, factions.md)', value: 'create' },
        { name: '✏️  Edit an existing Story Bible file (safely update without ruining lore)', value: 'edit' },
        { name: '📋 List all Story Bible files and word counts', value: 'list' },
        { name: '💾 Save lore decisions from recent conversation', value: 'save' },
        { name: chalk.dim('← Back'), value: 'cancel' }
      ]
    });

    if (action === 'cancel') return;
    if (action === 'create') {
      return handleBibleCreate({ cwd, groqClient, vectorStore, embedder, config });
    }
    if (action === 'edit') {
      return handleBibleEdit({ cwd, groqClient, vectorStore, embedder, config });
    }
    if (action === 'list') {
      return handleBibleList({ cwd });
    }
    if (action === 'save') {
      return handleBibleSave({ cwd, groqClient, vectorStore, embedder, conversationMgr, config });
    }

    // Otherwise consult
    const q = await input({
      message: 'Enter your question or lore query:'
    });
    if (!q || !q.trim()) return;
    query = q.trim();
  }

  const lower = query.trim().toLowerCase();

  // Check for "/bible save"
  if (lower === 'save') {
    return handleBibleSave({
      cwd,
      groqClient,
      vectorStore,
      embedder,
      conversationMgr,
      config
    });
  }

  // Check for "/bible create [filename]" or "/bible new [filename]"
  if (lower.startsWith('create') || lower.startsWith('new')) {
    const arg = query.trim().replace(/^(create|new)\s*/i, '').trim();
    return handleBibleCreate({
      arg,
      cwd,
      groqClient,
      vectorStore,
      embedder,
      config
    });
  }

  // Check for "/bible edit [filename]"
  if (lower.startsWith('edit')) {
    const arg = query.trim().replace(/^edit\s*/i, '').trim();
    return handleBibleEdit({
      arg,
      cwd,
      groqClient,
      vectorStore,
      embedder,
      config
    });
  }

  // Check for "/bible list"
  if (lower === 'list') {
    return handleBibleList({ cwd });
  }

  // 1. Query Rewriting with Small Model
  const recentTurns = conversationMgr.getRecentTurns(4);
  let rewrittenQuery = query.trim();

  if (recentTurns.length > 0) {
    const rewriteSpinner = createSpinner('Resolving context and rewriting query...').start();
    try {
      const turnsText = recentTurns.map((t) => `${t.role}: ${t.content}`).join('\n');
      const rewritePrompt = `Conversation History:\n${turnsText}\n\nCurrent User Query:\n${query}\n\nRewritten search query:`;

      const rewritten = await groqClient.chatCompletion({
        model: 'small',
        messages: [
          { role: 'system', content: QUERY_REWRITE_SYSTEM_PROMPT },
          { role: 'user', content: rewritePrompt }
        ],
        temperature: 0.1,
        sessionId: conversationMgr.current?.id || 'current',
        workflow: 'QUERY_REWRITE'
      });

      if (rewritten && rewritten.trim()) {
        rewrittenQuery = rewritten.trim();
      }
      rewriteSpinner.succeed(`Search query: "${rewrittenQuery}"`);
    } catch {
      rewriteSpinner.stop();
    }
  }

  // 2. Hybrid Retrieval + Cross-Encoder Reranking
  const searchSpinner = createSpinner('Running Vector + BM25 hybrid search & ONNX reranking...').start();
  let rerankedChunks = [];
  try {
    const queryVector = await embedder.embedQuery(rewrittenQuery);
    const candidates = await vectorStore.hybridSearch({
      queryText: rewrittenQuery,
      queryVector,
      vectorTopK: config.rag?.vectorTopK || 15,
      bm25TopK: config.rag?.bm25TopK || 15,
      rrfK: config.rag?.rrfK || 60
    });

    rerankedChunks = await reranker.rerank({
      queryText: rewrittenQuery,
      candidates,
      topK: config.rag?.rerankTopK || 5
    });

    searchSpinner.succeed(`Retrieved ${rerankedChunks.length} top canonical sources.`);
  } catch (err) {
    searchSpinner.fail(`Retrieval error: ${err.message}`);
  }

  // Sort into Tiers
  const tier1 = rerankedChunks.filter((c) => Number(c.authority_tier) === 1);
  const tier2 = rerankedChunks.filter((c) => Number(c.authority_tier) === 2);
  const tier3 = rerankedChunks.filter((c) => Number(c.authority_tier) === 3);

  const instructions = await loadInstructions(cwd);
  const hierarchyXml = buildHierarchyContext({
    instructions,
    tier1Chunks: tier1,
    tier2Chunks: tier2,
    tier3Chunks: tier3,
    rollingSummary: conversationMgr.getRollingSummary()
  });

  // Display citations banner
  if (rerankedChunks.length > 0) {
    const citedFiles = [...new Set(rerankedChunks.map((c) => c.source_path))];
    console.log(chalk.dim(`\n  Referencing sources: [${citedFiles.join(', ')}]\n`));
  }

  // 3. Streaming Response from Large Model
  const systemMessage = `${hierarchyXml}\n\nYou are consulting with the author about their Story Bible, plot, or lore.
Cite exact source files when answering questions. If a detail is missing from the Story Bible, explicitly state that it has not been recorded yet and offer creative suggestions.`;

  const messages = [
    { role: 'system', content: systemMessage },
    ...recentTurns.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: query }
  ];

  process.stdout.write(chalk.bold.magenta('\nQuillbot: '));
  let fullAnswer = '';

  try {
    fullAnswer = await groqClient.streamChatCompletion({
      model: 'large',
      messages,
      temperature: 0.7,
      sessionId: conversationMgr.current?.id || 'current',
      workflow: 'BIBLE_CONSULTATION',
      onChunk: (delta) => {
        process.stdout.write(delta);
      }
    });
    console.log('\n');
  } catch (err) {
    console.error(chalk.red(`\nGeneration error: ${err.message}`));
    return;
  }

  await conversationMgr.addTurn('user', `/bible ${query}`);
  await conversationMgr.addTurn('assistant', fullAnswer);
}

/**
 * Creates a brand new Story Bible file without touching existing files
 */
export async function handleBibleCreate({
  arg = '',
  cwd = process.cwd(),
  groqClient,
  vectorStore,
  embedder,
  config
}) {
  const bibleDir = path.join(cwd, 'story-bible');
  await fs.mkdir(bibleDir, { recursive: true });

  let filename = (arg || '').trim();
  if (!filename) {
    filename = await input({
      message: 'Enter new Story Bible filename (e.g. factions.md or magic-system.md):'
    });
  }

  if (!filename || !filename.trim()) {
    console.log(chalk.yellow('File creation aborted: No filename provided.'));
    return;
  }

  filename = filename.trim();
  if (!filename.endsWith('.md') && !filename.endsWith('.txt')) {
    filename += '.md';
  }

  const filePath = path.join(bibleDir, filename);

  try {
    await fs.access(filePath);
    console.log(chalk.yellow(`\nFile story-bible/${filename} already exists!`));
    console.log(chalk.dim(`To safely edit this file without ruining existing content, use: /bible edit ${filename}`));
    return;
  } catch {}

  const description = await input({
    message: `What should story-bible/${filename} document? (Describe topics, factions, or press Enter for empty template):`
  });

  let fileContent = '';

  if (description && description.trim()) {
    const spinner = createSpinner(`Drafting story-bible/${filename} in paragraph format...`).start();
    try {
      fileContent = await groqClient.chatCompletion({
        model: 'large',
        messages: [
          { role: 'system', content: CREATE_BIBLE_FILE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Project Title: ${config.projectTitle || 'Novel'}\nWriting Style: ${config.writingStyle || 'Prose'}\n\nTarget File: story-bible/${filename}\nTopic & Requirements:\n${description.trim()}`
          }
        ],
        temperature: 0.7,
        sessionId: 'bible_create',
        workflow: 'CREATE_BIBLE_FILE'
      });
      spinner.succeed(`Generated draft for story-bible/${filename}`);
    } catch (err) {
      spinner.fail(`Generation failed: ${err.message}`);
      return;
    }
  } else {
    const title = filename.replace(/\.md$/, '').replace(/[-_]/g, ' ').toUpperCase();
    fileContent = `# ${title}\n\nWrite your canon details here in paragraphs...\n`;
  }

  console.log('\n' + chalk.bold.magenta(`--- Preview: story-bible/${filename} ---`));
  printMarkdown(fileContent);

  const review = await promptReviewWorkflow({
    draftContent: fileContent,
    itemLabel: `new Story Bible file story-bible/${filename}`,
    allowPause: false,
    preferredEditor: config.editor
  });

  if (review.action === 'accept') {
    await fs.writeFile(filePath, review.content.trim() + '\n', 'utf8');
    console.log(chalk.green(`\nSuccessfully created story-bible/${filename}!`));

    const syncSpinner = createSpinner('Indexing new file into LanceDB...').start();
    try {
      await syncAllFiles({ cwd, vectorStore, embedder, config });
      syncSpinner.succeed(`story-bible/${filename} indexed as Tier 1 canon.`);
    } catch (err) {
      syncSpinner.fail(`Index update failed: ${err.message}`);
    }
  }
}

/**
 * Safely edits an existing Story Bible file without ruining or wiping previous content
 */
export async function handleBibleEdit({
  arg = '',
  cwd = process.cwd(),
  groqClient,
  vectorStore,
  embedder,
  config
}) {
  const bibleDir = path.join(cwd, 'story-bible');
  await fs.mkdir(bibleDir, { recursive: true });

  let filename = (arg || '').trim();

  // If no filename given, let user select from existing Story Bible files
  if (!filename) {
    const files = await fs.readdir(bibleDir);
    const bibleFiles = files.filter((f) => f.endsWith('.md') || f.endsWith('.txt')).sort();

    if (bibleFiles.length === 0) {
      console.log(chalk.yellow('\nNo Story Bible files found in story-bible/. Create one with /bible create.'));
      return;
    }

    const choices = bibleFiles.map((f) => ({ name: f, value: f }));
    choices.push({ name: chalk.dim('← Cancel'), value: '__cancel__' });

    filename = await select({
      message: 'Select a Story Bible file to edit:',
      choices
    });

    if (filename === '__cancel__') return;
  }

  if (!filename.endsWith('.md') && !filename.endsWith('.txt')) {
    filename += '.md';
  }

  const filePath = path.join(bibleDir, filename);

  let existingContent = '';
  try {
    existingContent = await fs.readFile(filePath, 'utf8');
  } catch {
    console.log(chalk.yellow(`\nFile story-bible/${filename} does not exist. Use /bible create to create it.`));
    return;
  }

  // Safety Backup: create backup before modifying so original file is never ruined or lost
  const backupPath = await createBackup(filePath, cwd);
  if (backupPath) {
    console.log(chalk.dim(`[Safety Backup] Saved backup to ${path.relative(cwd, backupPath)}`));
  }

  const editMode = await select({
    message: `How would you like to edit story-bible/${filename}?`,
    choices: [
      { name: `Open and edit directly in text editor (${config.editor || 'editor'})`, value: 'editor' },
      { name: `AI-assisted update (add or refine lore while strictly preserving existing text)`, value: 'ai' },
      { name: chalk.dim('← Cancel'), value: 'cancel' }
    ]
  });

  if (editMode === 'cancel') return;

  if (editMode === 'editor') {
    const edited = await openInEditor(existingContent, config.editor);
    const review = await promptReviewWorkflow({
      draftContent: edited,
      itemLabel: `edited story-bible/${filename}`,
      allowPause: false,
      preferredEditor: config.editor
    });

    if (review.action === 'accept') {
      await fs.writeFile(filePath, review.content.trim() + '\n', 'utf8');
      console.log(chalk.green(`\nSaved changes to story-bible/${filename}. Previous content preserved.`));

      const syncSpinner = createSpinner('Syncing updated Story Bible to LanceDB...').start();
      try {
        await syncAllFiles({ cwd, vectorStore, embedder, config });
        syncSpinner.succeed('LanceDB hybrid RAG updated with edits.');
      } catch (err) {
        syncSpinner.fail(`Sync error: ${err.message}`);
      }
    }
    return;
  }

  if (editMode === 'ai') {
    const instructions = await input({
      message: `What additions, lore updates, or adjustments would you like to make to ${filename}?`
    });

    if (!instructions || !instructions.trim()) {
      console.log(chalk.yellow('No instructions provided. Keeping original file untouched.'));
      return;
    }

    const spinner = createSpinner(`Updating story-bible/${filename} with AI (preserving existing canon)...`).start();
    let updatedContent = '';

    try {
      const messages = [
        { role: 'system', content: EDIT_BIBLE_FILE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Project Title: ${config.projectTitle || 'Novel'}\nFile: story-bible/${filename}\n\nEXISTING CANON CONTENT (PRESERVE ALL EXISTING FACTS & PARAGRAPHS):\n${existingContent}\n\nAUTHOR REQUESTED UPDATE (INTEGRATE SEAMLESSLY WITHOUT RUINING EXISTING CONTENT):\n${instructions.trim()}`
        }
      ];

      updatedContent = await groqClient.chatCompletion({
        model: 'large',
        messages,
        temperature: 0.5,
        sessionId: 'bible_edit',
        workflow: 'EDIT_BIBLE_FILE'
      });

      spinner.succeed(`Generated updated draft for story-bible/${filename}`);
    } catch (err) {
      spinner.fail(`Failed to update: ${err.message}`);
      return;
    }

    console.log('\n' + chalk.bold.magenta(`--- Updated Preview: story-bible/${filename} ---`));
    printMarkdown(updatedContent);

    const review = await promptReviewWorkflow({
      draftContent: updatedContent,
      itemLabel: `updated story-bible/${filename}`,
      allowPause: false,
      preferredEditor: config.editor
    });

    if (review.action === 'accept') {
      await fs.writeFile(filePath, review.content.trim() + '\n', 'utf8');
      console.log(chalk.green(`\nSuccessfully updated story-bible/${filename} without ruining previous lore!`));

      const syncSpinner = createSpinner('Syncing updated file to LanceDB...').start();
      try {
        await syncAllFiles({ cwd, vectorStore, embedder, config });
        syncSpinner.succeed('LanceDB hybrid RAG updated with new edits.');
      } catch (err) {
        syncSpinner.fail(`Sync error: ${err.message}`);
      }
    }
  }
}

/**
 * Lists all Story Bible files with word counts and sections
 */
export async function handleBibleList({ cwd = process.cwd() }) {
  const bibleDir = path.join(cwd, 'story-bible');
  try {
    const files = await fs.readdir(bibleDir);
    const bibleFiles = files.filter((f) => f.endsWith('.md') || f.endsWith('.txt')).sort();

    if (bibleFiles.length === 0) {
      console.log(chalk.yellow('\nNo Story Bible files found in story-bible/.'));
      return;
    }

    console.log(chalk.bold.cyan(`\n  Story Bible Files (${bibleFiles.length} Total):`));
    for (const file of bibleFiles) {
      const content = await fs.readFile(path.join(bibleDir, file), 'utf8');
      const lines = content.split('\n').length;
      const words = content.trim().split(/\s+/).filter(Boolean).length;
      const headers = content.match(/^#{1,3}\s+(.+)$/gm) || [];
      const headerPreview = headers.slice(0, 3).map((h) => h.replace(/^#{1,3}\s+/, '')).join(', ');

      console.log(`  ${chalk.green(file.padEnd(24))} ${chalk.dim(`${words} words, ${lines} lines`)}`);
      if (headerPreview) {
        console.log(`    ${chalk.dim('Sections:')} ${chalk.white(headerPreview)}${headers.length > 3 ? chalk.dim(', ...') : ''}`);
      }
    }
    console.log('');
  } catch (err) {
    console.error(chalk.red(`Failed to list Story Bible files: ${err.message}`));
  }
}

export async function handleBibleSave({
  cwd = process.cwd(),
  groqClient,
  vectorStore,
  embedder,
  conversationMgr,
  config
}) {
  const recentTurns = conversationMgr.getRecentTurns(6);
  if (recentTurns.length === 0) {
    console.log(chalk.yellow('No recent conversation turns to extract lore from.'));
    return;
  }

  const spinner = createSpinner('Extracting new lore decisions from recent conversation...').start();
  let extracted = null;

  try {
    const transcript = recentTurns.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n');
    extracted = await groqClient.jsonCompletion({
      model: 'small',
      messages: [
        { role: 'system', content: BIBLE_SAVE_EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: `Extract lore from this conversation:\n\n${transcript}` }
      ],
      temperature: 0.2,
      sessionId: conversationMgr.current?.id || 'current',
      workflow: 'EXTRACT_LORE_SAVE'
    });
    spinner.succeed('Lore extraction complete.');
  } catch (err) {
    spinner.fail(`Failed to extract lore: ${err.message}`);
    return;
  }

  if (!extracted?.markdownContent || !extracted.markdownContent.trim()) {
    console.log(chalk.yellow(`\nNo new permanent lore identified to save: ${extracted?.rationale || 'None'}`));
    return;
  }

  const targetFileName = extracted.targetFile || 'world-and-lore.md';
  const targetPath = path.join(cwd, 'story-bible', targetFileName);

  const preview = `# Proposed Addition to story-bible/${targetFileName}
**Rationale:** ${extracted.rationale || 'New lore decision'}
**Section:** ${extracted.sectionTitle || 'General'}

${extracted.markdownContent}
`;

  printMarkdown(preview);

  const review = await promptReviewWorkflow({
    draftContent: extracted.markdownContent,
    itemLabel: `addition to story-bible/${targetFileName}`,
    allowPause: false,
    preferredEditor: config.editor
  });

  if (review.action === 'accept') {
    // Safety Backup before appending
    await createBackup(targetPath, cwd);

    const toAppend = `\n\n### ${extracted.sectionTitle || 'New Entry'}\n${review.content.trim()}\n`;
    await fs.appendFile(targetPath, toAppend, 'utf8');
    console.log(chalk.green(`\nAppended new lore to story-bible/${targetFileName} without affecting previous content.`));

    const syncSpinner = createSpinner('Re-indexing Story Bible...').start();
    try {
      await syncAllFiles({ cwd, vectorStore, embedder, config });
      syncSpinner.succeed('Story Bible updated and re-indexed in LanceDB.');
    } catch (err) {
      syncSpinner.fail(`Index update failed: ${err.message}`);
    }
  }
}
