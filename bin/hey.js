#!/usr/bin/env node
import process from 'process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Config from '../src/config.js';
import ConfigSetup from '../src/config-setup.js';
import Logger from '../src/logger.js';
import { startClaudeWrapper } from '../src/index.js';
import HookHandler from '../src/claude/hook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const command = args[0];
const logger = new Logger('hey');

function showHelp() {
  console.log(`
HeyAgent: Get notified when Claude Code needs your attention!

Usage:
  hey claude [args...]   Run Claude with notifications (interactive)
  hey setup claude       Setup notifications for Claude (headless init)
  hey config             Configure notification settings
  hey license            Manage your license
  hey on                 Enable notifications
  hey off                Disable notifications
  hey --version          Show version number
  hey claude-hook        Handle Claude Code hook events (internal)

Examples:
  hey claude                    # Start Claude with notifications
  hey claude --help             # Pass --help to Claude
  hey claude -c                 # Pass -c flag to Claude to continue the last session

See more: https://heyagent.dev
`);
}

async function main() {
  if (!command) {
    showHelp();
    return;
  }

  if (command === 'config') {
    // Configure notifications
    console.log('\nHeyAgent: Get notified when Claude Code needs your input!\n');
    const config = new Config();
    const setup = new ConfigSetup(config);
    await setup.runConfigWizard();
    return;
  }

  if (command === 'license') {
    // Manage license key and checkout
    console.log('\nHeyAgent: Manage your license key\n');
    const config = new Config();
    const setup = new ConfigSetup(config);
    await setup.runLicenseWizard();
    return;
  }

  if (command === 'claude') {
    // Run the Claude wrapper with remaining args
    const claudeArgs = args.slice(1); // Everything after 'claude'
    await startClaudeWrapper(claudeArgs);
    return;
  }

  if (command === 'setup' && args[1] === 'claude') {
    // Setup Claude hooks and slash commands without starting Claude
    await startClaudeWrapper([], true);
    return;
  }

  if (command === 'claude-hook') {
    // Handle Claude Code hook events
    const hookHandler = new HookHandler();
    await hookHandler.handleHook();
    return;
  }

  if (command === 'on') {
    // Enable notifications
    const config = new Config();
    config.set('notificationsEnabled', true);
    console.log('HeyAgent notifications enabled');
    return;
  }

  if (command === 'off') {
    // Disable notifications
    const config = new Config();
    config.set('notificationsEnabled', false);
    console.log('HeyAgent notifications disabled');
    return;
  }

  if (command === '--version' || command === '-v') {
    // Show version
    const packageJsonPath = path.join(__dirname, '../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    console.log(packageJson.version);
    return;
  }

  // Unknown command - show help
  if (command != 'help' && command != '--help' && command != '-h') {
    console.log(`Unknown command: ${command}`);
  }
  showHelp();
}

main().catch(error => {
  logger.error(error);
  console.error('Error: ', error);
  process.exit(1);
});
