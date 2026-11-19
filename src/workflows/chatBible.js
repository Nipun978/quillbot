import fs from 'node:fs/promises';
import path from 'node:path';
import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  BIBLE_QUERY_IMPROVISE_SYSTEM_PROMPT,
  GENERAL_QUERY_IMPROVISE_SYSTEM_PROMPT,
  BIBLE_SAVE_EXTRACT_SYSTEM_PROMPT,
  CREATE_BIBLE_FILE_SYSTEM_PROMPT,
  EDIT_BIBLE_FILE_SYSTEM_PROMPT,
  buildStoryBibleContext,
  buildHierarchyContext
} from '../llm/prompts.js';
import { loadInstructions } from '../config/configManager.js';
import { loadState } from '../config/stateManager.js';
import { createBackup } from '../config/backupManager.js';
import { createSpinner, printMarkdown, createReadableStreamPrinter } from '../ui/renderer.js';
import { promptReviewWorkflow, openInEditor } from '../ui/reviewPrompt.js';
import { syncAllFiles } from '../rag/fileSync.js';
import { ensureStdinRaw } from '../ui/ttyManager.js';

const READABLE_RESPONSE_RULES = `
Formatting & Readability Rules:
- Write in a helpful, clear, easy-to-read conversational style.
- Do NOT use raw markdown syntax: no # headings, no ** or __ bold/italic markers, no backticks, and no markdown tables.
- Use short paragraphs, plain section labels (for example, "Key Details:" or "Next Steps:"), and simple "- " bullet points with blank lines between sections.`;

/**
 * Returns true when user input is a short conversational greeting or acknowledgement
 * that does not warrant RAG query improvisation or Story Bible retrieval.
 */
export function isTrivialGreeting(text = '') {
  return /^(hi|hello|hey|yo|hiya|good\s+(morning|afternoon|evening)|thanks|thank\s+you|thx|ok|okay|cool|great|bye|goodbye)[!.,?\s]*$/i.test(
    String(text || '').trim()
  );
}

/**
 * Strips raw markdown formatting markers so saved conversation history stays clean plain text.
 */
