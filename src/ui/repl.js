import readline from 'node:readline/promises';
import { select, input as promptInput } from '@inquirer/prompts';
import chalk from 'chalk';
import { printHelp, printBanner, createSpinner } from './renderer.js';
import { loadState } from '../config/stateManager.js';
import { runInitProjectWorkflow } from '../workflows/initProject.js';
import { runBibleQuery } from '../workflows/chatBible.js';
import { runPlanChapterWorkflow } from '../workflows/planChapter.js';
import { runWriteChapterWorkflow } from '../workflows/writeChapter.js';
import { syncAllFiles, getTrackedFiles } from '../rag/fileSync.js';
import { runOnboardingWizard } from '../config/configManager.js';

export const SLASH_COMMANDS = [
  '/init',
  '/bible',
  '/plan',
  '/write',
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
  if (process.stdin.isTTY) {
    try {
      process.stdin.resume();
    } catch {}
  }

  const choices = [
    { name: `${chalk.bold.cyan('/init')}     ${chalk.dim('—')} Seed Story Bible from a synopsis`, value: '/init' },
    { name: `${chalk.bold.cyan('/bible')}    ${chalk.dim('—')} Consult Story Bible lore or /bible save`, value: '/bible' },
    { name: `${chalk.bold.cyan('/plan')}     ${chalk.dim('—')} Plan chapter into structured beats`, value: '/plan' },
    { name: `${chalk.bold.cyan('/write')}    ${chalk.dim('—')} Write chapter beat-by-beat`, value: '/write' },
    { name: `${chalk.bold.cyan('/chat')}     ${chalk.dim('—')} Conversational chat with Story Bible RAG`, value: '/chat' },
    { name: `${chalk.bold.cyan('/archive')}  ${chalk.dim('—')} Archive active conversation & empty current.json`, value: '/archive' },
    { name: `${chalk.bold.cyan('/load')}     ${chalk.dim('—')} Restore an archived conversation session`, value: '/load' },
    { name: `${chalk.bold.cyan('/new')}      ${chalk.dim('—')} Start fresh session (auto-archives existing)`, value: '/new' },
    { name: `${chalk.bold.cyan('/sync')}     ${chalk.dim('—')} Manually trigger incremental sync to LanceDB`, value: '/sync' },
    { name: `${chalk.bold.cyan('/config')}   ${chalk.dim('—')} View or update Quillbot configuration`, value: '/config' },
    { name: `${chalk.bold.cyan('/status')}   ${chalk.dim('—')} View active chapter, beat and status`, value: '/status' },
    { name: `${chalk.bold.cyan('/help')}     ${chalk.dim('—')} Display command reference`, value: '/help' },
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
  if (process.stdin.isTTY) {
    try {
      process.stdin.resume();
    } catch {}
  }

  if (selected === '/plan') {
    const state = await loadState(cwd);
    const ch = await promptInput({
      message: 'Enter chapter number to plan:',
      default: String(state.activeChapter || 1)
    });
    return `/plan ${ch.trim()}`;
  } else if (selected === '/write') {
    const state = await loadState(cwd);
    const ch = await promptInput({
      message: 'Enter chapter number to write:',
      default: String(state.activeChapter || 1)
    });
    return `/write ${ch.trim()}`;
  } else if (selected === '/bible') {
    // Show the Story Bible menu directly with Query visible
    return '/bible';
  } else if (selected === '/chat') {
    const msg = await promptInput({
      message: 'Enter your message to chat with Story Bible & project RAG:'
    });
    return `/chat ${msg.trim()}`;
  }

  return selected;
}

export function readReplInput(promptText) {
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

  return new Promise((resolve) => {
    // Ensure stream is active and not paused before reading
    try {
      process.stdin.resume();
    } catch {}

    process.stdout.write(promptText);
    let buffer = '';

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {}
      }
      // CRITICAL: Do NOT call process.stdin.pause() here!
      // Calling pause() halts libuv console event reading on Windows,
      // which causes subsequent @inquirer prompts to freeze and become unresponsive to arrow keys/Enter.
    };

    const onData = (chunk) => {
      const str = chunk.toString();

      // Ctrl+C
      if (str === '\u0003') {
        cleanup();
        process.stdout.write('\n');
        process.exit(0);
      }

      // If user types '/' as the first character, trigger command dropdown menu immediately
      if (str === '/' && buffer.length === 0) {
        cleanup();
        process.stdout.write('\n');
        resolve({ isSlashMenu: true });
        return;
      }

      // Enter key
      if (str === '\r' || str === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve({ input: buffer });
        return;
      }

      // Backspace
      if (str === '\u0008' || str === '\x7f') {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }

      // Ignore escape sequences like arrow keys during direct text entry
      if (str.startsWith('\u001b')) {
        return;
      }

      // Handle pasted strings containing line endings
      if (str.includes('\r') || str.includes('\n')) {
        const clean = str.replace(/[\r\n]/g, '');
        buffer += clean;
        cleanup();
        process.stdout.write(clean + '\n');
        resolve({ input: buffer });
        return;
      }

      // Normal character typing
      buffer += str;
      process.stdout.write(str);
    };

    try {
      process.stdin.setRawMode(true);
    } catch {}
    try {
      process.stdin.resume();
    } catch {}
    process.stdin.on('data', onData);
  });
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
  printBanner();
  console.log(chalk.dim('Type ') + chalk.cyan('/') + chalk.dim(' for dropdown menu, ') + chalk.cyan('/help') + chalk.dim(' for commands, or type freely to chat.\n'));

  let running = true;

  while (running) {
    try {
      if (process.stdin.isTTY) {
        try {
          process.stdin.resume();
        } catch {}
      }

      const promptText = chalk.bold.hex('#7C3AED')('quillbot') + chalk.dim(' > ');
      const readResult = await readReplInput(promptText);

      let input = '';
      if (readResult.isSlashMenu) {
        const selected = await showSlashCommandMenu();
        if (selected === '__cancel__') {
          continue;
        }
        input = await resolveCommandArguments(selected, cwd);
      } else {
        input = (readResult.input || '').trim();
      }

      if (!input) continue;

      // If user typed only "/", open dropdown menu
      if (input === '/') {
        const selected = await showSlashCommandMenu();
        if (selected === '__cancel__') continue;
        input = await resolveCommandArguments(selected, cwd);
      }

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
