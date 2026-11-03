import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import chalk from 'chalk';
import ora from 'ora';

marked.use(
  markedTerminal({
    width: 90,
    reflowText: true,
    showSectionPrefix: false,
    tab: 2
  })
);

export function renderMarkdown(markdownText = '') {
  if (!markdownText) return '';
  try {
    return marked(markdownText);
  } catch {
    return markdownText;
  }
}

export function printMarkdown(markdownText = '') {
  const rendered = renderMarkdown(markdownText);
  console.log(rendered);
}

export function printBanner() {
  console.log(chalk.bold.hex('#7C3AED')(`
   ___        _ _ _ _           _   
  / _ \\ _   _(_) | | |__   ___ | |_ 
 | | | | | | | | | | '_ \\ / _ \\| __|
 | |_| | |_| | | | | |_) | (_) | |_ 
  \\__\\_\\\\__,_|_|_|_|_.__/ \\___/ \\__|
`));
  console.log(chalk.cyan.bold('  Turn-Based Interactive Story Writing Agent'));
  console.log(chalk.dim('  Local Hybrid RAG (LanceDB + Ollama) & Groq Cloud Inference\n'));
}

export function printHelp() {
  console.log(chalk.bold.cyan('\n  Quillbot Interactive Command Reference:'));
  console.log(chalk.dim('  Press "/" at the prompt to open the dropdown menu. Select a command and follow the prompts.\n'));
  const commands = [
    ['/write', 'Write or edit beats sequentially or targeted beat-by-beat'],
    ['/plan', 'Plan or revise chapter beats, or add new beats'],
    ['/bible', 'Query lore, create/edit bible files, list documents, or save lore'],
    ['/export', 'Export specific chapter, range (e.g. 1-3), or entire manuscript'],
    ['/chat', 'Conversational consultation with Story Bible and project context'],
    ['/status', 'View active chapter, beat, tracked files, and chunk counts'],
    ['/sync', 'Manually trigger incremental file sync to local hybrid index'],
    ['/config', 'Launch interactive onboarding & settings wizard'],
    ['/init', 'Seed Story Bible from a synopsis or story in a nutshell'],
    ['/new', 'Start fresh conversation session (auto-archives existing)'],
    ['/load', 'Restore an archived conversation session from dropdown'],
    ['/archive', 'Archive current conversation session to disk'],
    ['/help', 'Display this interactive command guide'],
    ['/exit', 'Gracefully save and exit Quillbot']
  ];

  for (const [cmd, desc] of commands) {
    console.log(`  ${chalk.cyan(cmd.padEnd(14))} ${chalk.white(desc)}`);
  }
  console.log('');
}

export function createSpinner(text) {
  return ora({
    text: chalk.dim(text),
    color: 'magenta',
    spinner: 'dots'
  });
}

export function renderQuotaDashboard(dashboardData) {
  if (!dashboardData || !dashboardData.models || dashboardData.models.length === 0) {
    return;
  }

  console.log(chalk.bold.cyan('  Groq Quotas & Rate Limits Dashboard:'));
  const tierName = dashboardData.isPaid ? 'Developer Plan (Pay-As-You-Go)' : 'Free Plan';
  console.log(`  Account Tier:       ${chalk.green(tierName)}\n`);

  for (const m of dashboardData.models) {
    console.log(chalk.bold.magenta(`  Model: ${m.model} (${m.label})`));
    const tpmReset = m.resetTokens ? ` (resets in ${m.resetTokens})` : '';
    const rpdReset = m.resetRequests ? ` (resets in ${m.resetRequests})` : '';
    const tpdLimit = m.limitTpd === Infinity ? 'Pay-As-You-Go' : m.limitTpd.toLocaleString();
    const tpdRem = m.remainingTpd === Infinity ? 'Uncapped' : m.remainingTpd.toLocaleString();
    const rpdLimit = m.limitRpd === Infinity ? 'Uncapped' : m.limitRpd.toLocaleString();
    const rpdRem = m.remainingRpd === Infinity ? 'Uncapped' : m.remainingRpd.toLocaleString();

    console.log(`    TPM (Tokens / Min):   [${m.usedTpm.toLocaleString()} / ${m.limitTpm.toLocaleString()}] | Remaining: ${chalk.green(m.remainingTpm.toLocaleString())}${tpmReset}`);
    console.log(`    TPD (Tokens / Day):   [${m.usedTpd.toLocaleString()} / ${tpdLimit}] | Remaining: ${chalk.green(tpdRem)}`);
    console.log(`    RPM (Requests / Min): [${m.usedRpm.toLocaleString()} / ${m.limitRpm.toLocaleString()}] | Remaining: ${chalk.green(m.remainingRpm.toLocaleString())}`);
    console.log(`    RPD (Requests / Day): [${m.usedRpd.toLocaleString()} / ${rpdLimit}] | Remaining: ${chalk.green(rpdRem)}${rpdReset}\n`);
  }
}
