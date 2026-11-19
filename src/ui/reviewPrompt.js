import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createPrompt,
  useState,
  useRef,
  useEffect,
  useKeypress,
  usePrefix,
  isSpaceKey,
  isEnterKey,
  isUpKey,
  isDownKey
} from '@inquirer/core';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { ensureStdinRaw, suspendStdinProtection } from './ttyManager.js';

export const hotkeySelect = createPrompt((config, done) => {
  const { message, choices = [], cooldownSeconds = 0, isPaid = false } = config;
  const [active, setActive] = useState(0);
  const [countdown, setCountdown] = useState(Number(cooldownSeconds) || 0);
  const [notice, setNotice] = useState('');
  const countRef = useRef(countdown);
  countRef.current = countdown;
  const prefix = usePrefix({ status: 'idle' });

  const isCooldownAction = (val) => val === 'accept' || val === 'retry';

  useEffect(() => {
    if (countRef.current <= 0) return;
    const timer = setInterval(() => {
      if (countRef.current <= 1) {
        clearInterval(timer);
        countRef.current = 0;
        setCountdown(0);
        setNotice('');
      } else {
        const next = countRef.current - 1;
        countRef.current = next;
        setCountdown(next);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useKeypress((key, rl) => {
    // 1. Developer / Paid Plan: Spacebar skips cooldown instantly for accept and retry
    if (isPaid && isSpaceKey(key) && countRef.current > 0) {
      countRef.current = 0;
      setCountdown(0);
      setNotice(chalk.green('✓ Cooldown skipped with [Space]. [A]ccept and [R]etry unlocked.'));
      return;
    }

    // 2. Single-character hotkeys
    const char = (key.name || key.sequence || '').toLowerCase();
    const matchedChoice = choices.find((c) => {
      if (c.key && c.key.toLowerCase() === char) return true;
      if (Array.isArray(c.keys) && c.keys.some((k) => k.toLowerCase() === char)) return true;
      return false;
    });
    if (matchedChoice) {
      if (isCooldownAction(matchedChoice.value) && countRef.current > 0) {
        const actionVerb = matchedChoice.value === 'retry' ? 'retry' : 'accept';
        setNotice(chalk.yellow(`⏳ 45s Cooldown Active: ${countRef.current}s remaining before you can ${actionVerb}. (Review prose cadence).`));
        return;
      }
      done(matchedChoice.value);
      return;
    }

    // 3. Enter key
    if (isEnterKey(key)) {
      const selectedChoice = choices[active];
      if (selectedChoice) {
        if (isCooldownAction(selectedChoice.value) && countRef.current > 0) {
          const actionVerb = selectedChoice.value === 'retry' ? 'retry' : 'accept';
          setNotice(chalk.yellow(`⏳ 45s Cooldown Active: ${countRef.current}s remaining before you can ${actionVerb}. (Review prose cadence).`));
          return;
        }
        done(selectedChoice.value);
      }
      return;
    }

    // 4. Arrow navigation
    if (isUpKey(key)) {
      setActive((active - 1 + choices.length) % choices.length);
    } else if (isDownKey(key)) {
      setActive((active + 1) % choices.length);
    }
  });

  const lines = [
    `${prefix} ${chalk.bold(message)}`,
    ...choices.map((c, idx) => {
      let displayName = c.name;
      if (isCooldownAction(c.value)) {
        if (countdown > 0) {
          displayName = isPaid
            ? `${c.name} (${countdown}s - Press [Space] to skip)`
            : `${c.name} (${countdown}s cooldown)`;
        } else {
          displayName = c.name;
        }
      }
      const isSelected = idx === active;
      const pointer = isSelected ? chalk.cyan('> ') : '  ';
      return isSelected ? chalk.cyan.bold(`${pointer}${displayName}`) : `${pointer}${displayName}`;
    }),
    notice ? notice : '',
    chalk.dim(`\nPress hotkey [${choices.filter((c) => c.key).map((c) => c.key.toUpperCase()).join('/')}] or ↑↓ navigate • ⏎ select`)
  ].filter(Boolean);

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
  const resumeProtection = suspendStdinProtection();
  let spawnRes;
  try {
    spawnRes = spawnSync(editor, [tempFile], {
      stdio: 'inherit',
      shell: isWin
    });
  } finally {
    resumeProtection();
  }

  ensureStdinRaw();

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

export function parseIssueIndices(inputStr, totalIssues) {
  if (!inputStr || !inputStr.trim() || inputStr.trim().toLowerCase() === 'all') {
    return Array.from({ length: totalIssues }, (_, i) => i);
  }
  const selected = new Set();
  const parts = inputStr.trim().split(/[\s,;]+/);
  for (const part of parts) {
    if (!part) continue;
    if (part.toLowerCase() === 'all') {
      for (let i = 0; i < totalIssues; i++) selected.add(i);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      const min = Math.max(1, Math.min(start, end));
      const max = Math.min(totalIssues, Math.max(start, end));
      for (let i = min; i <= max; i++) {
        selected.add(i - 1);
      }
    } else {
      const num = parseInt(part, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= totalIssues) {
        selected.add(num - 1);
      }
    }
  }
  if (selected.size === 0) {
    return Array.from({ length: totalIssues }, (_, i) => i);
  }
  return Array.from(selected).sort((a, b) => a - b);
}

export async function promptReviewWorkflow({
  draftContent = '',
  itemLabel = 'draft',
  allowPause = true,
  preferredEditor = '',
  criticIssues = [],
  cooldownSeconds = undefined,
  isPaid = false,
  quotaManager = null,
  config = null,
  model = ''
}) {
  ensureStdinRaw();
  const reviewStartTime = Date.now();

  const effectiveIsPaid = Boolean(
    isPaid ||
    config?.apiTier === 'paid' ||
    config?.apiTier === 'developer' ||
    quotaManager?.isPaidTier?.()
  );

  let effectiveCooldown;
  if (cooldownSeconds !== undefined) {
    effectiveCooldown = Number(cooldownSeconds) || 0;
  } else if (config?.cooldownSeconds !== undefined) {
    effectiveCooldown = Number(config.cooldownSeconds) || 0;
  } else {
    // Default to 45 in interactive/production, 0 in non-interactive tests unless configured
    effectiveCooldown = (typeof process !== 'undefined' && process.stdin?.isTTY) ? 45 : 0;
  }

  if (quotaManager && model) {
    const snapshot = quotaManager.getModelSnapshot(model);
    if (snapshot) {
      const tpmRem = snapshot.remainingTpm?.toLocaleString?.() ?? snapshot.remainingTpm;
      const rpdRem = snapshot.remainingRpd === Infinity ? 'Uncapped' : (snapshot.remainingRpd?.toLocaleString?.() ?? snapshot.remainingRpd);
      console.log(chalk.dim(`  [Live Quota: ${model} | Remaining: ${tpmRem} TPM • ${rpdRem} RPD]`));
    }
  }

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
      choices,
      cooldownSeconds: effectiveCooldown,
      isPaid: effectiveIsPaid
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
    let targetIssues = criticIssues;

    if (criticIssues.length > 1 && process.stdin.isTTY) {
      ensureStdinRaw();
      let issueSelection = '';
      try {
        issueSelection = await input({
          message: `Select issue numbers to fix (e.g. "1 2 6", "1-4", or "all" [default: all]):`,
          default: 'all'
        });
      } catch {
        issueSelection = 'all';
      }

      const selectedIndices = parseIssueIndices(issueSelection, criticIssues.length);
      targetIssues = selectedIndices.map((i) => criticIssues[i]).filter(Boolean);
      if (targetIssues.length === 0) {
        targetIssues = criticIssues;
      }
    }

    const formattedCriticFixInstructions = targetIssues.map((issue, idx) => {
      const typeStr = (issue.category || issue.type) ? `[${issue.category || issue.type}] ` : '';
      const quoteStr = issue.quote ? `\n- Quote: "${issue.quote}"` : '';
      const fixStr = issue.fixSuggestion ? `\n- Fix: ${issue.fixSuggestion}` : '';
      return `${idx + 1}. ${typeStr}${issue.description}${quoteStr}${fixStr}`;
    }).join('\n\n');

    return {
      action: 'retry',
      content: draftContent,
      feedback: `Please fix the following issues detected by Continuity & Plan Critic:\n\n${formattedCriticFixInstructions}`
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

    // Calculate remaining cooldown: user editing in notepad counts toward cooldown time
    const elapsedSeconds = Math.floor((Date.now() - reviewStartTime) / 1000);
    const remainingCooldown = Math.max(0, effectiveCooldown - elapsedSeconds);

    let postEditAction;
    try {
      postEditAction = await hotkeySelect({
        message: 'Action with edited text:',
        choices: [
          { key: 'a', name: '[A]ccept edited version', value: 'accept' },
          { key: 'r', name: '[R]e-edit in editor', value: 'edit_again' },
          { key: 'd', name: '[D]iscard edits and return to review', value: 'discard' }
        ],
        cooldownSeconds: remainingCooldown,
        isPaid: effectiveIsPaid
      });
    } catch (err) {
      if (err.name === 'ExitPromptError') {
        return { action: 'accept', content: draftContent };
      }
      throw err;
    }

    if (postEditAction === 'edit_again') {
      const updatedElapsed = Math.floor((Date.now() - reviewStartTime) / 1000);
      const updatedRemaining = Math.max(0, effectiveCooldown - updatedElapsed);
      return promptReviewWorkflow({
        draftContent: edited,
        itemLabel,
        allowPause,
        preferredEditor,
        criticIssues,
        cooldownSeconds: updatedRemaining,
        isPaid: effectiveIsPaid,
        quotaManager,
        config,
        model
      });
    }

    if (postEditAction === 'discard') {
      const updatedElapsed = Math.floor((Date.now() - reviewStartTime) / 1000);
      const updatedRemaining = Math.max(0, effectiveCooldown - updatedElapsed);
      return promptReviewWorkflow({
        draftContent,
        itemLabel,
        allowPause,
        preferredEditor,
        criticIssues,
        cooldownSeconds: updatedRemaining,
        isPaid: effectiveIsPaid,
        quotaManager,
        config,
        model
      });
    }

    return { action: 'accept', content: edited };
  }

  return { action: 'pause', content: draftContent };
}
