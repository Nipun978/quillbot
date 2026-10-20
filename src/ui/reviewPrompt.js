import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';

export async function openInEditor(initialContent = '', preferredEditor = '') {
  const editor = preferredEditor || (process.platform === 'win32' ? 'notepad' : (process.env.EDITOR || 'nano'));
  const tempDir = os.tmpdir();
  const rand = crypto.randomBytes(6).toString('hex');
  const tempFile = path.join(tempDir, `quillbot_edit_${rand}.md`);

  await fs.writeFile(tempFile, initialContent, 'utf8');

  console.log(chalk.dim(`\nOpening ${editor}... (save and close the editor when done)`));

  // Determine shell option on Windows if editor is a command
  const isWin = process.platform === 'win32';
  const spawnRes = spawnSync(editor, [tempFile], {
    stdio: 'inherit',
    shell: isWin
  });

  if (spawnRes.error) {
    console.error(chalk.red(`Failed to launch editor "${editor}": ${spawnRes.error.message}`));
    console.log(chalk.yellow(`Keeping original text.`));
    try { await fs.unlink(tempFile); } catch {}
    return initialContent;
  }

  let editedContent = initialContent;
  try {
    editedContent = await fs.readFile(tempFile, 'utf8');
    await fs.unlink(tempFile);
  } catch (err) {
    console.error(chalk.red(`Error reading edited file: ${err.message}`));
  }

  return editedContent;
}

export async function promptReviewWorkflow({
  draftContent = '',
  itemLabel = 'draft',
  allowPause = true,
  preferredEditor = ''
}) {
  const choices = [
    { name: '[A]ccept - Commit and proceed', value: 'accept' },
    { name: '[R]etry  - Regenerate with revision feedback', value: 'retry' },
    { name: '[E]dit   - Open in external editor', value: 'edit' }
  ];

  if (allowPause) {
    choices.push({ name: '[P]ause  - Save progress and return to prompt', value: 'pause' });
  }

  const action = await select({
    message: `Review ${itemLabel}:`,
    choices
  });

  if (action === 'accept') {
    return { action: 'accept', content: draftContent };
  }

  if (action === 'retry') {
    const feedback = await input({
      message: 'Enter revision feedback for regeneration:'
    });
    return { action: 'retry', content: draftContent, feedback: feedback.trim() };
  }

  if (action === 'edit') {
    const edited = await openInEditor(draftContent, preferredEditor);
    console.log(chalk.green(`\nSaved changes from editor.`));
    // Verify if user wants to accept the edited content or retry again
    const postEditAction = await select({
      message: 'Action with edited text:',
      choices: [
        { name: '[A]ccept edited version', value: 'accept' },
        { name: '[R]e-edit in editor', value: 'edit_again' },
        { name: '[D]iscard edits and keep original', value: 'discard' }
      ]
    });

    if (postEditAction === 'edit_again') {
      return promptReviewWorkflow({
        draftContent: edited,
        itemLabel,
        allowPause,
        preferredEditor
      });
    }

    if (postEditAction === 'discard') {
      return { action: 'accept', content: draftContent };
    }

    return { action: 'accept', content: edited };
  }

  return { action: 'pause', content: draftContent };
}
