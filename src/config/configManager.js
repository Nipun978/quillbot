import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { input, password } from '@inquirer/prompts';
import chalk from 'chalk';
import { hasState, saveState, getDefaultState } from './stateManager.js';

dotenv.config();

const CONFIG_DIR = '.quillbot';
const CONFIG_FILE = 'config.json';
const INSTRUCTIONS_FILE = 'instructions.md';

export const DEFAULT_INSTRUCTIONS = `# Quillbot Literary Prose & Pacing Instructions

## 1. Prime Narrative Objective
Deliver immersive, psychologically nuanced, and scene-grounded prose. Write strictly one beat at a time, honoring the emotional and dramatic arc outlined in the chapter plan without rushing toward future events.

## 2. Point of View & Tense
- **Default POV:** Close Third-Person Limited (or First-Person if specified in the Story Bible). Stay anchored inside the POV character's immediate perception, sensory field, and inner filter.
- **Tense:** Past Tense (consistent throughout).

## 3. Sensory Grounding & Atmosphere
- Ground every scene in tangible sensory specifics: sound, texture, temperature, ambient lighting, and smell.
- Ground emotional tension in physical actions, micro-expressions, posture shifts, and involuntary physical responses.
- Avoid abstract melodrama, clinical emotional labels ("he felt sad", "she was terrified"), and melodramatic clichés.

## 4. Beat Integrity & Micro-Pacing
- **Do not rush ahead:** Fulfill only the assigned beat's action and emotional turn. Do not resolve future conflicts or bleed into subsequent beats prematurely.
- **Scene transition:** Build seamlessly on the preceding beat's final moments. Pick up physical props, spatial orientation, and ongoing dialogue without repetition or abrupt cuts.
- **Dialogue:** Keep character voices distinct, textured by cadence, regional dialect (if established in the Story Bible), and subtext. Dialogue must serve character motivation or conflict, never pure exposition.

## 5. Tone & AI Anti-Patterns
- Never summarize the moral of the scene or editorialize in the narrative voice.
- Avoid purple prose, redundant metaphors, repetitive adjectives, and robotic dialogue markers ("he retorted with determination").
- Strictly uphold facts, relationship dynamics, and world lore recorded in the Story Bible.
`;

export function buildInstructionsContent({ projectTitle = 'Untitled Novel', writingStyle = '', enhancedWritingStyle = '' } = {}) {
  let content = `# ${projectTitle} — Literary Prose & Pacing Instructions\n\n`;
  if (enhancedWritingStyle) {
    content += `## Author Writing Style Preferences & Enhanced Prose Guide\n`;
    if (writingStyle && writingStyle.trim() !== enhancedWritingStyle.trim()) {
      content += `### Author Stated Preferences:\n${writingStyle.trim()}\n\n`;
    }
    content += `### AI-Enhanced Literary Prose Specification:\n${enhancedWritingStyle.trim()}\n\n`;
  } else if (writingStyle) {
    content += `## Author Writing Style Preferences & Tone\n${writingStyle}\n\n`;
  }
  content += DEFAULT_INSTRUCTIONS;
  return content;
}

export function getConfigPath(cwd = process.cwd()) {
  return path.join(cwd, CONFIG_DIR, CONFIG_FILE);
}

export function getInstructionsPath(cwd = process.cwd()) {
  return path.join(cwd, CONFIG_DIR, INSTRUCTIONS_FILE);
}

export async function hasConfig(cwd = process.cwd()) {
  try {
    await fs.access(getConfigPath(cwd));
    return true;
  } catch {
    return false;
  }
}

export function getDefaultConfig() {
  const defaultEditor = process.platform === 'win32'
    ? 'notepad'
    : (process.env.EDITOR || 'nano');

  return {
    projectTitle: 'Untitled Novel',
    writingStyle: 'Third-person limited, atmospheric, psychologically nuanced, sensory-rich prose',
    enhancedWritingStyle: '',
    groqApiKey: process.env.GROQ_API_KEY || '',
    models: {
      small: 'openai/gpt-oss-20b',
      large: 'openai/gpt-oss-120b'
    },
    ollama: {
      baseUrl: 'http://127.0.0.1:11434',
      embeddingModel: 'embeddinggemma',
      embeddingDimensions: 768
    },
    rag: {
      chunkSizeTokens: 400,
      chunkOverlapTokens: 60,
      vectorTopK: 15,
      bm25TopK: 15,
      rerankTopK: 5,
      rerankerModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
      rrfK: 60
    },
    generation: {
      temperaturePlan: 0.6,
      temperatureWrite: 0.75,
      continuityTailWords: 350,
      slidingChatWindowTurns: 8
    },
    editor: defaultEditor
  };
}

