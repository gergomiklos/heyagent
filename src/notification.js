import notifier from 'node-notifier';
import Logger from './logger.js';
import { isPaidNotificationMethod } from './license.js';

class NotificationService {
  constructor(config) {
    this.config = config;
    this.logger = new Logger('notification');
  }

  async send(message = null) {
    const title = 'Hey, Claude Code is waiting for you!';
    message = message || 'Claude Code finished';

    if (!this.config.notificationsEnabled) {
      return;
    }

    const method = this.config.notificationMethod || 'desktop';

    if (isPaidNotificationMethod(method) && !this.config.licenseKey) {
      throw new Error('Pro notifications require a license. Run "hey license" to set up.');
    }

    if (!this.config.validateConfig(method)) {
      throw new Error('Notification method is not configured. Run "hey config" to set up.');
    }

    if (method === 'email' || method === 'telegram' || method === 'whatsapp' || method === 'slack') {
      this.sendMessageNotification(title, message);
    } else if (method === 'webhook') {
      this.sendCustomWebhookNotification(title, message);
    } else {
      this.sendDesktopNotification(title, message);
    }
  }

  async sendMessageNotification(title, message) {
    const notificationMethod = this.config.data.notificationMethod;
    const payload = {
      title: title,
      message: message,
      method: notificationMethod,
      email: this.config.data.email,
      phoneNumber: this.config.data.phoneNumber,
      chatId: this.config.data.telegramChatId,
      slackWebhookUrl: this.config.data.slackWebhookUrl,
      slackUsername: this.config.data.slackUsername,
    };

    const headers = { 'Content-Type': 'application/json' };
    if (isPaidNotificationMethod(notificationMethod) && this.config.licenseKey) {
      headers.Authorization = `License ${this.config.licenseKey}`;
    }

    const response = await fetch('https://www.heyagent.dev/api/notification', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (response.status === 403 || response.status === 401) {
      throw new Error('Your license is invalid or revoked. Run "hey license" to set up.');
    }

    if (!response.ok) {
      throw new Error(`${notificationMethod} notification failed: ${response.status}`);
    }

    this.logger.info(`${notificationMethod} notification sent`);
  }

  async sendCustomWebhookNotification(title, message) {
    const webhookUrl = this.config.data.webhookUrl;
    if (!webhookUrl) {
      throw new Error('Webhook URL not configured');
    }

    const payload = {
      title: title,
      message: message,
      timestamp: new Date().toISOString(),
      source: 'heyagent',
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'HeyAgent/1.0.0',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Webhook notification failed: ${response.status} ${response.statusText}`);
    }

    this.logger.info(`Webhook notification sent to ${webhookUrl}`);
  }

  sendDesktopNotification(title, message) {
    const isMacOS = process.platform === 'darwin';
    const options = {
      title: title,
      message: message,
      sound: true,
      wait: false,
      timeout: 5,
      appId: 'HeyAgent',
      sender: isMacOS ? 'com.apple.Terminal' : undefined,
    };

    notifier.notify(options, (error, response) => {
      if (error) {
        this.logger.error(`Desktop notification error: ${error.message}`);
      } else {
        this.logger.info(`Desktop notification response: ${response}`);
      }
    });
  }
}

export default NotificationService;
