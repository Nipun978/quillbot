import readline from 'node:readline/promises';
import { select, input as promptInput } from '@inquirer/prompts';
import { createPrompt, useState, useKeypress, isEnterKey } from '@inquirer/core';
import chalk from 'chalk';
import { printHelp, printBanner, createSpinner } from './renderer.js';
import { loadState } from '../config/stateManager.js';
import { runInitProjectWorkflow } from '../workflows/initProject.js';
import { runBibleQuery } from '../workflows/chatBible.js';
import { runPlanChapterWorkflow } from '../workflows/planChapter.js';
import { runWriteChapterWorkflow } from '../workflows/writeChapter.js';
import { runExportWorkflow } from '../workflows/exportManuscript.js';
import { syncAllFiles, getTrackedFiles } from '../rag/fileSync.js';
import { runOnboardingWizard } from '../config/configManager.js';
import { enableStdinProtection, ensureStdinRaw } from './ttyManager.js';

export const SLASH_COMMANDS = [
  '/init',
  '/bible',
  '/plan',
  '/write',
  '/export',
  '/chat',
  '/archive',
  '/load',
  '/new',
  '/sync',
  '/config',
  '/status',
  '/help',
  '/exit'
];

export function completer(line) {
  if (line.startsWith('/')) {
    const hits = SLASH_COMMANDS.filter((c) => c.startsWith(line));
    return [hits.length ? hits : SLASH_COMMANDS, line];
  }
  return [[], line];
}

export async function showSlashCommandMenu() {
  ensureStdinRaw();

  const choices = [
    { name: `${chalk.bold.cyan('/write')}    ${chalk.dim('—')} Write or edit chapter beat-by-beat`, value: '/write' },
    { name: `${chalk.bold.cyan('/plan')}     ${chalk.dim('—')} Plan or edit chapter beats (full chapter or single beat)`, value: '/plan' },
    { name: `${chalk.bold.cyan('/bible')}    ${chalk.dim('—')} Story Bible lore & files (query, create, edit, list, save)`, value: '/bible' },
    { name: `${chalk.bold.cyan('/export')}   ${chalk.dim('—')} Export chapter, range (e.g. 1-3), or manuscript`, value: '/export' },
    { name: `${chalk.bold.cyan('/chat')}     ${chalk.dim('—')} Conversational chat with Story Bible RAG`, value: '/chat' },
    { name: `${chalk.bold.cyan('/status')}   ${chalk.dim('—')} View active chapter, beat, and novel statistics`, value: '/status' },
    { name: `${chalk.bold.cyan('/sync')}     ${chalk.dim('—')} Manually trigger incremental sync to LanceDB`, value: '/sync' },
    { name: `${chalk.bold.cyan('/config')}   ${chalk.dim('—')} View or update Quillbot configuration wizard`, value: '/config' },
    { name: `${chalk.bold.cyan('/init')}     ${chalk.dim('—')} Seed Story Bible from a synopsis`, value: '/init' },
    { name: `${chalk.bold.cyan('/new')}      ${chalk.dim('—')} Start fresh session (auto-archives existing)`, value: '/new' },
    { name: `${chalk.bold.cyan('/load')}     ${chalk.dim('—')} Restore an archived conversation session`, value: '/load' },
    { name: `${chalk.bold.cyan('/archive')}  ${chalk.dim('—')} Archive active conversation & empty current.json`, value: '/archive' },
    { name: `${chalk.bold.cyan('/help')}     ${chalk.dim('—')} Display command reference & dropdown guide`, value: '/help' },
    { name: `${chalk.bold.red('/exit')}     ${chalk.dim('—')} Exit Quillbot`, value: '/exit' },
    { name: chalk.dim('← Cancel / Back to conversation'), value: '__cancel__' }
  ];

  try {
    return await select({
      message: 'Choose a command from the menu:',
      choices
    });
  } catch (err) {
    if (err.name === 'ExitPromptError') {
      return '__cancel__';
    }
    throw err;
  }
}

