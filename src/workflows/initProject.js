import fs from 'node:fs/promises';
import path from 'node:path';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  INIT_OVERVIEW_SYSTEM_PROMPT,
  INIT_CHARACTERS_SYSTEM_PROMPT,
  INIT_LOCATIONS_SYSTEM_PROMPT,
  INIT_WORLD_LORE_SYSTEM_PROMPT,
  GENERATE_INIT_QUESTIONS_SYSTEM_PROMPT,
  buildCreativityDirective
} from '../llm/prompts.js';
import { createSpinner, printMarkdown } from '../ui/renderer.js';
import { promptReviewWorkflow, openInEditor } from '../ui/reviewPrompt.js';
import { syncAllFiles } from '../rag/fileSync.js';
import { saveConfig, updateInstructionsFile, enhanceWritingStyleWithAi, getCreativityTemperatures, getExecutionProfile } from '../config/configManager.js';
import { ensureCondensedDirectories } from '../config/condensedManager.js';
import { ensureStdinRaw } from '../ui/ttyManager.js';

async function generateCondensedSummary(text, label, groqClient, temperature = 0.2) {
  if (!text || !groqClient) {
    return text ? text.slice(0, 250).replace(/\n+/g, ' ') : '';
  }
  try {
    const res = await groqClient.chatCompletion({
      model: 'small', // Requirement 6: Use 20b model
      messages: [
        {
          role: 'system',
          content: `You are a concise story archivist. Summarize the provided ${label} document into 3 to 5 compact bullet pointers strictly under 100 words total. Do not include headings.`
        },
        { role: 'user', content: text.slice(0, 4000) }
      ],
      temperature,
      maxTokens: 1024,
      reasoningEffort: 'low',
      sessionId: 'init_condense',
      workflow: 'INIT_CONDENSE'
    });
    const trimmed = (res || '').trim();
    if (!trimmed) {
      throw new Error('Empty condensed summary response');
    }
    return trimmed;
  } catch {
    return text.slice(0, 250).replace(/\n+/g, ' ');
  }
}

