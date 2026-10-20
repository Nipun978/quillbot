import fs from 'node:fs/promises';
import path from 'node:path';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { INIT_BIBLE_SYSTEM_PROMPT } from '../llm/prompts.js';
import { createSpinner, printMarkdown } from '../ui/renderer.js';
import { promptReviewWorkflow } from '../ui/reviewPrompt.js';
import { syncAllFiles } from '../rag/fileSync.js';
import { saveConfig, updateInstructionsFile } from '../config/configManager.js';

export async function runInitProjectWorkflow({
  cwd = process.cwd(),
  groqClient,
  vectorStore,
  embedder,
  config
}) {
  console.log(chalk.bold.cyan('\n  /init: Story in a Nutshell -> Story Bible Generator'));
  console.log(chalk.dim('  Provide a project title, writing style preferences, and a short synopsis.'));
  console.log(chalk.dim('  Quillbot will generate characters.md, world-and-lore.md, locations.md, and plot-overview.md in structured paragraphs.\n'));

  const projectTitle = await input({
    message: 'Project / Novel Title:',
    default: config.projectTitle || 'Untitled Novel'
  });

  const writingStyle = await input({
    message: 'Writing Style Preferences (e.g., POV, tone, pacing, prose style):',
    default: config.writingStyle || 'Third-person limited, atmospheric, psychologically nuanced, sensory-rich prose'
  });

  config.projectTitle = projectTitle.trim() || 'Untitled Novel';
  config.writingStyle = writingStyle.trim() || config.writingStyle;
  await saveConfig(config, cwd);
  await updateInstructionsFile(cwd, {
    projectTitle: config.projectTitle,
    writingStyle: config.writingStyle
  });

  const synopsis = await input({
    message: 'Paste or type your story premise / synopsis:'
  });

  if (!synopsis || !synopsis.trim()) {
    console.log(chalk.yellow('No synopsis provided. Aborting /init.'));
    return;
  }

  let currentFeedback = '';
  let accepted = false;
  let bibleData = null;

  while (!accepted) {
    const spinner = createSpinner('Generating foundational Story Bible with large model in paragraph format...').start();

    try {
      const messages = [
        { role: 'system', content: INIT_BIBLE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Project Title: ${config.projectTitle}
Writing Style Preferences: ${config.writingStyle}

Story Synopsis:
${synopsis.trim()}` +
            (currentFeedback ? `\n\nRevision Notes:\n${currentFeedback}` : '')
        }
      ];

      bibleData = await groqClient.jsonCompletion({
        model: 'large',
        messages,
        temperature: 0.7,
        sessionId: 'init_project',
        workflow: 'INIT_STORY_BIBLE'
      });

      spinner.succeed('Generated 4 Story Bible documents.');
    } catch (err) {
      spinner.fail(`Failed to generate Story Bible: ${err.message}`);
      return;
    }

    const preview = `# Story Bible Preview: ${config.projectTitle}
**Writing Style Preferences:** ${config.writingStyle}

## 1. Characters (characters.md)
${bibleData.characters || '(Empty)'}

---

## 2. World & Lore (world-and-lore.md)
${bibleData.worldAndLore || '(Empty)'}

---

## 3. Locations (locations.md)
${bibleData.locations || '(Empty)'}

---

## 4. Plot Overview (plot-overview.md)
${bibleData.plotOverview || '(Empty)'}
`;

    console.log('\n' + chalk.bold.magenta('--- Story Bible Generation Preview ---'));
    printMarkdown(preview);

    const review = await promptReviewWorkflow({
      draftContent: preview,
      itemLabel: 'Story Bible draft',
      allowPause: false,
      preferredEditor: config.editor
    });

    if (review.action === 'accept') {
      accepted = true;
    } else if (review.action === 'retry') {
      currentFeedback = review.feedback || 'Please refine the details and enhance world richness.';
    }
  }

  // Write the four files to story-bible/
  const bibleDir = path.join(cwd, 'story-bible');
  await fs.mkdir(bibleDir, { recursive: true });

  await fs.writeFile(path.join(bibleDir, 'characters.md'), bibleData.characters || '', 'utf8');
  await fs.writeFile(path.join(bibleDir, 'world-and-lore.md'), bibleData.worldAndLore || '', 'utf8');
  await fs.writeFile(path.join(bibleDir, 'locations.md'), bibleData.locations || '', 'utf8');
  await fs.writeFile(path.join(bibleDir, 'plot-overview.md'), bibleData.plotOverview || '', 'utf8');

  console.log(chalk.green('\n  Successfully created 4 Story Bible files in story-bible/'));

  const syncSpinner = createSpinner('Indexing Story Bible into LanceDB...').start();
  try {
    const syncRes = await syncAllFiles({ cwd, vectorStore, embedder, config });
    syncSpinner.succeed(`Indexed ${syncRes.indexedCount} chunks into local hybrid RAG.`);
  } catch (err) {
    syncSpinner.fail(`Failed to index: ${err.message}`);
  }
}
