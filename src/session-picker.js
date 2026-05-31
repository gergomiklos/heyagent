import crypto from 'node:crypto';
import { gatherSessions } from './sessions.js';

const PROVIDER_ORDER = ['claude', 'codex'];
const SESSION_PICKER_LIMIT = 20;
const RECENT_SESSION_PICKER_LIMIT = 10;
const SESSION_BUTTON_MAX_LENGTH = 64;

function formatProviderName(provider) {
  if (provider === 'claude') {
    return 'Claude';
  }
  if (provider === 'codex') {
    return 'Codex';
  }
  return String(provider || 'Provider');
}

function normalizeProviderList(providers, fallback = PROVIDER_ORDER) {
  const values = new Set(Array.isArray(providers) ? providers : []);
  const normalized = PROVIDER_ORDER.filter(provider => values.has(provider));
  if (normalized.length > 0) {
    return normalized;
  }

  const fallbackValues = new Set(Array.isArray(fallback) ? fallback : []);
  return PROVIDER_ORDER.filter(provider => fallbackValues.has(provider));
}

function getSessionProviders(sessions) {
  const providers = new Set();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (session?.agentType === 'claude' || session?.agentType === 'codex') {
      providers.add(session.agentType);
    }
  }
  return PROVIDER_ORDER.filter(provider => providers.has(provider));
}

function resolveVisibleProviders(sessions, fallbackProvider = 'codex') {
  const sessionProviders = getSessionProviders(sessions);
  if (sessionProviders.length > 0) {
    return sessionProviders;
  }
  return normalizeProviderList([fallbackProvider], PROVIDER_ORDER);
}

function createTelegramBotCommands(visibleProviders = PROVIDER_ORDER) {
  const providers = new Set(normalizeProviderList(visibleProviders, PROVIDER_ORDER));
  return [
    { command: 'help', description: 'Show command list' },
    { command: 'new', description: 'Start a fresh session' },
    { command: 'stop', description: 'Stop current execution' },
    providers.has('claude') ? { command: 'claude', description: 'Switch to Claude' } : null,
    providers.has('codex') ? { command: 'codex', description: 'Switch to Codex' } : null,
    { command: 'projects', description: 'Choose project' },
    { command: 'sessions', description: 'Choose session' },
    { command: 'status', description: 'Show current status' },
  ].filter(Boolean);
}

function truncateLabel(text, maxLength = SESSION_BUTTON_MAX_LENGTH) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatRelativeAge(timestamp, now = new Date()) {
  if (!timestamp) {
    return null;
  }

  const thenMs = new Date(timestamp).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) {
    return null;
  }

  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (seconds < 60) {
    return 'now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  if (days < 30) {
    return `${Math.floor(days / 7)}w`;
  }
  if (days < 365) {
    return `${Math.floor(days / 30)}mo`;
  }
  return `${Math.floor(days / 365)}y`;
}

function formatSessionButtonLabel(session, now = new Date()) {
  const provider = formatProviderName(session?.agentType || 'provider');
  const title = String(session?.title || session?.lastUserMessage || session?.id || 'Untitled session')
    .replace(/\s+/g, ' ')
    .trim();
  const age = formatRelativeAge(session?.lastUserMessageAt, now);
  const meta = age ? `${provider} · ${age}` : provider;

  return truncateLabel(`${title} (${meta})`);
}

function normalizeProjectName(project) {
  return String(project || 'unknown').trim() || 'unknown';
}

function normalizeCommandName(command) {
  return String(command || '')
    .toLowerCase()
    .split('@')[0];
}

function groupSessionsByProject(sessions, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : Infinity;
  const groupsByProject = new Map();

  for (const session of (Array.isArray(sessions) ? sessions : []).slice(0, limit)) {
    const project = normalizeProjectName(session?.project);
    if (!groupsByProject.has(project)) {
      groupsByProject.set(project, {
        project,
        cwd: session?.cwd || null,
        sessions: [],
      });
    }
    groupsByProject.get(project).sessions.push(session);
  }

  return [...groupsByProject.values()];
}

