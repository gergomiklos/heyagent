import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

class Config {
  constructor() {
    this.configDir = path.join(os.homedir(), '.heyagent');
    this.configPath = path.join(this.configDir, 'config.json');
    this.defaults = {
      provider: null,
      claudeArgs: [],
      codexArgs: [],
      telegramBotToken: null,
      telegramBotUsername: null,
      telegramBotId: null,
      telegramChatId: null,
      telegramChatUserId: null,
      telegramUpdateCursor: 0,
      voiceTranscriptionEnabled: false,
      claudeLastSessionId: null,
      codexLastSessionId: null,
    };
    this._data = { ...this.defaults };
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
    if (newData) {
      this._data = { ...this._data, ...newData };
    }

    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }

    fs.writeFileSync(this.configPath, JSON.stringify(this._data, null, 2));
    return this._data;
  }

  setMany(data) {
    return this.save(data);
  }

  set(key, value) {
    this._data[key] = value;
    return this.save();
  }

  get provider() {
    return this._data.provider ?? this.defaults.provider;
  }

  get claudeArgs() {
    const value = this._data.claudeArgs ?? this.defaults.claudeArgs;
    return Array.isArray(value) ? value : [];
  }

  get codexArgs() {
    const value = this._data.codexArgs ?? this.defaults.codexArgs;
    return Array.isArray(value) ? value : [];
  }

  get telegramBotToken() {
    return this._data.telegramBotToken ?? this.defaults.telegramBotToken;
  }

  get telegramBotUsername() {
    return this._data.telegramBotUsername ?? this.defaults.telegramBotUsername;
  }

  get telegramBotId() {
    return this._data.telegramBotId ?? this.defaults.telegramBotId;
  }

  get telegramChatId() {
    return this._data.telegramChatId ?? this.defaults.telegramChatId;
  }

  get telegramChatUserId() {
    return this._data.telegramChatUserId ?? this.defaults.telegramChatUserId;
  }

  get telegramUpdateCursor() {
    return this._data.telegramUpdateCursor ?? this.defaults.telegramUpdateCursor;
  }

  get voiceTranscriptionEnabled() {
    return Boolean(this._data.voiceTranscriptionEnabled ?? this.defaults.voiceTranscriptionEnabled);
  }

  get codexLastSessionId() {
    return this._data.codexLastSessionId ?? this.defaults.codexLastSessionId;
  }

  get claudeLastSessionId() {
    return this._data.claudeLastSessionId ?? this.defaults.claudeLastSessionId;
  }

  isPaired() {
    return Boolean(this.telegramBotToken && this.telegramChatId);
  }

  clearPairing(options = {}) {
    const keepBotToken = options.keepBotToken !== false;

    this.save({
      telegramBotToken: keepBotToken ? this.telegramBotToken : null,
      telegramBotUsername: keepBotToken ? this.telegramBotUsername : null,
      telegramBotId: keepBotToken ? this.telegramBotId : null,
      telegramChatId: null,
      telegramChatUserId: null,
      telegramUpdateCursor: 0,
      claudeLastSessionId: null,
      codexLastSessionId: null,
    });
  }
}

export default Config;
