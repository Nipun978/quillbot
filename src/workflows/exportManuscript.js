import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';

/**
 * Extracts chapter title from plan.md content or falls back to 'Chapter N'
 */
export function extractChapterTitle(planContent = '', chapterNum = 1) {
  if (!planContent) return `Chapter ${chapterNum}`;
  const match = planContent.match(/^# Chapter \d+:\s*(.+)$/m);
  if (match && match[1].trim()) {
    return match[1].trim();
  }
  return `Chapter ${chapterNum}`;
}

/**
 * Cleans chapter.md prose by stripping beat comments, generic headers,
 * and normalizing paragraph spacing or inserting scene breaks.
 */
export function cleanChapterProse(rawContent = '', { useSceneBreaks = false } = {}) {
  if (!rawContent || !rawContent.trim()) return '';

  // 1. Strip generic placeholder header e.g. "# Chapter Manuscript"
  let cleaned = rawContent
    .replace(/^#\s+Chapter\s+Manuscript\s*/im, '')
    .trim();

  // 2. Separate beats and clean spacing
  const beatParts = cleaned
    .split(/<!-- BEAT \d+ -->/g)
    .map((part) => part.trim())
    .filter(Boolean);

  if (beatParts.length === 0) {
    // If no beat markers were present, simply clean whatever prose exists
    cleaned = cleaned.replace(/<!-- BEAT \d+ -->/g, '').trim();
    return cleaned.replace(/\n{3,}/g, '\n\n');
  }

  const separator = useSceneBreaks ? '\n\n* * *\n\n' : '\n\n';
  return beatParts.join(separator).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Computes word count of a given text
 */
export function countWords(text = '') {
  if (!text || !text.trim()) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Sanitizes project title for safe filesystem output
 */
export function sanitizeTitle(title = 'novel') {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'novel';
}

/**
 * Assembles full manuscript string in Markdown or Plain Text
 */
export function assembleManuscript({
  projectTitle = 'Untitled Novel',
  chapters = [],
  isTxt = false
}) {
  if (isTxt) {
    const separatorLine = '='.repeat(Math.max(projectTitle.length, 30));
    let doc = `${projectTitle.toUpperCase()}\n${separatorLine}\n\n`;

    const chapterBlocks = chapters.map((ch) => {
      const heading = `CHAPTER ${ch.num}: ${ch.title.toUpperCase()}`;
      const underLine = '-'.repeat(heading.length);
      return `${heading}\n${underLine}\n\n${ch.prose}`;
    });

    return doc + chapterBlocks.join('\n\n\n') + '\n';
  }

  // Markdown format
  let doc = `# ${projectTitle}\n\n---\n\n`;

  const chapterBlocks = chapters.map((ch) => {
    return `# Chapter ${ch.num}: ${ch.title}\n\n${ch.prose}`;
  });

  return doc + chapterBlocks.join('\n\n---\n\n') + '\n';
}

/**
 * Main export workflow: compiles all chapter manuscripts into exports/
 */
export async function runExportWorkflow({
  arg = '',
  cwd = process.cwd(),
  config = {}
}) {
  const isTxt = Boolean(arg && (arg.toLowerCase().includes('txt') || arg.toLowerCase().includes('--txt')));
  const useSceneBreaks = Boolean(arg && (arg.toLowerCase().includes('scene-break') || arg.toLowerCase().includes('--scene-breaks')));

  const projectDir = path.join(cwd, 'project');
  let entries = [];
  try {
    entries = await fs.readdir(projectDir, { withFileTypes: true });
  } catch {
    console.log(chalk.yellow('\nNo "project/" directory found. Write some chapters first with /write.'));
    return null;
  }

  // Scan and sort chapter directories numerically
  const chapterDirs = entries
    .filter((e) => e.isDirectory() && /^chapter-(\d+)$/i.test(e.name))
    .map((e) => {
      const match = e.name.match(/^chapter-(\d+)$/i);
      return {
        name: e.name,
        num: parseInt(match[1], 10),
        fullPath: path.join(projectDir, e.name)
      };
    })
    .sort((a, b) => a.num - b.num);

  if (chapterDirs.length === 0) {
    console.log(chalk.yellow('\nNo chapter directories found in project/. Plan and write chapters first with /plan and /write.'));
    return null;
  }

  const compiledChapters = [];

  for (const ch of chapterDirs) {
    const chapterFile = path.join(ch.fullPath, 'chapter.md');
    const planFile = path.join(ch.fullPath, 'plan.md');

    let chapterRaw = '';
    try {
      chapterRaw = await fs.readFile(chapterFile, 'utf8');
    } catch {
      continue;
    }

    if (!chapterRaw || !chapterRaw.trim()) {
      continue;
    }

    let planContent = '';
    try {
      planContent = await fs.readFile(planFile, 'utf8');
    } catch {}

    const title = extractChapterTitle(planContent, ch.num);
    const cleanProse = cleanChapterProse(chapterRaw, { useSceneBreaks });

    if (!cleanProse) continue;

    const words = countWords(cleanProse);
    compiledChapters.push({
      num: ch.num,
      title,
      prose: cleanProse,
      wordCount: words
    });
  }

  if (compiledChapters.length === 0) {
    console.log(chalk.yellow('\nNo written prose found in any chapter.md. Write beats using /write first.'));
    return null;
  }

  const projectTitle = config?.projectTitle || 'Untitled Novel';
  const fullText = assembleManuscript({
    projectTitle,
    chapters: compiledChapters,
    isTxt
  });

  const exportDir = path.join(cwd, 'exports');
  await fs.mkdir(exportDir, { recursive: true });

  const sanitized = sanitizeTitle(projectTitle);
  const ext = isTxt ? 'txt' : 'md';
  const fileName = `${sanitized}-manuscript.${ext}`;
  const outputPath = path.join(exportDir, fileName);

  await fs.writeFile(outputPath, fullText, 'utf8');

  // Print Summary Report
  const totalWords = compiledChapters.reduce((sum, c) => sum + c.wordCount, 0);
  const chapterRange = compiledChapters.length === 1
    ? `Chapter ${compiledChapters[0].num}`
    : `Chapters ${compiledChapters[0].num}–${compiledChapters[compiledChapters.length - 1].num}`;

  console.log(chalk.bold.green(`\n✔ Clean manuscript successfully exported!`));
  console.log(chalk.cyan(`  File:      ${path.relative(cwd, outputPath)}`));
  console.log(chalk.white(`  Scope:     ${chapterRange} (${compiledChapters.length} chapter${compiledChapters.length === 1 ? '' : 's'})`));
  console.log(chalk.white(`  Total:     ${totalWords.toLocaleString()} words\n`));
  console.log(chalk.bold('  Per-Chapter Word Counts:'));

  for (const c of compiledChapters) {
    console.log(`    • Chapter ${c.num}: ${c.title.padEnd(25)} — ${c.wordCount.toLocaleString()} words`);
  }
  console.log('');

  return {
    outputPath,
    totalWords,
    chaptersExported: compiledChapters.length,
    chapterRange
  };
}