export async function resolveCommandArguments(selected, cwd) {
  ensureStdinRaw();

  if (selected === '/plan') {
    const state = await loadState(cwd);
    let ch = String(state.activeChapter || 1);
    if (process.stdin.isTTY) {
      try {
        ch = await promptInput({
          message: 'Enter chapter number to plan:',
          default: String(state.activeChapter || 1)
        });
      } catch {}
    }
    let beat = '';
    if (process.stdin.isTTY) {
      try {
        beat = await promptInput({
          message: 'Target Beat number (press Enter to plan/edit whole chapter, or enter beat number e.g. 1, 2, or "add"):',
          default: ''
        });
      } catch {}
    }
    if (beat && beat.trim()) {
      return `/plan ${ch.trim()} ${beat.trim()}`;
    }
    return `/plan ${ch.trim()}`;
  } else if (selected === '/write') {
    const state = await loadState(cwd);
    let ch = String(state.activeChapter || 1);
    if (process.stdin.isTTY) {
      try {
        ch = await promptInput({
          message: 'Enter chapter number to write:',
          default: String(state.activeChapter || 1)
        });
      } catch {}
    }
    let beat = '';
    if (process.stdin.isTTY) {
      try {
        beat = await promptInput({
          message: 'Target Beat number (press Enter to write in sequence / auto-resume, or enter beat number e.g. 1 to edit):',
          default: ''
        });
      } catch {}
    }
    if (beat && beat.trim()) {
      return `/write ${ch.trim()} ${beat.trim()}`;
    }
    return `/write ${ch.trim()}`;
  } else if (selected === '/export') {
    let scope = '';
    let format = 'md';
    if (process.stdin.isTTY) {
      try {
        scope = await promptInput({
          message: 'Enter chapter number or range to export (e.g. 1, 1-3, or press Enter for all):',
          default: ''
        });
        format = await select({
          message: 'Select export format:',
          choices: [
            { name: 'Markdown (.md) — Complete formatted manuscript', value: 'md' },
            { name: 'Plain Text (.txt) — Clean plain text manuscript', value: 'txt' }
          ]
        });
      } catch {
        format = 'md';
      }
    }
    const scopePart = scope && scope.trim() ? scope.trim() : 'all';
    const formatFlag = format === 'txt' ? ' txt' : '';
    return `/export ${scopePart}${formatFlag}`;
  } else if (selected === '/bible') {
    // Show the Story Bible menu directly with Query, Create, Edit, List, Save
    return '/bible';
  } else if (selected === '/chat') {
    let msg = '';
    if (process.stdin.isTTY) {
      try {
        msg = await promptInput({
          message: 'Enter your message to chat with Story Bible & project RAG:'
        });
      } catch {}
    }
    return `/chat ${(msg || '').trim()}`;
  }

  return selected;
}

export const replInputPrompt = createPrompt((config, done) => {
  const [value, setValue] = useState('');

  useKeypress((key, rl) => {
    const isSlash = key.sequence === '/' || key.name === 'slash' || key.sequence?.includes('/') || rl.line?.startsWith('/');
    // As soon as '/' is pressed or present, trigger command dropdown menu immediately (no speed typing)
    if (isSlash) {
      done({ isSlashMenu: true });
      return;
    }

    if (isEnterKey(key)) {
      const finalInput = (rl.line !== undefined && rl.line !== '') ? rl.line : value;
      // If user submitted an input starting with '/', intercept and trigger command dropdown menu
      if (finalInput.trim().startsWith('/')) {
        done({ isSlashMenu: true });
        return;
      }
      done({ input: finalInput.trim() });
      return;
    }

    if (key.name === 'backspace') {
      setValue(value.slice(0, -1));
    } else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      setValue(rl.line ? rl.line : (value + key.sequence));
    } else if (rl.line !== undefined) {
      setValue(rl.line);
    }
  });

  const promptPrefix = chalk.bold.hex('#7C3AED')('quillbot') + chalk.dim(' > ');
  return `${promptPrefix}${value}`;
});

export async function readReplInput(promptText) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer
    });
    return rl.question(promptText).then((ans) => {
      rl.close();
      return { input: ans };
    });
  }

  ensureStdinRaw();

  try {
    return await replInputPrompt({});
  } catch (err) {
    if (err.name === 'ExitPromptError') {
      console.log(chalk.cyan('\nExiting Quillbot. Happy writing!'));
      process.exit(0);
    }
    throw err;
  }
}


