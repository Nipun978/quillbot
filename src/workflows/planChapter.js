import fs from 'node:fs/promises';
import path from 'node:path';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { PLAN_CHAPTER_SYSTEM_PROMPT, buildHierarchyContext } from '../llm/prompts.js';
import { loadInstructions } from '../config/configManager.js';
import { setActiveBeat } from '../config/stateManager.js';
import { createSpinner, printMarkdown } from '../ui/renderer.js';
import { promptReviewWorkflow } from '../ui/reviewPrompt.js';
import { syncAllFiles } from '../rag/fileSync.js';

export function padChapter(num) {
  return String(num).padStart(2, '0');
}

export async function loadPastChapterSummaries(cwd = process.cwd(), currentChapterNum = 1) {
  const summaries = [];
  const projectDir = path.join(cwd, 'project');

  for (let i = 1; i < currentChapterNum; i++) {
    const chName = `chapter-${padChapter(i)}`;
    const sumPath = path.join(projectDir, chName, 'summary.md');
    try {
      const text = await fs.readFile(sumPath, 'utf8');
      summaries.push(`### Chapter ${i} Summary:\n${text.trim()}`);
    } catch {}
  }

  return summaries.join('\n\n');
}

export function validatePlanFormat(planText) {
  const beatRegex = /^### Beat (\d+): (.+)$/gm;
  const matches = [...planText.matchAll(beatRegex)];
  return {
    valid: matches.length > 0,
    beatCount: matches.length,
    matches
  };
}

export async function runPlanChapterWorkflow({
  chapterArg,
  cwd = process.cwd(),
  groqClient,
  vectorStore,
  embedder,
  reranker,
  conversationMgr,
  config
}) {
  const chapterNum = parseInt(chapterArg, 10);
  if (isNaN(chapterNum) || chapterNum < 1) {
    console.log(chalk.yellow('Usage: /plan <chapter_number> (e.g. /plan 1)'));
    return;
  }

  const padded = padChapter(chapterNum);
  const chapterDir = path.join(cwd, 'project', `chapter-${padded}`);
  const planFile = path.join(chapterDir, 'plan.md');

  console.log(chalk.bold.cyan(`\n  Planning Chapter ${chapterNum} (project/chapter-${padded}/plan.md)`));

  const guidance = await input({
    message: `What happens in Chapter ${chapterNum}? (Brief ideas, character focus, or press Enter for AI direction):`
  });

  const spinner = createSpinner('Gathering story continuity & canonical sources...').start();

  // 1. Assembles Context
  const instructions = await loadInstructions(cwd);
  const pastSummaries = await loadPastChapterSummaries(cwd, chapterNum);

  // Hybrid search for story bible elements matching guidance
  let relevantChunks = [];
  const searchQuery = guidance.trim() || `Chapter ${chapterNum} plot progression and characters`;
  try {
    const queryVector = await embedder.embedQuery(searchQuery);
    const candidates = await vectorStore.hybridSearch({
      queryText: searchQuery,
      queryVector,
      vectorTopK: 15,
      bm25TopK: 15
    });
    relevantChunks = await reranker.rerank({
      queryText: searchQuery,
      candidates,
      topK: 6
    });
  } catch {}

  spinner.succeed('Context assembled.');

  const tier1 = relevantChunks.filter((c) => Number(c.authority_tier) === 1);
  const tier2 = relevantChunks.filter((c) => Number(c.authority_tier) === 2);
  const tier3 = relevantChunks.filter((c) => Number(c.authority_tier) === 3);

  const hierarchyXml = buildHierarchyContext({
    instructions,
    tier1Chunks: tier1,
    tier2Chunks: tier2,
    pastChapterSummaries: pastSummaries,
    tier3Chunks: tier3,
    rollingSummary: conversationMgr.getRollingSummary()
  });

  let currentFeedback = '';
  let accepted = false;
  let finalPlan = '';

  while (!accepted) {
    const planSpinner = createSpinner(`Drafting Beat Plan for Chapter ${chapterNum}...`).start();

    try {
      const activeStyle = config.enhancedWritingStyle
        ? `${config.enhancedWritingStyle}\n\nAuthor Core Preferences: ${config.writingStyle}`
        : (config.writingStyle || '');

      const userPrompt = `${hierarchyXml}

<writing_style_and_pacing_rules>
Author's Writing Style & Tone Specification:
${activeStyle || '(Standard literary prose guidelines)'}

CRITICAL: Embody this exact tone, psychological depth, and stylistic pacing in every beat's Action and Goal/Hook description.
</writing_style_and_pacing_rules>

Target: Chapter ${chapterNum}
Author Guidance / Core Conflict:
${guidance.trim() || '(Rely on Story Bible and previous chapter arc)'}
${currentFeedback ? `\nRevision Feedback:\n${currentFeedback}` : ''}

Generate the complete Chapter ${chapterNum} plan using the strict Beat schema.`;

      finalPlan = await groqClient.chatCompletion({
        model: 'large',
        messages: [
          { role: 'system', content: PLAN_CHAPTER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: config.generation?.temperaturePlan || 0.6
      });

      planSpinner.succeed(`Generated Chapter ${chapterNum} plan.`);
    } catch (err) {
      planSpinner.fail(`Failed to generate plan: ${err.message}`);
      return;
    }

    console.log('\n' + chalk.bold.magenta(`--- Chapter ${chapterNum} Plan Preview ---`));
    printMarkdown(finalPlan);

    const validation = validatePlanFormat(finalPlan);
    if (!validation.valid) {
      console.log(chalk.yellow(`\nWarning: Could not detect standard "### Beat N:" headings. Please review or edit.`));
    } else {
      console.log(chalk.dim(`Detected ${validation.beatCount} structured beats.\n`));
    }

    const review = await promptReviewWorkflow({
      draftContent: finalPlan,
      itemLabel: `Chapter ${chapterNum} Plan`,
      allowPause: false,
      preferredEditor: config.editor
    });

    if (review.action === 'accept') {
      finalPlan = review.content;
      accepted = true;
    } else if (review.action === 'retry') {
      currentFeedback = review.feedback || 'Please refine beat pacing and dramatic turns.';
    }
  }

  // Save plan.md
  await fs.mkdir(chapterDir, { recursive: true });
  await fs.writeFile(planFile, finalPlan, 'utf8');
  await setActiveBeat(chapterNum, 1, cwd);

  console.log(chalk.green(`\nSaved plan to project/chapter-${padded}/plan.md`));
  console.log(chalk.cyan(`Active chapter set to ${chapterNum}, beat 1. Ready to write with: /write ${chapterNum}`));

  // Index new plan
  const syncSpinner = createSpinner('Indexing plan into LanceDB...').start();
  try {
    await syncAllFiles({ cwd, vectorStore, embedder, config });
    syncSpinner.succeed('Chapter plan indexed.');
  } catch (err) {
    syncSpinner.fail(`Indexing failed: ${err.message}`);
  }
}
