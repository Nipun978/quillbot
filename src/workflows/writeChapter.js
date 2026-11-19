import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import {
  WRITE_BEAT_SYSTEM_PROMPT,
  CHAPTER_SUMMARY_SYSTEM_PROMPT,
  CONTINUITY_CRITIC_SYSTEM_PROMPT,
  buildHierarchyContext,
  buildStoryBibleContext,
  buildCreativityDirective
} from '../llm/prompts.js';
import { loadInstructions, getCreativityTemperatures, getCreativityExecutionProfile, getExecutionProfile } from '../config/configManager.js';
import { createBackup } from '../config/backupManager.js';
import { setActiveBeat, loadState } from '../config/stateManager.js';
import { padChapter } from './planChapter.js';
import { createSpinner } from '../ui/renderer.js';
import { promptReviewWorkflow } from '../ui/reviewPrompt.js';
import { syncAllFiles } from '../rag/fileSync.js';
import { ensureStdinRaw } from '../ui/ttyManager.js';
import {
  loadStoryContextForChapter,
  loadCondensedBeats,
  loadWritingContinuityContext,
  saveCondensedBeatProse,
  saveCondensedBeatPlan,
  condenseBeatPlan,
  condenseChapterProse,
  updateStorySoFar
} from '../config/condensedManager.js';

