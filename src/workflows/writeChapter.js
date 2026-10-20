import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import {
  WRITE_BEAT_SYSTEM_PROMPT,
  CHAPTER_SUMMARY_SYSTEM_PROMPT,
  buildHierarchyContext
} from '../llm/prompts.js';
import { loadInstructions } from '../config/configManager.js';
import { createBackup } from '../config/backupManager.js';
import { setActiveBeat } from '../config/stateManager.js';
import { padChapter } from './planChapter.js';
import { createSpinner, printMarkdown } from '../ui/renderer.js';
import { promptReviewWorkflow } from '../ui/reviewPrompt.js';
import { syncAllFiles } from '../rag/fileSync.js';

export function parseBeatsFromPlan(planContent) {
  const beatRegex = /^### Beat (\d+): (.*?)$/gm;
  const indices = [];
  let match;

  while ((match = beatRegex.exec(planContent)) !== null) {
    indices.push({
      index: match.index,
      beatNum: parseInt(match[1], 10),
      title: match[2].trim()
    });
  }

  const beats = [];
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i].index;
    const end = i < indices.length - 1 ? indices[i + 1].index : planContent.length;
    const fullBlock = planContent.slice(start, end).trim();

    const charsMatch = fullBlock.match(/(?:-\s*)?\*\*Characters:\*\*\s*([^\n\r]+)/i);
    const locMatch = fullBlock.match(/(?:-\s*)?\*\*Location:\*\*\s*([^\n\r]+)/i);
    const actMatch = fullBlock.match(/(?:-\s*)?\*\*Action:\*\*\s*([\s\S]*?)(?=(?:(?:-\s*)?\*\*Goal\/Hook:\*\*)|$)/i);
    const goalMatch = fullBlock.match(/(?:-\s*)?\*\*Goal\/Hook:\*\*\s*([\s\S]*?)$/i);

    beats.push({
      num: indices[i].beatNum,
      title: indices[i].title,
      characters: charsMatch ? charsMatch[1].trim() : '',
      location: locMatch ? locMatch[1].trim() : '',
      action: actMatch ? actMatch[1].trim() : '',
      goalHook: goalMatch ? goalMatch[1].trim() : '',
      rawBlock: fullBlock
    });
  }

  return beats;
}

export function getLastNWords(text = '', count = 350) {
  if (!text) return '';
  const words = text.trim().split(/\s+/);
  if (words.length <= count) return text.trim();
  return words.slice(-count).join(' ');
}

export async function getCompletedBeatsInChapter(chapterFilePath) {
  try {
    const content = await fs.readFile(chapterFilePath, 'utf8');
    const matches = [...content.matchAll(/<!-- BEAT (\d+) -->/g)];
    const completedNums = matches.map((m) => parseInt(m[1], 10));
    return {
      completedNums,
      content,
      lastBeatNum: completedNums.length > 0 ? Math.max(...completedNums) : 0
    };
  } catch {
    return { completedNums: [], content: '', lastBeatNum: 0 };
  }
}

/**
 * Safely commits beat prose to chapter.md.
 * Creates a safety backup, replaces only the target beat if already present (for revisions),
 * or appends it cleanly so previous beats are NEVER ruined or overwritten.
 */
export async function commitBeatToChapter({
  chapterFile,
  chapterDir,
  beatNum,
  finalProse,
  cwd = process.cwd()
}) {
  await fs.mkdir(chapterDir, { recursive: true });

  // 1. Safety Backup: Create a backup of chapter.md before modifying so previous manuscript is NEVER lost
  const backupPath = await createBackup(chapterFile, cwd);
  if (backupPath) {
    console.log(chalk.dim(`[Safety Backup] Saved chapter backup to ${path.relative(cwd, backupPath)}`));
  }

  let existing = '';
  try {
    existing = await fs.readFile(chapterFile, 'utf8');
  } catch {}

  const beatMarker = `<!-- BEAT ${beatNum} -->`;
  const beatBlock = `${beatMarker}\n${finalProse.trim()}\n`;

  if (!existing || !existing.trim()) {
    // Fresh chapter file
    await fs.writeFile(chapterFile, `# Chapter Manuscript\n\n${beatBlock}`, 'utf8');
    return;
  }

  // 2. If this beat already exists (e.g. revision or re-write), replace ONLY this beat without affecting earlier or later beats
  if (existing.includes(beatMarker)) {
    // Regex matches from <!-- BEAT N --> up to the next <!-- BEAT \d+ --> or EOF
    const beatSectionRegex = new RegExp(`<!-- BEAT ${beatNum} -->[\\s\\S]*?(?=(?:<!-- BEAT \\d+ -->)|$)`, 'g');
    const updated = existing.replace(beatSectionRegex, `${beatBlock}\n`);
    await fs.writeFile(chapterFile, updated.trim() + '\n', 'utf8');
  } else {
    // Append while preserving all previous beats completely
    const updated = existing.trim() + '\n\n' + beatBlock;
    await fs.writeFile(chapterFile, updated.trim() + '\n', 'utf8');
  }
}