export async function startRepl({
  cwd = process.cwd(),
  groqClient,
  vectorStore,
  embedder,
  reranker,
  conversationMgr,
  config,
  watcher
}) {
  enableStdinProtection();
  printBanner();
  console.log(chalk.dim('Press ') + chalk.bold.cyan('/') + chalk.dim(' anytime to open the command dropdown menu, or type freely to consult lore / chat.\n'));

  let running = true;

  while (running) {
    try {
      ensureStdinRaw();

      const promptText = chalk.bold.hex('#7C3AED')('quillbot') + chalk.dim(' > ');
      const readResult = await readReplInput(promptText);

      let input = '';
      const rawTrimmed = (readResult.input || '').trim();

      // Whenever slash is entered (or input starts with '/'), ALWAYS route to dropdown menu
      if (readResult.isSlashMenu || rawTrimmed.startsWith('/')) {
        const selected = await showSlashCommandMenu();
        if (selected === '__cancel__') {
          continue;
        }
        input = await resolveCommandArguments(selected, cwd);
      } else {
        input = rawTrimmed;
      }

      if (!input) continue;

      // Handle Exit
      if (input === '/exit' || input.toLowerCase() === 'exit' || input === '/quit' || input.toLowerCase() === 'quit') {
        console.log(chalk.cyan('\nExiting Quillbot. Happy writing!'));
        running = false;
        break;
      }

      // Handle Help
      if (input === '/help') {
        printHelp();
        continue;
      }

      // Handle Status
      if (input === '/status') {
        const state = await loadState(cwd);
        const tracked = await getTrackedFiles(cwd);
        let rowCount = 0;
        try {
          if (vectorStore.table) {
            rowCount = await vectorStore.table.countRows();
          }
        } catch {}

        console.log(chalk.bold.cyan('\n  Quillbot Novel Status:'));
        console.log(`  Project Title:      ${chalk.green(config.projectTitle || 'Untitled Novel')}`);
        console.log(`  Writing Style:      ${chalk.green(config.writingStyle || 'Default')}`);
        if (config.enhancedWritingStyle) {
          console.log(`  Enhanced Style:     ${chalk.green('Active (AI-Enhanced Guide incorporated)')}`);
        }
        console.log(`  Active Chapter:     ${chalk.green(state.activeChapter || 1)}`);
        console.log(`  Active Beat:        ${chalk.green(state.activeBeat || 1)}`);
        console.log(`  Active Session:     ${chalk.green(conversationMgr.current?.id || 'none')}`);
        console.log(`  Tracked Files:      ${chalk.green(tracked.length)}`);
        console.log(`  LanceDB Chunks:     ${chalk.green(rowCount)}`);
        console.log(`  Ollama Model:       ${chalk.green(config.ollama?.embeddingModel)}`);
        console.log(`  Groq Model (Small): ${chalk.green(config.models?.small)}`);
        console.log(`  Groq Model (Large): ${chalk.green(config.models?.large)}\n`);
        continue;
      }

      // Handle Sync
      if (input === '/sync') {
        const spinner = createSpinner('Running incremental sync to LanceDB...').start();
        try {
          const res = await syncAllFiles({ cwd, vectorStore, embedder, config });
          spinner.succeed(`Sync complete. Indexed ${res.indexedCount} chunks, removed ${res.deletedCount} deleted.`);
        } catch (err) {
          spinner.fail(`Sync error: ${err.message}`);
        }
        continue;
      }

      // Handle Config
      if (input === '/config') {
        console.log(chalk.bold.cyan('\nCurrent Configuration:'));
        console.log(JSON.stringify(config, null, 2));
        const updated = await runOnboardingWizard(cwd);
        Object.assign(config, updated);
        groqClient.updateConfig(config);
        embedder.updateConfig(config);
        continue;
      }

      // Handle Archive Session
      if (input === '/archive') {
        await conversationMgr.archiveCurrentAndReset();
        continue;
      }

      // Handle Load Session
      if (input === '/load') {
        await conversationMgr.loadSessionPrompt();
        continue;
      }

      // Handle New Session
      if (input === '/new') {
        await conversationMgr.startNewSession();
        continue;
      }

      // Handle Init
      if (input.startsWith('/init')) {
        await runInitProjectWorkflow({ cwd, groqClient, vectorStore, embedder, config });
        continue;
      }

      // Handle Bible
      if (input.startsWith('/bible')) {
        const query = input.slice(6).trim();
        await runBibleQuery({
          query,
          cwd,
          groqClient,
          vectorStore,
          embedder,
          reranker,
          conversationMgr,
          config
        });
        continue;
      }

      // Handle Plan
      if (input.startsWith('/plan')) {
        const arg = input.slice(5).trim();
        await runPlanChapterWorkflow({
          chapterArg: arg,
          cwd,
          groqClient,
          vectorStore,
          embedder,
          reranker,
          conversationMgr,
          config
        });
        continue;
      }

      // Handle Write
      if (input.startsWith('/write')) {
        const arg = input.slice(6).trim();
        await runWriteChapterWorkflow({
          chapterArg: arg,
          cwd,
          groqClient,
          vectorStore,
          embedder,
          reranker,
          conversationMgr,
          config
        });
        continue;
      }

      // Handle Export
      if (input.startsWith('/export')) {
        const arg = input.slice(7).trim();
        await runExportWorkflow({
          arg,
          cwd,
          config
        });
        continue;
      }

      // Handle Chat or default free text -> treats as /bible consultation
      const query = input.startsWith('/chat') ? input.slice(5).trim() : input;
      await runBibleQuery({
        query,
        cwd,
        groqClient,
        vectorStore,
        embedder,
        reranker,
        conversationMgr,
        config
      });
    } catch (err) {
      if (err.name === 'ExitPromptError') {
        // User pressed Ctrl+C inside inquirer prompt
        console.log('\n');
        continue;
      }
      console.error(chalk.red(`\nCommand error: ${err.message || err}\n`));
    }
  }

  if (watcher) {
    try {
      await watcher.close();
    } catch {}
  }
}