export function parseChapterPlanHeader(planContent = '') {
  if (!planContent) return { title: '', chapterSummary: '', chapterInstructions: '' };
  const titleMatch = planContent.match(/^#\s+(?:Chapter\s+\d+:\s*)?(.*?)$/m);
  const summaryMatch = planContent.match(/##\s+Chapter Summary\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  const instrMatch = planContent.match(/##\s+Chapter Instructions\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  return {
    title: titleMatch ? titleMatch[1].trim() : '',
    chapterSummary: summaryMatch ? summaryMatch[1].trim() : '',
    chapterInstructions: instrMatch ? instrMatch[1].trim() : ''
  };
}

export function parseBeatsFromPlan(planContent) {
  if (!planContent) return [];
  const clarifyIdx = planContent.search(/\n##\s+(?:Author\s+Clarifications|Clarifications)/i);
  const beatsSection = clarifyIdx !== -1 ? planContent.slice(0, clarifyIdx) : planContent;

  const beatRegex = /^### Beat (\d+): (.*?)$/gm;
  const indices = [];
  let match;

  while ((match = beatRegex.exec(beatsSection)) !== null) {
    indices.push({
      index: match.index,
      beatNum: parseInt(match[1], 10),
      title: match[2].trim()
    });
  }

  if (indices.length === 0) return [];

  const lastBeatStartIndex = indices[indices.length - 1].index;
  const afterLastBeat = beatsSection.slice(lastBeatStartIndex);
  let lastBeatEndIndex = beatsSection.length;
  const postSectionMatch = afterLastBeat.match(/\n(##\s+[^\n]+[\s\S]*)$/);
  if (postSectionMatch) {
    lastBeatEndIndex = lastBeatStartIndex + postSectionMatch.index;
  }

  const beats = [];
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i].index;
    const end = i < indices.length - 1 ? indices[i + 1].index : lastBeatEndIndex;
    const fullBlock = beatsSection.slice(start, end).trim();

    const charsMatch = fullBlock.match(/(?:-\s*)?\*\*Characters:\*\*\s*([^\n\r]+)/i);
    const settingMatch = fullBlock.match(/(?:-\s*)?\*\*(?:Setting|Location):\*\*\s*([^\n\r]+)/i);
    const outlineMatch = fullBlock.match(/(?:-\s*)?\*\*(?:Beat Outline|Action):\*\*\s*([\s\S]*?)(?=(?:(?:-\s*)?\*\*(?:Author's Notes|Author Notes|Goal\/Hook|Beat Instructions|Instructions):\*\*)|$)/i);
    const notesMatch = fullBlock.match(/(?:-\s*)?\*\*(?:Author's Notes|Author Notes|Goal\/Hook):\*\*\s*([\s\S]*?)(?=(?:(?:-\s*)?\*\*(?:Beat Instructions|Instructions):\*\*)|$)/i);
    const instrMatch = fullBlock.match(/(?:-\s*)?\*\*(?:Beat Instructions|Instructions):\*\*\s*([\s\S]*?)$/i);

    const setting = settingMatch ? settingMatch[1].trim() : '';
    const outline = outlineMatch ? outlineMatch[1].trim() : '';
    const authorNotes = notesMatch ? notesMatch[1].trim() : '';
    const instructions = instrMatch ? instrMatch[1].trim() : '';

    // Extract inline dialogue tags: Speaker to Listener (how): "Line" or [Speaker to Listener (delivery)]: "Line"
    const dialogueRegex = /(?:\[)?([A-Za-z0-9_\s'-]+?)\s+to\s+([A-Za-z0-9_\s'-]+?)(?:\s*\(([^)]+)\))?(?:\])?:\s*["“']([^"”']+)["”']/gi;
    const dialogueTags = [];
    let dMatch;
    while ((dMatch = dialogueRegex.exec(outline)) !== null) {
      dialogueTags.push({
        speaker: dMatch[1].trim(),
        listener: dMatch[2].trim(),
        delivery: (dMatch[3] || '').trim(),
        line: dMatch[4].trim(),
        fullTag: dMatch[0]
      });
    }

    beats.push({
      num: indices[i].beatNum,
      title: indices[i].title,
      characters: charsMatch ? charsMatch[1].trim() : '',
      location: setting,
      setting,
      action: outline,
      beatOutline: outline,
      goalHook: authorNotes,
      authorNotes,
      instructions,
      dialogueTags,
      rawBlock: fullBlock
    });
  }

  return beats;
}

export function parseBeatClarifications(planContent = '', beatNum) {
  if (!planContent) return '';
  const clarifySectionMatch = planContent.match(/##\s+(?:Author\s+Clarifications[^\n]*|Clarifications[^\n]*)([\s\S]*)/i);
  if (!clarifySectionMatch) return '';
  const sectionBody = clarifySectionMatch[1];

  // Match either ### Beat N: or ## Beat N: or Beat N
  const beatRegex = new RegExp(`###?\\s*Beat\\s*${beatNum}[:\\s][^\\n]*([\\s\\S]*?)(?=(?:###?\\s*Beat\\s*\\d+)|$)`, 'i');
  const beatMatch = sectionBody.match(beatRegex);
  if (!beatMatch) return '';
  return beatMatch[1].trim();
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
  chapterInstructions = '',
  globalInstructions = '',
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

### 3. CHAPTER & BEAT WRITING INSTRUCTIONS:
${chapterInstructions ? `Chapter Instructions:\n${chapterInstructions}\n` : ''}
${beat?.instructions ? `Beat Instructions (Narrow & Specific to this Beat):\n${beat.instructions}\n` : ''}
${globalInstructions ? `Global Writing Directives:\n${globalInstructions}\n` : ''}

### 4. TARGET BEAT PLAN & AUTHOR'S NOTES:
${planContent ? `Full Plan:\n${planContent.trim()}\n` : ''}
Target Beat to Verify: Beat ${beat?.num} (${beat?.title || ''})
Required Characters: ${beat?.characters || 'Unspecified'}
Required Location: ${beat?.setting || beat?.location || 'Unspecified'}
Beat Outline (Planned Actions & Spoken Dialogue):
${beat?.beatOutline || beat?.action || 'Unspecified'}
Author's Notes (Author's Vision & Purpose for this Beat):
${beat?.authorNotes || beat?.goalHook || 'Unspecified'}

### 5. DRAFTED BEAT PROSE TO AUDIT:
${beatProse}

Audit the drafted Beat Prose against:
1. Plan adherence (were planned events, character actions, and planned dialogue lines executed? Note: prose renders dialogue in standard literary novel format, NOT planning tags).
2. Author's Notes & Purpose (was the specific emotional texture, subtext, and creative vision achieved?)
3. Beat & Chapter Instructions adherence (were pacing, tone, and emotional distance constraints followed?)
4. Grammar, spelling, and syntax flaws (including robotic/ungrammatical tags like "said personifying" or "said matter-of-fact")
5. Story Bible canon and scene continuity

Return your evaluation strictly as the JSON schema requested in your instructions.`;

  try {
    const result = await groqClient.jsonCompletion({
      model: 'small',
      messages: [
        { role: 'system', content: CONTINUITY_CRITIC_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.1,
      maxTokens: 2048,
      reasoningEffort: 'low',
      sessionId,
      workflow: 'CONTINUITY_CRITIC'
    });

    if (!result || typeof result !== 'object') {
      return {
        passed: true,
        checklist: {
          planFollowed: true,
          authorVisionMet: true,
          instructionsFollowed: true,
          grammarCorrect: true
        },
        severity: 'none',
        issues: [],
        skipped: true,
        missingCanon: tier1Chunks.length === 0,
        skipReason: 'Invalid or empty critic JSON object'
      };
    }

    const rawIssues = Array.isArray(result.issues) ? result.issues : [];

    // Filter out small-model hallucinations where the critic inverted the rule and told the author
    // to replace standard prose dialogue with planning tags like "Speaker to Listener (how):"
    const issues = rawIssues.filter((i) => {
      const desc = (i.description || '').toLowerCase();
      const fix = (i.fixSuggestion || '').toLowerCase();
      if (
        fix.includes('inline plan tag') ||
        fix.includes('inline format') ||
        fix.includes('required inline') ||
        /replace.*prose dialogue.*with.*to.*:/i.test(fix) ||
        (desc.includes('written as prose') && desc.includes('inline'))
      ) {
        return false;
      }
      return true;
    });

    const hasPlanDiscrepancyIssue = issues.some((i) => (i.category || i.type) === 'plan_discrepancy' || (i.category || i.type) === 'raw_dialogue_tags_leaked');
    const checklist = result.checklist && typeof result.checklist === 'object' ? {
      planFollowed: hasPlanDiscrepancyIssue ? false : Boolean(result.checklist.planFollowed !== false || !hasPlanDiscrepancyIssue),
      authorVisionMet: Boolean(result.checklist.authorVisionMet !== false),
      instructionsFollowed: Boolean(result.checklist.instructionsFollowed !== false),
      grammarCorrect: Boolean(result.checklist.grammarCorrect !== false)
    } : {
      planFollowed: !hasPlanDiscrepancyIssue,
      authorVisionMet: issues.every((i) => (i.category || i.type) !== 'purpose_vision'),
      instructionsFollowed: issues.every((i) => (i.category || i.type) !== 'instructions_violation'),
      grammarCorrect: issues.every((i) => (i.category || i.type) !== 'grammar_spelling')
    };

    // Deterministic check: detect raw planning bracket tags or planning dialogue tags that leaked into narrative prose
    const leakedDialogueRegex = /(?:\[([^\]]+?)\s+to\s+([^\]]+?)(?:\s*\([^)]+\))?\]:\s*["“']|\[Non-verbal[^\]]*\]|^(?:[A-Za-z0-9_\s'-]+?)\s+to\s+(?:[A-Za-z0-9_\s'-]+?)(?:\s*\([^)]+\))?:\s*["“']|^Non-verbal\s*\/\s*silent interaction:)/im;
    const leakedMatch = beatProse.match(leakedDialogueRegex);
    if (leakedMatch) {
      checklist.planFollowed = false;
      const alreadyReported = issues.some((i) => i.type === 'raw_dialogue_tags_leaked' || (i.description && (i.description.includes('bracket') || i.description.includes('dialogue tag'))));
      if (!alreadyReported) {
        issues.unshift({
          type: 'raw_dialogue_tags_leaked',
          category: 'plan_discrepancy',
          description: 'Raw planning dialogue tags detected in prose. Convert all planning dialogue tags into natural literary prose with dialogue attributions or action beats.',
          quote: leakedMatch[0],
          fixSuggestion: 'Remove raw planning syntax and integrate speech or physical action directly into novel prose narrative.'
        });
      }
    }

    // Deterministic check: detect robotic planning delivery cues pasted directly into dialogue tags
    // e.g. "said personifying", "said matter-of-fact", "asked inquiring", "asked questioningly", "said surprised"
    const roboticCueRegex = /\b(?:said|asked|replied|answered|whispered|murmured|muttered|spoke)\s+(?:personifying|matter-of-fact|inquiring|questioningly|surprised)\b/i;
    const roboticMatch = beatProse.match(roboticCueRegex);
    if (roboticMatch) {
      checklist.grammarCorrect = false;
      const alreadyReported = issues.some((i) => i.quote && i.quote.includes(roboticMatch[0]));
      if (!alreadyReported) {
        issues.push({
          type: 'grammar_spelling',
          category: 'grammar_spelling',
          description: `Robotic planning delivery cue leaked into dialogue tag ("${roboticMatch[0]}"). Delivery cues are subtext directions, not literal speech adverbs.`,
          quote: roboticMatch[0],
          fixSuggestion: 'Express the delivery through character action beats, gestures, tone, or clean standard dialogue attributions.'
        });
      }
    }

    const allChecklistPassed = Object.values(checklist).every(Boolean);
    const passed = Boolean(result.passed === true || (issues.length === 0 && allChecklistPassed)) && !leakedMatch;
    const severity = leakedMatch ? 'major' : (result.severity || (passed ? 'none' : 'minor'));

    return {
      passed,
      checklist,
      severity,
      issues,
      missingCanon: tier1Chunks.length === 0
    };
  } catch (err) {
    // If Critic call fails, do not halt authoring, but mark skipped explicitly so UI warns instead of reporting false pass
    return {
      passed: true,
      checklist: {
        planFollowed: true,
        authorVisionMet: true,
        instructionsFollowed: true,
        grammarCorrect: true
      },
      severity: 'none',
      issues: [],
      skipped: true,
      missingCanon: tier1Chunks.length === 0,
      error: err.message,
      skipReason: err.message
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
    ensureStdinRaw();
    if (process.stdin.isTTY) {
      try {
        const { input } = await import('@inquirer/prompts');
        const state = await loadState(cwd);
        const chInput = await input({
          message: 'Enter chapter number to write:',
          default: String(state.activeChapter || 1)
        });
        chapterNum = parseInt(chInput, 10);
      } catch {}
    }
  }

  if (isNaN(chapterNum) || chapterNum < 1) {
    console.log(chalk.yellow('Please specify a valid chapter number to write.'));
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
      ensureStdinRaw();
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
        ensureStdinRaw();
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
    ensureStdinRaw();
    if (isRevision && !beatEditNotes && process.stdin.isTTY) {
      try {
        const { input } = await import('@inquirer/prompts');
        beatEditNotes = await input({
          message: `Enter edit/improvement instructions for Beat ${beat.num} (Press Enter for literary polish & depth):`,
          default: ''
        });
      } catch {}
    }

    // 1. Dedicated Tier 1 Story Bible retrieval (so Tier 2 plan.md never crowds out canon)
    // plus optional Tier 2/3 supplemental retrieval
    const bibleQueryTerms = [beat.characters, beat.location, beat.title, (beat.action || '').slice(0, 220), beatEditNotes]
      .filter(Boolean)
      .join(' ');
    let tier1 = [];
    let tier2 = [];
    if (bibleQueryTerms.trim()) {
      try {
        const isPaid = Boolean(config?.apiTier === 'paid' || config?.apiTier === 'developer');
        const queryVector = await embedder.embedQuery(bibleQueryTerms);
        const bibleCandidates = await vectorStore.hybridSearch({
          queryText: bibleQueryTerms,
          queryVector,
          vectorTopK: 15,
          bm25TopK: 15,
          sourceTypes: isPaid ? ['story-bible', 'story-bible-reference'] : ['story-bible'],
          authorityTiers: [1],
          isPaid
        });
        const rerankedBible = await reranker.rerank({
          queryText: bibleQueryTerms,
          candidates: bibleCandidates,
          topK: 5
        });
        tier1 = rerankedBible.filter((c) => Number(c.authority_tier) === 1);

        const supplementalCandidates = await vectorStore.hybridSearch({
          queryText: bibleQueryTerms,
          queryVector,
          vectorTopK: 10,
          bm25TopK: 10,
          sourceTypes: ['chapter', 'chapter-summary', 'condensed-story-so-far', 'conversation'],
          authorityTiers: [2, 3],
          isPaid
        });
        if (supplementalCandidates && supplementalCandidates.length > 0) {
          const rerankedSupp = await reranker.rerank({
            queryText: bibleQueryTerms,
            candidates: supplementalCandidates,
            topK: 3
          });
          tier2 = rerankedSupp.filter((c) => Number(c.authority_tier) === 2);
        }
      } catch {}
    }

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

    // 4. Prompt Assembly (Optimized for Groq Prefix Caching & Deterministic Continuity)
    const { title: chapterTitle, chapterSummary, chapterInstructions } = parseChapterPlanHeader(planContent);

    // Requirement 5: Story So Far (1..N-2) & Preceding Chapter Summary (N-1) loaded deterministically
    const { storySoFar, previousChapterSummary } = await loadStoryContextForChapter({
      currentChapterNum: chapterNum,
      cwd
    });

    // Requirement 6: Prior condensed prose, trailing snippet, and next beat foresight
    const {
      priorCondensedProse,
      lastProseSnippet: tailSnippet,
      nextBeatCondensedPlan,
      isFinaleBeat
    } = await loadWritingContinuityContext({
      chapterNum,
      activeBeatNum: beat.num,
      beatsList: beats,
      cwd,
      chapterFile,
      tailWordLimit
    });

    const activeLastSnippet = lastProseSnippet || tailSnippet;

    const activeStyle = config.enhancedWritingStyle
      ? config.enhancedWritingStyle.trim()
      : (config.writingStyle || '');

    const profile = getExecutionProfile(isRevision ? 'EDIT_BEAT' : 'WRITE_BEAT', config);
    const creativityDirective = buildCreativityDirective('off');
    const writeTemp = profile.temperatureWrite;
    const reasoningEffort = profile.reasoningEffort;
    const maxTokens = profile.maxTokens;
    const beatClarifications = parseBeatClarifications(planContent, beat.num);

    const globalInstructionsBlock = instructions && instructions.trim()
      ? (activeStyle && !instructions.includes(activeStyle)
          ? `${activeStyle}\n\n${instructions.trim()}`
          : instructions.trim())
      : (activeStyle || '(Deliver immersive, sensory-rich prose in consistent POV and tense.)');

    // STATIC PREFIX (System Message): Byte-identical for EVERY beat in Chapter N to maximize Groq prefix caching
    const systemPrompt = `You are an acclaimed novelist writing narrative prose for a novel chapter.
You write ONE BEAT at a time with uncompromising psychological depth, sensory immersion, and scene grounding.

<instruction_precedence>
Hierarchy of Authority:
1. Beat-Specific Instructions (Highest Precedence — exact tone, pacing, and camera directives for this active beat)
2. Chapter-Level Instructions (Middle Precedence — chapter-wide tension and pacing rules)
3. Global Writing Style (Global Baseline Style)

Truth Precedence: Specific Past Chapters & Manuscript Progress override global Story Bible lore when resolving continuity.
</instruction_precedence>

<global_writing_instructions>
${globalInstructionsBlock}
</global_writing_instructions>
${chapterInstructions ? `\n<chapter_writing_instructions>\n${chapterInstructions}\n</chapter_writing_instructions>\n` : ''}
${creativityDirective}

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

    const storyBibleXml = tier1.length > 0 ? buildStoryBibleContext(tier1) : '';

    const macroContinuityBlock = [
      storySoFar ? `### Story So Far (Chapters 1 to ${Math.max(1, chapterNum - 2)}):\n${storySoFar}` : '',
      previousChapterSummary ? `### Chapter ${chapterNum - 1} Summary:\n${previousChapterSummary}` : '',
      chapterSummary ? `### Chapter ${chapterNum} Summary:\n${chapterSummary}` : ''
    ].filter(Boolean).join('\n\n');

    const sceneProgressionBlock = priorCondensedProse.length > 0
      ? `### Preceding Scenes in Chapter ${chapterNum} (Narrative Progression):\n${priorCondensedProse.map((p) => `- ${p}`).join('\n')}`
      : '(Opening beat of this chapter)';

    const foresightBlock = nextBeatCondensedPlan
      ? `### Next Scene Foresight Horizon (Next Planned Beat):\n${nextBeatCondensedPlan}`
      : isFinaleBeat
        ? '### Scene Foresight Horizon:\n(Chapter Climax & Resolution Beat - bring this chapter arc to a natural closing point)'
        : '';

    let beatProse = '';
    let retryFeedback = '';
    let beatAccepted = false;

    while (!beatAccepted) {
      // Dynamic user prompt structured for Groq KV-prefix caching:
      // Invariant chapter foundation & macro continuity first, followed by scene progression,
      // and dynamic per-beat lore and target beat details at the end.
      const dynamicUserPrompt = `${macroContinuityBlock ? `<macro_story_continuity>\n${macroContinuityBlock}\n</macro_story_continuity>\n\n` : ''}<chapter_scene_progression>
${sceneProgressionBlock}
</chapter_scene_progression>

${storyBibleXml ? `${storyBibleXml}\n\n` : ''}### Immediate Narrative Seam:
#### Verbatim Final Words from Preceding Scene:
${activeLastSnippet ? `"...${activeLastSnippet}"` : '(Opening of the chapter - establish setting and atmosphere)'}
${downstreamContext ? `\n${downstreamContext}` : ''}

### TARGET BEAT TO WRITE NOW (ACTIVE BEAT FULL PLAN):
- **Beat Number:** ${beat.num}
- **Beat Title:** ${beat.title}
- **Characters Present:** ${beat.characters || 'Unspecified'}
- **Setting:** ${beat.setting || beat.location || 'Unspecified'}
- **Beat Outline (Deterministic Events & Verbatim Dialogue):**
${beat.beatOutline || beat.action || 'Unspecified'}
${(beat.authorNotes || beat.goalHook) ? `- **Author's Notes (Supreme Vision for this Beat):**\n${beat.authorNotes || beat.goalHook}\n` : ''}${beat.instructions ? `- **Beat Instructions:** ${beat.instructions}\n` : ''}${beatClarifications ? `\n<beat_author_clarifications>\n${beatClarifications}\n</beat_author_clarifications>\n` : ''}${foresightBlock ? `\n${foresightBlock}\n` : ''}${revisionBlock ? `\n${revisionBlock}` : ''}
${retryFeedback ? `\n### Revision Notes (from previous attempt):\n${retryFeedback}\n` : ''}
${isRevision ? `Write the revised and improved narrative prose for Beat ${beat.num}.` : `Write the continuous narrative prose for Beat ${beat.num} by dramatizing it into immersive literary fiction:
- Transform the Beat Outline into fully realized narrative paragraphs with sensory atmosphere, physical blocking, spatial grounding, and natural dialogue cadence guided by the Author's Notes.
- Group related actions, character gestures, and dialogue exchanges into breathing paragraphs.
- Never output a mechanical line-by-line outline translation.
- Convert all planned dialogue and delivery cues into natural literary dialogue, action beats, and physical gestures. Never copy delivery cues literally into dialogue tags (e.g. strictly no "said personifying" or "said matter-of-fact").
- Output ONLY the continuous narrative prose for Beat ${beat.num}.`}`;

      if (groqClient?.quotaManager) {
        const cd = config?.cooldownSeconds !== undefined ? config.cooldownSeconds : (process.stdin?.isTTY ? 45 : 0);
        await groqClient.quotaManager.enforceGenerationCooldown({
          cooldownSeconds: cd,
          isPaid: config?.apiTier === 'paid' || config?.apiTier === 'developer'
        });
      }

      process.stdout.write(chalk.bold.green(`\nGenerating Beat ${beat.num} prose:\n\n`));
      beatProse = '';

      try {
        beatProse = await groqClient.streamChatCompletion({
          model: 'large',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: dynamicUserPrompt }
          ],
          temperature: writeTemp,
          maxTokens,
          reasoningEffort,
          sessionId: `chapter_${chapterNum}_beat_${beat.num}`,
          workflow: isRevision ? 'EDIT_BEAT' : 'WRITE_BEAT',
          onChunk: (delta) => {
            process.stdout.write(delta);
          }
        });
        console.log('\n');
        if (groqClient?.quotaManager) {
          groqClient.quotaManager.recordGenerationEnd();
        }
      } catch (err) {
        console.error(chalk.red(`\nBeat generation failed: ${err.message}`));
        return;
      }

      // Feature 2: Automatic Continuity Critic Pass (Pre-Review Audit)
      let criticResult = { passed: true, severity: 'none', issues: [] };
      if (config.generation?.enableContinuityCritic !== false) {
        const criticSpinner = createSpinner('Running Continuity Critic check against Story Bible & timeline...').start();
        try {
          const pastSummariesForCritic = [
            storySoFar ? `### Story So Far (Chapters 1 to ${Math.max(1, chapterNum - 2)}):\n${storySoFar}` : '',
            previousChapterSummary ? `### Chapter ${chapterNum - 1} Summary:\n${previousChapterSummary}` : ''
          ].filter(Boolean).join('\n\n');

          criticResult = await runContinuityCritic({
            beatProse,
            beat,
            tier1Chunks: tier1,
            tier2Chunks: tier2,
            pastChapterSummaries: pastSummariesForCritic,
            lastProseSnippet: activeLastSnippet,
            planContent,
            chapterInstructions,
            globalInstructions: globalInstructionsBlock,
            groqClient,
            sessionId: `chapter_${chapterNum}_beat_${beat.num}`
          });

          if (criticResult.skipped) {
            criticSpinner.warn(chalk.yellow(`Continuity Critic skipped (${criticResult.skipReason || 'API/JSON error'}) — review manually.`));
          } else if (criticResult.passed || !criticResult.issues || criticResult.issues.length === 0) {
            if (criticResult.missingCanon) {
              criticSpinner.warn(chalk.yellow('Continuity Critic: Passed beat check, but 0 Story Bible canon chunks were retrieved.'));
            } else {
              criticSpinner.succeed(chalk.green('Continuity Critic: Passed (0 canon or timeline contradictions detected)'));
            }
          } else {
            criticSpinner.warn(chalk.yellow(`Continuity Critic: ${criticResult.issues.length} issue(s) flagged (${criticResult.severity})`));
          }

          // 4-Point Visual Checklist
          const cl = criticResult.checklist || {
            planFollowed: true,
            authorVisionMet: true,
            instructionsFollowed: true,
            grammarCorrect: true
          };
          const checkMark = (ok) => (ok ? chalk.green('[✓]') : chalk.red('[✗]'));
          console.log(chalk.bold('\n--- Pre-Review Audit Checklist ---'));
          console.log(`  ${checkMark(cl.planFollowed)} Plan Followed:        ${cl.planFollowed ? 'All outline steps & dialogue tags executed' : 'Discrepancy with Beat Outline / dialogue tags'}`);
          console.log(`  ${checkMark(cl.authorVisionMet)} Author Vision:        ${cl.authorVisionMet ? 'Beat purpose and emotional subtext achieved' : 'Author\'s Notes vision/subtext not fully reflected'}`);
          console.log(`  ${checkMark(cl.instructionsFollowed)} Instructions:         ${cl.instructionsFollowed ? 'Beat & chapter constraints respected' : 'Beat or chapter instructions violated'}`);
          console.log(`  ${checkMark(cl.grammarCorrect)} Grammar & Spelling:   ${cl.grammarCorrect ? 'No typographical or syntactic errors' : 'Spelling, grammar, or punctuation errors found'}`);

          if (criticResult.issues && criticResult.issues.length > 0) {
            console.log(chalk.yellow.bold(`\n⚠ Continuity & Plan Critic Flagged ${criticResult.issues.length} Issue(s) [Severity: ${criticResult.severity}]:`));
            criticResult.issues.forEach((issue, idx) => {
              const tag = issue.category || issue.type || 'continuity';
              console.log(chalk.yellow(`  ${idx + 1}. [${tag}] ${issue.description}`));
              if (issue.quote) {
                console.log(chalk.dim(`     Quote: "${issue.quote}"`));
              }
              if (issue.fixSuggestion) {
                console.log(chalk.cyan(`     Fix:   ${issue.fixSuggestion}`));
              }
            });
          }
          console.log('');
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

        criticIssues: criticResult.issues || [],
        quotaManager: groqClient?.quotaManager,
        config,
        model: config.models?.large || 'openai/gpt-oss-120b'
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

        // Condense beat prose into .condensed/chapters/chapter-XX/prose.md
        const condenseSpinner = createSpinner(`Condensing Beat ${beat.num} prose with 20B model...`).start();
        try {
          await saveCondensedBeatProse({
            chapterNum,
            beatNum: beat.num,
            beatTitle: beat.title,
            proseText: finalProse,
            groqClient,
            cwd,
            config
          });
          condenseSpinner.succeed(`Beat ${beat.num} prose condensed into .condensed/chapters/chapter-${padded}/prose.md`);
        } catch (err) {
          condenseSpinner.fail(`Failed to condense Beat ${beat.num} prose: ${err.message}`);
        }

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

        const nextBeatInPlan = beats.find((b) => b.num === beat.num + 1);
        const totalPlannedBeats = beats.length;

        // Interactive post-beat menu in TTY:
        if (process.stdin.isTTY) {
          ensureStdinRaw();
          const { select } = await import('@inquirer/prompts');
          const writeChoices = [];
          if (nextBeatInPlan) {
            writeChoices.push({
              name: `Write Next Beat (Beat ${beat.num + 1}${nextBeatInPlan.title ? `: ${nextBeatInPlan.title}` : ''})`,
              value: 'write_next'
            });
          }
          writeChoices.push(
            { name: `Plan Next Beat (Beat ${totalPlannedBeats + 1})`, value: 'plan_next' },
            { name: `End Chapter (finish Chapter ${chapterNum} with ${beat.num} beat(s))`, value: 'end_chapter' },
            { name: `Pause and return to prompt`, value: 'pause' }
          );

          let postBeatAction = 'write_next';
          try {
            postBeatAction = await select({
              message: `Beat ${beat.num} written. What would you like to do next?`,
              choices: writeChoices
            });
          } catch {
            postBeatAction = nextBeatInPlan ? 'write_next' : 'end_chapter';
          }

          if (postBeatAction === 'pause') {
            console.log(chalk.yellow(`\nPaused after Beat ${beat.num}. Next beat is Beat ${beat.num + 1}. Resume anytime with /write ${chapterNum}`));
            return;
          }
          if (postBeatAction === 'end_chapter') {
            console.log(chalk.bold.green(`\nEnding Chapter ${chapterNum} after Beat ${beat.num}...`));
            await generateChapterSummary({ chapterNum, chapterFile, summaryFile, groqClient, cwd, vectorStore, embedder, config });
            return;
          }
          if (postBeatAction === 'plan_next') {
            console.log(chalk.bold.cyan(`\nTransitioning to plan Beat ${totalPlannedBeats + 1} for Chapter ${chapterNum}...`));
            const { runPlanChapterWorkflow } = await import('./planChapter.js');
            await runPlanChapterWorkflow({
              chapterArg: `${chapterNum} add`,
              cwd,
              groqClient,
              vectorStore,
              embedder,
              reranker,
              conversationMgr,
              config
            });
            return;
          }
        }
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

    const creativity = config?.generation?.creativity || config?.creativity || 'medium';
    const temps = getCreativityTemperatures(creativity);
    const summaryTemp = temps.temperatureSummaries;

    const summaryText = await groqClient.chatCompletion({
      model: 'small',
      messages: [
        { role: 'system', content: CHAPTER_SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: `Chapter ${chapterNum} Full Manuscript:\n\n${cleanProse}` }
      ],
      temperature: summaryTemp,
      maxTokens: 2048,
      reasoningEffort: 'low',
      sessionId: `chapter_${chapterNum}`,
      workflow: 'CHAPTER_SUMMARY'
    });

    await createBackup(summaryFile, cwd);
    await fs.writeFile(summaryFile, summaryText.trim(), 'utf8');
    spinner.succeed(`Saved summary to project/chapter-${padChapter(chapterNum)}/summary.md`);

    // Requirement 4 & 5: Update story-so-far.md
    let chapterTitle = '';
    try {
      const planFile = path.join(cwd, 'project', `chapter-${padChapter(chapterNum)}`, 'plan.md');
      const planContent = await fs.readFile(planFile, 'utf8');
      const header = parseChapterPlanHeader(planContent);
      chapterTitle = header.title || '';
    } catch {}

    const ssfSpinner = createSpinner('Condensing chapter summary into Story So Far with 20B model...').start();
    try {
      await updateStorySoFar({
        chapterNum,
        chapterTitle,
        summaryText,
        groqClient,
        cwd,
        config
      });
      ssfSpinner.succeed('Updated .condensed/story-so-far.md.');
    } catch (err) {
      ssfSpinner.fail(`Failed to update Story So Far: ${err.message}`);
    }

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
  ensureStdinRaw();
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

  // Scoped Story Bible RAG for chapter revision
  let ragChunks = [];
  try {
    const isPaid = Boolean(config?.apiTier === 'paid' || config?.apiTier === 'developer');
    const queryVector = await embedder.embedQuery(editInstructions);
    const candidates = await vectorStore.hybridSearch({
      queryText: editInstructions,
      queryVector,
      vectorTopK: 15,
      bm25TopK: 15,
      sourceTypes: isPaid ? ['story-bible', 'story-bible-reference'] : ['story-bible'],
      authorityTiers: [1],
      isPaid
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

  if (groqClient?.quotaManager) {
    const cd = config?.cooldownSeconds !== undefined ? config.cooldownSeconds : (process.stdin?.isTTY ? 45 : 0);
    await groqClient.quotaManager.enforceGenerationCooldown({
      cooldownSeconds: cd,
      isPaid: config?.apiTier === 'paid' || config?.apiTier === 'developer'
    });
  }

  process.stdout.write(chalk.bold.green(`\nGenerating revised Chapter ${chapterNum} manuscript:\n\n`));

  const editProfile = getExecutionProfile('EDIT_CHAPTER', config);
  let revisedChapter = '';
  try {
    revisedChapter = await groqClient.streamChatCompletion({
      model: 'large',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: editProfile.temperatureWrite,
      maxTokens: 8192,
      reasoningEffort: editProfile.reasoningEffort,
      sessionId: `chapter_${chapterNum}`,
      workflow: 'EDIT_CHAPTER',
      onChunk: (delta) => {
        process.stdout.write(delta);
      }
    });
    console.log('\n');
    if (groqClient?.quotaManager) {
      groqClient.quotaManager.recordGenerationEnd();
    }

  } catch (err) {
    console.error(chalk.red(`\nChapter revision failed: ${err.message}`));
    return;
  }

  const review = await promptReviewWorkflow({
    draftContent: revisedChapter,
    itemLabel: `Chapter ${chapterNum} Manuscript`,
    allowPause: false,
    preferredEditor: config.editor,
    quotaManager: groqClient?.quotaManager,
    config,
    model: config.models?.large || 'openai/gpt-oss-120b'
  });

  if (review.action === 'accept') {
    await createBackup(chapterFile, cwd);
    // Parse beats to ensure ordering is guaranteed
    const { header, beatsMap } = parseChapterBeats(review.content);
    const planBeats = planContent ? parseBeatsFromPlan(planContent) : [];
    if (beatsMap.size > 0) {
      await fs.writeFile(chapterFile, serializeChapterBeats(header, beatsMap), 'utf8');

      // Re-condense revised beats into .condensed/chapters/chapter-XX/prose.md
      const condenseSpinner = createSpinner(`Re-condensing ${beatsMap.size} revised beats with 20B model...`).start();
      try {
        for (const [beatNum, beatProse] of beatsMap.entries()) {
          const matchedPlanBeat = planBeats.find((b) => b.num === beatNum);
          await saveCondensedBeatProse({
            chapterNum,
            beatNum,
            beatTitle: matchedPlanBeat?.title || `Scene ${beatNum}`,
            proseText: beatProse,
            groqClient,
            cwd,
            config
          });
        }
        condenseSpinner.succeed(`Revised beats condensed into .condensed/chapters/chapter-${padded}/prose.md`);
      } catch (err) {
        condenseSpinner.fail(`Failed to re-condense revised beats: ${err.message}`);
      }
    } else {
      await fs.writeFile(chapterFile, review.content.trim() + '\n', 'utf8');
    }
    console.log(chalk.green(`\nChapter ${chapterNum} updated in project/chapter-${padded}/chapter.md`));
    await generateChapterSummary({ chapterNum, chapterFile, summaryFile, groqClient, cwd, vectorStore, embedder, config });
  } else {
    console.log(chalk.yellow(`\nChapter ${chapterNum} revision discarded. Original manuscript kept intact.`));
  }
}

