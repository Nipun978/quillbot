import fs from 'node:fs/promises';
import path from 'node:path';
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { CONVERSATION_SUMMARY_SYSTEM_PROMPT } from '../llm/prompts.js';
import { logConversationEvent } from '../config/logger.js';

export class ConversationManager {
  constructor({ cwd = process.cwd(), groqClient, config }) {
    this.cwd = cwd;
    this.groqClient = groqClient;
    this.config = config;
    this.convDir = path.join(cwd, 'conversations');
    this.archiveDir = path.join(this.convDir, 'archive');
    this.currentFile = path.join(this.convDir, 'current.json');
    this.current = null;
  }

  async init() {
    await fs.mkdir(this.archiveDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.currentFile, 'utf8');
      this.current = JSON.parse(raw);
    } catch {
      this.current = this._createNewSession();
      await this.saveCurrent();
    }
    return this;
  }

  _createNewSession() {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return {
      id: `conv_${timestamp}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rollingSummary: '',
      turns: []
    };
  }

  async saveCurrent() {
    if (!this.current) return;
    this.current.updatedAt = new Date().toISOString();
    await fs.mkdir(this.convDir, { recursive: true });
    await fs.writeFile(this.currentFile, JSON.stringify(this.current, null, 2), 'utf8');
  }

  getRecentTurns(count = 8) {
    if (!this.current?.turns) return [];
    return this.current.turns.slice(-count);
  }

  getRollingSummary() {
    return this.current?.rollingSummary || '';
  }

  hasUnarchivedContent() {
    if (!this.current) return false;
    const hasTurns = Array.isArray(this.current.turns) && this.current.turns.length > 0;
    const hasSummary = typeof this.current.rollingSummary === 'string' && this.current.rollingSummary.trim().length > 0;
    return hasTurns || hasSummary;
  }

  async addTurn(role, content) {
    if (!this.current) await this.init();
    const turn = {
      role,
      content,
      timestamp: new Date().toISOString()
    };
    this.current.turns.push(turn);

    await logConversationEvent({
      cwd: this.cwd,
      sessionId: this.current.id,
      eventType: 'ADD_TURN',
      details: { role, contentLength: content?.length, preview: content?.slice(0, 80) }
    });

    const maxTurns = this.config.generation?.slidingChatWindowTurns || 8;
    // When turns exceed sliding window, compress oldest turns into rolling summary
    if (this.current.turns.length > maxTurns + 2) {
      await this._compressOldTurns();
    }

    await this.saveCurrent();
  }

  async _compressOldTurns() {
    try {
      const toCompress = this.current.turns.slice(0, 4);
      const remaining = this.current.turns.slice(4);

      const transcript = toCompress
        .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
        .join('\n\n');

      const userPrompt = `Previous rolling summary:\n${this.current.rollingSummary || '(None)'}\n\nOlder conversation turns to compress into rolling summary:\n${transcript}\n\nUpdate and output the revised rolling summary:`;

      const compressed = await this.groqClient.chatCompletion({
        model: 'small',
        messages: [
          { role: 'system', content: CONVERSATION_SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        sessionId: this.current.id,
        workflow: 'COMPRESS_CONVERSATION_TURNS'
      });

      this.current.rollingSummary = compressed.trim();
      this.current.turns = remaining;
    } catch {
      // Continue even if compression fails
    }
  }

  /**
   * Starts a new conversation session.
   * If current.json contains unarchived turns/summary, it archives them to conversations/archive/
   * and empties current.json to begin the new conversation.
   */
  async startNewSession() {
    if (this.hasUnarchivedContent()) {
      console.log(chalk.yellow('\n[Auto-Archive] Archiving current conversation to conversations/archive/ before starting fresh...'));
      await this.archiveCurrent();
    }

    this.current = this._createNewSession();
    await this.saveCurrent();

    await logConversationEvent({
      cwd: this.cwd,
      sessionId: this.current.id,
      eventType: 'NEW_SESSION_STARTED',
      details: { id: this.current.id, createdAt: this.current.createdAt }
    });

    console.log(chalk.green(`\nStarted fresh conversation session [${this.current.id}]. current.json is now empty.`));
    return this.current;
  }

  /**
   * Explicitly archives current conversation and empties current.json.
   */
  async archiveCurrentAndReset() {
    if (!this.hasUnarchivedContent()) {
      console.log(chalk.yellow('\nCurrent conversation has no messages or summary to archive.'));
      return false;
    }

    const archivedId = this.current.id;
    await this.archiveCurrent();
    this.current = this._createNewSession();
    await this.saveCurrent();

    console.log(chalk.green(`\nArchived session [${archivedId}] and emptied current.json.`));
    return true;
  }

  async archiveCurrent() {
    if (!this.current) return;
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const jsonPath = path.join(this.archiveDir, `session-${timestamp}.json`);
    const mdPath = path.join(this.archiveDir, `session-${timestamp}.md`);

    await fs.writeFile(jsonPath, JSON.stringify(this.current, null, 2), 'utf8');

    // Create distilled markdown recap for LanceDB indexing
    let summaryText = `Archived conversation on ${new Date().toLocaleDateString()}.\n\n`;
    if (this.current.rollingSummary) {
      summaryText += `## Rolling Summary\n${this.current.rollingSummary}\n\n`;
    }
    summaryText += `## Discussion Highlights\n`;
    for (const turn of (this.current.turns || [])) {
      summaryText += `**${turn.role.toUpperCase()}:** ${turn.content}\n\n`;
    }

    await fs.writeFile(mdPath, summaryText, 'utf8');

    await logConversationEvent({
      cwd: this.cwd,
      sessionId: this.current.id,
      eventType: 'SESSION_ARCHIVED',
      details: { jsonPath, mdPath, turnCount: this.current.turns?.length || 0 }
    });

    console.log(chalk.dim(`Archived session saved to conversations/archive/session-${timestamp}.json`));
  }

  async loadSessionPrompt() {
    try {
      const files = await fs.readdir(this.archiveDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json')).sort().reverse();

      if (jsonFiles.length === 0) {
        console.log(chalk.yellow('No archived sessions found in conversations/archive/.'));
        return false;
      }

      const choices = jsonFiles.map((file) => ({
        name: file,
        value: file
      }));
      choices.push({ name: '[Cancel]', value: '__cancel__' });

      const chosen = await select({
        message: 'Select an archived conversation to load:',
        choices
      });

      if (chosen === '__cancel__') return false;

      const raw = await fs.readFile(path.join(this.archiveDir, chosen), 'utf8');
      const loaded = JSON.parse(raw);

      // Archive current if it has content
      if (this.current && this.current.turns.length > 0) {
        await this.archiveCurrent();
      }

      this.current = loaded;
      await this.saveCurrent();
      console.log(chalk.green(`Loaded session [${loaded.id || chosen}] into active conversation.`));
      return true;
    } catch (err) {
      console.error(chalk.red(`Failed to load session: ${err.message}`));
      return false;
    }
  }
}
