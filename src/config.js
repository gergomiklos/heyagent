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
      callModeEnabled: false,
      claudeLastSessionId: null,
      codexLastSessionId: null,
      activeAgentChatId: 'default',
      agentChats: {},
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

  get callModeEnabled() {
    return Boolean(this._data.callModeEnabled ?? this.defaults.callModeEnabled);
  }

  get codexLastSessionId() {
    return this._data.codexLastSessionId ?? this.defaults.codexLastSessionId;
  }

  get claudeLastSessionId() {
    return this._data.claudeLastSessionId ?? this.defaults.claudeLastSessionId;
  }

  get activeAgentChatId() {
    const value = this._data.activeAgentChatId ?? this.defaults.activeAgentChatId;
    return String(value || 'default').trim() || 'default';
  }

  get agentChats() {
    const value = this._data.agentChats ?? this.defaults.agentChats;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  getAgentChat(chatId = this.activeAgentChatId) {
    const normalizedId = String(chatId || 'default').trim() || 'default';
    const stored = this.agentChats[normalizedId];
    const fallback = normalizedId === 'default' ? { name: 'default' } : { name: normalizedId };
    const chat = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : fallback;

    return {
      id: normalizedId,
      name: String(chat.name || normalizedId).trim() || normalizedId,
      provider: chat.provider || null,
      cwd: chat.cwd || null,
      claudeLastSessionId: chat.claudeLastSessionId || null,
      codexLastSessionId: chat.codexLastSessionId || null,
      createdAt: chat.createdAt || null,
      updatedAt: chat.updatedAt || null,
    };
  }

  listAgentChats() {
    const chats = Object.keys(this.agentChats).map(chatId => this.getAgentChat(chatId));
    if (!chats.some(chat => chat.id === 'default')) {
      chats.unshift(this.getAgentChat('default'));
    }
    return chats.sort((left, right) => left.name.localeCompare(right.name));
  }

  saveAgentChat(chatId, data = {}) {
    const normalizedId = String(chatId || 'default').trim() || 'default';
    const now = new Date().toISOString();
    const previous = this.getAgentChat(normalizedId);
    const next = {
      ...previous,
      ...data,
      id: normalizedId,
      name: String(data.name || previous.name || normalizedId).trim() || normalizedId,
      createdAt: previous.createdAt || now,
      updatedAt: now,
    };

    this._data.agentChats = {
      ...this.agentChats,
      [normalizedId]: next,
    };
    return this.save();
  }

  setActiveAgentChat(chatId) {
    const normalizedId = String(chatId || 'default').trim() || 'default';
    this._data.activeAgentChatId = normalizedId;
    if (!this.agentChats[normalizedId]) {
      this.saveAgentChat(normalizedId, { name: normalizedId });
      return this._data;
    }
    return this.save();
  }

  deleteAgentChat(chatId) {
    const normalizedId = String(chatId || '').trim();
    if (!normalizedId || normalizedId === 'default') {
      return this._data;
    }

    const nextChats = { ...this.agentChats };
    delete nextChats[normalizedId];
    this._data.agentChats = nextChats;
    if (this.activeAgentChatId === normalizedId) {
      this._data.activeAgentChatId = 'default';
    }
    return this.save();
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
