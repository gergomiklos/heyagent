import ClaudeWrapper from './claude/claude-wrapper.js';
import Config from './config.js';
import ConfigSetup from './config-setup.js';
import Logger from './logger.js';

export async function startClaudeWrapper(claudeArgs = [], headless = false) {
  const logger = new Logger('main');
  logger.info('HeyAgent started');

  console.log('\n✻ Welcome to HeyAgent!');
  console.log('You will be notified when Claude Code is waiting for you.\n');

  const config = new Config();
  logger.info(`Settings loaded: ${JSON.stringify(config.data)}`);

  const setup = new ConfigSetup(config);
  await setup.runSetupWizard();

  console.log('\nTips:');
  console.log('  ※ Toggle notifications inside Claude: /hey [on | off]');
  console.log('  ※ Get help: hey help');
  console.log('  ※ See more: https://heyagent.dev \n');

  const wrapper = new ClaudeWrapper(config);
  if (headless) {
    await wrapper.init();
    console.log('HeyAgent setup complete');
  } else {
    await wrapper.start(claudeArgs);
  }
}