export function stripMarkdownForStorage(text = '') {
  return String(text || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .trim();
}

/**
 * Loads deterministic on-disk manuscript progress (.condensed/story-so-far.md, chapter summaries,
 * written beat counts, and state.json active cursor) so progress queries never confuse
 * Story Bible outlines with actually written manuscript chapters.
 */
async function loadWrittenProgressSummary(cwd) {
  const parts = [];
  let hasWrittenContent = false;

  try {
    const storySoFarPath = path.join(cwd, '.condensed', 'story-so-far.md');
    const storySoFar = (await fs.readFile(storySoFarPath, 'utf8')).trim();
    if (storySoFar) {
      hasWrittenContent = true;
      parts.push(`Story So Far (.condensed/story-so-far.md):\n${storySoFar}`);
    }
  } catch {
    // Not created yet
  }

  try {
    const state = await loadState(cwd);
    if (state?.activeChapter) {
      parts.push(`Current Workspace Cursor: Chapter ${state.activeChapter}${state.activeBeat ? `, Beat ${state.activeBeat}` : ''}`);
    }
  } catch {
    // Ignore missing state
  }

  try {
    const projectDir = path.join(cwd, 'project');
    const entries = await fs.readdir(projectDir, { withFileTypes: true });
    const chapterDirs = entries
      .filter((e) => e.isDirectory() && /^chapter-\d+$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const chapterStatuses = [];
    for (const dirName of chapterDirs) {
      const chDir = path.join(projectDir, dirName);
      let hasPlan = false;
      let writtenBeats = 0;
      let summaryText = '';

      try {
        await fs.access(path.join(chDir, 'plan.md'));
        hasPlan = true;
      } catch {
        // no plan
      }

      try {
        const chText = await fs.readFile(path.join(chDir, 'chapter.md'), 'utf8');
        const beatMatches = chText.match(/<!--\s*BEAT\s+\d+\s*-->/gi);
        writtenBeats = beatMatches ? beatMatches.length : (chText.trim() ? 1 : 0);
        if (writtenBeats > 0) hasWrittenContent = true;
      } catch {
        // no written prose yet
      }

      try {
        summaryText = (await fs.readFile(path.join(chDir, 'summary.md'), 'utf8')).trim();
        if (summaryText) hasWrittenContent = true;
      } catch {
        // no chapter summary yet
      }

      chapterStatuses.push(
        `- ${dirName}: planned=${hasPlan ? 'yes' : 'no'}, written_beats=${writtenBeats}, completed_summary=${summaryText ? 'yes' : 'no'}`
      );
      if (summaryText) {
        parts.push(`${dirName}/summary.md:\n${summaryText}`);
      }
    }

    if (chapterStatuses.length > 0) {
      parts.unshift(`Written Manuscript Status:\n${chapterStatuses.join('\n')}`);
    } else if (!hasWrittenContent) {
      parts.unshift('Written Manuscript Status: No chapters have been planned or written in project/ yet.');
    }
  } catch {
    if (!hasWrittenContent) {
      parts.push('Written Manuscript Status: No chapters have been written in project/ yet.');
    }
  }

  return {
    text: parts.join('\n\n'),
    hasWrittenContent
  };
}

/**
 * Shared Hybrid RAG consultation pipeline supporting two scopes:
 * - 'bible': Queries strictly Story Bible files (story-bible/**, Tier 1)
 * - 'all':   Queries all project sources (Story Bible, chapters, .condensed files, and archived conversations)
 */
async function runRagConsultation({
  query,
  scope = 'all',
  cwd = process.cwd(),
  groqClient,
  vectorStore,
  embedder,
  reranker,
  conversationMgr,
  config
}) {
  const cleanQuery = (query || '').trim();
  if (!cleanQuery) return;

  const isBibleScope = scope === 'bible';
  const recentTurns = conversationMgr?.getRecentTurns ? conversationMgr.getRecentTurns(4) : [];
  const rollingSummary = conversationMgr?.getRollingSummary ? conversationMgr.getRollingSummary() : '';

  if (!isBibleScope && isTrivialGreeting(cleanQuery)) {
    process.stdout.write(chalk.bold.magenta('\nQuillbot:\n'));
    const printer = createReadableStreamPrinter();
    let fullAnswer = '';
    try {
      fullAnswer = await groqClient.streamChatCompletion({
        model: 'large',
        messages: [
          {
            role: 'system',
            content: `You are Quillbot, a friendly novel writing assistant. Reply warmly and concisely to the author's greeting or acknowledgement without dumping story spoilers or unsolicited project recaps. Offer brief slash-command next steps like /bible, /plan, or /write if appropriate.\n${READABLE_RESPONSE_RULES}`
          },
          ...recentTurns.map((t) => ({ role: t.role, content: t.content })),
          { role: 'user', content: cleanQuery }
        ],
        temperature: 0.6,
        maxTokens: 256,
        sessionId: conversationMgr?.current?.id || 'current',
        workflow: 'GENERAL_GREETING',
        onChunk: (delta) => printer.push(delta)
      });
      printer.flush();
      console.log('\n');
      if (conversationMgr?.addTurn) {
        await conversationMgr.addTurn('user', cleanQuery);
        await conversationMgr.addTurn('assistant', stripMarkdownForStorage(fullAnswer));
      }
    } catch (err) {
      printer.flush();
      console.error(chalk.red(`\nGeneration error: ${err.message}`));
    }
    return;
  }

  // 1. Always improvise the query first using the 20B (small) model
  let improvisedQuery = cleanQuery;
  const improviseSpinner = createSpinner('Improvising search query with 20B model...').start();
  try {
    const turnsText = recentTurns.length > 0
      ? recentTurns.map((t) => `${t.role}: ${t.content}`).join('\n')
      : '(None — standalone question)';

    const improvisePrompt = `Conversation History:\n${turnsText}\n\nUser Question:\n${cleanQuery}\n\nImprovised search query:`;

    const rewritten = await groqClient.chatCompletion({
      model: 'small',
      messages: [
        {
          role: 'system',
          content: isBibleScope ? BIBLE_QUERY_IMPROVISE_SYSTEM_PROMPT : GENERAL_QUERY_IMPROVISE_SYSTEM_PROMPT
        },
        { role: 'user', content: improvisePrompt }
      ],
      temperature: 0.1,
      maxTokens: 512,
      reasoningEffort: 'low',
      sessionId: conversationMgr?.current?.id || 'current',
      workflow: isBibleScope ? 'IMPROVISE_BIBLE_QUERY' : 'IMPROVISE_GENERAL_QUERY'
    });

    if (rewritten && rewritten.trim()) {
      improvisedQuery = rewritten.trim();
    }
    improviseSpinner.succeed(`Search query: "${improvisedQuery}"`);
  } catch {
    improviseSpinner.stop();
  }

  // 2. Hybrid Retrieval (Vector + BM25 + RRF) + Cross-Encoder Reranking
  const searchLabel = isBibleScope
    ? 'Searching Story Bible files with Hybrid RAG...'
    : 'Searching all project sources (Story Bible, chapters, condensed files, notes) with Hybrid RAG...';
  const searchSpinner = createSpinner(searchLabel).start();

  const writtenProgress = !isBibleScope
    ? await loadWrittenProgressSummary(cwd)
    : { text: '', hasWrittenContent: false };

  let rerankedChunks = [];
  try {
    const isPaid = config?.apiTier === 'paid' || config?.apiTier === 'developer';
    const queryVector = await embedder.embedQuery(improvisedQuery);
    const searchOpts = {
      queryText: improvisedQuery,
      queryVector,
      vectorTopK: config?.rag?.vectorTopK || 15,
      bm25TopK: config?.rag?.bm25TopK || 15,
      rrfK: config?.rag?.rrfK || 60,
      isPaid
    };

    if (isBibleScope) {
      searchOpts.sourceTypes = isPaid ? ['story-bible', 'story-bible-reference'] : ['story-bible'];
      searchOpts.authorityTiers = [1];
    }

    const candidates = await vectorStore.hybridSearch(searchOpts);
    const defaultTopK = isBibleScope ? 5 : 8;
    rerankedChunks = await reranker.rerank({
      queryText: improvisedQuery,
      candidates,
      topK: Math.max(config?.rag?.rerankTopK || defaultTopK, isBibleScope ? 1 : 8),
      minScore: config?.rag?.minScore ?? 0.03
    });

    if (isBibleScope) {
      rerankedChunks = rerankedChunks.filter((c) => {
        const isBibleDoc = c.source_type === 'story-bible' ||
          (isPaid && c.source_type === 'story-bible-reference') ||
          Number(c.authority_tier) === 1 ||
          String(c.source_path || '').replace(/\\/g, '/').startsWith('story-bible/');
        const isRef = c.source_type === 'story-bible-reference' ||
          String(c.source_path || '').replace(/\\/g, '/').startsWith('story-bible/references/');
        return isPaid ? isBibleDoc : (isBibleDoc && !isRef);
      });
    } else if (!isPaid) {
      rerankedChunks = rerankedChunks.filter((c) => (
        c.source_type !== 'story-bible-reference' &&
        !String(c.source_path || '').replace(/\\/g, '/').startsWith('story-bible/references/')
      ));
    } else if (
      writtenProgress.hasWrittenContent &&
      rerankedChunks.every((c) => Number(c.authority_tier) !== 2)
    ) {
      try {
        const tier2Candidates = await vectorStore.hybridSearch({
          ...searchOpts,
          sourceTypes: ['condensed-story-so-far', 'chapter-summary', 'chapter', 'condensed-prose', 'condensed-plan'],
          authorityTiers: [2]
        });
        if (tier2Candidates?.length > 0) {
          const tier2Ranked = await reranker.rerank({
            queryText: improvisedQuery,
            candidates: tier2Candidates,
            topK: 4
          });
          rerankedChunks = [...rerankedChunks, ...tier2Ranked];
        }
      } catch {
        // Supplemental Tier 2 search is best-effort
      }
    }

    const sourceDesc = isBibleScope ? 'Story Bible sources' : 'project sources';
    searchSpinner.succeed(`Retrieved ${rerankedChunks.length} relevant ${sourceDesc}.`);
  } catch (err) {
    searchSpinner.fail(`Retrieval error: ${err.message}`);
  }

  // 3. Assemble Context & System Prompt (omit prose-style <system_instructions> so Q&A stays crisp & factual)
  let systemMessage = '';

  if (isBibleScope) {
    const bibleContext = rerankedChunks.length > 0
      ? buildStoryBibleContext(rerankedChunks)
      : '<story_bible_lore>\n(No matching Story Bible entries found)\n</story_bible_lore>';

    systemMessage = `${bibleContext}${rollingSummary ? `\n\n<recent_discussion_summary>\n${rollingSummary}\n</recent_discussion_summary>` : ''}

You are Quillbot, a helpful Story Bible canon assistant.
Answer the author's question based strictly on the Story Bible files retrieved above.
Mention the relevant Story Bible filenames naturally in plain text. If a detail is not recorded in the Story Bible yet, state that clearly and offer helpful creative suggestions consistent with existing canon.
${READABLE_RESPONSE_RULES}`;
  } else {
    // 1. Deduplicate tier1 chunks by source_path + section_title and allow up to 6 chunks
    const seenTier1 = new Set();
    const uniqueTier1 = [];
    for (const c of rerankedChunks.filter((c) => Number(c.authority_tier) === 1)) {
      const key = `${c.source_path || ''}::${c.section_title || ''}`;
      if (!seenTier1.has(key)) {
        seenTier1.add(key);
        uniqueTier1.push(c);
      }
    }
    const tier1 = uniqueTier1.slice(0, 6);

    // 2. Filter out Tier 2 chunks that are already injected via loadWrittenProgressSummary
    // (e.g. .condensed/story-so-far.md and chapter-XX/summary.md)
    const tier2Candidates = rerankedChunks.filter((c) => Number(c.authority_tier) === 2);
    const uniqueTier2 = [];
    const seenTier2 = new Set();
    for (const c of tier2Candidates) {
      const p = String(c.source_path || '').replace(/\\/g, '/');
      const isAlreadyInSummary = writtenProgress.hasWrittenContent && (
        p.endsWith('summary.md') || p.endsWith('story-so-far.md')
      );
      const key = `${c.source_path || ''}::${c.section_title || ''}`;
      if (!isAlreadyInSummary && !seenTier2.has(key)) {
        seenTier2.add(key);
        uniqueTier2.push(c);
      }
    }
    const tier2 = uniqueTier2.slice(0, 4);
    const tier3 = rerankedChunks.filter((c) => Number(c.authority_tier) === 3).slice(0, 2);

    const hierarchyXml = buildHierarchyContext({
      tier1Chunks: tier1,
      tier2Chunks: tier2,
      pastChapterSummaries: writtenProgress.text,
      tier3Chunks: tier3,
      rollingSummary
    });

    systemMessage = `${hierarchyXml}

You are Quillbot, a helpful novel writing assistant consulting across all project sources: Story Bible canon, chapter plans, chapter manuscripts, condensed progress files (.condensed), and archived discussion notes.
Synthesize the most relevant facts while honoring the Hierarchy of Truth (Story Bible > Chapters & Condensed Progress > Archived Notes), and cite the exact files or chapters you draw from in plain text.

CRITICAL GROUNDING & MANUSCRIPT INTEGRITY RULES:
1. Distinguish strictly between events ALREADY WRITTEN in the manuscript (<past_chapters> / project/) versus high-level planned outline arcs in <story_bible_canon> (story-bible/plot-overview.md).
2. MANUSCRIPT GROUNDING RULE: You may ONLY state that a character, event, or object "appears in the written manuscript" or "has already happened in the story" if that character or event is explicitly named in <past_chapters> (Previous Chapter Summaries or Manuscript Excerpts). If they are only mentioned in <story_bible_canon>, state explicitly that they exist in the planned Story Bible outline but have NOT YET appeared in the written manuscript.
3. If something hasn't been written or decided yet, say so clearly and offer practical next-step suggestions.
${READABLE_RESPONSE_RULES}`;
  }

  // Display citations banner
  if (rerankedChunks.length > 0) {
    const citedFiles = [...new Set(rerankedChunks.map((c) => c.source_path))];
    const bannerLabel = isBibleScope ? 'Referencing Story Bible files' : 'Referencing sources';
    console.log(chalk.dim(`\n  ${bannerLabel}: [${citedFiles.join(', ')}]`));
  }

  const messages = [
    { role: 'system', content: systemMessage },
    ...recentTurns.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: cleanQuery }
  ];

  // 4. Stream Easy-to-Read Output
  const headerLabel = isBibleScope ? '\nQuillbot (Story Bible):\n' : '\nQuillbot:\n';
  process.stdout.write(chalk.bold.magenta(headerLabel));
  const printer = createReadableStreamPrinter();
  let fullAnswer = '';

  try {
    fullAnswer = await groqClient.streamChatCompletion({
      model: 'large',
      messages,
      temperature: 0.7,
      sessionId: conversationMgr?.current?.id || 'current',
      workflow: isBibleScope ? 'BIBLE_QUERY' : 'PROJECT_QUERY',
      onChunk: (delta) => {
        printer.push(delta);
      }
    });
    printer.flush();
    console.log('\n');
  } catch (err) {
    printer.flush();
    console.error(chalk.red(`\nGeneration error: ${err.message}`));
    return;
  }

  if (conversationMgr?.addTurn) {
    await conversationMgr.addTurn('user', isBibleScope ? `/bible query ${cleanQuery}` : cleanQuery);
    await conversationMgr.addTurn('assistant', stripMarkdownForStorage(fullAnswer));
  }
}

export async function runGeneralQuery({
  query,
  cwd = process.cwd(),
  groqClient,
  vectorStore,
  embedder,
  reranker,
  conversationMgr,
  config
}) {
  const clean = (query || '').trim();
  if (!clean) return;
  return runRagConsultation({
    query: clean,
    scope: 'all',
    cwd,
    groqClient,
    vectorStore,
    embedder,
    reranker,
    conversationMgr,
    config
  });
}

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
    ensureStdinRaw();

    const action = await select({
      message: 'Story Bible Actions:',
      choices: [
        { name: `🔍 ${chalk.bold.cyan('Query Story Bible')} — Search & ask questions from Story Bible files`, value: 'query' },
        { name: `➕ ${chalk.bold('Create File')} — Add a new Story Bible file (e.g. magic-system.md)`, value: 'create' },
        { name: `✏️  ${chalk.bold('Edit File')} — Safely update/expand an existing Story Bible file`, value: 'edit' },
        { name: `📋 ${chalk.bold('List Files')} — View all Story Bible documents and word counts`, value: 'list' },
        { name: `💾 ${chalk.bold('Save Lore')} — Extract and save decisions from recent conversation`, value: 'save' },
        { name: chalk.dim('← Back to prompt'), value: 'cancel' }
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

    // Otherwise query Story Bible
    ensureStdinRaw();
    const q = await input({
      message: 'Enter your Story Bible question:'
    });
    if (!q || !q.trim()) return;
    query = q.trim();
  }

  let effectiveQuery = query.trim();
  const lower = effectiveQuery.toLowerCase();

  // Handle "/bible query" (prompt interactively) or "/bible query <question>"
  if (lower === 'query') {
    ensureStdinRaw();
    const q = await input({
      message: 'Enter your Story Bible question:'
    });
    if (!q || !q.trim()) return;
    effectiveQuery = q.trim();
  } else if (lower.startsWith('query ')) {
    effectiveQuery = effectiveQuery.replace(/^query\s+/i, '').trim();
    if (!effectiveQuery) return;
  }

  const effectiveLower = effectiveQuery.toLowerCase();

  // Check for "/bible save"
  if (effectiveLower === 'save') {
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
  if (effectiveLower.startsWith('create') || effectiveLower.startsWith('new')) {
    const arg = effectiveQuery.replace(/^(create|new)\s*/i, '').trim();
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
  if (effectiveLower.startsWith('edit')) {
    const arg = effectiveQuery.replace(/^edit\s*/i, '').trim();
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
  if (effectiveLower === 'list') {
    return handleBibleList({ cwd });
  }

  return runRagConsultation({
    query: effectiveQuery,
    scope: 'bible',
    cwd,
    groqClient,
    vectorStore,
    embedder,
    reranker,
    conversationMgr,
    config
  });
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
    preferredEditor: config.editor,
    quotaManager: groqClient?.quotaManager,
    config,
    model: config.models?.small || 'openai/gpt-oss-20b'
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
      preferredEditor: config.editor,
      quotaManager: groqClient?.quotaManager,
      config,
      model: config.models?.small || 'openai/gpt-oss-20b'
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
      preferredEditor: config.editor,
      quotaManager: groqClient?.quotaManager,
      config,
      model: config.models?.small || 'openai/gpt-oss-20b'
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

  const storyBibleRoot = path.resolve(cwd, 'story-bible');
  const rawName = String(extracted.targetFile || 'world-and-lore.md').replace(/\\/g, '/').replace(/^story-bible\//i, '');
  let targetPath = path.resolve(storyBibleRoot, rawName);
  if (
    targetPath !== storyBibleRoot &&
    !targetPath.startsWith(`${storyBibleRoot}${path.sep}`)
  ) {
    targetPath = path.join(storyBibleRoot, 'world-and-lore.md');
  }
  const safeRelativeFile = path.relative(storyBibleRoot, targetPath).replace(/\\/g, '/');

  const preview = `# Proposed Addition to story-bible/${safeRelativeFile}
**Rationale:** ${extracted.rationale || 'New lore decision'}
**Section:** ${extracted.sectionTitle || 'General'}

${extracted.markdownContent}
`;

  printMarkdown(preview);

  const review = await promptReviewWorkflow({
    draftContent: extracted.markdownContent,
    itemLabel: `addition to story-bible/${safeRelativeFile}`,
    allowPause: false,
    preferredEditor: config.editor,
    quotaManager: groqClient?.quotaManager,
    config,
    model: config.models?.small || 'openai/gpt-oss-20b'
  });

  if (review.action === 'accept') {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    let existing = '';
    try {
      existing = await fs.readFile(targetPath, 'utf8');
      await createBackup(targetPath, cwd);
    } catch {
      existing = '';
    }

    const sectionTitle = (extracted.sectionTitle || 'New Entry').trim();
    const cleanedBody = review.content.trim();
    const trimmedBodyWithoutDupHeader = cleanedBody.replace(
      new RegExp(`^#{1,6}\\s+${sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n+`, 'i'),
      ''
    );
    const prefix = existing.trim() ? '\n\n' : '';
    const toAppend = `${prefix}### ${sectionTitle}\n${trimmedBodyWithoutDupHeader}\n`;
    await fs.appendFile(targetPath, toAppend, 'utf8');
    console.log(chalk.green(`\nAppended new lore to story-bible/${safeRelativeFile} without affecting previous content.`));

    const syncSpinner = createSpinner('Re-indexing Story Bible...').start();
    try {
      await syncAllFiles({ cwd, vectorStore, embedder, config });
      syncSpinner.succeed('Story Bible updated and re-indexed in LanceDB.');
    } catch (err) {
      syncSpinner.fail(`Index update failed: ${err.message}`);
    }
  }
}
