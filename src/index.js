import fs from 'node:fs/promises';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  hasConfig,
  loadConfig,
  ensureProjectDirectories,
  runOnboardingWizard
} from './config/configManager.js';
import { GroqClient } from './llm/groqClient.js';
import { OllamaEmbedder } from './rag/embedder.js';
import { VectorStore } from './rag/vectorStore.js';
import { CrossEncoderReranker } from './rag/reranker.js';
import { syncAllFiles, startFileWatcher, getTrackedFiles } from './rag/fileSync.js';
import { ConversationManager } from './workflows/conversationMgr.js';
import { runInitProjectWorkflow } from './workflows/initProject.js';
import { startRepl } from './ui/repl.js';
import { createSpinner } from './ui/renderer.js';

export async function main() {
  const cwd = process.cwd();

  // 1. Check or Run Onboarding Wizard
  let config;
  if (!(await hasConfig(cwd))) {
    console.log(chalk.bold.yellow('No Quillbot configuration found in this directory.'));
    config = await runOnboardingWizard(cwd);
  } else {
    await ensureProjectDirectories(cwd);
    config = await loadConfig(cwd);
  }

  // 2. Initialize Ollama Embedder & Verify Connection
  const embedder = new OllamaEmbedder(config);
  const ollamaCheck = await embedder.checkConnection();
  if (!ollamaCheck.ok) {
    console.log(chalk.yellow(`\n[Ollama Warning] ${ollamaCheck.error}`));
    console.log(chalk.dim(`Make sure Ollama is running and run: ollama pull ${config.ollama?.embeddingModel || 'embeddinggemma'}\n`));
  }

  // 3. Initialize Vector Store & Reranker
  const vectorStore = new VectorStore(config, cwd);
  await vectorStore.init();
  const reranker = new CrossEncoderReranker(config);

  // 4. Initialize Groq Client
  const groqClient = new GroqClient(config);

  // 5. Initialize Conversation Manager
  const conversationMgr = new ConversationManager({ cwd, groqClient, config });
  await conversationMgr.init();

  // 6. Check if story-bible is empty
  const trackedFiles = await getTrackedFiles(cwd);
  const bibleFiles = trackedFiles.filter((f) => f.startsWith('story-bible/'));

  if (bibleFiles.length === 0) {
    console.log(chalk.yellow('\nYour story-bible/ is empty.'));
    let shouldInit = false;
    try {
      shouldInit = await confirm({
        message: 'Would you like to initialize your project by providing your story in a nutshell?',
        default: true
      });
    } catch {
      shouldInit = false;
    }

    if (shouldInit) {
      await runInitProjectWorkflow({
        cwd,
        groqClient,
        vectorStore,
        embedder,
        config
      });
    }
  } else {
    // Initial sync
    const syncSpinner = createSpinner('Syncing novel workspace with LanceDB...').start();
    try {
      const syncRes = await syncAllFiles({ cwd, vectorStore, embedder, config });
      if (syncRes.hasChanges) {
        syncSpinner.succeed(`Synced files. Indexed ${syncRes.indexedCount} chunks.`);
      } else {
        syncSpinner.succeed('Workspace up to date.');
      }
    } catch (err) {
      syncSpinner.fail(`Sync error: ${err.message}`);
    }
  }

  // 7. Background file watcher for story-bible
  const watcher = startFileWatcher({
    cwd,
    vectorStore,
    embedder,
    config,
    onSync: (res) => {
      console.log(chalk.dim(`\n[Background Sync] Re-indexed ${res.indexedCount} modified chunks.`));
    }
  });

  // 8. Launch Turn-Based REPL
  await startRepl({
    cwd,
    groqClient,
    vectorStore,
    embedder,
    reranker,
    conversationMgr,
    config,
    watcher
  });
}
