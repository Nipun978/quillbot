import fs from 'node:fs/promises';
import path from 'node:path';
import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  PLAN_CHAPTER_SYSTEM_PROMPT,
  PLAN_CHAPTER_HEADER_SYSTEM_PROMPT,
  PLAN_SINGLE_BEAT_SYSTEM_PROMPT,
  GENERATE_BEAT_QUESTIONS_SYSTEM_PROMPT,
  buildHierarchyContext,
  buildStoryBibleContext,
  buildCreativityDirective
} from '../llm/prompts.js';
import { loadInstructions, getCreativityTemperatures, getCreativityExecutionProfile, getExecutionProfile } from '../config/configManager.js';
import { setActiveBeat, loadState } from '../config/stateManager.js';
import { createBackup } from '../config/backupManager.js';
import { parseBeatsFromPlan, parseChapterPlanHeader } from './writeChapter.js';
import { createSpinner, printMarkdown } from '../ui/renderer.js';
import { promptReviewWorkflow, openInEditor } from '../ui/reviewPrompt.js';
import { syncAllFiles } from '../rag/fileSync.js';
import { ensureStdinRaw } from '../ui/ttyManager.js';
import {
  saveCondensedBeatPlan,
  loadPlanningContinuityContext,
  loadStoryContextForChapter,
  condenseBeatPlan,
  condenseChapterPlan,
  loadCondensedBeats
} from '../config/condensedManager.js';

export function padChapter(num) {
  return String(num).padStart(2, '0');
}

function assemblePlanningStyle(config = {}) {
  const enhanced = (config.enhancedWritingStyle || '').trim();
  const core = (config.writingStyle || '').trim();
  if (enhanced && core && core !== enhanced) {
    return `${enhanced}\n\nAuthor Core Preferences: ${core}`;
  }
  return enhanced || core || '';
}