export async function runWriteChapterWorkflow({
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
    console.log(chalk.yellow('Usage: /write <chapter_number> (e.g. /write 1)'));
    return;
  }

  const padded = padChapter(chapterNum);
  const chapterDir = path.join(cwd, 'project', `chapter-${padded}`);
  const planFile = path.join(chapterDir, 'plan.md');
  const chapterFile = path.join(chapterDir, 'chapter.md');
  const summaryFile = path.join(chapterDir, 'summary.md');

  // Verify plan exists
  let planContent = '';
  try {
    planContent = await fs.readFile(planFile, 'utf8');
  } catch {
    console.log(chalk.red(`\nNo plan found at project/chapter-${padded}/plan.md.`));
    console.log(chalk.yellow(`Please run /plan ${chapterNum} first to create a beat plan.`));
    return;
  }

  const beats = parseBeatsFromPlan(planContent);
  if (beats.length === 0) {
    console.log(chalk.red('\nCould not parse any beats from plan.md. Format must match: ### Beat N: [Title]'));
    return;
  }

  console.log(chalk.bold.cyan(`\n  Writing Chapter ${chapterNum} Beat-by-Beat (${beats.length} Beats Total)`));

  // Determine starting beat
  const { completedNums, content: existingProse, lastBeatNum } = await getCompletedBeatsInChapter(chapterFile);
  let currentBeatIndex = 0;

  for (let i = 0; i < beats.length; i++) {
    if (!completedNums.includes(beats[i].num)) {
      currentBeatIndex = i;
      break;
    }
    if (i === beats.length - 1) {
      // All beats are already written
      currentBeatIndex = beats.length;
    }
  }

  if (currentBeatIndex >= beats.length) {
    console.log(chalk.green(`\nAll ${beats.length} beats for Chapter ${chapterNum} are already written!`));
    // Check if summary exists, otherwise generate
    try {
      await fs.access(summaryFile);
      console.log(chalk.dim(`Summary already exists at project/chapter-${padded}/summary.md.`));
    } catch {
      await generateChapterSummary({ chapterNum, chapterFile, summaryFile, groqClient, cwd, vectorStore, embedder, config });
    }
    return;
  }

  const instructions = await loadInstructions(cwd);
  const tailWordLimit = config.generation?.continuityTailWords || 350;

  // Process beats iteratively
  for (let b = currentBeatIndex; b < beats.length; b++) {
    const beat = beats[b];
    console.log(chalk.bold.magenta(`\n========================================`));
    console.log(chalk.bold.magenta(`  Writing Beat ${beat.num} of ${beats.length}: ${beat.title}`));
    console.log(chalk.bold.magenta(`========================================`));
    console.log(chalk.dim(`  Characters: ${beat.characters || 'Unspecified'}`));
    console.log(chalk.dim(`  Location:   ${beat.location || 'Unspecified'}`));
    console.log(chalk.dim(`  Action:     ${beat.action || 'Unspecified'}\n`));

    // 1. Targeted Hybrid RAG for this Beat
    const searchTerms = [beat.characters, beat.location, beat.action].filter(Boolean).join(' ');
    let ragChunks = [];
    if (searchTerms.trim()) {
      try {
        const queryVector = await embedder.embedQuery(searchTerms);
        const candidates = await vectorStore.hybridSearch({
          queryText: searchTerms,
          queryVector,
          vectorTopK: 15,
          bm25TopK: 15
        });
        ragChunks = await reranker.rerank({
          queryText: searchTerms,
          candidates,
          topK: 5
        });
      } catch {}
    }

    const tier1 = ragChunks.filter((c) => Number(c.authority_tier) === 1);
    const tier2 = ragChunks.filter((c) => Number(c.authority_tier) === 2);

    // 2. Continuity Window: Verbatim last N words of existing prose
    const { content: currentManuscript } = await getCompletedBeatsInChapter(chapterFile);
    const lastProseSnippet = getLastNWords(currentManuscript, tailWordLimit);

    // Previous beats summaries in this chapter
    const previousBeatsList = beats.slice(0, b).map((prev) =>
      `- Beat ${prev.num} (${prev.title}): ${prev.action}`
    ).join('\n');

    // 3. Prompt Assembly (Optimized for Groq Prefix Caching)
    const hierarchyXml = buildHierarchyContext({
      instructions,
      tier1Chunks: tier1,
      tier2Chunks: tier2,
      rollingSummary: conversationMgr.getRollingSummary()
    });

    // Static prefix: instructions + full plan
    const systemPrompt = `${hierarchyXml}

<chapter_plan_static_prefix>
${planContent.trim()}
</chapter_plan_static_prefix>

${WRITE_BEAT_SYSTEM_PROMPT}`;

    let beatProse = '';
    let retryFeedback = '';
    let beatAccepted = false;

    while (!beatAccepted) {
      // Dynamic suffix per beat
      const dynamicUserPrompt = `
### Immediate Narrative Continuity:
${previousBeatsList ? `#### Earlier Beats in Chapter ${chapterNum}:\n${previousBeatsList}\n` : ''}
#### Verbatim Final Words from Preceding Scene:
${lastProseSnippet ? `"...${lastProseSnippet}"` : '(Opening of the chapter - establish setting and atmosphere)'}

### TARGET BEAT TO WRITE NOW:
- **Beat Number:** ${beat.num}
- **Beat Title:** ${beat.title}
- **Characters Present:** ${beat.characters}
- **Location:** ${beat.location}
- **Required Action & Beat Event:** ${beat.action}
- **Goal / Scene Hook:** ${beat.goalHook}
${retryFeedback ? `\n### Revision Notes (from previous attempt):\n${retryFeedback}` : ''}

Write the continuous narrative prose for Beat ${beat.num}.`;

      process.stdout.write(chalk.bold.green(`\nGenerating Beat ${beat.num} prose:\n\n`));
      beatProse = '';

      try {
        beatProse = await groqClient.streamChatCompletion({
          model: 'large',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: dynamicUserPrompt }
          ],
          temperature: config.generation?.temperatureWrite || 0.75,
          onChunk: (delta) => {
            process.stdout.write(delta);
          }
        });
        console.log('\n');
      } catch (err) {
        console.error(chalk.red(`\nBeat generation failed: ${err.message}`));
        return;
      }

      // Review Gate
      const review = await promptReviewWorkflow({
        draftContent: beatProse,
        itemLabel: `Beat ${beat.num} Prose`,
        allowPause: true,
        preferredEditor: config.editor
      });

      if (review.action === 'accept') {
        beatAccepted = true;
        const finalProse = review.content.trim();

        // Safely commit beat: backup chapter.md, replace beat if exists or append cleanly
        await commitBeatToChapter({
          chapterFile,
          chapterDir,
          beatNum: beat.num,
          finalProse,
          cwd
        });

        await setActiveBeat(chapterNum, beat.num + 1, cwd);
        console.log(chalk.green(`\nBeat ${beat.num} accepted and committed to project/chapter-${padded}/chapter.md (earlier beats preserved)`));
      } else if (review.action === 'retry') {
        retryFeedback = review.feedback || 'Improve prose flow, pacing, and sensory engagement.';
      } else if (review.action === 'pause') {
        await setActiveBeat(chapterNum, beat.num, cwd);
        console.log(chalk.yellow(`\nPaused at Beat ${beat.num}. Progress saved. You can resume with /write ${chapterNum}`));
        return;
      }
    }
  }

  // All beats written! Chapter Completion Hook
  console.log(chalk.bold.green(`\nChapter ${chapterNum} successfully written to completion!`));
  await generateChapterSummary({ chapterNum, chapterFile, summaryFile, groqClient, cwd, vectorStore, embedder, config });
}

export async function generateChapterSummary({
  chapterNum,
  chapterFile,
  summaryFile,
  groqClient,
  cwd,
  vectorStore,
  embedder,
  config
}) {
  const spinner = createSpinner(`Generating 250-word canonical summary for Chapter ${chapterNum}...`).start();

  try {
    const rawProse = await fs.readFile(chapterFile, 'utf8');
    // Strip beat comments for clean summary
    const cleanProse = rawProse.replace(/<!-- BEAT \d+ -->/g, '').trim();

    const summaryText = await groqClient.chatCompletion({
      model: 'small',
      messages: [
        { role: 'system', content: CHAPTER_SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: `Chapter ${chapterNum} Full Manuscript:\n\n${cleanProse}` }
      ],
      temperature: 0.3,
      sessionId: `chapter_${chapterNum}`,
      workflow: 'CHAPTER_SUMMARY'
    });

    await createBackup(summaryFile, cwd);
    await fs.writeFile(summaryFile, summaryText.trim(), 'utf8');
    spinner.succeed(`Saved summary to project/chapter-${padChapter(chapterNum)}/summary.md`);

    const syncSpinner = createSpinner('Syncing full chapter and canonical summary to LanceDB...').start();
    await syncAllFiles({ cwd, vectorStore, embedder, config });
    syncSpinner.succeed('Chapter and summary indexed into LanceDB.');
  } catch (err) {
    spinner.fail(`Failed to generate chapter summary: ${err.message}`);
  }
}