export async function loadConfig(cwd = process.cwd()) {
  const filePath = getConfigPath(cwd);
  const defaults = getDefaultConfig();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const config = {
      ...defaults,
      ...parsed,
      projectTitle: parsed.projectTitle || defaults.projectTitle,
      writingStyle: parsed.writingStyle || defaults.writingStyle,
      enhancedWritingStyle: parsed.enhancedWritingStyle || '',
      models: { ...defaults.models, ...(parsed.models || {}) },
      ollama: { ...defaults.ollama, ...(parsed.ollama || {}) },
      rag: { ...defaults.rag, ...(parsed.rag || {}) },
      generation: { ...defaults.generation, ...(parsed.generation || {}) }
    };
    if (!config.groqApiKey && process.env.GROQ_API_KEY) {
      config.groqApiKey = process.env.GROQ_API_KEY;
    }
    return config;
  } catch {
    return defaults;
  }
}

export async function saveConfig(config, cwd = process.cwd()) {
  const dirPath = path.join(cwd, CONFIG_DIR);
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = getConfigPath(cwd);
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

export async function ensureProjectDirectories(cwd = process.cwd(), config = null) {
  const dirs = [
    path.join(cwd, CONFIG_DIR),
    path.join(cwd, CONFIG_DIR, 'index'),
    path.join(cwd, CONFIG_DIR, 'backups'),
    path.join(cwd, 'story-bible'),
    path.join(cwd, 'conversations', 'archive'),
    path.join(cwd, 'project'),
    path.join(cwd, 'logs')
  ];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }

  const instrPath = getInstructionsPath(cwd);
  try {
    await fs.access(instrPath);
  } catch {
    const title = config?.projectTitle || 'Untitled Novel';
    const style = config?.writingStyle || '';
    const enhanced = config?.enhancedWritingStyle || '';
    await fs.writeFile(instrPath, buildInstructionsContent({ projectTitle: title, writingStyle: style, enhancedWritingStyle: enhanced }), 'utf8');
  }

  if (!(await hasState(cwd))) {
    await saveState(getDefaultState(), cwd);
  }
}

export async function loadInstructions(cwd = process.cwd()) {
  const instrPath = getInstructionsPath(cwd);
  try {
    return await fs.readFile(instrPath, 'utf8');
  } catch {
    return DEFAULT_INSTRUCTIONS;
  }
}

export async function updateInstructionsFile(cwd = process.cwd(), { projectTitle, writingStyle, enhancedWritingStyle = '' }) {
  const instrPath = getInstructionsPath(cwd);
  const content = buildInstructionsContent({ projectTitle, writingStyle, enhancedWritingStyle });
  await fs.writeFile(instrPath, content, 'utf8');
  return content;
}

export async function enhanceWritingStyleWithAi({
  projectTitle = 'Untitled Novel',
  writingStyle = '',
  groqApiKey = '',
  model = 'openai/gpt-oss-120b'
} = {}) {
  const trimmed = (writingStyle || '').trim();
  if (!trimmed || !groqApiKey) {
    return trimmed;
  }

  try {
    const { Groq } = await import('groq-sdk');
    const client = new Groq({ apiKey: groqApiKey });

    const systemPrompt = `You are an elite literary editor, prose stylist, and novelist consultant.
The author is writing a novel titled "${projectTitle}".
The author has provided their core writing style preferences. Your job is to analyze and expand these preferences into an actionable, comprehensive, and high-impact literary prose guide.

Your guide MUST be formatted under clear Markdown section headings (NO TABLES) with rich, focused instructions:
1. Point of View & Narrative Distance: POV mechanics (e.g. deep third-person limited), interiority access, sensory filter.
2. Prose Rhythm, Cadence & Syntax: Sentence length variance, clause structure, micro-pacing for action vs contemplative moments.
3. Tone, Mood & Atmospheric Texture: Sensory priorities (light, texture, temperature, smell), emotional restraint vs raw expression.
4. Vocabulary, Diction & Figurative Language: Register, thematic motifs, metaphor style, avoiding purple prose and clichés.
5. Dialogue Dynamics: Character voice distinctiveness, subtext, cadence, and dialogue tagging rules.

Output ONLY the enhanced style guide as markdown paragraphs under headings. Do not include introductory conversational pleasantries or meta commentary.`;

    const response = await client.chat.completions.create({
      model: model || 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Author's Writing Style Preferences for "${projectTitle}":\n"${trimmed}"\n\nEnhance this into a concrete, professional literary prose specification.`
        }
      ],
      temperature: 0.5,
      max_tokens: 1500
    });

    const enhanced = response.choices[0]?.message?.content?.trim();
    return enhanced || trimmed;
  } catch (err) {
    // If enhancement fails (e.g. offline or network issue), fallback gracefully to original
    return trimmed;
  }
}

