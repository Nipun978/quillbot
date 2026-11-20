import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CONDENSE_BEAT_PLAN_SYSTEM_PROMPT,
  CONDENSE_BEAT_PROSE_SYSTEM_PROMPT,
  CONDENSE_PLAN_SYSTEM_PROMPT,
  CONDENSE_PROSE_SYSTEM_PROMPT,
  UPDATE_STORY_SO_FAR_SYSTEM_PROMPT
} from '../llm/prompts.js';
import { getCreativityTemperatures } from './configManager.js';

export const CONDENSED_DIR = '.condensed';

export function getCondensedDir(cwd = process.cwd()) {
  return path.join(cwd, CONDENSED_DIR);
}

export function padChapter(num) {
  return String(num).padStart(2, '0');
}

export function padBeat(num) {
  return String(num).padStart(2, '0');
}

/**
 * Ensures .condensed/ and .condensed/chapters/chapter-XX exist.
 * Note: Each chapter folder strictly contains ONLY plan.md and prose.md.
 */
export async function ensureCondensedDirectories(cwd = process.cwd(), chapterNum = null) {
  const baseDir = getCondensedDir(cwd);
  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(path.join(baseDir, 'chapters'), { recursive: true });

  if (chapterNum !== null && !isNaN(chapterNum)) {
    const chPadded = padChapter(chapterNum);
    const chDir = path.join(baseDir, 'chapters', `chapter-${chPadded}`);
    await fs.mkdir(chDir, { recursive: true });
    return chDir;
  }

  return baseDir;
}

/**
 * Parses a condensed markdown file containing beats (### Beat N: Title\nText)
 * into an array of { num, title, text, rawBlock }.
 */
export function parseCondensedBeats(fileContent = '') {
  if (!fileContent || !fileContent.trim()) return [];

  const beatRegex = /^### Beat (\d+)(?::\s*(.*?))?$/gm;
  const indices = [];
  let match;

  while ((match = beatRegex.exec(fileContent)) !== null) {
    indices.push({
      index: match.index,
      beatNum: parseInt(match[1], 10),
      title: (match[2] || '').trim()
    });
  }

  const beats = [];
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i].index;
    const end = i < indices.length - 1 ? indices[i + 1].index : fileContent.length;
    const rawBlock = fileContent.slice(start, end).trim();
    // Body is text after heading line
    const bodyMatch = rawBlock.match(/^### Beat \d+.*?\n([\s\S]*)$/);
    const text = bodyMatch ? bodyMatch[1].trim() : rawBlock;

    beats.push({
      num: indices[i].beatNum,
      title: indices[i].title,
      text,
      rawBlock
    });
  }

  return beats;
}

/**
 * Formats a list of beats into a clean markdown document.
 */
export function formatCondensedBeatsFile(headerTitle, beatsList = []) {
  const sorted = [...beatsList].sort((a, b) => a.num - b.num);
  const blocks = sorted.map((b) => {
    const titlePart = b.title ? `: ${b.title}` : '';
    return `### Beat ${b.num}${titlePart}\n${b.text.trim()}`;
  });

  return `# ${headerTitle}\n\n${blocks.join('\n\n')}\n`;
}

