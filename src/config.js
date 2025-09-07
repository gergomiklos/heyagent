import fs from 'fs';
import path from 'path';
import os from 'os';

class Config {
  constructor() {
    this.configDir = path.join(os.homedir(), '.heyagent');
    this.configPath = path.join(this.configDir, 'config.json');
    this.defaults = {
      notificationMethod: 'desktop',
      notificationsEnabled: true,
      email: null,
      phoneNumber: null,
      telegramChatId: null,
      webhookUrl: null,
      slackWebhookUrl: null,
      slackUsername: null,
      licenseKey: null,
    };
    this._data = { ...this.defaults };
    this.isFirstRun = !fs.existsSync(this.configPath);
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const fileData = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this._data = { ...this.defaults, ...fileData };
      }
    } catch (error) {
      console.error(`Failed to load config: ${error.message}`);
      this._data = { ...this.defaults };
    }

    return this._data;
  }

  save(newData = null) {
    try {
      if (newData) {
        this._data = { ...this._data, ...newData };
      }

      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }

      fs.writeFileSync(this.configPath, JSON.stringify(this._data, null, 2));
    } catch (error) {
      console.error(`Failed to save config: ${error.message}`);
    }
  }

  get(key) {
    return this._data[key] ?? this.defaults[key];
  }

  set(key, value) {
    this._data[key] = value;
    this.save();
  }

  get data() {
    return this._data;
  }

  get notificationMethod() {
    return this.get('notificationMethod');
  }

  get email() {
    return this.get('email');
  }

  get phoneNumber() {
    return this.get('phoneNumber');
  }

  get telegramChatId() {
    return this.get('telegramChatId');
  }

  get webhookUrl() {
    return this.get('webhookUrl');
  }

  get slackWebhookUrl() {
    return this.get('slackWebhookUrl');
  }

  get slackUsername() {
    return this.get('slackUsername');
  }

  get licenseKey() {
    return this.get('licenseKey');
  }

  get notificationsEnabled() {
    return this.get('notificationsEnabled');
  }

  clearLicenseKey() {
    this.set('licenseKey', null);
  }

  validateConfig(method = null) {
    method = method || this.notificationMethod;
    if (!this.notificationsEnabled) return true;

    if (method === 'email') return !!this.email;
    if (method === 'whatsapp') return !!this.phoneNumber;
    if (method === 'telegram') return !!this.telegramChatId;
    if (method === 'slack') return !!this.slackWebhookUrl && !!this.slackUsername;
    if (method === 'webhook') return !!this.webhookUrl;

    return true;
  }
}

export default Config;
