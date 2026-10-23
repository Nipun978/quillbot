import fs from 'node:fs/promises';
import path from 'node:path';
import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  PLAN_CHAPTER_SYSTEM_PROMPT,
  PLAN_SINGLE_BEAT_SYSTEM_PROMPT,
  buildHierarchyContext
} from '../llm/prompts.js';
import { loadInstructions } from '../config/configManager.js';
import { setActiveBeat } from '../config/stateManager.js';
import { createBackup } from '../config/backupManager.js';
import { parseBeatsFromPlan } from './writeChapter.js';
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

/**
 * Updates or inserts a beat block into plan.md content,
 * maintaining strict numerical order of all beats.
 */
export function updateBeatInPlan(planContent = '', targetBeatNum, newBeatBlock = '') {
  if (!planContent || !planContent.trim()) {
    return `# Chapter Plan\n\n## Beats\n\n${newBeatBlock.trim()}\n`;
  }

  const beatRegex = /^### Beat (\d+):/gm;
  const matches = [...planContent.matchAll(beatRegex)];

  if (matches.length === 0) {
    // No beats found, append to plan
    return `${planContent.trim()}\n\n## Beats\n\n${newBeatBlock.trim()}\n`;
  }

  const preamble = planContent.slice(0, matches[0].index).trimEnd();
  const beats = [];

  for (let i = 0; i < matches.length; i++) {
    const num = parseInt(matches[i][1], 10);
    const startIdx = matches[i].index;
    const endIdx = i < matches.length - 1 ? matches[i + 1].index : planContent.length;
    const rawBlock = planContent.slice(startIdx, endIdx).trim();
    beats.push({ num, rawBlock });
  }

  // Update or insert
  const existingIdx = beats.findIndex((b) => b.num === targetBeatNum);
  if (existingIdx !== -1) {
    beats[existingIdx] = { num: targetBeatNum, rawBlock: newBeatBlock.trim() };
  } else {
    beats.push({ num: targetBeatNum, rawBlock: newBeatBlock.trim() });
    beats.sort((a, b) => a.num - b.num);
  }

  const beatsText = beats.map((b) => b.rawBlock).join('\n\n');
  return `${preamble}\n\n${beatsText}\n`;
}

/**
 * Workflow to plan or edit a specific beat in a chapter plan.
 */
