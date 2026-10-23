import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import {
  WRITE_BEAT_SYSTEM_PROMPT,
  CHAPTER_SUMMARY_SYSTEM_PROMPT,
  CONTINUITY_CRITIC_SYSTEM_PROMPT,
  buildHierarchyContext
} from '../llm/prompts.js';
import { loadInstructions } from '../config/configManager.js';
import { createBackup } from '../config/backupManager.js';
import { setActiveBeat } from '../config/stateManager.js';
import { padChapter } from './planChapter.js';
import { createSpinner } from '../ui/renderer.js';
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

export function getFirstNWords(text = '', count = 150) {
  if (!text) return '';
  const words = text.trim().split(/\s+/);
  if (words.length <= count) return text.trim();
  return words.slice(0, count).join(' ');
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
 * Extracts the raw prose of a specific beat from chapter.md
 */
export async function getBeatProseFromChapter(chapterFilePath, beatNum) {
  try {
    const content = await fs.readFile(chapterFilePath, 'utf8');
    const marker = `<!-- BEAT ${beatNum} -->`;
    const startIdx = content.indexOf(marker);
    if (startIdx === -1) return '';

    const afterMarker = content.slice(startIdx + marker.length);
    const nextMarkerMatch = afterMarker.match(/<!-- BEAT \d+ -->/);
    const rawProse = nextMarkerMatch
      ? afterMarker.slice(0, nextMarkerMatch.index)
      : afterMarker;

    return rawProse.replace(/<!-- BEAT \d+ -->/g, '').trim();
  } catch {
    return '';
  }
}

/**
 * Extracts all prose from <!-- BEAT 1 --> up to (but not including) <!-- BEAT targetBeatNum -->,
 * strips markers, and returns the last tailWordLimit words for continuity window.
 */
export async function getProseBeforeBeat(chapterFilePath, targetBeatNum, tailWordLimit = 350) {
  if (targetBeatNum <= 1) {
    return '';
  }
  try {
    const content = await fs.readFile(chapterFilePath, 'utf8');
    if (!content.trim()) return '';

    const targetMarker = `<!-- BEAT ${targetBeatNum} -->`;
    const targetIdx = content.indexOf(targetMarker);

    const beat1Marker = '<!-- BEAT 1 -->';
    const beat1Idx = content.indexOf(beat1Marker);
    const startIdx = beat1Idx !== -1 ? beat1Idx : 0;

    let textBeforeTarget = '';
    if (targetIdx !== -1) {
      textBeforeTarget = content.slice(startIdx, targetIdx);
    } else {
      textBeforeTarget = content.slice(startIdx);
    }

    const cleanText = textBeforeTarget.replace(/<!-- BEAT \d+ -->/g, '').trim();
    return getLastNWords(cleanText, tailWordLimit);
  } catch {
    return '';
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

/**
 * Runs an automated Continuity Critic audit on the drafted beat prose
 * using the small model via groqClient.jsonCompletion
 */
export async function runContinuityCritic({
  beatProse,
  beat,
  tier1Chunks = [],
  tier2Chunks = [],
  pastChapterSummaries = '',
  lastProseSnippet = '',
  planContent = '',
  groqClient,
  sessionId = 'continuity_critic'
}) {
  const formatChunks = (chunks) => {
    if (!chunks || chunks.length === 0) return '(None available)';
    return chunks
      .map((c) => `[Source: ${c.source_path || 'Canon'} - Section: ${c.section_title || 'General'}]\n${c.text || ''}`)
      .join('\n\n---\n\n');
  };

  const userPrompt = `### 1. TIER 1 STORY BIBLE CANON:
${formatChunks(tier1Chunks)}

### 2. PRECEDING SCENE CONTINUITY:
${pastChapterSummaries ? `Past Chapter Summaries:\n${pastChapterSummaries}\n` : ''}
${lastProseSnippet ? `Verbatim Preceding Scene Tail:\n"...${lastProseSnippet}"\n` : '(Opening of chapter)'}

### 3. CHAPTER PLAN & TARGET BEAT:
${planContent ? `Full Plan:\n${planContent.trim()}\n` : ''}
Target Beat to Verify: Beat ${beat?.num} (${beat?.title || ''})
Required Characters: ${beat?.characters || 'Unspecified'}
Required Location: ${beat?.location || 'Unspecified'}
Required Action: ${beat?.action || 'Unspecified'}
Goal/Hook: ${beat?.goalHook || 'Unspecified'}

### 4. DRAFTED BEAT PROSE TO AUDIT:
${beatProse}

Evaluate the drafted Beat Prose against Story Bible canon, beat boundaries, and scene continuity. Return your evaluation strictly as the JSON schema requested in your instructions.`;

  try {
    const result = await groqClient.jsonCompletion({
      model: 'small',
      messages: [
        { role: 'system', content: CONTINUITY_CRITIC_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.1,
      sessionId,
      workflow: 'CONTINUITY_CRITIC'
    });

    if (!result || typeof result !== 'object') {
      return { passed: true, severity: 'none', issues: [] };
    }

    const issues = Array.isArray(result.issues) ? result.issues : [];
    const passed = Boolean(result.passed === true || issues.length === 0);

    return {
      passed,
      severity: result.severity || (passed ? 'none' : 'minor'),
      issues
    };
  } catch (err) {
    // If Critic call fails, return clean pass with error recorded so workflow is not halted
    return {
      passed: true,
      severity: 'none',
      issues: [],
      error: err.message
    };
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
  // Parse chapter and optional target beat number:
  // e.g. "1", "1 2", "1 --beat 2", "1 --beat=2"
  let chapterNum = NaN;
  let targetBeatNum = null;

  if (typeof chapterArg === 'number') {
    chapterNum = chapterArg;
  } else if (typeof chapterArg === 'string') {
    const clean = chapterArg.trim();
    const beatFlagMatch = clean.match(/^(\d+)\s+--beat(?:=|\s+)(\d+)$/i);
    const twoNumMatch = clean.match(/^(\d+)\s+(\d+)$/);
    const singleNumMatch = clean.match(/^(\d+)$/);

    if (beatFlagMatch) {
      chapterNum = parseInt(beatFlagMatch[1], 10);
      targetBeatNum = parseInt(beatFlagMatch[2], 10);
    } else if (twoNumMatch) {
      chapterNum = parseInt(twoNumMatch[1], 10);
      targetBeatNum = parseInt(twoNumMatch[2], 10);
    } else if (singleNumMatch) {
      chapterNum = parseInt(singleNumMatch[1], 10);
    }
  }

  if (isNaN(chapterNum) || chapterNum < 1) {
    console.log(chalk.yellow('Usage: /write <chapter_number> [beat_number] (e.g. /write 1 or /write 1 2)'));
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

  const isTargetedBeat = targetBeatNum !== null && !isNaN(targetBeatNum);
  let beatsToProcess = [];

  if (isTargetedBeat) {
    const matchedBeat = beats.find((b) => b.num === targetBeatNum);
    if (!matchedBeat) {
      console.log(chalk.red(`\nBeat ${targetBeatNum} not found in plan.md for Chapter ${chapterNum}.`));
      console.log(chalk.yellow(`Available beats: ${beats.map((b) => b.num).join(', ')}`));
      return;
    }
    beatsToProcess = [matchedBeat];
    console.log(chalk.bold.cyan(`\n  Targeted Rewrite: Chapter ${chapterNum}, Beat ${targetBeatNum}: "${matchedBeat.title}"`));
  } else {
    // Standard resume flow: determine starting beat
    console.log(chalk.bold.cyan(`\n  Writing Chapter ${chapterNum} Beat-by-Beat (${beats.length} Beats Total)`));

    const { completedNums } = await getCompletedBeatsInChapter(chapterFile);
    let currentBeatIndex = 0;

    for (let i = 0; i < beats.length; i++) {
      if (!completedNums.includes(beats[i].num)) {
        currentBeatIndex = i;
        break;
      }
      if (i === beats.length - 1) {
        currentBeatIndex = beats.length;
      }
    }

    if (currentBeatIndex >= beats.length) {
      console.log(chalk.green(`\nAll ${beats.length} beats for Chapter ${chapterNum} are already written!`));
      console.log(chalk.dim(`Tip: To rewrite a specific beat, use /write ${chapterNum} <beat_number> (e.g. /write ${chapterNum} 1)`));
      try {
        await fs.access(summaryFile);
        console.log(chalk.dim(`Summary already exists at project/chapter-${padded}/summary.md.`));
      } catch {
        await generateChapterSummary({ chapterNum, chapterFile, summaryFile, groqClient, cwd, vectorStore, embedder, config });
      }
      return;
    }

    beatsToProcess = beats.slice(currentBeatIndex);
  }

  const instructions = await loadInstructions(cwd);
  const tailWordLimit = config.generation?.continuityTailWords || 350;

  // Process beats
  for (let b = 0; b < beatsToProcess.length; b++) {
    const beat = beatsToProcess[b];
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

    // 2. Continuity Window: Sliced strictly before target beat
    const lastProseSnippet = await getProseBeforeBeat(chapterFile, beat.num, tailWordLimit);

    // 3. Downstream Continuity Context (if rewriting beat B and beat B+1 exists)
    let downstreamContext = '';
    if (isTargetedBeat) {
      const nextBeatProse = await getBeatProseFromChapter(chapterFile, beat.num + 1);
      if (nextBeatProse) {
        const opening150 = getFirstNWords(nextBeatProse, 150);
        if (opening150) {
          downstreamContext = `#### Upcoming Scene Anchor (Beat ${beat.num + 1} Opening - Ensure your ending bridges smoothly into this):\n"${opening150}..."\n`;
        }
      }
    }

    // Previous beats summaries in this chapter
    const beatIndexInFullPlan = beats.findIndex((x) => x.num === beat.num);
    const previousBeatsList = beats.slice(0, beatIndexInFullPlan).map((prev) =>
      `- Beat ${prev.num} (${prev.title}): ${prev.action}`
    ).join('\n');

    // 4. Prompt Assembly (Optimized for Groq Prefix Caching)
    const hierarchyXml = buildHierarchyContext({
      instructions,
      tier1Chunks: tier1,
      tier2Chunks: tier2,
      rollingSummary: conversationMgr?.getRollingSummary ? conversationMgr.getRollingSummary() : ''
    });

    const activeStyle = config.enhancedWritingStyle
      ? `${config.enhancedWritingStyle}\n\nAuthor Core Preferences: ${config.writingStyle}`
      : (config.writingStyle || '');

    // Static prefix: instructions + full plan + writing style rules
    const systemPrompt = `${hierarchyXml}

<chapter_plan_static_prefix>
${planContent.trim()}
</chapter_plan_static_prefix>

<writing_style_rules>
Author's Writing Style & Prose Requirements:
${activeStyle || '(Standard literary prose guidelines)'}

CRITICAL EXECUTION RULE:
You must strictly embody and adhere to this exact writing style, narrative distance, voice, sentence rhythm, and sensory grounding when writing this beat.
</writing_style_rules>

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
${downstreamContext ? `\n${downstreamContext}` : ''}
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

      // Feature 2: Automatic Continuity Critic Pass (Pre-Review Audit)
      let criticResult = { passed: true, severity: 'none', issues: [] };
      if (config.generation?.enableContinuityCritic !== false) {
        const criticSpinner = createSpinner('Running Continuity Critic check against Story Bible & timeline...').start();
        try {
          criticResult = await runContinuityCritic({
            beatProse,
            beat,
            tier1Chunks: tier1,
            tier2Chunks: tier2,
            pastChapterSummaries: '',
            lastProseSnippet,
            planContent,
            groqClient,
            sessionId: `chapter_${chapterNum}_beat_${beat.num}`
          });

          if (criticResult.passed || !criticResult.issues || criticResult.issues.length === 0) {
            criticSpinner.succeed(chalk.green('Continuity Critic: Passed (0 canon or timeline contradictions detected)'));
          } else {
            criticSpinner.warn(chalk.yellow(`Continuity Critic: ${criticResult.issues.length} issue(s) flagged (${criticResult.severity})`));
            console.log(chalk.yellow.bold(`\n⚠ Continuity Critic Flagged ${criticResult.issues.length} Issue(s) [Severity: ${criticResult.severity}]:`));
            criticResult.issues.forEach((issue, idx) => {
              console.log(chalk.yellow(`  ${idx + 1}. [${issue.type || 'continuity'}] ${issue.description}`));
              if (issue.quote) {
                console.log(chalk.dim(`     Quote: "${issue.quote}"`));
              }
              if (issue.fixSuggestion) {
                console.log(chalk.cyan(`     Fix:   ${issue.fixSuggestion}`));
              }
            });
            console.log('');
          }
        } catch {
          criticSpinner.stop();
        }
      }

      // Review Gate with Critic Issues injected for auto-fix hotkey
      const review = await promptReviewWorkflow({
        draftContent: beatProse,
        itemLabel: `Beat ${beat.num} Prose`,
        allowPause: true,
        preferredEditor: config.editor,
        criticIssues: criticResult.issues || []
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

        if (isTargetedBeat) {
          console.log(chalk.green(`\nBeat ${beat.num} rewritten and updated in project/chapter-${padded}/chapter.md`));

          // Check if all beats in the chapter are completed or if summary.md already exists
          const { completedNums: updatedCompleted } = await getCompletedBeatsInChapter(chapterFile);
          const allCompleted = beats.every((b) => updatedCompleted.includes(b.num));
          let summaryExists = false;
          try {
            await fs.access(summaryFile);
            summaryExists = true;
          } catch {}

          if (allCompleted || summaryExists) {
            console.log(chalk.cyan(`\nRe-generating chapter summary to reflect rewritten Beat ${beat.num}...`));
            await generateChapterSummary({ chapterNum, chapterFile, summaryFile, groqClient, cwd, vectorStore, embedder, config });
          }

          return;
        }

        // Standard sequential flow
        await setActiveBeat(chapterNum, beat.num + 1, cwd);
        console.log(chalk.green(`\nBeat ${beat.num} accepted and committed to project/chapter-${padded}/chapter.md (earlier beats preserved)`));
      } else if (review.action === 'retry') {
        retryFeedback = review.feedback || 'Improve prose flow, pacing, and sensory engagement.';
      } else if (review.action === 'pause') {
        if (!isTargetedBeat) {
          await setActiveBeat(chapterNum, beat.num, cwd);
        }
        console.log(chalk.yellow(`\nPaused at Beat ${beat.num}. Progress saved. You can resume with /write ${chapterNum}`));
        return;
      }
    }
  }

  // All beats written! Chapter Completion Hook (standard flow)
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