async function retrieveScopedPlanContext({
  searchQuery = '',
  embedder,
  vectorStore,
  reranker,
  topKBible = 5,
  topKSupp = 3
}) {
  if (!searchQuery || !searchQuery.trim() || !embedder || !vectorStore || !reranker) {
    return { tier1: [], tier2: [], tier3: [] };
  }
  try {
    const queryVector = await embedder.embedQuery(searchQuery);
    const bibleCandidates = await vectorStore.hybridSearch({
      queryText: searchQuery,
      queryVector,
      vectorTopK: 15,
      bm25TopK: 15,
      sourceTypes: ['story-bible'],
      authorityTiers: [1]
    });
    const rerankedBible = await reranker.rerank({
      queryText: searchQuery,
      candidates: bibleCandidates,
      topK: topKBible
    });
    const tier1 = rerankedBible.filter((c) => Number(c.authority_tier) === 1);

    let tier2 = [];
    let tier3 = [];
    if (topKSupp > 0) {
      const suppCandidates = await vectorStore.hybridSearch({
        queryText: searchQuery,
        queryVector,
        vectorTopK: 10,
        bm25TopK: 10,
        sourceTypes: ['chapter', 'chapter-summary', 'condensed-story-so-far', 'conversation'],
        authorityTiers: [2, 3]
      });
      if (suppCandidates && suppCandidates.length > 0) {
        const rerankedSupp = await reranker.rerank({
          queryText: searchQuery,
          candidates: suppCandidates,
          topK: topKSupp
        });
        tier2 = rerankedSupp.filter((c) => Number(c.authority_tier) === 2);
        tier3 = rerankedSupp.filter((c) => Number(c.authority_tier) === 3);
      }
    }
    return { tier1, tier2, tier3 };
  } catch {
    return { tier1: [], tier2: [], tier3: [] };
  }
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
    // No beats found yet
    if (planContent.includes('## Beats')) {
      return `${planContent.trim()}\n\n${newBeatBlock.trim()}\n`;
    }
    return `${planContent.trim()}\n\n## Beats\n\n${newBeatBlock.trim()}\n`;
  }

  const preamble = planContent.slice(0, matches[0].index).trimEnd();
  const lastBeatStartIndex = matches[matches.length - 1].index;
  const afterLastBeat = planContent.slice(lastBeatStartIndex);

  let postscript = '';
  const postSectionMatch = afterLastBeat.match(/\n(##\s+[^\n]+[\s\S]*)$/);
  let lastBeatEndIndex = planContent.length;
  if (postSectionMatch) {
    postscript = postSectionMatch[1].trim();
    lastBeatEndIndex = lastBeatStartIndex + postSectionMatch.index;
  }

  const beats = [];
  for (let i = 0; i < matches.length; i++) {
    const num = parseInt(matches[i][1], 10);
    const startIdx = matches[i].index;
    const endIdx = i < matches.length - 1 ? matches[i + 1].index : lastBeatEndIndex;
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
  return postscript
    ? `${preamble}\n\n${beatsText}\n\n${postscript}\n`
    : `${preamble}\n\n${beatsText}\n`;
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
  ensureStdinRaw();
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

  const searchQuery = [guidance, matchedBeat?.title, matchedBeat?.characters, matchedBeat?.location]
    .filter(Boolean)
    .join(' ') || `Chapter ${chapterNum} Beat ${targetNum}`;

  const { tier1, tier2, tier3 } = await retrieveScopedPlanContext({
    searchQuery,
    embedder,
    vectorStore,
    reranker
  });

  spinner.succeed('Context assembled.');

  const hierarchyXml = buildHierarchyContext({
    instructions,
    tier1Chunks: tier1,
    tier2Chunks: tier2,
    pastChapterSummaries: pastSummaries,
    tier3Chunks: tier3,
    rollingSummary: conversationMgr?.getRollingSummary ? conversationMgr.getRollingSummary() : ''
  });

  const activeStyle = assemblePlanningStyle(config);
  const profile = getExecutionProfile('PLAN_BEAT', config);
  const creativityDirective = buildCreativityDirective('off');
  const planTemp = profile.temperaturePlan;
  const reasoningEffort = profile.reasoningEffort;
  const maxTokens = profile.maxTokens;

  // Beats context around this beat
  const otherBeatsContext = existingBeats
    .filter((b) => b.num !== targetNum)
    .map((b) => `- Beat ${b.num} (${b.title}): ${(b.beatOutline || b.action || '').slice(0, 150)}... [Author's Notes: ${(b.authorNotes || b.goalHook || '').slice(0, 100)}]`)
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

${creativityDirective}

<chapter_context>
Chapter ${chapterNum} Surrounding Beats:
${otherBeatsContext || '(No other beats planned yet)'}
</chapter_context>

${isEditingExisting ? `
<current_beat_draft_to_revise>
${matchedBeat.rawBlock}
</current_beat_draft_to_revise>

### REVISION & IMPROVEMENT OBJECTIVE FOR BEAT ${targetNum}:
${guidance || 'Improve the beat structure, deepen character motivation, and ensure smooth scene transitions.'}
` : `
### OBJECTIVE FOR NEW BEAT ${targetNum}:
${guidance || 'Plan an impactful new beat advancing the chapter story arc seamlessly.'}
`}
${currentFeedback ? `\nRevision Feedback from previous attempt:\n${currentFeedback}` : ''}

Generate the streamlined planning blueprint for Beat ${targetNum} matching:
### Beat ${targetNum}: [Short Beat Title]
- **Characters:** [Comma-separated character names matching Story Bible]
- **Setting:** [Location and time/environment]
- **Beat Outline:** [Concise, deterministic narrative progression containing ONLY details the author specified. Include author's verbatim dialogue in quotes. If the encounter is non-verbal/silent, state that no words are spoken—NEVER invent greetings, small-talk, or spoken dialogue not indicated by the author.]
- **Author's Notes:** [Captures how and what the author wants to achieve: the emotional texture, subtext, and creative vision for this specific beat.]
- **Beat Instructions:** [Concise beat-level prose directives: pacing, tone, and emotional distance. NO camera/screenplay jargon.]`;

      if (groqClient?.quotaManager) {
        const cd = config?.cooldownSeconds !== undefined ? config.cooldownSeconds : (process.stdin?.isTTY ? 45 : 0);
        await groqClient.quotaManager.enforceGenerationCooldown({
          cooldownSeconds: cd,
          isPaid: config?.apiTier === 'paid' || config?.apiTier === 'developer'
        });
      }

      finalBeatPlan = await groqClient.chatCompletion({
        model: 'large',
        messages: [
          { role: 'system', content: PLAN_SINGLE_BEAT_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: planTemp,
        maxTokens,
        reasoningEffort,
        sessionId: `plan_chapter_${chapterNum}_beat_${targetNum}`,
        workflow: 'PLAN_BEAT'
      });

      beatSpinner.succeed(`Generated Beat ${targetNum} plan.`);
      if (groqClient?.quotaManager) {
        groqClient.quotaManager.recordGenerationEnd();
      }
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
      preferredEditor: config.editor,
      quotaManager: groqClient?.quotaManager,
      config,
      model: config.models?.large || 'openai/gpt-oss-120b'
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

  // Condense beat plan in .condensed/chapters/chapter-XX/plan.md
  const updatedBeats = parseBeatsFromPlan(updatedPlan);
  const matched = updatedBeats.find((b) => b.num === targetNum) || { num: targetNum, title: `Beat ${targetNum}`, rawBlock: finalBeatPlan };
  const condenseSpinner = createSpinner(`Condensing Beat ${targetNum} plan with 20B model...`).start();
  try {
    await saveCondensedBeatPlan({
      chapterNum,
      beatNum: targetNum,
      beatTitle: matched.title,
      planText: finalBeatPlan,
      groqClient,
      cwd,
      config
    });
    condenseSpinner.succeed(`Beat ${targetNum} plan condensed into .condensed/chapters/chapter-${padded}/plan.md`);
  } catch (err) {
    condenseSpinner.fail(`Failed to condense Beat ${targetNum} plan: ${err.message}`);
  }

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
    ensureStdinRaw();
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
    ensureStdinRaw();
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
      ensureStdinRaw();
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
  ensureStdinRaw();
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

  // Scoped Story Bible + supplemental RAG matching guidance
  const searchQuery = guidance.trim() || `Chapter ${chapterNum} plot progression and characters`;
  const { tier1, tier2, tier3 } = await retrieveScopedPlanContext({
    searchQuery,
    embedder,
    vectorStore,
    reranker
  });

  spinner.succeed('Context assembled.');

  const hierarchyXml = buildHierarchyContext({
    instructions,
    tier1Chunks: tier1,
    tier2Chunks: tier2,
    pastChapterSummaries: pastSummaries,
    tier3Chunks: tier3,
    rollingSummary: conversationMgr?.getRollingSummary ? conversationMgr.getRollingSummary() : ''
  });

  let finalPlan = '';
  const condensedBeatNums = new Set();
  const profile = getExecutionProfile('PLAN_CHAPTER', config);
  const creativityDirective = buildCreativityDirective('off');
  const planTemp = profile.temperaturePlan;
  const reasoningEffort = profile.reasoningEffort;
  const maxTokens = profile.maxTokens;

  if (!isEditingFullPlan) {
    // REQUIREMENT 9: Planning a chapter without a specific target beat works beat-by-beat over multiple requests
    console.log(chalk.bold.cyan(`\n  Step 1: Planning Chapter ${chapterNum} Foundation (Summary & Instructions)...`));

    const chapterAuthorOutline = guidance.trim();
    const activeStyle = assemblePlanningStyle(config);

    // 1. Plan Chapter Header
    let headerAccepted = false;
    let headerFeedback = '';
    let chapterHeaderContent = '';

    while (!headerAccepted) {
      const headerSpinner = createSpinner(`Drafting Chapter ${chapterNum} Summary & Chapter Instructions...`).start();
      try {
        const headerPrompt = `${hierarchyXml}

Target: Chapter ${chapterNum}
Author Guidance / Core Conflict:
${guidance.trim() || '(Rely on Story Bible and previous chapter arc)'}

${creativityDirective}
${headerFeedback ? `\nRevision Feedback:\n${headerFeedback}` : ''}

Draft the Chapter Title, Chapter Summary (1-2 paragraphs), and Chapter Instructions (under 50 words) adhering strictly to the schema.`;

        if (groqClient?.quotaManager) {
          const cd = config?.cooldownSeconds !== undefined ? config.cooldownSeconds : (process.stdin?.isTTY ? 45 : 0);
          await groqClient.quotaManager.enforceGenerationCooldown({
            cooldownSeconds: cd,
            isPaid: config?.apiTier === 'paid' || config?.apiTier === 'developer'
          });
        }

        chapterHeaderContent = await groqClient.chatCompletion({
          model: 'large',
          messages: [
            { role: 'system', content: PLAN_CHAPTER_HEADER_SYSTEM_PROMPT },
            { role: 'user', content: headerPrompt }
          ],
          temperature: planTemp,
          maxTokens,
          reasoningEffort,
          sessionId: `plan_chapter_${chapterNum}`,
          workflow: 'PLAN_CHAPTER_HEADER'
        });

        headerSpinner.succeed(`Drafted Chapter ${chapterNum} Foundation.`);
        if (groqClient?.quotaManager) {
          groqClient.quotaManager.recordGenerationEnd();
        }
      } catch (err) {
        headerSpinner.fail(`Failed to draft chapter foundation: ${err.message}`);
        return;
      }

      console.log('\n' + chalk.bold.magenta(`--- Chapter ${chapterNum} Foundation Preview ---`));
      printMarkdown(chapterHeaderContent);

      const review = await promptReviewWorkflow({
        draftContent: chapterHeaderContent,
        itemLabel: `Chapter ${chapterNum} Foundation`,
        allowPause: false,
        preferredEditor: config.editor,
        quotaManager: groqClient?.quotaManager,
        config,
        model: config.models?.large || 'openai/gpt-oss-120b'
      });

      if (review.action === 'accept') {
        chapterHeaderContent = review.content.trim();
        headerAccepted = true;
      } else if (review.action === 'retry') {
        headerFeedback = review.feedback || 'Please refine the chapter summary and tone instructions.';
      }
    }

    // Save initial skeleton plan.md
    await fs.mkdir(chapterDir, { recursive: true });
    let currentPlanMarkdown = `${chapterHeaderContent}\n\n## Beats\n`;
    await fs.writeFile(planFile, currentPlanMarkdown, 'utf8');

    // Parse header
    const { title: chTitle, chapterSummary: chSummary, chapterInstructions: chInstructions } = parseChapterPlanHeader(currentPlanMarkdown);

    // 2. Plan Beats sequentially over multiple requests (Beats 1, 2, 3...)
    let currentBeatNum = 1;
    let continuePlanningBeats = true;

    while (continuePlanningBeats) {
      console.log(chalk.bold.cyan(`\n  Step 2.${currentBeatNum}: Planning Beat ${currentBeatNum} for Chapter ${chapterNum}`));

      let beatGuidance = '';
      ensureStdinRaw();
      if (process.stdin.isTTY) {
        try {
          beatGuidance = await input({
            message: `What should happen in Beat ${currentBeatNum}? (Brief ideas or press Enter for AI direction):`
          });
        } catch {}
      }

      const existingPlanSoFar = await fs.readFile(planFile, 'utf8');
      const beatsSoFar = parseBeatsFromPlan(existingPlanSoFar);

      // Requirement 5: Story So Far (1..N-2) & Preceding Chapter Summary (N-1) loaded deterministically
      const { storySoFar, previousChapterSummary } = await loadStoryContextForChapter({
        currentChapterNum: chapterNum,
        cwd
      });

      // Requirement 5: Complete plan of Beat K-1 & condensed plans of prior beats
      const { previousBeatPlan, priorCondensedPlans } = await loadPlanningContinuityContext({
        chapterNum,
        activeBeatNum: currentBeatNum,
        allBeatsInPlan: beatsSoFar,
        cwd
      });

      // Re-query Story Bible canon specifically for this beat's guidance so characters/locations
      // introduced mid-chapter don't miss their Tier 1 canon entries
      let beatTier1 = tier1;
      const perBeatQuery = [beatGuidance, chTitle, previousBeatPlan?.slice(0, 200)].filter(Boolean).join(' ');
      if (perBeatQuery.trim()) {
        const beatRag = await retrieveScopedPlanContext({
          searchQuery: perBeatQuery,
          embedder,
          vectorStore,
          reranker,
          topKBible: 5,
          topKSupp: 0
        });
        if (beatRag.tier1.length > 0) {
          const seenIds = new Set(beatRag.tier1.map((c) => c.id));
          beatTier1 = [...beatRag.tier1, ...tier1.filter((c) => !seenIds.has(c.id))].slice(0, 5);
        }
      }

      let beatPlanDraft = '';
      let beatAccepted = false;
      let beatFeedback = '';

      while (!beatAccepted) {
        const beatSpinner = createSpinner(`Drafting Beat ${currentBeatNum} Plan...`).start();
        try {
          const storyBibleXml = beatTier1.length > 0 ? buildStoryBibleContext(beatTier1) : '';
          const sysInstrXml = instructions && instructions.trim()
            ? `<system_instructions>\n${instructions.trim()}\n</system_instructions>\n\n`
            : '';

          const macroContinuityBlock = [
            storySoFar ? `### Story So Far (Chapters 1 to ${Math.max(1, chapterNum - 2)}):\n${storySoFar}` : '',
            previousChapterSummary ? `### Chapter ${chapterNum - 1} Summary:\n${previousChapterSummary}` : ''
          ].filter(Boolean).join('\n\n');

          const beatContextBlock = [
            priorCondensedPlans.length > 0 ? `### Prior Beats in Chapter ${chapterNum} (Condensed Plans):\n${priorCondensedPlans.map((p) => `- ${p}`).join('\n')}` : '',
            previousBeatPlan ? `### Immediate Preceding Beat Plan (Beat ${currentBeatNum - 1} Full Plan):\n${previousBeatPlan}` : ''
          ].filter(Boolean).join('\n\n') || '(First beat of this chapter)';

          const beatUserPrompt = `${sysInstrXml}${storyBibleXml ? `${storyBibleXml}\n\n` : ''}${macroContinuityBlock ? `<macro_story_continuity>\n${macroContinuityBlock}\n</macro_story_continuity>\n\n` : ''}${chapterAuthorOutline ? `<chapter_author_outline>\nFull Chapter Arc & Milestones specified by Author:\n${chapterAuthorOutline}\n</chapter_author_outline>\n\n` : ''}<chapter_foundation>
Chapter Title: ${chTitle || `Chapter ${chapterNum}`}
Chapter Summary: ${chSummary}
${chInstructions ? `Chapter Instructions: ${chInstructions}` : ''}
</chapter_foundation>

<chapter_beats_context>
${beatContextBlock}
</chapter_beats_context>

${creativityDirective}

### OBJECTIVE FOR BEAT ${currentBeatNum}:
${beatGuidance.trim() || (chapterAuthorOutline ? `Execute Beat ${currentBeatNum} precisely as specified in <chapter_author_outline>. Obey the exact sequence, verbatim dialogue, and intentional silences.` : 'Advance the chapter narrative arc with concrete character tension and pacing.')}
${beatFeedback ? `\nRevision Feedback from previous attempt:\n${beatFeedback}` : ''}

Generate the streamlined planning blueprint for Beat ${currentBeatNum} matching:
### Beat ${currentBeatNum}: [Short Beat Title]
- **Characters:** [Comma-separated character names matching Story Bible]
- **Setting:** [Location and time/environment]
- **Beat Outline:** [Concise, deterministic narrative progression containing ONLY details the author specified. Include author's verbatim dialogue in quotes. If the encounter is non-verbal/silent, state that no words are spoken—NEVER invent greetings, small-talk, or spoken dialogue not indicated by the author.]
- **Author's Notes:** [Captures how and what the author wants to achieve: the emotional texture, subtext, and creative vision for this specific beat.]
- **Beat Instructions:** [Concise beat-level prose directives: pacing, tone, and emotional distance. NO camera/screenplay jargon.]`;

          if (groqClient?.quotaManager) {
            const cd = config?.cooldownSeconds !== undefined ? config.cooldownSeconds : (process.stdin?.isTTY ? 45 : 0);
            await groqClient.quotaManager.enforceGenerationCooldown({
              cooldownSeconds: cd,
              isPaid: config?.apiTier === 'paid' || config?.apiTier === 'developer'
            });
          }

          beatPlanDraft = await groqClient.chatCompletion({
            model: 'large',
            messages: [
              { role: 'system', content: PLAN_SINGLE_BEAT_SYSTEM_PROMPT },
              { role: 'user', content: beatUserPrompt }
            ],
            temperature: planTemp,
            maxTokens,
            reasoningEffort,
            sessionId: `plan_chapter_${chapterNum}_beat_${currentBeatNum}`,
            workflow: 'PLAN_CHAPTER_BEAT'
          });

          beatSpinner.succeed(`Drafted Beat ${currentBeatNum} Plan.`);
          if (groqClient?.quotaManager) {
            groqClient.quotaManager.recordGenerationEnd();
          }
        } catch (err) {
          beatSpinner.fail(`Failed to draft beat plan: ${err.message}`);
          return;
        }

        console.log('\n' + chalk.bold.magenta(`--- Beat ${currentBeatNum} Plan Preview ---`));
        printMarkdown(beatPlanDraft);

        const beatReview = await promptReviewWorkflow({
          draftContent: beatPlanDraft,
          itemLabel: `Chapter ${chapterNum} Beat ${currentBeatNum} Plan`,
          allowPause: true,
          preferredEditor: config.editor,
          quotaManager: groqClient?.quotaManager,
          config,
          model: config.models?.large || 'openai/gpt-oss-120b'
        });

        if (beatReview.action === 'accept') {
          beatPlanDraft = beatReview.content.trim();
          beatAccepted = true;

          // Append to plan.md
          currentPlanMarkdown = updateBeatInPlan(currentPlanMarkdown, currentBeatNum, beatPlanDraft);
          await fs.writeFile(planFile, currentPlanMarkdown, 'utf8');

          // Condense beat in .condensed/chapters/chapter-XX/plan.md
          const allBeats = parseBeatsFromPlan(currentPlanMarkdown);
          const currentBeatObj = allBeats.find((b) => b.num === currentBeatNum) || { num: currentBeatNum, title: `Beat ${currentBeatNum}`, rawBlock: beatPlanDraft };
          const condenseSpinner = createSpinner(`Condensing Beat ${currentBeatNum} plan with 20B model...`).start();
          try {
            await saveCondensedBeatPlan({
              chapterNum,
              beatNum: currentBeatNum,
              beatTitle: currentBeatObj.title,
              planText: beatPlanDraft,
              groqClient,
              cwd,
              config
            });
            condensedBeatNums.add(currentBeatNum);
            condenseSpinner.succeed(`Beat ${currentBeatNum} plan condensed into .condensed/chapters/chapter-${padded}/plan.md`);
          } catch (err) {
            condenseSpinner.fail(`Failed to condense Beat ${currentBeatNum} plan: ${err.message}`);
          }

          console.log(chalk.green(`\nBeat ${currentBeatNum} saved into project/chapter-${padded}/plan.md`));

          // Ask to continue or finish
          if (currentBeatNum >= 2 && process.stdin.isTTY) {
            ensureStdinRaw();
            try {
              const nextChoice = await select({
                message: `Beat ${currentBeatNum} planned. What would you like to do next?`,
                choices: [
                  { name: `Plan Beat ${currentBeatNum + 1}`, value: 'next' },
                  { name: `Finish Chapter ${chapterNum} Plan (${currentBeatNum} beats total)`, value: 'finish' }
                ]
              });
              if (nextChoice === 'finish') {
                continuePlanningBeats = false;
              } else {
                currentBeatNum++;
              }
            } catch {
              if (currentBeatNum >= 3) {
                continuePlanningBeats = false;
              } else {
                currentBeatNum++;
              }
            }
          } else {
            // Default 3 beats if non-TTY or tests
            if (currentBeatNum >= 3 && !process.stdin.isTTY) {
              continuePlanningBeats = false;
            } else {
              currentBeatNum++;
            }
          }
        } else if (beatReview.action === 'retry') {
          beatFeedback = beatReview.feedback || 'Please refine the action, character motivation, and scene instructions.';
        } else if (beatReview.action === 'pause') {
          try {
            await syncAllFiles({ cwd, vectorStore, embedder, config });
          } catch {}
          console.log(chalk.yellow(`\nPlanning paused at Beat ${currentBeatNum}. Progress saved in project/chapter-${padded}/plan.md. Resume with /plan ${chapterNum}`));
          return;
        }
      }
    }

    finalPlan = currentPlanMarkdown;
  } else {
    // isEditingFullPlan: revise full plan
    let currentFeedback = '';
    let accepted = false;

    while (!accepted) {
      const planSpinner = createSpinner(`Revising Beat Plan for Chapter ${chapterNum}...`).start();

      try {
        const activeStyle = assemblePlanningStyle(config);

        const userPrompt = `${hierarchyXml}

<writing_style_and_pacing_rules>
Author's Writing Style & Tone Specification:
${activeStyle || '(Standard literary prose guidelines)'}

CRITICAL: Embody the author's intended tone, emotional restraint, and stylistic pacing in every beat's Beat Outline and Author's Notes.
</writing_style_and_pacing_rules>

Target: Chapter ${chapterNum}

### EXISTING CHAPTER ${chapterNum} PLAN (FOR REVISION & IMPROVEMENT):
${existingPlan.trim()}

${creativityDirective}

### AUTHOR'S REVISION GUIDANCE & EDITORIAL DIRECTION:
${guidance.trim() || 'Refine the dramatic arc, heighten emotional stakes, improve beat pacing, and ensure seamless transitions between beats.'}
${currentFeedback ? `\nRevision Feedback:\n${currentFeedback}` : ''}

CRITICAL REVISION INSTRUCTIONS:
You are editing and improving the existing Chapter ${chapterNum} plan above according to the author's guidance.
- Retain strong beats, characters, and established events from the existing plan.
- Address the author's revision guidance.
- Output the complete, revised Chapter ${chapterNum} plan matching the streamlined Beat blueprint schema (Characters, Setting, Beat Outline, Author's Notes, Beat Instructions).`;

        if (groqClient?.quotaManager) {
          const cd = config?.cooldownSeconds !== undefined ? config.cooldownSeconds : (process.stdin?.isTTY ? 45 : 0);
          await groqClient.quotaManager.enforceGenerationCooldown({
            cooldownSeconds: cd,
            isPaid: config?.apiTier === 'paid' || config?.apiTier === 'developer'
          });
        }

        finalPlan = await groqClient.chatCompletion({
          model: 'large',
          messages: [
            { role: 'system', content: PLAN_CHAPTER_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
          ],
          temperature: planTemp,
          maxTokens,
          reasoningEffort,
          sessionId: `plan_chapter_${chapterNum}`,
          workflow: 'PLAN_CHAPTER'
        });

        planSpinner.succeed(`Revised Chapter ${chapterNum} plan.`);
        if (groqClient?.quotaManager) {
          groqClient.quotaManager.recordGenerationEnd();
        }
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
        preferredEditor: config.editor,
        quotaManager: groqClient?.quotaManager,
        config,
        model: config.models?.large || 'openai/gpt-oss-120b'
      });

      if (review.action === 'accept') {
        finalPlan = review.content;
        accepted = true;
      } else if (review.action === 'retry') {
        currentFeedback = review.feedback || 'Please refine beat pacing and dramatic turns.';
      }
    }
  }

  // Requirement: 120B Open Questions at high reasoning upon finishing chapter plan
  if (config.groqApiKey && !finalPlan.includes('## Author Clarifications & Beat Directives')) {
    console.log(chalk.bold.cyan('\n  Formulating beat clarifying questions (120B model)...'));
    const questionsProfile = getExecutionProfile('PLAN_BEAT_QUESTIONS', config);
    const qSpinner = createSpinner('Generating open clarifying questions per beat...').start();
    let beatQuestionsDraft = '';
    try {
      const qPrompt = `Project Title: ${config.projectTitle || 'Novel'}
Target: Chapter ${chapterNum} Plan

${finalPlan.trim()}`;

      beatQuestionsDraft = await groqClient.chatCompletion({
        model: 'large',
        messages: [
          { role: 'system', content: GENERATE_BEAT_QUESTIONS_SYSTEM_PROMPT },
          { role: 'user', content: qPrompt }
        ],
        temperature: questionsProfile.temperaturePlan,
        maxTokens: questionsProfile.maxTokens,
        reasoningEffort: questionsProfile.reasoningEffort,
        sessionId: `plan_questions_chapter_${chapterNum}`,
        workflow: 'PLAN_BEAT_QUESTIONS'
      });
      qSpinner.succeed('Beat clarifying questions generated.');
    } catch (err) {
      qSpinner.warn(`Skipping beat questions generation: ${err.message}`);
    }

    if (beatQuestionsDraft && beatQuestionsDraft.trim()) {
      console.log(chalk.cyan('Opening questions in your editor. Add your beat-specific directives/answers, then save and close.'));
      try {
        const answeredQuestions = await openInEditor(beatQuestionsDraft, config.editor);
        if (answeredQuestions && answeredQuestions.trim() && answeredQuestions.trim() !== beatQuestionsDraft.trim()) {
          finalPlan = `${finalPlan.trim()}\n\n## Author Clarifications & Beat Directives\n\n${answeredQuestions.trim()}\n`;
          console.log(chalk.green('✓ Author beat clarifications appended to chapter plan.'));
        } else {
          console.log(chalk.dim('No additional beat clarifications entered.'));
        }
      } catch (err) {
        console.log(chalk.yellow(`Could not open editor (${err.message}). Continuing without beat clarifications.`));
      }
    }
  }

  // Save plan.md with backup
  await fs.mkdir(chapterDir, { recursive: true });
  if (hasExistingPlan) {
    await createBackup(planFile, cwd);
  }
  await fs.writeFile(planFile, finalPlan, 'utf8');
  await setActiveBeat(chapterNum, 1, cwd);

  // Condense any chapter beats into .condensed/chapters/chapter-XX/plan.md not already condensed during the loop
  const finalBeats = parseBeatsFromPlan(finalPlan);
  const beatsToCondense = finalBeats.filter((b) => !condensedBeatNums.has(b.num));
  if (beatsToCondense.length > 0) {
    const condenseSpinner = createSpinner(`Syncing ${beatsToCondense.length} beat(s) into .condensed/chapters/chapter-${padded}/plan.md...`).start();
    try {
      for (const b of beatsToCondense) {
        await saveCondensedBeatPlan({
          chapterNum,
          beatNum: b.num,
          beatTitle: b.title,
          planText: b.rawBlock,
          groqClient,
          cwd,
          config
        });
      }
      condenseSpinner.succeed(`Synced ${beatsToCondense.length} beat(s) into .condensed/chapters/chapter-${padded}/plan.md`);
    } catch (err) {
      condenseSpinner.fail(`Failed to sync condensed beats: ${err.message}`);
    }
  }

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