function formatProjectButtonLabel(group) {
  const sessions = Array.isArray(group?.sessions) ? group.sessions : [];
  const project = normalizeProjectName(group?.project || sessions[0]?.project);

  return truncateLabel(`${project} (${sessions.length})`);
}

function createSessionKeyboard(sessions, registerToken, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : SESSION_PICKER_LIMIT;
  const now = options.now || new Date();
  const rows = [];

  for (const session of (Array.isArray(sessions) ? sessions : []).slice(0, limit)) {
    const token = registerToken(session);
    rows.push([
      {
        text: formatSessionButtonLabel(session, now),
        callback_data: token,
      },
    ]);
  }

  return {
    inline_keyboard: rows,
  };
}

function createSessionProjectKeyboard(sessions, registerProjectToken, options = {}) {
  const rows = [];

  for (const group of groupSessionsByProject(sessions, options)) {
    rows.push([
      {
        text: formatProjectButtonLabel(group),
        callback_data: registerProjectToken(group),
      },
    ]);
  }

  return {
    inline_keyboard: rows,
  };
}

function createProjectSessionKeyboard(group, registerSessionToken, registerNewSessionToken, options = {}) {
  const sessions = Array.isArray(group?.sessions) ? group.sessions : [];
  const project = normalizeProjectName(group?.project || sessions[0]?.project);
  const cwd = group?.cwd || sessions.find(session => session?.cwd)?.cwd || null;
  const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : SESSION_PICKER_LIMIT;
  const now = options.now || new Date();
  const visibleProviders = new Set(normalizeProviderList(options.visibleProviders || PROVIDER_ORDER, PROVIDER_ORDER));
  const projectProviders = getSessionProviders(sessions).filter(provider => visibleProviders.has(provider));
  const rows = [];

  if (projectProviders.length > 0 && typeof registerNewSessionToken === 'function') {
    rows.push(
      projectProviders.map(provider => ({
        text: `New ${formatProviderName(provider)}`,
        callback_data: registerNewSessionToken({
          provider,
          project,
          cwd,
        }),
      }))
    );
  }

  for (const session of sessions.slice(0, limit)) {
    rows.push([
      {
        text: formatSessionButtonLabel(session, now),
        callback_data: registerSessionToken(session),
      },
    ]);
  }

  return {
    inline_keyboard: rows,
  };
}

