import ClaudeWrapper from './claude/claude-wrapper.js';
import CodexWrapper from './codex/codex-wrapper.js';
import AgentWrapper from './agent/agent-wrapper.js';
import Config from './config.js';
import ConfigSetup from './config-setup.js';
import Logger from './logger.js';

async function showLatestNews() {
  try {
    const response = await fetch('https://www.heyagent.dev/api/news', { signal: globalThis.AbortSignal.timeout(2000) });
    if (!response.ok) return;

    const payload = await response.json();
    const latestNews = Array.isArray(payload?.news) ? payload.news[0] : null;
    if (latestNews) console.log(`News: ${latestNews}\n`);
  } catch (error) {
    void error;
  }
}

export async function startClaudeWrapper(claudeArgs = [], headless = false) {
  const logger = new Logger('main-claude');
  logger.info('HeyAgent started');

  console.log('\n✻ Welcome to HeyAgent!');
  console.log('You will be notified when Claude Code is waiting for you.\n');

  const config = new Config();
  logger.info(`Settings loaded: ${JSON.stringify(config.data)}`);

  // Show latest news (quick, silent on failure)
  await showLatestNews();

  console.log('Tips:');
  console.log('  ※ Toggle notifications inside Claude: /hey [on | off]');
  console.log('  ※ Get help: hey help');
  console.log('  ※ See more: https://heyagent.dev \n');

  const setup = new ConfigSetup(config);
  await setup.runSetupWizard();

  const wrapper = new ClaudeWrapper(config);
  if (headless) {
    await wrapper.init();
    console.log('HeyAgent setup complete');
  } else {
    await wrapper.start(claudeArgs);
  }
}

export async function startCodexWrapper(codexArgs = []) {
  const logger = new Logger('main-codex');
  logger.info('HeyAgent Codex started');

  console.log('\n>_ Welcome to HeyAgent!');
  console.log('You will be notified when Codex CLI is waiting for you.\n');

  const config = new Config();
  logger.info(`Settings loaded: ${JSON.stringify(config.data)}`);

  // Show latest news (quick, silent on failure)
  await showLatestNews();

  console.log('Tips:');
  console.log('  - Configure notifications: hey config');
  console.log('  - Get help: hey help');
  console.log('  - See more: https://heyagent.dev \n');

  const setup = new ConfigSetup(config);
  await setup.runSetupWizard();

  const wrapper = new CodexWrapper(config);
  await wrapper.start(codexArgs);
}

export async function startAgentWrapper(agentName, agentArgs = []) {
  const logger = new Logger(`main-${agentName}`);
  logger.info(`HeyAgent ${agentName} started`);

  const capitalizedName = agentName.charAt(0).toUpperCase() + agentName.slice(1);
  console.log(`\n⚡ Welcome to HeyAgent!`);
  console.log(`You will be notified when ${capitalizedName} is waiting for you.\n`);

  const config = new Config();
  logger.info(`Settings loaded: ${JSON.stringify(config.data)}`);

  // Show latest news (quick, silent on failure)
  await showLatestNews();

  console.log('Tips:');
  console.log('  - Configure notifications: hey config');
  console.log('  - Get help: hey help');
  console.log('  - See more: https://heyagent.dev \n');

  const setup = new ConfigSetup(config);
  await setup.runSetupWizard();

  const wrapper = new AgentWrapper(config, agentName);
  await wrapper.start(agentArgs);
}