export async function runOnboardingWizard(cwd = process.cwd()) {
  console.log(chalk.bold.cyan('\n  Quillbot Novel Workspace Setup Wizard'));
  console.log(chalk.dim('  Configure your Groq Cloud and Local Ollama / RAG pipeline.\n'));

  const defaults = getDefaultConfig();
  const envKey = process.env.GROQ_API_KEY || '';

  // 1. Pipeline configuration details FIRST
  const groqApiKey = await password({
    message: 'Enter your Groq API Key' + (envKey ? ' (press Enter to use GROQ_API_KEY from environment)' : '') + ':',
    mask: '*'
  });

  const finalGroqKey = (groqApiKey && groqApiKey.trim()) || envKey;

  const smallModel = await input({
    message: 'Small Fast Model ID (routing, summaries, compression):',
    default: defaults.models.small
  });

  const largeModel = await input({
    message: 'Large Model ID (planning & beat prose generation):',
    default: defaults.models.large
  });

  const ollamaUrl = await input({
    message: 'Ollama Base URL:',
    default: defaults.ollama.baseUrl
  });

  const embeddingModel = await input({
    message: 'Ollama Gemma Embedding Model Tag:',
    default: defaults.ollama.embeddingModel
  });

  const editorChoice = await input({
    message: 'Preferred Text Editor (for [E]dit review mode):',
    default: defaults.editor
  });

  // 2. Ask project title and writing style ONCE after configured details
  console.log(chalk.bold.cyan('\n  Novel & Writing Style Setup'));
  const projectTitle = await input({
    message: 'Project / Novel Title:',
    default: defaults.projectTitle || 'Untitled Novel'
  });

  const writingStyle = await input({
    message: 'Writing Style Preferences (e.g. POV, tone, pacing, prose style):',
    default: defaults.writingStyle
  });

  // 3. Enhance writing style preferences with AI
  let enhancedWritingStyle = '';
  const finalStyle = writingStyle.trim() || defaults.writingStyle;
  if (finalGroqKey) {
    const { createSpinner } = await import('../ui/renderer.js');
    const spinner = createSpinner('Enhancing writing style preferences with AI...').start();
    try {
      enhancedWritingStyle = await enhanceWritingStyleWithAi({
        projectTitle: projectTitle.trim() || 'Untitled Novel',
        writingStyle: finalStyle,
        groqApiKey: finalGroqKey.trim(),
        model: largeModel.trim() || defaults.models.large
      });
      spinner.succeed('AI-enhanced writing style guide generated.');
    } catch {
      spinner.warn('Could not reach AI model; using raw writing style preferences.');
      enhancedWritingStyle = finalStyle;
    }
  } else {
    enhancedWritingStyle = finalStyle;
  }

  const newConfig = {
    ...defaults,
    projectTitle: projectTitle.trim() || 'Untitled Novel',
    writingStyle: finalStyle,
    enhancedWritingStyle,
    groqApiKey: finalGroqKey.trim(),
    models: {
      small: smallModel.trim(),
      large: largeModel.trim()
    },
    ollama: {
      ...defaults.ollama,
      baseUrl: ollamaUrl.trim(),
      embeddingModel: embeddingModel.trim()
    },
    editor: editorChoice.trim()
  };

  await ensureProjectDirectories(cwd, newConfig);
  await saveConfig(newConfig, cwd);
  await updateInstructionsFile(cwd, {
    projectTitle: newConfig.projectTitle,
    writingStyle: newConfig.writingStyle,
    enhancedWritingStyle: newConfig.enhancedWritingStyle
  });

  console.log(chalk.green('Setup complete! Configuration saved to .quillbot/config.json\n'));
  return newConfig;
}
