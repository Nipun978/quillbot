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
  console.log(chalk.bold.yellow('\n  Quillbot Slash Commands:'));
  const commands = [
    ['/init', 'Seed Story Bible from a "Story in a Nutshell" synopsis'],
    ['/bible [subcommand]', 'Consult lore, or /bible create, /bible edit, /bible list, /bible save'],
    ['/plan <ch> [beat]', 'Plan or edit chapter beats (e.g. /plan 1 or /plan 1 2)'],
    ['/write <ch> [beat]', 'Write or edit chapter/beat (e.g. /write 1 or /write 1 2)'],
    ['/export [scope]', 'Export chapter, range (e.g. /export 1-3), or full manuscript'],
    ['/chat [message]', 'Open conversational chat with Story Bible & project RAG'],
    ['/archive', 'Archive active conversation and empty current.json'],
    ['/load', 'Restore an archived conversation session'],
    ['/new', 'Archive current conversation session and start fresh'],
    ['/sync', 'Manually trigger incremental file sync to LanceDB'],
    ['/config', 'View or update Quillbot configuration'],
    ['/status', 'View current novel status, active chapter & beat'],
    ['/help', 'Display this command reference'],
    ['/exit', 'Exit the Quillbot CLI']
  ];

  for (const [cmd, desc] of commands) {
    console.log(`  ${chalk.cyan(cmd.padEnd(18))} ${chalk.white(desc)}`);
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
