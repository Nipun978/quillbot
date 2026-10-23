import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createPrompt, useState, useKeypress, usePrefix, isEnterKey, isUpKey, isDownKey } from '@inquirer/core';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';

export const hotkeySelect = createPrompt((config, done) => {
  const { message, choices = [] } = config;
  const [active, setActive] = useState(0);
  const prefix = usePrefix({ status: 'idle' });

  useKeypress((key, rl) => {
    // 1. Check single-letter hotkeys (e.g. a, r, e, p, d)
    const char = (key.name || key.sequence || '').toLowerCase();
    const matchedChoice = choices.find((c) => c.key && c.key.toLowerCase() === char);
    if (matchedChoice) {
      done(matchedChoice.value);
      return;
    }

    // 2. Check Enter key
    if (isEnterKey(key)) {
      if (choices[active]) {
        done(choices[active].value);
      }
      return;
    }

    // 3. Arrow navigation
    if (isUpKey(key)) {
      setActive((active - 1 + choices.length) % choices.length);
    } else if (isDownKey(key)) {
      setActive((active + 1) % choices.length);
    }
  });

  const lines = [
    `${prefix} ${chalk.bold(message)}`,
    ...choices.map((c, idx) => {
      const isSelected = idx === active;
      const pointer = isSelected ? chalk.cyan('> ') : '  ';
      return isSelected ? chalk.cyan.bold(`${pointer}${c.name}`) : `${pointer}${c.name}`;
    }),
    chalk.dim(`\nPress hotkey [${choices.filter((c) => c.key).map((c) => c.key.toUpperCase()).join('/')}] or ↑↓ navigate • ⏎ select`)
  ];

  return lines.join('\n');
});

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

  if (process.stdin.isTTY) {
    try {
      process.stdin.resume();
    } catch {}
  }

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
  preferredEditor = '',
  criticIssues = []
}) {
  const choices = [
    { key: 'a', name: '[A]ccept - Commit and proceed', value: 'accept' },
    { key: 'r', name: '[R]etry  - Regenerate with revision feedback', value: 'retry' },
    { key: 'e', name: '[E]dit   - Open in external editor', value: 'edit' }
  ];

  if (criticIssues && criticIssues.length > 0) {
    choices.push({
      key: 'f',
      name: '[F]ix    - Auto-regenerate beat fixing Continuity Critic issues',
      value: 'fix_critic'
    });
  }

  if (allowPause) {
    choices.push({ key: 'p', name: '[P]ause  - Save progress and return to prompt', value: 'pause' });
  }

  let action;
  try {
    action = await hotkeySelect({
      message: `Review ${itemLabel}:`,
      choices
    });
  } catch (err) {
    if (err.name === 'ExitPromptError') {
      return { action: allowPause ? 'pause' : 'accept', content: draftContent };
    }
    throw err;
  }

  if (action === 'accept') {
    return { action: 'accept', content: draftContent };
  }

  if (action === 'fix_critic') {
    const formattedCriticFixInstructions = criticIssues.map((issue, idx) => {
      const typeStr = issue.type ? `[${issue.type}] ` : '';
      const quoteStr = issue.quote ? `\n- Quote: "${issue.quote}"` : '';
      const fixStr = issue.fixSuggestion ? `\n- Fix: ${issue.fixSuggestion}` : '';
      return `${idx + 1}. ${typeStr}${issue.description}${quoteStr}${fixStr}`;
    }).join('\n\n');

    return {
      action: 'retry',
      content: draftContent,
      feedback: `Please fix the following continuity issues detected by Continuity Critic:\n\n${formattedCriticFixInstructions}`
    };
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
    let postEditAction;
    try {
      postEditAction = await hotkeySelect({
        message: 'Action with edited text:',
        choices: [
          { key: 'a', name: '[A]ccept edited version', value: 'accept' },
          { key: 'r', name: '[R]e-edit in editor', value: 'edit_again' },
          { key: 'd', name: '[D]iscard edits and keep original', value: 'discard' }
        ]
      });
    } catch (err) {
      if (err.name === 'ExitPromptError') {
        return { action: 'accept', content: draftContent };
      }
      throw err;
    }

    if (postEditAction === 'edit_again') {
      return promptReviewWorkflow({
        draftContent: edited,
        itemLabel,
        allowPause,
        preferredEditor,
        criticIssues
      });
    }

    if (postEditAction === 'discard') {
      return { action: 'accept', content: draftContent };
    }

    return { action: 'accept', content: edited };
  }

  return { action: 'pause', content: draftContent };
}

