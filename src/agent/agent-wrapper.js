import pty from '@lydell/node-pty';
import process from 'process';
import Logger from '../logger.js';
import NotificationService from '../notification.js';

function createNotificationMessages(agentName) {
  const capitalizedName = agentName.charAt(0).toUpperCase() + agentName.slice(1);
  return {
    title: `Hey, ${capitalizedName} is waiting for you!`,
    message: `${capitalizedName} stopped`
  };
}

export default class AgentWrapper {
  constructor(config, agentName) {
    this.config = config;
    this.agentName = agentName;
    this.logger = new Logger(`agent-wrapper-${agentName}`);
    this.agent = null;
    this.notificationService = new NotificationService(this.config);
    this.inactivityTimer = null;
    this.inactivityTimeoutMs = 5000;
    this.appState = 'idle'; // 'idle' | 'working' | 'notified'
    this.notifications = createNotificationMessages(agentName);
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
      this.logger.info('Inactivity check triggered, state is: ' + this.appState);
      if (this.appState === 'working') {
        this.appState = 'notified';
        try {
          await this.notificationService.send(this.notifications.title, this.notifications.message);
        } catch (err) {
          this.logger.error(`Notification error: ${err.message || err}`);
        }
      }
    }, this.inactivityTimeoutMs);
  }

  cleanup(sig) {
    this.logger.info(`${this.agentName} process exited, cleaning up...`);
    this.clearTimer();
    try {
      process.stdin.setRawMode(false);
    } catch (e) {
      void e; // ignore
    }
    if (sig && this.agent) {
      this.agent.kill();
    } else {
      process.exit(0);
    }
  }

  async start(agentArgs = []) {
    console.log(`Starting ${this.agentName}...`);

    this.agent = pty.spawn(this.agentName, agentArgs, {
      name: 'xterm-color',
      cwd: process.cwd(),
      env: process.env,
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });


    // Mirror agent output and track activity
    this.agent.onData(data => {
      process.stdout.write(data);
      // New output implies agent is actively working.
      this.scheduleInactivityCheck();
    });

    // Forward user input to agent
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', data => {
      this.agent.write(data);
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
    this.agent.onExit(() => {
      this.cleanup(false);
      console.log(`${this.agentName} process exited, cleaning up...`);
    });
    process.on('SIGINT', () => this.cleanup(true));
    process.on('SIGTERM', () => this.cleanup(true));

    // Keep PTY size in sync
    const resize = () => {
      if (this.agent && this.agent.resize) {
        const { columns, rows } = process.stdout;
        this.agent.resize(columns || 80, rows || 24);
      }
    };
    process.stdout.on('resize', resize);
    process.on('SIGWINCH', resize);
  }
}