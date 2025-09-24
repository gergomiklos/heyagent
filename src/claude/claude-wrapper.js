import pty from '@lydell/node-pty';
// import stripAnsi from 'strip-ansi';
import process from 'process';
import Logger from '../logger.js';
import HookSetup from './hook-setup.js';
import SlashCommandSetup from './slash-command-setup.js';

export default class ClaudeWrapper {
  constructor(config) {
    this.config = config;
    this.logger = new Logger('wrapper');
    this.claude = null;
    this.hookSetup = null;
    this.slashCommandSetup = null;
  }

  async init() {
    this.hookSetup = new HookSetup();
    this.hookSetup.setupHooks();
    this.slashCommandSetup = new SlashCommandSetup();
    this.slashCommandSetup.setupCommands();
  }

  cleanup(sig) {
    this.logger.info('Claude process exited, cleaning up settings...');
    try {
      process.stdin.setRawMode(false);
    } catch (e) {
      void e;
    }
    if (sig) {
      this.claude.kill();
    } else {
      process.exit(0);
    }
  }

  async start(claudeArgs = []) {
    await this.init();

    console.log('Starting claude...');
    this.claude = pty.spawn('claude', claudeArgs, {
      name: 'xterm-color',
      cwd: process.cwd(),
      env: process.env,
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });

    this.claude.onData(data => {
      process.stdout.write(data);
    });

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', data => {
      this.claude.write(data);
    });

    this.claude.onExit(() => {
      this.logger.info('Claude process exited, cleaning up settings...');
      this.cleanup(false);
    });

    process.on('SIGINT', () => {
      this.logger.info('Received SIGINT, cleaning up...');
      this.cleanup(true);
    });

    process.on('SIGTERM', () => {
      this.logger.info('Received SIGTERM, cleaning up...');
      this.cleanup(true);
    });

    process.stdout.on('resize', () => {
      if (this.claude && this.claude.resize) {
        const { columns, rows } = process.stdout;
        this.claude.resize(columns || 80, rows || 24);
      }
    });

    process.on('SIGWINCH', () => {
      if (this.claude && this.claude.resize) {
        const { columns, rows } = process.stdout;
        this.claude.resize(columns || 80, rows || 24);
      }
    });
  }
}