export async function runInitProjectWorkflow({
  cwd = process.cwd(),
  groqClient,
  vectorStore,
  embedder,
  config,
  synopsis: initialSynopsis = ''
}) {
  console.log(chalk.bold.cyan('\n  /init: Step-by-Step Story Bible Generator'));
  console.log(chalk.dim(`  Project: ${chalk.green(config.projectTitle || 'Untitled Novel')}`));
  console.log(chalk.dim('  Quillbot will generate each Story Bible file sequentially with human-in-the-loop review.\n'));

  // 1. Setup Title & Writing Style if needed
  if (!config.projectTitle || !config.writingStyle) {
    ensureStdinRaw();
    const projectTitle = await input({
      message: 'Project / Novel Title:',
      default: config.projectTitle || 'Untitled Novel'
    });

    const writingStyle = await input({
      message: 'Writing Style Preferences (e.g. POV, tone, pacing, prose style):',
      default: config.writingStyle || 'Third-person limited, atmospheric, psychologically nuanced, sensory-rich prose'
    });

    config.projectTitle = projectTitle.trim() || 'Untitled Novel';
    config.writingStyle = writingStyle.trim() || config.writingStyle;

    // Requirement 1: Stylize user writing instructions using 20B model under 100 words
    if (config.groqApiKey) {
      const styleSpinner = createSpinner('Stylizing global writing instructions with 20B model (< 100 words)...').start();
      try {
        config.enhancedWritingStyle = await enhanceWritingStyleWithAi({
          projectTitle: config.projectTitle,
          writingStyle: config.writingStyle,
          groqApiKey: config.groqApiKey,
          model: config.models?.small || 'openai/gpt-oss-20b',
          baseUrl: config.groqBaseUrl || config.baseUrl
        });
        styleSpinner.succeed('Global stylized writing instructions created.');
      } catch {
        styleSpinner.warn('Using raw writing style preferences.');
        config.enhancedWritingStyle = config.writingStyle;
      }
    }

    await saveConfig(config, cwd);
    await updateInstructionsFile(cwd, {
      projectTitle: config.projectTitle,
      writingStyle: config.writingStyle,
      enhancedWritingStyle: config.enhancedWritingStyle
    });
  } else if (
    config.groqApiKey &&
    config.writingStyle &&
    (!config.enhancedWritingStyle || config.enhancedWritingStyle.trim() === config.writingStyle.trim())
  ) {
    const styleSpinner = createSpinner('Stylizing global writing instructions with 20B model (< 100 words)...').start();
    try {
      const enhanced = await enhanceWritingStyleWithAi({
        projectTitle: config.projectTitle,
        writingStyle: config.writingStyle,
        groqApiKey: config.groqApiKey,
        model: config.models?.small || 'openai/gpt-oss-20b',
        baseUrl: config.groqBaseUrl || config.baseUrl
      });
      if (enhanced && enhanced.trim() && enhanced.trim() !== config.writingStyle.trim()) {
        config.enhancedWritingStyle = enhanced;
        await saveConfig(config, cwd);
        await updateInstructionsFile(cwd, {
          projectTitle: config.projectTitle,
          writingStyle: config.writingStyle,
          enhancedWritingStyle: config.enhancedWritingStyle
        });
        styleSpinner.succeed('Global stylized writing instructions created.');
      } else {
        styleSpinner.stop();
      }
    } catch {
      styleSpinner.stop();
    }
  }

  let synopsis = initialSynopsis;
  if (!synopsis) {
    ensureStdinRaw();
    synopsis = await input({
      message: 'Paste or type your story premise / synopsis:'
    });
  }

  if (!synopsis || !synopsis.trim()) {
    console.log(chalk.yellow('No synopsis provided. Aborting /init.'));
    return;
  }

  // Step 0: Generate open clarifying questions using 120B model at high reasoning before Bible generation
  let authorClarifications = '';
  if (config.groqApiKey) {
    console.log(chalk.bold.cyan('\n  Analyzing synopsis and formulating clarifying questions (120B model)...'));
    const questionsProfile = getExecutionProfile('INIT_QUESTIONS', config);
    const qSpinner = createSpinner('Generating targeted open questions on premise & stakes...').start();
    let questionsDraft = '';
    try {
      const qPrompt = `Project Title: ${config.projectTitle || 'Untitled Novel'}
Thematic Tone & Setting Palette:
${config.writingStyle || 'Atmospheric, grounded, psychologically nuanced'}

Story Synopsis:
${synopsis.trim()}`;

      questionsDraft = await groqClient.chatCompletion({
        model: 'large',
        messages: [
          { role: 'system', content: GENERATE_INIT_QUESTIONS_SYSTEM_PROMPT },
          { role: 'user', content: qPrompt }
        ],
        temperature: questionsProfile.temperaturePlan,
        maxTokens: questionsProfile.maxTokens,
        reasoningEffort: questionsProfile.reasoningEffort,
        sessionId: 'init_questions',
        workflow: 'INIT_QUESTIONS'
      });
      qSpinner.succeed('Clarifying questions generated.');
    } catch (err) {
      qSpinner.warn(`Skipping open questions generation: ${err.message}`);
    }

    if (questionsDraft && questionsDraft.trim()) {
      console.log(chalk.cyan('Opening questions in your editor for clarifications. Answer what you wish, then save and close.'));
      try {
        const answeredQuestions = await openInEditor(questionsDraft, config.editor);
        if (answeredQuestions && answeredQuestions.trim() && answeredQuestions.trim() !== questionsDraft.trim()) {
          authorClarifications = answeredQuestions.trim();
          console.log(chalk.green('✓ Author clarifications saved. Incorporating into Story Bible generation.'));
        } else {
          console.log(chalk.dim('No additional clarifications entered. Continuing with original synopsis.'));
        }
      } catch (err) {
        console.log(chalk.yellow(`Could not open editor (${err.message}). Continuing with original synopsis.`));
      }
    }
  }

  const bibleDir = path.join(cwd, 'story-bible');
  await fs.mkdir(bibleDir, { recursive: true });
  await ensureCondensedDirectories(cwd);

  const activeStyle = config.enhancedWritingStyle
    ? config.enhancedWritingStyle.trim()
    : (config.writingStyle || '');

  const creativity = config?.generation?.creativity || config?.creativity || 'off';
  const creativityDirective = buildCreativityDirective(creativity);
  const execProfile = getExecutionProfile('INIT_OVERVIEW', config);
  const planTemp = execProfile.temperaturePlan;
  const summaryTemp = execProfile.temperatureSummaries;

  // -------------------------------------------------------------
  // STEP 1: plot-overview.md
  // -------------------------------------------------------------
  console.log(chalk.bold.cyan('\n  [1/4] Generating Plot Overview (story-bible/plot-overview.md)...'));
  let overviewContent = '';
  let overviewAccepted = false;
  let overviewFeedback = '';

  while (!overviewAccepted) {
    const spinner = createSpinner('Drafting plot overview in paragraph format...').start();
    try {
      const userPrompt = `Project Title: ${config.projectTitle}
Thematic Tone & Setting Palette:
${config.writingStyle || 'Atmospheric, grounded, psychologically nuanced'}
(Format Directive: Maintain strictly objective, third-person archival prose. Do NOT write in first-person 'I'.)

Story Synopsis:
${synopsis.trim()}
${authorClarifications ? `\n<author_clarifications>\n${authorClarifications}\n</author_clarifications>` : ''}

${creativityDirective}
${overviewFeedback ? `\nRevision Feedback from author:\n${overviewFeedback}` : ''}`;

      if (groqClient?.quotaManager) {
        const cd = config?.cooldownSeconds !== undefined ? config.cooldownSeconds : (process.stdin?.isTTY ? 45 : 0);
        await groqClient.quotaManager.enforceGenerationCooldown({
          cooldownSeconds: cd,
          isPaid: config?.apiTier === 'paid' || config?.apiTier === 'developer'
        });
      }

      overviewContent = await groqClient.chatCompletion({
        model: 'large',
        messages: [
          { role: 'system', content: INIT_OVERVIEW_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: planTemp,
        sessionId: 'init_overview',
        workflow: 'INIT_OVERVIEW'
      });

      spinner.succeed('Plot Overview generated.');
      if (groqClient?.quotaManager) {
        groqClient.quotaManager.recordGenerationEnd();
      }
    } catch (err) {
      spinner.fail(`Failed to generate plot overview: ${err.message}`);
      return;
    }

    console.log('\n' + chalk.bold.magenta('--- Plot Overview Preview ---'));
    printMarkdown(overviewContent);

    const review = await promptReviewWorkflow({
      draftContent: overviewContent,
      itemLabel: 'Plot Overview (plot-overview.md)',
      allowPause: false,
      preferredEditor: config.editor,
      quotaManager: groqClient?.quotaManager,
      config,
      model: config.models?.large || 'openai/gpt-oss-120b'
    });

    if (review.action === 'accept') {
      overviewContent = review.content.trim();
      overviewAccepted = true;
      await fs.writeFile(path.join(bibleDir, 'plot-overview.md'), overviewContent, 'utf8');
      console.log(chalk.green('✓ Saved story-bible/plot-overview.md'));
    } else if (review.action === 'retry') {
      overviewFeedback = review.feedback || 'Please deepen the central conflict and timeline milestones.';
    }
  }

  // Create condensed overview to pass to next steps (Requirement 8: Do not send entire files!)
  const condensedOverview = await generateCondensedSummary(overviewContent, 'Plot Overview', groqClient, summaryTemp);

  // -------------------------------------------------------------
  // STEP 2: characters.md
  // -------------------------------------------------------------
  console.log(chalk.bold.cyan('\n  [2/4] Generating Characters (story-bible/characters.md)...'));
  let charactersContent = '';
  let charactersAccepted = false;
  let charactersFeedback = '';

  while (!charactersAccepted) {
    const spinner = createSpinner('Drafting character profiles in paragraph format...').start();
    try {
      // Notice: Only sending synopsis + condensed overview, NOT entire plot-overview.md
      const userPrompt = `Project Title: ${config.projectTitle}
Thematic Tone & Setting Palette:
${config.writingStyle || 'Atmospheric, grounded, psychologically nuanced'}
(Format Directive: Maintain strictly objective, third-person archival prose. Do NOT write in first-person 'I'.)

Story Synopsis:
${synopsis.trim()}
${authorClarifications ? `\n<author_clarifications>\n${authorClarifications}\n</author_clarifications>` : ''}

<condensed_plot_overview>
${condensedOverview}
</condensed_plot_overview>

${creativityDirective}
${charactersFeedback ? `\nRevision Feedback from author:\n${charactersFeedback}` : ''}`;

      if (groqClient?.quotaManager) {
        const cd = config?.cooldownSeconds !== undefined ? config.cooldownSeconds : (process.stdin?.isTTY ? 45 : 0);
        await groqClient.quotaManager.enforceGenerationCooldown({
          cooldownSeconds: cd,
          isPaid: config?.apiTier === 'paid' || config?.apiTier === 'developer'
        });
      }

      charactersContent = await groqClient.chatCompletion({
        model: 'large',
        messages: [
          { role: 'system', content: INIT_CHARACTERS_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: planTemp,
        sessionId: 'init_characters',
        workflow: 'INIT_CHARACTERS'
      });

      spinner.succeed('Character profiles generated.');
      if (groqClient?.quotaManager) {
        groqClient.quotaManager.recordGenerationEnd();
      }
    } catch (err) {
      spinner.fail(`Failed to generate characters: ${err.message}`);
      return;
    }

    console.log('\n' + chalk.bold.magenta('--- Characters Preview ---'));
    printMarkdown(charactersContent);

    const review = await promptReviewWorkflow({
      draftContent: charactersContent,
      itemLabel: 'Characters (characters.md)',
      allowPause: false,
      preferredEditor: config.editor,
      quotaManager: groqClient?.quotaManager,
      config,
      model: config.models?.large || 'openai/gpt-oss-120b'
    });

    if (review.action === 'accept') {
      charactersContent = review.content.trim();
      charactersAccepted = true;
      await fs.writeFile(path.join(bibleDir, 'characters.md'), charactersContent, 'utf8');
      console.log(chalk.green('✓ Saved story-bible/characters.md'));
    } else if (review.action === 'retry') {
      charactersFeedback = review.feedback || 'Please sharpen motivations and character voices.';
    }
  }

  // Create condensed character cast
  const condensedCharacters = await generateCondensedSummary(charactersContent, 'Character Cast', groqClient, summaryTemp);

  // -------------------------------------------------------------
  // STEP 3: locations.md
  // -------------------------------------------------------------
  console.log(chalk.bold.cyan('\n  [3/4] Generating Locations (story-bible/locations.md)...'));
  let locationsContent = '';
  let locationsAccepted = false;
  let locationsFeedback = '';

  while (!locationsAccepted) {
    const spinner = createSpinner('Drafting setting and location descriptions in paragraph format...').start();
    try {
      // Notice: Only sending synopsis + condensed overview + condensed characters
      const userPrompt = `Project Title: ${config.projectTitle}
Thematic Tone & Setting Palette:
${config.writingStyle || 'Atmospheric, grounded, psychologically nuanced'}
(Format Directive: Maintain strictly objective, third-person archival prose. Do NOT write in first-person 'I'.)

Story Synopsis:
${synopsis.trim()}
${authorClarifications ? `\n<author_clarifications>\n${authorClarifications}\n</author_clarifications>` : ''}

<condensed_narrative_context>
${condensedOverview}
</condensed_narrative_context>

<key_character_roster>
${condensedCharacters}
</key_character_roster>

${creativityDirective}
${locationsFeedback ? `\nRevision Feedback from author:\n${locationsFeedback}` : ''}`;

      if (groqClient?.quotaManager) {
        const cd = config?.cooldownSeconds !== undefined ? config.cooldownSeconds : (process.stdin?.isTTY ? 45 : 0);
        await groqClient.quotaManager.enforceGenerationCooldown({
          cooldownSeconds: cd,
          isPaid: config?.apiTier === 'paid' || config?.apiTier === 'developer'
        });
      }

      locationsContent = await groqClient.chatCompletion({
        model: 'large',
        messages: [
          { role: 'system', content: INIT_LOCATIONS_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: planTemp,
        sessionId: 'init_locations',
        workflow: 'INIT_LOCATIONS'
      });

      spinner.succeed('Locations generated.');
      if (groqClient?.quotaManager) {
        groqClient.quotaManager.recordGenerationEnd();
      }
    } catch (err) {
      spinner.fail(`Failed to generate locations: ${err.message}`);
      return;
    }

    console.log('\n' + chalk.bold.magenta('--- Locations Preview ---'));
    printMarkdown(locationsContent);

    const review = await promptReviewWorkflow({
      draftContent: locationsContent,
      itemLabel: 'Locations (locations.md)',
      allowPause: false,
      preferredEditor: config.editor,
      quotaManager: groqClient?.quotaManager,
      config,
      model: config.models?.large || 'openai/gpt-oss-120b'
    });

    if (review.action === 'accept') {
      locationsContent = review.content.trim();
      locationsAccepted = true;
      await fs.writeFile(path.join(bibleDir, 'locations.md'), locationsContent, 'utf8');
      console.log(chalk.green('✓ Saved story-bible/locations.md'));
    } else if (review.action === 'retry') {
      locationsFeedback = review.feedback || 'Please enhance sensory texture and atmospheric tone.';
    }
  }

  // Create condensed locations summary
  const condensedLocations = await generateCondensedSummary(locationsContent, 'Locations', groqClient, summaryTemp);

  // -------------------------------------------------------------
  // STEP 4: world-and-lore.md
  // -------------------------------------------------------------
  console.log(chalk.bold.cyan('\n  [4/4] Generating World & Lore (story-bible/world-and-lore.md)...'));
  let worldContent = '';
  let worldAccepted = false;
  let worldFeedback = '';

  while (!worldAccepted) {
    const spinner = createSpinner('Drafting world rules, magic/tech, and historical lore in paragraph format...').start();
    try {
      // Notice: Only sending synopsis + condensed overview + condensed locations
      const userPrompt = `Project Title: ${config.projectTitle}
Thematic Tone & Setting Palette:
${config.writingStyle || 'Atmospheric, grounded, psychologically nuanced'}
(Format Directive: Maintain strictly objective, third-person archival prose. Do NOT write in first-person 'I'.)

Story Synopsis:
${synopsis.trim()}
${authorClarifications ? `\n<author_clarifications>\n${authorClarifications}\n</author_clarifications>` : ''}

<condensed_narrative_context>
${condensedOverview}
</condensed_narrative_context>

<key_locations_summary>
${condensedLocations}
</key_locations_summary>

${creativityDirective}
${worldFeedback ? `\nRevision Feedback from author:\n${worldFeedback}` : ''}`;

      if (groqClient?.quotaManager) {
        const cd = config?.cooldownSeconds !== undefined ? config.cooldownSeconds : (process.stdin?.isTTY ? 45 : 0);
        await groqClient.quotaManager.enforceGenerationCooldown({
          cooldownSeconds: cd,
          isPaid: config?.apiTier === 'paid' || config?.apiTier === 'developer'
        });
      }

      worldContent = await groqClient.chatCompletion({
        model: 'large',
        messages: [
          { role: 'system', content: INIT_WORLD_LORE_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: planTemp,
        sessionId: 'init_world_lore',
        workflow: 'INIT_WORLD_LORE'
      });

      spinner.succeed('World & Lore generated.');
      if (groqClient?.quotaManager) {
        groqClient.quotaManager.recordGenerationEnd();
      }
    } catch (err) {
      spinner.fail(`Failed to generate world and lore: ${err.message}`);
      return;
    }

    console.log('\n' + chalk.bold.magenta('--- World & Lore Preview ---'));
    printMarkdown(worldContent);

    const review = await promptReviewWorkflow({
      draftContent: worldContent,
      itemLabel: 'World & Lore (world-and-lore.md)',
      allowPause: false,
      preferredEditor: config.editor,
      quotaManager: groqClient?.quotaManager,
      config,
      model: config.models?.large || 'openai/gpt-oss-120b'
    });

    if (review.action === 'accept') {
      worldContent = review.content.trim();
      worldAccepted = true;
      await fs.writeFile(path.join(bibleDir, 'world-and-lore.md'), worldContent, 'utf8');
      console.log(chalk.green('✓ Saved story-bible/world-and-lore.md'));
    } else if (review.action === 'retry') {
      worldFeedback = review.feedback || 'Please clarify canon rules and societal dynamics.';
    }
  }

  // -------------------------------------------------------------
  // STEP 5: Finalize and Index
  // -------------------------------------------------------------
  const storySoFarPath = path.join(cwd, '.condensed', 'story-so-far.md');
  try {
    await fs.writeFile(storySoFarPath, '# Story So Far\n\n(No chapters written yet.)\n', { flag: 'wx' });
  } catch {}

  console.log(chalk.bold.green('\n  🎉 Successfully initialized all 4 Story Bible files in story-bible/!'));

  const syncSpinner = createSpinner('Indexing Story Bible into LanceDB...').start();
  try {
    const syncRes = await syncAllFiles({ cwd, vectorStore, embedder, config });
    syncSpinner.succeed(`Indexed ${syncRes.indexedCount} chunks into local hybrid RAG.`);
  } catch (err) {
    syncSpinner.fail(`Failed to index: ${err.message}`);
  }
}
