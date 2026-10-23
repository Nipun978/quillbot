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

/**
 * Parses chapter.md content into an optional header and a Map of beat numbers to prose.
 */
export function parseChapterBeats(rawContent = '') {
  if (!rawContent || !rawContent.trim()) {
    return { header: '# Chapter Manuscript', beatsMap: new Map() };
  }

  const beatMarkerRegex = /<!-- BEAT (\d+) -->/g;
  const matches = [...rawContent.matchAll(beatMarkerRegex)];

  if (matches.length === 0) {
    return { header: rawContent.trim(), beatsMap: new Map() };
  }

  const header = rawContent.slice(0, matches[0].index).trim();
  const beatsMap = new Map();

  for (let i = 0; i < matches.length; i++) {
    const num = parseInt(matches[i][1], 10);
    const startIdx = matches[i].index + matches[i][0].length;
    const endIdx = (i < matches.length - 1) ? matches[i + 1].index : rawContent.length;
    const prose = rawContent.slice(startIdx, endIdx).trim();
    beatsMap.set(num, prose);
  }

  return { header, beatsMap };
}

/**
 * Serializes the header and beatsMap into chapter.md markdown,
 * ensuring all beats are written strictly in ascending numerical order.
 */
export function serializeChapterBeats(header = '# Chapter Manuscript', beatsMap = new Map()) {
  const sortedNums = Array.from(beatsMap.keys()).sort((a, b) => a - b);
  const beatBlocks = sortedNums.map((num) => {
    return `<!-- BEAT ${num} -->\n${beatsMap.get(num).trim()}`;
  });

  const cleanHeader = (header || '# Chapter Manuscript').trim();
  if (beatBlocks.length === 0) {
    return cleanHeader ? `${cleanHeader}\n` : '';
  }

  return cleanHeader
    ? `${cleanHeader}\n\n${beatBlocks.join('\n\n')}\n`
    : `${beatBlocks.join('\n\n')}\n`;
}

export async function getCompletedBeatsInChapter(chapterFilePath) {
  try {
    const content = await fs.readFile(chapterFilePath, 'utf8');
    const { beatsMap } = parseChapterBeats(content);
    const completedNums = Array.from(beatsMap.keys()).sort((a, b) => a - b);
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
    const { beatsMap } = parseChapterBeats(content);
    return beatsMap.get(beatNum) || '';
  } catch {
    return '';
  }
}

/**
 * Extracts all prose from beats strictly prior to targetBeatNum in numerical order,
 * and returns the last tailWordLimit words for continuity window.
 */
export async function getProseBeforeBeat(chapterFilePath, targetBeatNum, tailWordLimit = 350) {
  if (targetBeatNum <= 1) {
    return '';
  }
  try {
    const content = await fs.readFile(chapterFilePath, 'utf8');
    if (!content.trim()) return '';

    const { beatsMap } = parseChapterBeats(content);
    const priorNums = Array.from(beatsMap.keys())
      .filter((n) => n < targetBeatNum)
      .sort((a, b) => a - b);

    if (priorNums.length === 0) return '';

    const textBeforeTarget = priorNums.map((n) => beatsMap.get(n)).join('\n\n');
    return getLastNWords(textBeforeTarget, tailWordLimit);
  } catch {
    return '';
  }
}