function makePickerToken(prefix, counter) {
  const tokenNonce = crypto
    .randomBytes(4)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9_-]/g, '');
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${tokenNonce}`;
}

// Stateful controller for the Telegram session/project pickers. It owns the
// short-lived callback-token registries and drives the picker conversation,
// delegating session-switch side effects back to the host Bridge.
class SessionPicker {
  constructor(host, options = {}) {
    this.host = host;
    this.gatherSessions = typeof options.gatherSessions === 'function' ? options.gatherSessions : gatherSessions;
    this.visibleProviders = null;
    this.sessionPickerEntries = new Map();
    this.sessionPickerProjectEntries = new Map();
    this.newSessionProjectEntries = new Map();
    this.sessionPickerCounter = 0;
  }

  async configureTelegramCommands(telegram = this.host.telegram) {
    if (!telegram || typeof telegram.setCommands !== 'function') {
      return;
    }

    let commands = createTelegramBotCommands(this.visibleProviders || [this.host.provider]);
    try {
      const sessions = await this.gatherSessions();
      this.visibleProviders = resolveVisibleProviders(sessions, this.host.provider);
      commands = createTelegramBotCommands(this.visibleProviders);
    } catch (error) {
      this.host.logger.warn(`Failed to inspect local sessions for Telegram commands: ${error.message}`);
    }

    try {
      await telegram.setCommands(commands, { chatId: this.host.config.telegramChatId });
    } catch (error) {
      this.host.logger.warn(`Failed to configure Telegram bot commands: ${error.message}`);
    }
  }

  registerSessionPickerEntry(session) {
    const token = makePickerToken('sess', this.sessionPickerCounter);
    this.sessionPickerCounter += 1;
    this.sessionPickerEntries.set(token, session);
    return token;
  }

  registerSessionPickerProject(group) {
    const token = makePickerToken('proj', this.sessionPickerCounter);
    this.sessionPickerCounter += 1;
    this.sessionPickerProjectEntries.set(token, group);
    return token;
  }

  registerNewSessionProject(entry) {
    const token = makePickerToken('new', this.sessionPickerCounter);
    this.sessionPickerCounter += 1;
    this.newSessionProjectEntries.set(token, entry);
    return token;
  }

  async showSessionPicker() {
    this.host.logCliEvent('Session picker', 'loading latest Claude and Codex sessions');
    const sessions = await this.gatherSessions();
    this.visibleProviders = resolveVisibleProviders(sessions, this.host.provider);
    const recentSessions = sessions.slice(0, RECENT_SESSION_PICKER_LIMIT);

    if (recentSessions.length === 0) {
      await this.host.safeSendMessage('No Claude or Codex sessions found.');
      return;
    }

    this.sessionPickerEntries.clear();
    this.sessionPickerProjectEntries.clear();
    this.newSessionProjectEntries.clear();
    const replyMarkup = createSessionKeyboard(recentSessions, session => this.registerSessionPickerEntry(session), {
      limit: RECENT_SESSION_PICKER_LIMIT,
    });
    await this.host.safeSendMessage(`Kies een sessie (${recentSessions.length} meest recent):`, {
      replyMarkup,
    });
  }

  async showProjectPicker() {
    this.host.logCliEvent('Project picker', 'loading Claude and Codex projects');
    const sessions = await this.gatherSessions();
    this.visibleProviders = resolveVisibleProviders(sessions, this.host.provider);
    const groups = groupSessionsByProject(sessions);

    if (groups.length === 0) {
      await this.host.safeSendMessage('Geen Claude- of Codex-projecten gevonden.');
      return;
    }

    this.sessionPickerEntries.clear();
    this.sessionPickerProjectEntries.clear();
    this.newSessionProjectEntries.clear();
    const replyMarkup = createSessionProjectKeyboard(sessions, group => this.registerSessionPickerProject(group));
    const projectSuffix = groups.length === 1 ? 'project' : 'projecten';
    await this.host.safeSendMessage(`Kies een project (${groups.length} ${projectSuffix}):`, {
      replyMarkup,
    });
  }

  async answerCallback(callbackQueryId, text = '') {
    if (!this.host.telegram || !callbackQueryId) {
      return;
    }

    try {
      await this.host.telegram.answerCallbackQuery(callbackQueryId, text);
    } catch (error) {
      this.host.logger.warn(`Failed to answer Telegram callback: ${error.message}`);
    }
  }

  async handleCallback(callback) {
    const data = String(callback?.data || '').trim();
    if (data.startsWith('proj_')) {
      await this.handleSessionProjectCallback(callback);
      return;
    }

    if (data.startsWith('new_')) {
      await this.handleNewSessionCallback(callback);
      return;
    }

    if (!data.startsWith('sess_')) {
      await this.answerCallback(callback.callbackQueryId);
      return;
    }

    await this.handleSessionPickerCallback(callback);
  }

  async handleSessionProjectCallback(callback) {
    const token = String(callback?.data || '').trim();
    const group = this.sessionPickerProjectEntries.get(token);

    if (!group) {
      await this.answerCallback(callback.callbackQueryId, 'Project verlopen');
      await this.host.safeSendMessage('Deze projectkeuze is verlopen. Stuur opnieuw /projects.');
      return;
    }

    const sessions = Array.isArray(group.sessions) ? group.sessions : [];
    if (sessions.length === 0) {
      await this.answerCallback(callback.callbackQueryId, 'No sessions');
      await this.host.safeSendMessage('No sessions found for this project. Send /projects again.');
      return;
    }

    this.sessionPickerEntries.clear();
    this.newSessionProjectEntries.clear();
    const project = normalizeProjectName(group.project);
    const visibleProviders = this.visibleProviders || resolveVisibleProviders(sessions, this.host.provider);
    const replyMarkup = createProjectSessionKeyboard(
      group,
      session => this.registerSessionPickerEntry(session),
      entry => this.registerNewSessionProject(entry),
      {
        visibleProviders,
        limit: SESSION_PICKER_LIMIT,
      }
    );
    await this.answerCallback(callback.callbackQueryId, project);
    await this.host.safeSendMessage(`Kies een sessie voor ${project}:`, { replyMarkup });
  }

  async handleNewSessionCallback(callback) {
    const token = String(callback?.data || '').trim();
    const entry = this.newSessionProjectEntries.get(token);

    if (!entry) {
      await this.answerCallback(callback.callbackQueryId, 'Keuze verlopen');
      await this.host.safeSendMessage('Deze nieuwe-sessiekeuze is verlopen. Stuur opnieuw /projects.');
      return;
    }

    if (entry.provider !== 'claude' && entry.provider !== 'codex') {
      await this.answerCallback(callback.callbackQueryId, 'Onbekende provider');
      await this.host.safeSendMessage(`Unsupported session provider: ${entry.provider || 'unknown'}`);
      return;
    }

    this.host.requestStopCurrentPrompt('session_switch');
    this.host.clearQueuedTelegramMessages();
    this.host.switchProvider(entry.provider);
    this.host.setBoundSessionId(null);
    this.host.selectedSessionCwd = entry.cwd || null;
    this.host.forceNewNextPrompt = true;
    this.newSessionProjectEntries.delete(token);

    const providerLabel = formatProviderName(entry.provider);
    const project = normalizeProjectName(entry.project);
    await this.answerCallback(callback.callbackQueryId, `New ${providerLabel}`);
    await this.host.safeSendMessage(
      [
        `New ${providerLabel} session selected.`,
        `Project: ${project}`,
        entry.cwd ? `Directory: ${entry.cwd}` : null,
        'Your next message starts a fresh session.',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  async handleSessionPickerCallback(callback) {
    const token = String(callback?.data || '').trim();
    const session = this.sessionPickerEntries.get(token);

    if (!session) {
      await this.answerCallback(callback.callbackQueryId, 'Sessie verlopen');
      await this.host.safeSendMessage('Deze sessiekeuze is verlopen. Stuur opnieuw /sessions.');
      return;
    }

    if (session.agentType !== 'claude' && session.agentType !== 'codex') {
      await this.answerCallback(callback.callbackQueryId, 'Onbekende provider');
      await this.host.safeSendMessage(`Unsupported session provider: ${session.agentType || 'unknown'}`);
      return;
    }

    this.host.requestStopCurrentPrompt('session_switch');
    this.host.clearQueuedTelegramMessages();
    this.host.switchProvider(session.agentType);
    this.host.setBoundSessionId(session.id);
    this.host.selectedSessionCwd = session.cwd || null;
    this.host.forceNewNextPrompt = false;
    this.sessionPickerEntries.delete(token);

    const providerLabel = formatProviderName(session.agentType);
    const project = session.project || 'unknown';
    const title = session.title || session.lastUserMessage || session.id;
    await this.answerCallback(callback.callbackQueryId, `${providerLabel} geselecteerd`);
    await this.host.safeSendMessage(
      [`Selected ${providerLabel} session.`, `Project: ${project}`, `Session: ${session.id}`, title ? `Title: ${title}` : null]
        .filter(Boolean)
        .join('\n')
    );
  }
}

export {
  SessionPicker,
  PROVIDER_ORDER,
  SESSION_PICKER_LIMIT,
  RECENT_SESSION_PICKER_LIMIT,
  SESSION_BUTTON_MAX_LENGTH,
  normalizeProviderList,
  getSessionProviders,
  resolveVisibleProviders,
  createTelegramBotCommands,
  truncateLabel,
  formatSessionButtonLabel,
  normalizeProjectName,
  normalizeCommandName,
  groupSessionsByProject,
  formatProjectButtonLabel,
  createSessionKeyboard,
  createSessionProjectKeyboard,
  createProjectSessionKeyboard,
};