function isTruncatedOrEmptyCondensed(text = '', prefixRegex = null) {
  let body = (text || '').trim();
  if (prefixRegex) {
    body = body.replace(prefixRegex, '').trim();
  }
  if (!body || body.length < 12) return true;
  if (body.length < 35 && !/[.!?…"”'’)]$/.test(body)) return true;
  return false;
}

/**
 * Requirement 2: Condenses a single beat plan using 20B model and stores it in
 * .condensed/chapters/chapter-XX/plan.md under the beat label.
 */
export async function saveCondensedBeatPlan({
  chapterNum,
  beatNum,
  beatTitle = '',
  planText = '',
  groqClient,
  cwd = process.cwd(),
  config = {}
}) {
  if (!chapterNum || !beatNum) return '';

  const chDir = await ensureCondensedDirectories(cwd, chapterNum);
  const planFilePath = path.join(chDir, 'plan.md');

  let condensed = '';
  const creativity = config?.generation?.creativity || config?.creativity || 'medium';
  const temps = getCreativityTemperatures(creativity);
  if (groqClient && planText) {
    try {
      condensed = await groqClient.chatCompletion({
        model: 'small', // Requirement 6: Use 20B model
        messages: [
          { role: 'system', content: CONDENSE_BEAT_PLAN_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Chapter ${chapterNum} Beat ${beatNum}${beatTitle ? ` (${beatTitle})` : ''} Plan to condense:\n\n${planText}`
          }
        ],
        temperature: temps.temperatureSummaries,
        maxTokens: 1024,
        reasoningEffort: 'low',
        sessionId: `condense_plan_ch${chapterNum}_b${beatNum}`,
        workflow: 'CONDENSE_BEAT'
      });
      condensed = (condensed || '').trim();
    } catch {
      condensed = '';
    }
  }

  const prefixRegex = new RegExp(`^Beat\\s+${beatNum}(?:\\s*\\([^)]*\\))?:?\\s*`, 'i');

  // Fallback if model output is empty, API call failed, or reasoning exhausted into a mid-sentence fragment
  if (isTruncatedOrEmptyCondensed(condensed, prefixRegex)) {
    const fallbackClean = planText.replace(/^### Beat \d+:.*?\n/, '').replace(/\n+/g, ' ').slice(0, 120).trim();
    condensed = `- **Facts & Milestones:**\n  1. ${fallbackClean}...\n- **Key Dialogue & Interactions:**\n  - Tagged interactions from Beat ${beatNum} outline.\n- **Sensory & Atmospheric Anchors:**\n  - Grounded setting and atmosphere from Beat ${beatNum} plan.`;
  }

  // Ensure consistent label
  condensed = condensed.replace(prefixRegex, '').trim();
  const label = `Beat ${beatNum} (${beatTitle || 'Scene'}):`;
  let formattedBeatText = '';
  if (condensed.startsWith(label)) {
    formattedBeatText = condensed;
  } else if (condensed.startsWith('- **Facts & Milestones:**') || condensed.startsWith('- **')) {
    formattedBeatText = `${label}\n${condensed}`;
  } else {
    formattedBeatText = `${label} ${condensed}`;
  }

  // Read existing plan.md or initialize
  let currentFile = '';
  try {
    currentFile = await fs.readFile(planFilePath, 'utf8');
  } catch {
    currentFile = `# Chapter ${chapterNum} Condensed Plan\n`;
  }

  const existingBeats = parseCondensedBeats(currentFile);
  const idx = existingBeats.findIndex((b) => b.num === beatNum);
  if (idx !== -1) {
    existingBeats[idx] = { num: beatNum, title: beatTitle, text: formattedBeatText };
  } else {
    existingBeats.push({ num: beatNum, title: beatTitle, text: formattedBeatText });
  }

  const updatedContent = formatCondensedBeatsFile(`Chapter ${chapterNum} Condensed Plan`, existingBeats);
  await fs.writeFile(planFilePath, updatedContent, 'utf8');

  return formattedBeatText;
}

/**
 * Requirement 3: Condenses accepted beat prose using 20B model and stores it in
 * .condensed/chapters/chapter-XX/prose.md under the beat label.
 * Cross-references Beat Plan (blueprint) and Narrative Prose (manuscript).
 */
export async function saveCondensedBeatProse({
  chapterNum,
  beatNum,
  beatTitle = '',
  proseText = '',
  planText = '',
  groqClient,
  cwd = process.cwd(),
  config = {}
}) {
  if (!chapterNum || !beatNum) return '';

  const chDir = await ensureCondensedDirectories(cwd, chapterNum);
  const proseFilePath = path.join(chDir, 'prose.md');

  const cleanProse = proseText.replace(/<!-- BEAT \d+ -->/g, '').trim();

  // If planText is not passed, attempt to look it up from condensed plan or full plan
  let effectivePlanText = (planText || '').trim();
  if (!effectivePlanText) {
    try {
      const plans = await getCondensedBeatPlans(chapterNum, cwd);
      const match = plans.find((b) => b.num === beatNum);
      if (match && match.text) {
        effectivePlanText = match.text;
      }
    } catch {}
  }
  if (!effectivePlanText) {
    try {
      const chPadded = padChapter(chapterNum);
      const fullPlanPath = path.join(cwd, 'project', `chapter-${chPadded}`, 'plan.md');
      const fullPlan = await fs.readFile(fullPlanPath, 'utf8');
      const { parseBeatsFromPlan } = await import('../workflows/planChapter.js');
      const allBeats = parseBeatsFromPlan(fullPlan);
      const target = allBeats.find((b) => b.num === beatNum);
      if (target) {
        effectivePlanText = target.rawBlock || target.action || '';
      }
    } catch {}
  }

  let condensed = '';
  const creativity = config?.generation?.creativity || config?.creativity || 'medium';
  const temps = getCreativityTemperatures(creativity);
  if (groqClient && cleanProse) {
    try {
      const planSection = effectivePlanText
        ? `--- BEAT PLAN (Author's Blueprint) ---\n${effectivePlanText.slice(0, 3000)}\n\n`
        : '';

      condensed = await groqClient.chatCompletion({
        model: 'small', // Requirement 6: Use 20B model
        messages: [
          { role: 'system', content: CONDENSE_BEAT_PROSE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Chapter ${chapterNum} Beat ${beatNum}${beatTitle ? ` (${beatTitle})` : ''} to condense:\n\n${planSection}--- NARRATIVE PROSE (Manuscript) ---\n${cleanProse.slice(-3500)}`
          }
        ],
        temperature: temps.temperatureSummaries,
        maxTokens: 1024,
        reasoningEffort: 'low',
        sessionId: `condense_prose_ch${chapterNum}_b${beatNum}`,
        workflow: 'CONDENSE_BEAT_PROSE'
      });
      condensed = (condensed || '').trim();
    } catch {
      condensed = '';
    }
  }

  const prefixRegex = new RegExp(`^Beat\\s+${beatNum}(?:\\s*\\([^)]*\\))?:?\\s*`, 'i');

  // Fallback if model output is empty, API call failed, or truncated fragment
  if (isTruncatedOrEmptyCondensed(condensed, prefixRegex)) {
    const fallbackFacts = cleanProse.slice(0, 120).replace(/\n+/g, ' ').trim();
    condensed = `- **Facts & Milestones:**\n  1. ${fallbackFacts}...\n- **Key Dialogue & Interactions:**\n  - Dialogue and actions as written in Beat ${beatNum}.\n- **Sensory & Atmospheric Anchors:**\n  - Atmospheric and environmental continuity preserved.`;
  }

  // Ensure consistent label
  condensed = condensed.replace(prefixRegex, '').trim();
  const label = `Beat ${beatNum} (${beatTitle || 'Scene'}):`;
  let formattedProseText = '';
  if (condensed.startsWith(label)) {
    formattedProseText = condensed;
  } else if (condensed.startsWith('- **Facts & Milestones:**') || condensed.startsWith('- **')) {
    formattedProseText = `${label}\n${condensed}`;
  } else {
    formattedProseText = `${label} ${condensed}`;
  }

  // Read existing prose.md or initialize
  let currentFile = '';
  try {
    currentFile = await fs.readFile(proseFilePath, 'utf8');
  } catch {
    currentFile = `# Chapter ${chapterNum} Condensed Prose\n`;
  }

  const existingBeats = parseCondensedBeats(currentFile);
  const idx = existingBeats.findIndex((b) => b.num === beatNum);
  if (idx !== -1) {
    existingBeats[idx] = { num: beatNum, title: beatTitle, text: formattedProseText };
  } else {
    existingBeats.push({ num: beatNum, title: beatTitle, text: formattedProseText });
  }

  const updatedContent = formatCondensedBeatsFile(`Chapter ${chapterNum} Condensed Prose`, existingBeats);
  await fs.writeFile(proseFilePath, updatedContent, 'utf8');

  return formattedProseText;
}

/**
 * Returns all condensed beat plans for a chapter from .condensed/chapters/chapter-XX/plan.md.
 */
export async function getCondensedBeatPlans(chapterNum, cwd = process.cwd()) {
  const chPadded = padChapter(chapterNum);
  const planFilePath = path.join(getCondensedDir(cwd), 'chapters', `chapter-${chPadded}`, 'plan.md');
  try {
    const content = await fs.readFile(planFilePath, 'utf8');
    return parseCondensedBeats(content);
  } catch {
    return [];
  }
}

/**
 * Returns all condensed beat prose for a chapter from .condensed/chapters/chapter-XX/prose.md.
 */
export async function getCondensedBeatProse(chapterNum, cwd = process.cwd()) {
  const chPadded = padChapter(chapterNum);
  const proseFilePath = path.join(getCondensedDir(cwd), 'chapters', `chapter-${chPadded}`, 'prose.md');
  try {
    const content = await fs.readFile(proseFilePath, 'utf8');
    return parseCondensedBeats(content);
  } catch {
    return [];
  }
}

/**
 * Requirement 4: Updates or appends 2-3 bullet pointers for chapterNum in .condensed/story-so-far.md
 */
export async function updateStorySoFar({
  chapterNum,
  chapterTitle = '',
  summaryText = '',
  groqClient,
  cwd = process.cwd(),
  config = {}
}) {
  await ensureCondensedDirectories(cwd);
  const storySoFarPath = path.join(getCondensedDir(cwd), 'story-so-far.md');

  let currentStorySoFar = '';
  try {
    currentStorySoFar = await fs.readFile(storySoFarPath, 'utf8');
  } catch {
    currentStorySoFar = '# Story So Far\n';
  }

  // Clean out default placeholder if present
  currentStorySoFar = currentStorySoFar.replace(/\(No chapters written yet\.\)\s*\n?/gi, '').trim();

  let body = '';
  const creativity = config?.generation?.creativity || config?.creativity || 'medium';
  const temps = getCreativityTemperatures(creativity);
  if (groqClient && summaryText) {
    try {
      body = await groqClient.chatCompletion({
        model: 'small', // Requirement 6: Use 20B model
        messages: [
          { role: 'system', content: UPDATE_STORY_SO_FAR_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Chapter ${chapterNum}${chapterTitle ? ` (${chapterTitle})` : ''} 250-word Summary:\n${summaryText.trim()}\n\nGenerate the complete chronological milestone facts and End State for this chapter.`
          }
        ],
        temperature: temps.temperatureSummaries,
        maxTokens: 1024,
        reasoningEffort: 'low',
        sessionId: `story_so_far_ch${chapterNum}`,
        workflow: 'UPDATE_STORY_SO_FAR'
      });
      body = (body || '').trim();
    } catch {
      body = '';
    }
  }

  if (isTruncatedOrEmptyCondensed(body)) {
    const sentences = summaryText ? summaryText.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/).filter(Boolean) : [];
    const list = sentences.slice(0, 5).map((s, idx) => `  ${idx + 1}. ${s.trim()}`).join('\n');
    body = `- **Facts & Milestones:**\n${list || `  1. Events of Chapter ${chapterNum} concluded.`}\n- **Key Dialogue & Interactions:**\n  - Key dialogues and interactions in Chapter ${chapterNum}.\n- **Sensory & Atmospheric Anchors:**\n  - Atmospheric and environmental continuity preserved.\n- **End State:** Chapter ${chapterNum} concluded.`;
  }

  // Strip redundant leading markdown header if generated by LLM
  body = body.replace(/^#+\s*Chapter\s+\d+[^\n]*\n+/i, '').replace(/^-\s*\*\*Chapter\s+\d+[^\n]*\n+/i, '').trim();

  const cleanHeader = `- **Chapter ${chapterNum}${chapterTitle ? ` (${chapterTitle}):` : ':'}**`;
  const newEntry = `${cleanHeader} ${body}`.trim();

  // If chapter entry already exists in story-so-far.md (modern ## or - **), replace it; otherwise append
  const chapterBlockRegex = new RegExp(
    `(^|\\n)(?:##\\s*Chapter\\s+${chapterNum}(?:\\s*\\([^)]+\\))?:?|-\\s*\\*\\*Chapter\\s+${chapterNum}(?:\\s*\\([^)]+\\))?:?\\*\\*)[\\s\\S]*?(?=(\\n(?:##\\s*Chapter\\s+\\d+|-\\s*\\*\\*Chapter\\s+\\d+))|$)`,
    'i'
  );

  let updatedContent = '';
  if (chapterBlockRegex.test(currentStorySoFar)) {
    updatedContent = currentStorySoFar.replace(chapterBlockRegex, (match, prefix) => `${prefix}${newEntry}`);
  } else {
    const base = currentStorySoFar.trim() || '# Story So Far';
    updatedContent = `${base}\n\n${newEntry}\n`;
  }

  await fs.writeFile(storySoFarPath, updatedContent.trim() + '\n', 'utf8');
  return updatedContent.trim();
}

/**
 * Loads the full story-so-far.md content if available.
 */
export async function loadStorySoFar(cwd = process.cwd()) {
  const storySoFarPath = path.join(getCondensedDir(cwd), 'story-so-far.md');
  try {
    return await fs.readFile(storySoFarPath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Implements Requirement 5 & 6 sliding window for past chapters (Deterministic):
 * - If currentChapterNum <= 1: returns empty strings
 * - If currentChapterNum == 2: sends Chapter 1 summary.md only
 * - If currentChapterNum >= 3:
 *   - Sends summary of chapter currentChapterNum - 1 in full
 *   - Sends pointers for chapters 1 to currentChapterNum - 2 from story-so-far.md
 */
export async function loadStoryContextForChapter({
  currentChapterNum = 1,
  cwd = process.cwd()
}) {
  if (currentChapterNum <= 1) {
    return {
      storySoFar: '',
      previousChapterSummary: ''
    };
  }

  const projectDir = path.join(cwd, 'project');

  // Chapter N - 1 summary (full 250 words)
  const prevNum = currentChapterNum - 1;
  const prevPadded = padChapter(prevNum);
  let previousChapterSummary = '';
  try {
    const prevSummaryPath = path.join(projectDir, `chapter-${prevPadded}`, 'summary.md');
    previousChapterSummary = await fs.readFile(prevSummaryPath, 'utf8');
  } catch {}

  if (currentChapterNum === 2) {
    return {
      storySoFar: '',
      previousChapterSummary: previousChapterSummary.trim()
    };
  }

  // For currentChapterNum >= 3: extract pointers for chapters 1 .. N-2 from story-so-far.md
  let storySoFar = '';
  try {
    const fullStorySoFar = await loadStorySoFar(cwd);
    if (fullStorySoFar) {
      // Support both modern structured blocks (## Chapter N) and legacy bullet points (- **Chapter N)
      const parts = fullStorySoFar.split(/(?=^##\s*Chapter\s+\d+|^-\s*\*\*Chapter\s+\d+)/mi);
      const matchedBlocks = [];
      for (const part of parts) {
        const m = part.match(/^(?:##\s*Chapter\s+(\d+)|-\s*\*\*Chapter\s+(\d+))/i);
        if (m) {
          const ch = parseInt(m[1] || m[2], 10);
          if (ch >= 1 && ch <= currentChapterNum - 2) {
            matchedBlocks.push(part.trim());
          }
        }
      }
      if (matchedBlocks.length > 0) {
        storySoFar = matchedBlocks.join('\n\n');
      }
    }
  } catch {}

  // Fallback if story-so-far is empty: gather condensed summaries
  if (!storySoFar) {
    const fallbackPointers = [];
    for (let i = 1; i <= currentChapterNum - 2; i++) {
      const chPadded = padChapter(i);
      try {
        const sumPath = path.join(projectDir, `chapter-${chPadded}`, 'summary.md');
        const text = await fs.readFile(sumPath, 'utf8');
        fallbackPointers.push(`- **Chapter ${i}:** ${text.trim().slice(0, 150)}...`);
      } catch {}
    }
    storySoFar = fallbackPointers.join('\n');
  }

  return {
    storySoFar: storySoFar.trim(),
    previousChapterSummary: previousChapterSummary.trim()
  };
}

/**
 * Requirement 5: Context assembly for planning Beat K of Chapter N (Deterministic):
 * - Complete plan of Beat K-1 (if exists)
 * - Condensed plans of Beats 1 .. K-2 from .condensed/chapters/chapter-XX/plan.md
 */
export async function loadPlanningContinuityContext({
  chapterNum,
  activeBeatNum = 1,
  allBeatsInPlan = [],
  cwd = process.cwd()
}) {
  if (activeBeatNum <= 1) {
    return {
      previousBeatPlan: null,
      priorCondensedPlans: []
    };
  }

  // Previous Beat (K - 1) in full detail
  const prevBeat = allBeatsInPlan.find((b) => b.num === activeBeatNum - 1);
  const previousBeatPlan = prevBeat ? (prevBeat.rawBlock || `### Beat ${prevBeat.num}: ${prevBeat.title}\n- **Action:** ${prevBeat.action}\n- **Goal/Hook:** ${prevBeat.goalHook}`) : null;

  // Condensed plans for beats 1 .. K - 2
  const allCondensed = await getCondensedBeatPlans(chapterNum, cwd);
  const priorCondensedPlans = allCondensed
    .filter((b) => b.num < activeBeatNum - 1)
    .map((b) => b.text || `Beat ${b.num}: ${b.title}`);

  return {
    previousBeatPlan,
    priorCondensedPlans
  };
}

/**
 * Requirement 6: Context assembly for writing Beat K of Chapter N (Deterministic):
 * - Condensed prose for beats 1 .. K-1 from .condensed/chapters/chapter-XX/prose.md
 * - Verbatim trailing words (~200-350 words) from Beat K-1
 * - Next beat condensed plan (Beat K+1 from .condensed/chapters/chapter-XX/plan.md)
 * - Is finale beat flag (if K is the last beat)
 */
export async function loadWritingContinuityContext({
  chapterNum,
  activeBeatNum = 1,
  beatsList = [],
  cwd = process.cwd(),
  chapterFile = null,
  tailWordLimit = 350
}) {
  const allCondensedProse = await getCondensedBeatProse(chapterNum, cwd);
  const priorCondensedProse = allCondensedProse
    .filter((b) => b.num < activeBeatNum)
    .map((b) => b.text || `Beat ${b.num}: ${b.title}`);

  // Next Beat (K + 1) condensed plan for foresight
  let nextBeatCondensedPlan = null;
  const isFinaleBeat = activeBeatNum >= beatsList.length;

  if (!isFinaleBeat) {
    const allCondensedPlans = await getCondensedBeatPlans(chapterNum, cwd);
    const nextCondensed = allCondensedPlans.find((b) => b.num === activeBeatNum + 1);
    if (nextCondensed) {
      nextBeatCondensedPlan = nextCondensed.text;
    } else {
      const nextRaw = beatsList.find((b) => b.num === activeBeatNum + 1);
      if (nextRaw) {
        nextBeatCondensedPlan = `Beat ${nextRaw.num} (${nextRaw.title || 'Next Scene'}): ${(nextRaw.action || '').slice(0, 100).trim()}...`;
      }
    }
  }

  // Verbatim trailing words from Beat K-1 in chapter.md
  let lastProseSnippet = '';
  if (chapterFile && activeBeatNum > 1) {
    try {
      const rawManuscript = await fs.readFile(chapterFile, 'utf8');
      const beatMarker = `<!-- BEAT ${activeBeatNum - 1} -->`;
      const nextMarker = `<!-- BEAT ${activeBeatNum} -->`;

      let beatText = '';
      if (rawManuscript.includes(beatMarker)) {
        const afterPrev = rawManuscript.slice(rawManuscript.indexOf(beatMarker) + beatMarker.length);
        beatText = afterPrev.includes(nextMarker) ? afterPrev.slice(0, afterPrev.indexOf(nextMarker)) : afterPrev;
      } else {
        beatText = rawManuscript;
      }

      const words = beatText.replace(/<!-- BEAT \d+ -->/g, '').trim().split(/\s+/);
      if (words.length > 0 && words[0]) {
        lastProseSnippet = words.slice(-tailWordLimit).join(' ');
      }
    } catch {}
  }

  return {
    priorCondensedProse,
    lastProseSnippet,
    nextBeatCondensedPlan,
    isFinaleBeat
  };
}

// ==========================================
// BACKWARDS-COMPATIBILITY ALIASES
// ==========================================

export async function condenseBeatPlan({
  chapterNum,
  beat,
  groqClient,
  cwd = process.cwd(),
  config = {}
}) {
  if (!beat || !beat.num) return '';
  const rawBeat = beat.rawBlock || `### Beat ${beat.num}: ${beat.title || ''}
- **Action:** ${beat.action || ''}
- **Goal/Hook:** ${beat.goalHook || ''}`;
  return saveCondensedBeatPlan({
    chapterNum,
    beatNum: beat.num,
    beatTitle: beat.title,
    planText: rawBeat,
    groqClient,
    cwd,
    config
  });
}

export async function condenseChapterPlan({
  chapterNum,
  planContent,
  beats = [],
  groqClient,
  cwd = process.cwd(),
  config = {}
}) {
  for (const b of beats) {
    await condenseBeatPlan({ chapterNum, beat: b, groqClient, cwd, config });
  }
}

export async function condenseChapterProse({
  chapterNum,
  proseContent,
  groqClient,
  cwd = process.cwd(),
  config = {}
}) {
  // If chapter prose has beat markers, condense each beat into prose.md
  const markerRegex = /<!-- BEAT (\d+) -->/g;
  const matches = [...proseContent.matchAll(markerRegex)];
  if (matches.length > 0) {
    for (let i = 0; i < matches.length; i++) {
      const beatNum = parseInt(matches[i][1], 10);
      const start = matches[i].index + matches[i][0].length;
      const end = i < matches.length - 1 ? matches[i + 1].index : proseContent.length;
      const beatProse = proseContent.slice(start, end).trim();
      await saveCondensedBeatProse({
        chapterNum,
        beatNum,
        beatTitle: `Scene ${beatNum}`,
        proseText: beatProse,
        groqClient,
        cwd,
        config
      });
    }
  } else {
    // Only fallback if there are NO existing condensed beats for this chapter
    const existing = await getCondensedBeatProse(chapterNum, cwd);
    if (existing.length === 0 && proseContent.trim()) {
      await saveCondensedBeatProse({
        chapterNum,
        beatNum: 1,
        beatTitle: 'Scene 1',
        proseText: proseContent,
        groqClient,
        cwd,
        config
      });
    }
  }
}

export async function loadCondensedBeats({
  chapterNum,
  beats = [],
  excludeBeatNum = null,
  cwd = process.cwd(),
  groqClient = null,
  config = {}
}) {
  const allCondensed = await getCondensedBeatPlans(chapterNum, cwd);
  const results = [];
  for (const b of beats) {
    if (excludeBeatNum !== null && b.num === excludeBeatNum) {
      continue;
    }
    const found = allCondensed.find((cb) => cb.num === b.num);
    if (found && found.text) {
      results.push(found.text);
    } else {
      const act = (b.action || '').replace(/\n+/g, ' ').slice(0, 100).trim();
      results.push(`Beat ${b.num} (${b.title || 'Scene'}): ${act}${act.length >= 100 ? '...' : ''}`);
    }
  }
  return results;
}
