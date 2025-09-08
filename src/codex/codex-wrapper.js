import pty from '@lydell/node-pty';
import process from 'process';
import Logger from '../logger.js';
import NotificationService from '../notification.js';
import { NOTIFY_TITLE_CODEX, NOTIFY_MSG_CODEX_STOPPED } from '../constants.js';

// Minimal Codex wrapper: spawn `codex`, mirror I/O, and notify after inactivity.
export default class CodexWrapper {
  constructor(config) {
    this.config = config;
    this.logger = new Logger('codex-wrapper');
    this.codex = null;
    this.notificationService = new NotificationService(this.config);
    this.inactivityTimer = null;
    this.inactivityTimeoutMs = 5000;
    this.appState = 'idle'; // 'idle' | 'working' | 'notified'
  }

  clearTimer() {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  scheduleInactivityCheck() {
    this.clearTimer();
    this.inactivityTimer = setTimeout(async () => {
      // If Codex has been producing output and then became silent, alert once.
      this.logger.info('Inactivity check triggered, state is: ' + this.appState);
      if (this.appState === 'working') {
        this.appState = 'notified';
        try {
          await this.notificationService.send(NOTIFY_TITLE_CODEX, NOTIFY_MSG_CODEX_STOPPED);
        } catch (err) {
          this.logger.error(`Notification error: ${err.message || err}`);
        }
      }
    }, this.inactivityTimeoutMs);
  }

  cleanup(sig) {
    this.logger.info('Codex process exited, cleaning up...');
    this.clearTimer();
    try {
      process.stdin.setRawMode(false);
    } catch (e) {
      void e; // ignore
    }
    if (sig && this.codex) {
      this.codex.kill();
    } else {
      process.exit(0);
    }
  }

  async start(codexArgs = []) {
    this.codex = pty.spawn('codex', codexArgs, {
      name: 'xterm-color',
      cwd: process.cwd(),
      env: process.env,
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });

    // Mirror Codex output and track activity
    this.codex.onData(data => {
      process.stdout.write(data);
      // New output implies Codex is actively working.
      this.scheduleInactivityCheck();
    });

    // Forward user input to Codex
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', data => {
      this.codex.write(data);
      // Consider Enter as submission, reset state to working.
      if (data[0] === 0x0d || data[0] === 0x0a) {
        this.logger.info('Submit detected, resetting state to working');
        this.appState = 'working';
      } else {
        this.logger.info('Input detected, resetting state to idle');
        this.appState = 'idle';
        this.clearTimer();
      }
    });

    // Handle exit and signals
    this.codex.onExit(() => this.cleanup(false));
    process.on('SIGINT', () => this.cleanup(true));
    process.on('SIGTERM', () => this.cleanup(true));

    // Keep PTY size in sync
    const resize = () => {
      if (this.codex && this.codex.resize) {
        const { columns, rows } = process.stdout;
        this.codex.resize(columns || 80, rows || 24);
      }
    };
    process.stdout.on('resize', resize);
    process.on('SIGWINCH', resize);
  }
}