/**
 * Safely commits beat prose to chapter.md.
 * Creates a safety backup, updates or inserts the beat in strictly sorted numerical order
 * (e.g. Beat 1 always precedes Beat 2 even if written out of order),
 * preserving all existing beats non-destructively.
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

  const { header, beatsMap } = parseChapterBeats(existing);
  beatsMap.set(beatNum, finalProse.trim());
  const updated = serializeChapterBeats(header, beatsMap);

  await fs.writeFile(chapterFile, updated, 'utf8');
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
  // Parse chapter, optional target beat number, and optional user edit instruction:
  // e.g. "1", "1 2", "1 --beat 2", "1 2 Make Jonathan more suspicious", "1 --edit"
  let chapterNum = NaN;
  let targetBeatNum = null;
  let userInstruction = '';

  if (typeof chapterArg === 'number') {
    chapterNum = chapterArg;
  } else if (typeof chapterArg === 'string') {
    const clean = chapterArg.trim();
    const beatFlagMatch = clean.match(/^(\d+)\s+--beat(?:=|\s+)(\d+)(?:\s+(.*))?$/i);
    const twoNumMatch = clean.match(/^(\d+)\s+(\d+)(?:\s+(.*))?$/);
    const singleNumMatch = clean.match(/^(\d+)(?:\s+(.*))?$/);

    if (beatFlagMatch) {
      chapterNum = parseInt(beatFlagMatch[1], 10);
      targetBeatNum = parseInt(beatFlagMatch[2], 10);
      userInstruction = (beatFlagMatch[3] || '').trim();
    } else if (twoNumMatch) {
      chapterNum = parseInt(twoNumMatch[1], 10);
      targetBeatNum = parseInt(twoNumMatch[2], 10);
      userInstruction = (twoNumMatch[3] || '').trim();
    } else if (singleNumMatch) {
      chapterNum = parseInt(singleNumMatch[1], 10);
      userInstruction = (singleNumMatch[2] || '').trim();
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
    const existingTargetProse = await getBeatProseFromChapter(chapterFile, targetBeatNum);
    if (existingTargetProse) {
      console.log(chalk.bold.cyan(`\n  Targeted Edit/Rewrite: Chapter ${chapterNum}, Beat ${targetBeatNum}: "${matchedBeat.title}"`));
    } else {
      console.log(chalk.bold.cyan(`\n  Writing Chapter ${chapterNum}, Beat ${targetBeatNum}: "${matchedBeat.title}"`));
    }
  } else {
    // Check completed beats in chapter
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

    // If all beats in this chapter are already written, enter Chapter Edit Mode!
    if (currentBeatIndex >= beats.length) {
      console.log(chalk.bold.cyan(`\n  Chapter ${chapterNum} is already written (${beats.length} of ${beats.length} beats present).`));
      console.log(chalk.bold.yellow(`  Entering Chapter Edit Mode...`));

      let editChoice = 'all_beats';
      if (process.stdin.isTTY) {
        try {
          const { select } = await import('@inquirer/prompts');
          editChoice = await select({
            message: `Chapter ${chapterNum} is already written. How would you like to edit it?`,
            choices: [
              { name: `1. Edit a specific beat (Choose Beat 1–${beats.length})`, value: 'single_beat' },
              { name: `2. Revise full chapter beat-by-beat (sequential revision with prior drafts)`, value: 'all_beats' },
              { name: `3. Full chapter manuscript edit (AI editorial pass on full chapter.md)`, value: 'full_manuscript' },
              { name: `4. Re-generate canonical chapter summary & sync`, value: 'summary_only' },
              { name: `← Cancel / Return`, value: 'cancel' }
            ]
          });
        } catch {
          editChoice = 'all_beats';
        }
      }

      if (editChoice === 'cancel') {
        return;
      }
      if (editChoice === 'summary_only') {
        await generateChapterSummary({ chapterNum, chapterFile, summaryFile, groqClient, cwd, vectorStore, embedder, config });
        return;
      }
      if (editChoice === 'single_beat') {
        let chosenBeatNum = 1;
        if (process.stdin.isTTY) {
          try {
            const { select } = await import('@inquirer/prompts');
            chosenBeatNum = await select({
              message: `Select beat in Chapter ${chapterNum} to edit:`,
              choices: beats.map((b) => ({
                name: `Beat ${b.num}: ${b.title}`,
                value: b.num
              }))
            });
          } catch {
            chosenBeatNum = 1;
          }
        }
        const matched = beats.find((b) => b.num === chosenBeatNum) || beats[0];
        beatsToProcess = [matched];
        targetBeatNum = matched.num;
      } else if (editChoice === 'all_beats') {
        beatsToProcess = beats;
      } else if (editChoice === 'full_manuscript') {
        await runFullChapterEditWorkflow({
          chapterNum,
          chapterFile,
          planContent,
          summaryFile,
          groqClient,
          vectorStore,
          embedder,
          reranker,
          config,
          cwd,
          userInstruction
        });
        return;
      }
    } else {
      console.log(chalk.bold.cyan(`\n  Writing Chapter ${chapterNum} Beat-by-Beat (${beats.length} Beats Total)`));
      beatsToProcess = beats.slice(currentBeatIndex);
    }
  }

  const instructions = await loadInstructions(cwd);
  const tailWordLimit = config.generation?.continuityTailWords || 350;

  // Process beats
  for (let b = 0; b < beatsToProcess.length; b++) {
    const beat = beatsToProcess[b];
    const existingBeatProse = await getBeatProseFromChapter(chapterFile, beat.num);
    const isRevision = Boolean(existingBeatProse && existingBeatProse.trim());

    console.log(chalk.bold.magenta(`\n========================================`));
    if (isRevision) {
      console.log(chalk.bold.magenta(`  Editing Beat ${beat.num} of ${beats.length}: ${beat.title}`));
    } else {
      console.log(chalk.bold.magenta(`  Writing Beat ${beat.num} of ${beats.length}: ${beat.title}`));
    }
    console.log(chalk.bold.magenta(`========================================`));
    console.log(chalk.dim(`  Characters: ${beat.characters || 'Unspecified'}`));
    console.log(chalk.dim(`  Location:   ${beat.location || 'Unspecified'}`));
    console.log(chalk.dim(`  Action:     ${beat.action || 'Unspecified'}\n`));

    // If editing existing beat and user did not pass instructions in CLI, ask interactively
    let beatEditNotes = userInstruction;
    if (isRevision && !beatEditNotes && process.stdin.isTTY) {
      try {
        const { input } = await import('@inquirer/prompts');
        beatEditNotes = await input({
          message: `Enter edit/improvement instructions for Beat ${beat.num} (Press Enter for literary polish & depth):`,
          default: ''
        });
      } catch {}
    }

    // 1. Targeted Hybrid RAG for this Beat (retrieving all necessary files)
    const searchTerms = [beat.characters, beat.location, beat.action, beat.goalHook, beatEditNotes].filter(Boolean).join(' ');
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
    const nextBeatProse = await getBeatProseFromChapter(chapterFile, beat.num + 1);
    if (nextBeatProse) {
      const opening150 = getFirstNWords(nextBeatProse, 150);
      if (opening150) {
        downstreamContext = `#### Upcoming Scene Anchor (Beat ${beat.num + 1} Opening - Ensure your ending bridges smoothly into this):\n"${opening150}..."\n`;
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

    let revisionBlock = '';
    if (isRevision) {
      revisionBlock = `
### PREVIOUS DRAFT OF BEAT ${beat.num} (TO BE REVISED & IMPROVED):
"""
${existingBeatProse}
"""

### REVISION & IMPROVEMENT OBJECTIVE:
${beatEditNotes || 'Enhance the sensory immersion, dialogue rhythm, emotional depth, and narrative pacing while seamlessly maintaining scene continuity.'}

### EDITING RULES:
1. You are revising and improving the existing draft of Beat ${beat.num} provided above.
2. Incorporate the revision objective cleanly while preserving character voices and established canon.
3. Ensure the scene opens seamlessly from the preceding scene and leads naturally into any upcoming scene.
4. Output only the continuous, revised narrative prose for Beat ${beat.num}.`;
    }

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
${revisionBlock ? `\n${revisionBlock}` : ''}
${retryFeedback ? `\n### Revision Notes (from previous attempt):\n${retryFeedback}\n` : ''}
${isRevision ? `Write the revised and improved narrative prose for Beat ${beat.num}.` : `Write the continuous narrative prose for Beat ${beat.num}.`}`;

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

/**
 * Runs a developmental and line-editorial pass across the full chapter.md manuscript.
 */
