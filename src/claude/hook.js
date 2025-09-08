import process from 'process';
import Logger from '../logger.js';
import { NOTIFY_TITLE_CLAUDE, NOTIFY_MSG_CLAUDE_DONE } from '../constants.js';

import Config from '../config.js';
import NotificationService from '../notification.js';

class HookHandler {
  constructor() {
    this.logger = new Logger('hook');
  }

  getNotificationService() {
    const config = new Config();
    return new NotificationService(config);
  }

  async readInput() {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    return input;
  }

  async handleHook() {
    const input = await this.readInput();
    this.logger.info(`Claude hook input received: ${input}`);

    const hookData = JSON.parse(input.trim());

    const eventType = hookData.hook_event_name;
    const message = hookData.message;

    const notificationService = this.getNotificationService();

    if (eventType === 'Stop') {
      await notificationService.send(NOTIFY_TITLE_CLAUDE, NOTIFY_MSG_CLAUDE_DONE);
    } else if (eventType === 'Notification') {
      await notificationService.send(NOTIFY_TITLE_CLAUDE, message);
    } else {
      this.logger.info(`Unknown event type: ${eventType}`);
    }
  }
}

export default HookHandler;