export async function runEditSingleBeatPlanWorkflow({
  chapterNum,
  targetBeatNum, // number or 'add'
  planFile,
  chapterDir,
  existingPlan = '',
  existingBeats = [],
  cwd = process.cwd(),
  groqClient,
  vectorStore,
  embedder,
  reranker,
  conversationMgr,
  config,
  userGuidance = ''
}) {
  const padded = padChapter(chapterNum);
  let targetNum = typeof targetBeatNum === 'number' ? targetBeatNum : null;

  if (targetBeatNum === 'add' || targetNum === null) {
    targetNum = existingBeats.length > 0
      ? Math.max(...existingBeats.map((b) => b.num)) + 1
      : 1;
  }

  const matchedBeat = existingBeats.find((b) => b.num === targetNum);
  const isEditingExisting = Boolean(matchedBeat);

  if (isEditingExisting) {
    console.log(chalk.bold.cyan(`\n  Editing Planned Beat ${targetNum} of Chapter ${chapterNum}: "${matchedBeat.title}"`));
  } else {
    console.log(chalk.bold.cyan(`\n  Adding Beat ${targetNum} to Chapter ${chapterNum} Plan`));
  }

  let guidance = userGuidance;
  if (!guidance && process.stdin.isTTY) {
    try {
      guidance = await input({
        message: isEditingExisting
          ? `What changes or improvements would you like for Beat ${targetNum}? (Press Enter for dramatic polish):`
          : `What should happen in Beat ${targetNum}? (Brief ideas or press Enter for AI direction):`
      });
    } catch {}
  }

  const spinner = createSpinner('Gathering story lore & beat context...').start();
  const instructions = await loadInstructions(cwd);
  const pastSummaries = await loadPastChapterSummaries(cwd, chapterNum);

  // Hybrid search
  let relevantChunks = [];
  const searchQuery = [guidance, matchedBeat?.title, matchedBeat?.characters, matchedBeat?.location]
    .filter(Boolean)
    .join(' ') || `Chapter ${chapterNum} Beat ${targetNum}`;

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
    rollingSummary: conversationMgr?.getRollingSummary ? conversationMgr.getRollingSummary() : ''
  });

  const activeStyle = config.enhancedWritingStyle
    ? `${config.enhancedWritingStyle}\n\nAuthor Core Preferences: ${config.writingStyle}`
    : (config.writingStyle || '');

  // Beats context around this beat
  const otherBeatsContext = existingBeats
    .filter((b) => b.num !== targetNum)
    .map((b) => `- Beat ${b.num} (${b.title}): ${b.action.slice(0, 150)}... [Goal/Hook: ${b.goalHook.slice(0, 100)}]`)
    .join('\n');

  let currentFeedback = '';
  let accepted = false;
  let finalBeatPlan = '';

  while (!accepted) {
    const beatSpinner = createSpinner(
      isEditingExisting
        ? `Re-planning Beat ${targetNum} for Chapter ${chapterNum}...`
        : `Drafting Beat ${targetNum} for Chapter ${chapterNum}...`
    ).start();

    try {
      const userPrompt = `${hierarchyXml}

<writing_style_and_pacing_rules>
${activeStyle || '(Standard literary prose guidelines)'}
</writing_style_and_pacing_rules>

<chapter_context>
Chapter ${chapterNum} Surrounding Beats:
${otherBeatsContext || '(No other beats planned yet)'}
</chapter_context>

${isEditingExisting ? `
<current_beat_draft_to_revise>
${matchedBeat.rawBlock}
</current_beat_draft_to_revise>

### REVISION & IMPROVEMENT OBJECTIVE FOR BEAT ${targetNum}:
${guidance || 'Improve the beat structure, deepen character motivation, sensory details, and dramatic tension while ensuring smooth scene transitions.'}
` : `
### OBJECTIVE FOR NEW BEAT ${targetNum}:
${guidance || 'Plan an impactful new beat advancing the chapter story arc seamlessly.'}
`}
${currentFeedback ? `\nRevision Feedback from previous attempt:\n${currentFeedback}` : ''}

Generate the beat block for Beat ${targetNum} matching:
### Beat ${targetNum}: [Title]
- **Characters:** [Names]
- **Location:** [Location]
- **Action:** [Paragraph describing the beat events]
- **Goal/Hook:** [Paragraph describing resolution and hook]`;

      finalBeatPlan = await groqClient.chatCompletion({
        model: 'large',
        messages: [
          { role: 'system', content: PLAN_SINGLE_BEAT_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: config.generation?.temperaturePlan || 0.6
      });

      beatSpinner.succeed(`Generated Beat ${targetNum} plan.`);
    } catch (err) {
      beatSpinner.fail(`Failed to generate beat plan: ${err.message}`);
      return;
    }

    console.log('\n' + chalk.bold.magenta(`--- Beat ${targetNum} Plan Preview ---`));
    printMarkdown(finalBeatPlan);

    const review = await promptReviewWorkflow({
      draftContent: finalBeatPlan,
      itemLabel: `Chapter ${chapterNum} Beat ${targetNum} Plan`,
      allowPause: false,
      preferredEditor: config.editor
    });

    if (review.action === 'accept') {
      finalBeatPlan = review.content.trim();
      accepted = true;
    } else if (review.action === 'retry') {
      currentFeedback = review.feedback || 'Please refine the action and goal/hook.';
    }
  }

  // Update plan.md
  await fs.mkdir(chapterDir, { recursive: true });
  await createBackup(planFile, cwd);

  const updatedPlan = updateBeatInPlan(existingPlan, targetNum, finalBeatPlan);
  await fs.writeFile(planFile, updatedPlan, 'utf8');

  console.log(chalk.green(`\nBeat ${targetNum} saved into project/chapter-${padded}/plan.md`));

  // Sync to LanceDB
  const syncSpinner = createSpinner('Indexing updated plan into LanceDB...').start();
  try {
    await syncAllFiles({ cwd, vectorStore, embedder, config });
    syncSpinner.succeed('Updated plan indexed into LanceDB.');
  } catch (err) {
    syncSpinner.fail(`Indexing failed: ${err.message}`);
  }
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
  let chapterNum = NaN;
  let targetBeatNum = null;
  let userGuidance = '';

  if (typeof chapterArg === 'number') {
    chapterNum = chapterArg;
  } else if (typeof chapterArg === 'string') {
    const clean = chapterArg.trim();
    const addMatch = clean.match(/^(\d+)\s+(?:--?add|add)(?:\s+(.*))?$/i);
    const beatFlagMatch = clean.match(/^(\d+)\s+--beat(?:=|\s+)(\d+)(?:\s+(.*))?$/i);
    const twoNumMatch = clean.match(/^(\d+)\s+(\d+)(?:\s+(.*))?$/);
    const singleNumMatch = clean.match(/^(\d+)(?:\s+(.*))?$/);

    if (addMatch) {
      chapterNum = parseInt(addMatch[1], 10);
      targetBeatNum = 'add';
      userGuidance = (addMatch[2] || '').trim();
    } else if (beatFlagMatch) {
      chapterNum = parseInt(beatFlagMatch[1], 10);
      targetBeatNum = parseInt(beatFlagMatch[2], 10);
      userGuidance = (beatFlagMatch[3] || '').trim();
    } else if (twoNumMatch) {
      chapterNum = parseInt(twoNumMatch[1], 10);
      targetBeatNum = parseInt(twoNumMatch[2], 10);
      userGuidance = (twoNumMatch[3] || '').trim();
    } else if (singleNumMatch) {
      chapterNum = parseInt(singleNumMatch[1], 10);
      userGuidance = (singleNumMatch[2] || '').trim();
    }
  }

  if (isNaN(chapterNum) || chapterNum < 1) {
    if (process.stdin.isTTY) {
      try {
        const state = await loadState(cwd);
        const chInput = await input({
          message: 'Enter chapter number to plan:',
          default: String(state.activeChapter || 1)
        });
        chapterNum = parseInt(chInput, 10);
      } catch {}
    }
  }

  if (isNaN(chapterNum) || chapterNum < 1) {
    console.log(chalk.yellow('Please specify a valid chapter number to plan.'));
    return;
  }

  const padded = padChapter(chapterNum);
  const chapterDir = path.join(cwd, 'project', `chapter-${padded}`);
  const planFile = path.join(chapterDir, 'plan.md');

  let existingPlan = '';
  let hasExistingPlan = false;
  try {
    existingPlan = await fs.readFile(planFile, 'utf8');
    hasExistingPlan = Boolean(existingPlan && existingPlan.trim());
  } catch {}

  const existingBeats = hasExistingPlan ? parseBeatsFromPlan(existingPlan) : [];

  // If user explicitly targeted a beat (number or 'add'):
  if (targetBeatNum !== null) {
    await runEditSingleBeatPlanWorkflow({
      chapterNum,
      targetBeatNum,
      planFile,
      chapterDir,
      existingPlan,
      existingBeats,
      cwd,
      groqClient,
      vectorStore,
      embedder,
      reranker,
      conversationMgr,
      config,
      userGuidance
    });
    return;
  }

  // If chapter plan already exists and no specific beat was given:
  let isEditingFullPlan = false;
  if (hasExistingPlan) {
    console.log(chalk.bold.cyan(`\n  Chapter ${chapterNum} already has a plan (${existingBeats.length} beats present).`));
    console.log(chalk.bold.yellow(`  Entering Chapter Plan Edit Mode...`));

    let planAction = 'edit_full_plan';
    if (process.stdin.isTTY) {
      try {
        planAction = await select({
          message: `Chapter ${chapterNum} plan already exists. Choose an action:`,
          choices: [
            { name: `1. Edit an already planned beat (Choose from Beats 1–${existingBeats.length})`, value: 'edit_beat' },
            { name: `2. Add a new beat to chapter plan (Beat ${existingBeats.length + 1})`, value: 'add_beat' },
            { name: `3. Edit / Revise entire chapter plan (with current plan in context)`, value: 'edit_full_plan' },
            { name: `4. Re-plan from scratch (overwrite existing plan)`, value: 'scratch' },
            { name: `← Cancel / Return`, value: 'cancel' }
          ]
        });
      } catch {
        planAction = 'edit_full_plan';
      }
    }

    if (planAction === 'cancel') {
      return;
    }
    if (planAction === 'edit_beat') {
      let chosenBeat = 1;
      if (process.stdin.isTTY) {
        try {
          chosenBeat = await select({
            message: `Select beat in Chapter ${chapterNum} plan to edit:`,
            choices: existingBeats.map((b) => ({
              name: `Beat ${b.num}: ${b.title}`,
              value: b.num
            }))
          });
        } catch {
          chosenBeat = 1;
        }
      }
      await runEditSingleBeatPlanWorkflow({
        chapterNum,
        targetBeatNum: chosenBeat,
        planFile,
        chapterDir,
        existingPlan,
        existingBeats,
        cwd,
        groqClient,
        vectorStore,
        embedder,
        reranker,
        conversationMgr,
        config,
        userGuidance
      });
      return;
    }
    if (planAction === 'add_beat') {
      await runEditSingleBeatPlanWorkflow({
        chapterNum,
        targetBeatNum: 'add',
        planFile,
        chapterDir,
        existingPlan,
        existingBeats,
        cwd,
        groqClient,
        vectorStore,
        embedder,
        reranker,
        conversationMgr,
        config,
        userGuidance
      });
      return;
    }
    if (planAction === 'edit_full_plan') {
      isEditingFullPlan = true;
    }
    // planAction === 'scratch' falls through to regular planning
  }

  console.log(
    isEditingFullPlan
      ? chalk.bold.cyan(`\n  Editing Chapter ${chapterNum} Plan (project/chapter-${padded}/plan.md)`)
      : chalk.bold.cyan(`\n  Planning Chapter ${chapterNum} (project/chapter-${padded}/plan.md)`)
  );

  let guidance = userGuidance;
  if (!guidance && process.stdin.isTTY) {
    try {
      guidance = await input({
        message: isEditingFullPlan
          ? `What changes or improvements would you like to make to Chapter ${chapterNum} plan? (Press Enter for structural polish):`
          : `What happens in Chapter ${chapterNum}? (Brief ideas, character focus, or press Enter for AI direction):`
      });
    } catch {}
  }

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
    rollingSummary: conversationMgr?.getRollingSummary ? conversationMgr.getRollingSummary() : ''
  });

  let currentFeedback = '';
  let accepted = false;
  let finalPlan = '';

  while (!accepted) {
    const planSpinner = createSpinner(
      isEditingFullPlan
        ? `Revising Beat Plan for Chapter ${chapterNum}...`
        : `Drafting Beat Plan for Chapter ${chapterNum}...`
    ).start();

    try {
      const activeStyle = config.enhancedWritingStyle
        ? `${config.enhancedWritingStyle}\n\nAuthor Core Preferences: ${config.writingStyle}`
        : (config.writingStyle || '');

      let userPrompt = '';
      if (isEditingFullPlan) {
        userPrompt = `${hierarchyXml}

<writing_style_and_pacing_rules>
Author's Writing Style & Tone Specification:
${activeStyle || '(Standard literary prose guidelines)'}

CRITICAL: Embody this exact tone, psychological depth, and stylistic pacing in every beat's Action and Goal/Hook description.
</writing_style_and_pacing_rules>

Target: Chapter ${chapterNum}

### EXISTING CHAPTER ${chapterNum} PLAN (FOR REVISION & IMPROVEMENT):
${existingPlan.trim()}

### AUTHOR'S REVISION GUIDANCE & EDITORIAL DIRECTION:
${guidance.trim() || 'Refine the dramatic arc, heighten emotional stakes, improve beat pacing, and ensure seamless transitions between beats.'}
${currentFeedback ? `\nRevision Feedback:\n${currentFeedback}` : ''}

CRITICAL REVISION INSTRUCTIONS:
You are editing and improving the existing Chapter ${chapterNum} plan above according to the author's guidance.
- Retain strong beats, characters, and established events from the existing plan.
- Address the author's revision guidance.
- Output the complete, revised Chapter ${chapterNum} plan matching the strict Beat schema.`;
      } else {
        userPrompt = `${hierarchyXml}

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
      }

      finalPlan = await groqClient.chatCompletion({
        model: 'large',
        messages: [
          { role: 'system', content: PLAN_CHAPTER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: config.generation?.temperaturePlan || 0.6
      });

      planSpinner.succeed(
        isEditingFullPlan
          ? `Revised Chapter ${chapterNum} plan.`
          : `Generated Chapter ${chapterNum} plan.`
      );
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

  // Save plan.md with backup
  await fs.mkdir(chapterDir, { recursive: true });
  if (hasExistingPlan) {
    await createBackup(planFile, cwd);
  }
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