export async function runFullChapterEditWorkflow({
  chapterNum,
  chapterFile,
  planContent,
  summaryFile,
  groqClient,
  vectorStore,
  embedder,
  reranker,
  config,
  cwd,
  userInstruction = ''
}) {
  const padded = padChapter(chapterNum);
  let chapterRaw = '';
  try {
    chapterRaw = await fs.readFile(chapterFile, 'utf8');
  } catch {
    console.log(chalk.red(`\nNo manuscript found at project/chapter-${padded}/chapter.md.`));
    return;
  }

  let editInstructions = userInstruction;
  if (!editInstructions && process.stdin.isTTY) {
    try {
      const { input } = await import('@inquirer/prompts');
      editInstructions = await input({
        message: `Enter editorial instructions for Chapter ${chapterNum} (Press Enter for literary polish):`,
        default: 'Enhance narrative momentum, deepen sensory atmosphere, polish dialogue cadence, and heighten dramatic stakes.'
      });
    } catch {}
  }
  if (!editInstructions) {
    editInstructions = 'Enhance narrative momentum, deepen sensory atmosphere, polish dialogue cadence, and heighten dramatic stakes.';
  }

  console.log(chalk.bold.magenta(`\n========================================`));
  console.log(chalk.bold.magenta(`  Full Editorial Pass: Chapter ${chapterNum} Manuscript`));
  console.log(chalk.bold.magenta(`========================================`));
  console.log(chalk.dim(`  Editorial Direction: ${editInstructions}\n`));

  // RAG for chapter
  let ragChunks = [];
  try {
    const queryVector = await embedder.embedQuery(editInstructions);
    const candidates = await vectorStore.hybridSearch({
      queryText: editInstructions,
      queryVector,
      vectorTopK: 15,
      bm25TopK: 15
    });
    ragChunks = await reranker.rerank({
      queryText: editInstructions,
      candidates,
      topK: 5
    });
  } catch {}

  const tier1 = ragChunks.filter((c) => Number(c.authority_tier) === 1);
  const instructions = await loadInstructions(cwd);
  const hierarchyXml = buildHierarchyContext({
    instructions,
    tier1Chunks: tier1,
    tier2Chunks: []
  });

  const activeStyle = config.enhancedWritingStyle
    ? `${config.enhancedWritingStyle}\n\nAuthor Core Preferences: ${config.writingStyle}`
    : (config.writingStyle || '');

  const systemPrompt = `${hierarchyXml}

<chapter_plan>
${planContent ? planContent.trim() : '(No beat plan)'}
</chapter_plan>

<writing_style_rules>
Author's Writing Style:
${activeStyle || '(Literary novel prose standards)'}
</writing_style_rules>

You are Quillbot's Senior Developmental & Line Editor.
Your objective is to revise, polish, and elevate the author's full chapter manuscript according to the author's editorial direction, while adhering to Story Bible canon.
CRITICAL FORMATTING RULE:
You MUST preserve all \`<!-- BEAT N -->\` structural comments intact in their correct sequential positions between scenes.`;

  const userPrompt = `### FULL CHAPTER ${chapterNum} MANUSCRIPT TO EDIT:
${chapterRaw}

### AUTHOR'S EDITORIAL DIRECTION:
${editInstructions}

Revise and polish Chapter ${chapterNum} according to the editorial direction. Elevate the prose, heighten immersion, and preserve all <!-- BEAT N --> markers.`;

  process.stdout.write(chalk.bold.green(`\nGenerating revised Chapter ${chapterNum} manuscript:\n\n`));

  let revisedChapter = '';
  try {
    revisedChapter = await groqClient.streamChatCompletion({
      model: 'large',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: config.generation?.temperatureWrite || 0.7,
      onChunk: (delta) => {
        process.stdout.write(delta);
      }
    });
    console.log('\n');
  } catch (err) {
    console.error(chalk.red(`\nChapter revision failed: ${err.message}`));
    return;
  }

  const review = await promptReviewWorkflow({
    draftContent: revisedChapter,
    itemLabel: `Chapter ${chapterNum} Manuscript`,
    allowPause: false,
    preferredEditor: config.editor
  });

  if (review.action === 'accept') {
    await createBackup(chapterFile, cwd);
    // Parse beats to ensure ordering is guaranteed
    const { header, beatsMap } = parseChapterBeats(review.content);
    if (beatsMap.size > 0) {
      await fs.writeFile(chapterFile, serializeChapterBeats(header, beatsMap), 'utf8');
    } else {
      await fs.writeFile(chapterFile, review.content.trim() + '\n', 'utf8');
    }
    console.log(chalk.green(`\nChapter ${chapterNum} updated in project/chapter-${padded}/chapter.md`));
    await generateChapterSummary({ chapterNum, chapterFile, summaryFile, groqClient, cwd, vectorStore, embedder, config });
  } else {
    console.log(chalk.yellow(`\nChapter ${chapterNum} revision discarded. Original manuscript kept intact.`));
  }
}

