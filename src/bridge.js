import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { select } from '@inquirer/prompts';
import qrcode from 'qrcode-terminal';
import Logger from './logger.js';
import { TelegramApi, TelegramApiError } from './telegram-api.js';
import { createOnboardingSession } from './token-web-intake.js';
import { runClaudePrompt } from './providers/claude-provider.js';
import { runCodexPrompt } from './providers/codex-provider.js';
import { applyDefaultBypassArgs } from './args.js';
import { formatSleepInhibitorStatus, startSleepInhibitor } from './sleep-inhibitor.js';

const BOTFATHER_URL = 'https://t.me/BotFather';
const SETUP_MODE_PHONE = 'phone_onboarding';
const SETUP_MODE_MANUAL = 'manual_fallback';
const ATTACHMENT_DOWNLOAD_DIR = path.join(os.tmpdir(), 'heyagent-files');
const DICTATION_HINT_TEXT = 'Hint: for voice input, use your phone keyboard dictation.';
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_ARCHIVE_DIR = path.join(os.homedir(), '.codex', 'archived_sessions');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function promptLine(question) {
  const rl = readlinePromises.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return String(answer || '').trim();
  } finally {
    rl.close();
  }
}

function getCurrentSessionId(config, provider) {
  if (provider === 'codex') {
    return config.codexLastSessionId || null;
  }
  if (provider === 'claude') {
    return config.claudeLastSessionId || null;
  }
  return null;
}

function splitArgs(raw) {
  return String(raw || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function formatProviderName(provider) {
  if (provider === 'claude') {
    return 'Claude';
  }
  if (provider === 'codex') {
    return 'Codex';
  }
  return String(provider || 'Provider');
}

function makePairCode() {
  while (true) {
    const code = crypto
      .randomBytes(8)
      .toString('base64url')
      .replace(/[^a-zA-Z0-9]/g, '');
    if (code.length >= 10) {
      return code.slice(0, 10).toLowerCase();
    }
  }
}

function buildStatusText(config, provider, providerArgs = [], sleepInhibitorState = null) {
  const bot = config.telegramBotUsername ? `@${config.telegramBotUsername}` : 'not set';
  const sessionId = getCurrentSessionId(config, provider);
  const argsText = Array.isArray(providerArgs) && providerArgs.length > 0 ? providerArgs.join(' ') : '(none)';
  const sleepStatus = formatSleepInhibitorStatus(sleepInhibitorState);
  return [
    `Provider: ${provider}`,
    `Args: ${argsText}`,
    `Sleep prevention: ${sleepStatus}`,
    `Directory: ${process.cwd()}`,
    `Bot: ${bot}`,
    `Chat: ${config.telegramChatId || 'not paired'}`,
    `Session: ${sessionId || '-'}`,
  ].join('\n');
}

function isPairStartMessage(text, code) {
  const match = String(text || '')
    .trim()
    .match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);

  if (!match) {
    return false;
  }

  const payload = String(match[1] || '').trim();
  return payload === `ha2_${code}`;
}

function printManualTokenSetupHelp() {
  console.log('\nManual setup (fallback, no tunnel):');
  console.log('Open BotFather with this QR/link:\n');
  qrcode.generate(BOTFATHER_URL, { small: true });
  console.log(`Link: ${BOTFATHER_URL}\n`);
  console.log('Steps:');
  console.log('1. Run /newbot (or /token for an existing bot)');
  console.log('2. Copy the HTTP API token');
  console.log('3. Paste token here in terminal\n');
}

function toLogPreview(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return '(empty)';
  }

  const singleLine = normalized.replace(/\s+/g, ' ');
  if (singleLine.length <= 240) {
    return singleLine;
  }

  return `${singleLine.slice(0, 239)}…`;
}

function shortenSessionId(sessionId) {
  const normalized = String(sessionId || '').trim();
  if (!normalized) {
    return '-';
  }
  return normalized.slice(0, 8);
}

function formatSessionTimestamp(timestamp) {
  const value = String(timestamp || '').trim();
  if (!value) {
    return 'unknown time';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  const hours = String(parsed.getHours()).padStart(2, '0');
  const minutes = String(parsed.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function truncateSessionPreview(text, maxLength = 100) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function extractTextParts(content) {
  if (typeof content === 'string') {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }

    if (!block || typeof block !== 'object') {
      continue;
    }

    if (typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text);
      continue;
    }

    if (typeof block.content === 'string' && block.content.trim()) {
      parts.push(block.content);
    }
  }

  return parts;
}

function firstMeaningfulText(parts, predicate = null) {
  for (const candidate of extractTextParts(parts)) {
    const normalized = String(candidate || '').trim();
    if (!normalized) {
      continue;
    }

    if (predicate && !predicate(normalized)) {
      continue;
    }

    return normalized;
  }

  return '';
}

function isCodexSystemText(text) {
  return (
    text.startsWith('# AGENTS.md instructions') ||
    text.startsWith('<environment_context>') ||
    text.startsWith('<permissions instructions>') ||
    text.startsWith('<app-context>') ||
    text.startsWith('<collaboration_mode>') ||
    text.startsWith('<skills_instructions>')
  );
}

function collectJsonlFiles(dirPath, results = []) {
  if (!fs.existsSync(dirPath)) {
    return results;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(fullPath, results);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }

  return results;
}

function getFileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function readJsonl(filePath) {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseClaudeSessionFile(filePath) {
  const lines = readJsonl(filePath);
  const fallbackTimestamp = new Date(getFileMtime(filePath)).toISOString();
  const record = {
    id: path.basename(filePath, '.jsonl'),
    provider: 'claude',
    cwd: '',
    timestamp: fallbackTimestamp,
    preview: '',
  };

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!record.cwd && typeof entry.cwd === 'string' && entry.cwd.trim()) {
        record.cwd = entry.cwd.trim();
      }
      if ((!record.timestamp || record.timestamp === fallbackTimestamp) && typeof entry.timestamp === 'string' && entry.timestamp.trim()) {
        record.timestamp = entry.timestamp.trim();
      }

      const message = entry.message;
      if (!record.preview && message && message.role === 'user') {
        record.preview = firstMeaningfulText(message.content);
      }

      if (record.cwd && record.preview) {
        break;
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  if (!record.preview) {
    record.preview = path.basename(record.cwd || filePath);
  }

  return record;
}

function parseCodexSessionFile(filePath) {
  const lines = readJsonl(filePath);
  const fallbackTimestamp = new Date(getFileMtime(filePath)).toISOString();
  const record = {
    id: path.basename(filePath, '.jsonl'),
    provider: 'codex',
    cwd: '',
    timestamp: fallbackTimestamp,
    preview: '',
  };

  for (let index = 0; index < lines.length; index += 1) {
    try {
      const entry = JSON.parse(lines[index]);

      if (entry.type === 'session_meta' && entry.payload && typeof entry.payload === 'object') {
        if (typeof entry.payload.id === 'string' && entry.payload.id.trim()) {
          record.id = entry.payload.id.trim();
        }
        if (!record.cwd && typeof entry.payload.cwd === 'string' && entry.payload.cwd.trim()) {
          record.cwd = entry.payload.cwd.trim();
        }
        if (
          (!record.timestamp || record.timestamp === fallbackTimestamp) &&
          typeof entry.payload.timestamp === 'string' &&
          entry.payload.timestamp.trim()
        ) {
          record.timestamp = entry.payload.timestamp.trim();
        }
        continue;
      }

      if (!record.preview && entry.type === 'response_item' && entry.payload && entry.payload.type === 'message' && entry.payload.role === 'user') {
        record.preview = firstMeaningfulText(entry.payload.content, text => !isCodexSystemText(text));
      }

      if (record.cwd && record.preview) {
        break;
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  if (!record.preview) {
    record.preview = path.basename(record.cwd || filePath);
  }

  return record;
}

function loadRecentSessionRecords(provider, limit = 8) {
  const normalizedLimit = Math.max(1, Math.min(20, Number(limit) || 8));
  const sessionFiles = provider === 'claude' ? collectJsonlFiles(CLAUDE_PROJECTS_DIR) : collectJsonlFiles(CODEX_ARCHIVE_DIR);

  const sortedFiles = [...sessionFiles].sort((left, right) => getFileMtime(right) - getFileMtime(left)).slice(0, normalizedLimit * 4);

  const records = [];
  const seen = new Set();
  for (const filePath of sortedFiles) {
    const record = provider === 'claude' ? parseClaudeSessionFile(filePath) : parseCodexSessionFile(filePath);
    if (!record.id || seen.has(record.id)) {
      continue;
    }
    seen.add(record.id);
    records.push(record);
    if (records.length >= normalizedLimit) {
      break;
    }
  }

  return records;
}

function resolveSessionRecord(provider, sessionId) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    return null;
  }

  if (provider === 'claude') {
    const files = collectJsonlFiles(CLAUDE_PROJECTS_DIR);
    for (const filePath of files) {
      if (path.basename(filePath, '.jsonl') !== normalizedSessionId) {
        continue;
      }
      return parseClaudeSessionFile(filePath);
    }
    return null;
  }

  const files = collectJsonlFiles(CODEX_ARCHIVE_DIR);
  for (const filePath of files) {
    if (!path.basename(filePath).includes(normalizedSessionId)) {
      continue;
    }
    const record = parseCodexSessionFile(filePath);
    if (record.id === normalizedSessionId) {
      return record;
    }
  }

  return null;
}

class Bridge {
  constructor(config, provider, providerArgs = [], options = {}) {
    this.config = config;
    this.provider = provider;
    this.providerArgs = providerArgs;
    this.initialSessionId = String(options.initialSessionId || '').trim() || null;
    this.startMode = options.startMode === 'new' ? 'new' : options.startMode === 'resume' ? 'resume' : 'auto';
    this.forceNewNextPrompt = this.startMode === 'new';
    this.logger = new Logger('bridge');
    this.telegram = null;
    this.sleepInhibitorState = null;
    this.running = true;
    this.manualHelpShown = false;
    this.localInputInterface = null;
    this.localInputQueue = Promise.resolve();
    this.promptQueue = Promise.resolve();
    this.activePromptAbortController = null;
    this.activePromptSource = null;
    this.activePromptAbortReason = null;
    this.telegramPendingMessages = [];
    this.telegramDispatchScheduled = false;
    this.sessionChoices = {
      claude: [],
      codex: [],
    };

    this.onSignal = () => {
      this.requestStopCurrentPrompt('shutdown');
      this.clearQueuedTelegramMessages();
      this.running = false;
      this.stopLocalInputLoop();
      console.log('\nStopping HeyAgent...');
    };
  }

  async start() {
    process.on('SIGINT', this.onSignal);
    process.on('SIGTERM', this.onSignal);

    try {
      this.sleepInhibitorState = startSleepInhibitor({ logger: this.logger });

      if (this.sleepInhibitorState.active) {
        console.log(`Sleep prevention active (${this.sleepInhibitorState.backend}).`);
      } else {
        console.log(`Sleep prevention unavailable: ${this.sleepInhibitorState.reason || 'unknown error'}.`);
      }

      await mkdir(ATTACHMENT_DOWNLOAD_DIR, { recursive: true });

      const pairing = await this.ensureBridgeReady();
      this.config.setMany({
        provider: this.provider,
        telegramChatId: pairing.chatId,
      });
      if (this.initialSessionId) {
        this.setBoundSessionId(this.initialSessionId);
        this.forceNewNextPrompt = false;
      } else {
        this.setBoundSessionId(null);
      }

      console.log(`Connected to Telegram chat ${pairing.chatId}.`);
      console.log(`HeyAgent is running in ${this.provider} mode. Send /help in Telegram.\n`);

      const providerLabel = formatProviderName(this.provider);
      const startupHeadline =
        this.startMode === 'new'
          ? `HeyAgent connected. Next message starts a new ${providerLabel} session.`
          : this.initialSessionId
            ? `HeyAgent connected to ${providerLabel} session ${this.initialSessionId}.`
            : `HeyAgent connected to your last ${providerLabel} session for the current folder: ${process.cwd()}`;

      await this.safeSendMessage([startupHeadline, 'Send /help for available commands.', DICTATION_HINT_TEXT].join('\n\n'));

      this.startLocalInputLoop();

      while (this.running) {
        await this.pollOnce();
      }
    } finally {
      this.stopLocalInputLoop();
      if (this.sleepInhibitorState && typeof this.sleepInhibitorState.stop === 'function') {
        await this.sleepInhibitorState.stop();
      }
      process.off('SIGINT', this.onSignal);
      process.off('SIGTERM', this.onSignal);
    }
  }

  writeCliLine(line) {
    const message = String(line || '');
    if (this.localInputInterface) {
      output.write(`\n${message}\n`);
      if (this.running) {
        this.localInputInterface.prompt();
      }
      return;
    }

    console.log(message);
  }

  logCliEvent(label, text = '') {
    const timestamp = new Date().toLocaleTimeString();
    const suffix = text ? `: ${toLogPreview(text)}` : '';
    this.writeCliLine(`[${timestamp}] ${label}${suffix}`);
  }

  getBoundSessionId() {
    return getCurrentSessionId(this.config, this.provider);
  }

  getBoundSessionIdForProvider(provider) {
    return getCurrentSessionId(this.config, provider);
  }

  setBoundSessionId(sessionId) {
    const normalized = String(sessionId || '').trim() || null;
    if (this.provider === 'codex') {
      this.config.set('codexLastSessionId', normalized);
      return;
    }
    if (this.provider === 'claude') {
      this.config.set('claudeLastSessionId', normalized);
    }
  }

  setBoundSessionIdForProvider(provider, sessionId) {
    const normalized = String(sessionId || '').trim() || null;
    if (provider === 'codex') {
      this.config.set('codexLastSessionId', normalized);
      return;
    }
    if (provider === 'claude') {
      this.config.set('claudeLastSessionId', normalized);
    }
  }

  switchProvider(provider) {
    if (provider !== 'claude' && provider !== 'codex') {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    const rawArgs = provider === 'claude' ? this.config.claudeArgs : this.config.codexArgs;
    const effective = applyDefaultBypassArgs(provider, rawArgs);

    this.provider = provider;
    this.providerArgs = effective.providerArgs;
    this.config.setMany({
      provider,
      claudeArgs: provider === 'claude' ? effective.providerArgs : this.config.claudeArgs,
      codexArgs: provider === 'codex' ? effective.providerArgs : this.config.codexArgs,
    });

    return effective;
  }

  async handleProviderSwitchCommand(provider, rawArgs = '', source = 'telegram') {
    const sourceLabel = source === 'cli' ? 'CLI' : 'Telegram';
    const selectedSessionId = String(rawArgs || '').trim() || null;
    const effective = this.switchProvider(provider);
    if (selectedSessionId) {
      this.setBoundSessionIdForProvider(provider, selectedSessionId);
      this.forceNewNextPrompt = false;
    }
    const sessionId = this.getBoundSessionId() || '-';
    const sessionRecord = selectedSessionId ? resolveSessionRecord(provider, sessionId) : null;
    const argsText = effective.providerArgs.length > 0 ? effective.providerArgs.join(' ') : '(none)';

    this.logCliEvent(`${sourceLabel} provider switch`, selectedSessionId ? `${provider} (${selectedSessionId})` : provider);

    await this.safeSendMessage(
      [
        `Provider switched to ${provider}.`,
        `Session: ${sessionId}`,
        sessionRecord?.cwd ? `Session directory: ${sessionRecord.cwd}` : null,
        `Args: ${argsText}`,
        selectedSessionId ? 'Explicit session binding updated.' : null,
        selectedSessionId && !sessionRecord ? 'Session metadata not found locally. Direct resume will still be attempted.' : null,
        effective.defaultBypassApplied ? 'Default bypass mode applied.' : null,
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  buildRuntimeStatusText() {
    const lines = [buildStatusText(this.config, this.provider, this.providerArgs, this.sleepInhibitorState)];
    const sessionRecord = resolveSessionRecord(this.provider, this.getBoundSessionId());
    if (sessionRecord?.cwd) {
      lines.push(`Session directory: ${sessionRecord.cwd}`);
    }
    return lines.join('\n');
  }

  parseSessionListArguments(rawArgs = '') {
    const parts = splitArgs(rawArgs);
    let provider = this.provider;
    let limit = 8;

    if (parts[0] === 'claude' || parts[0] === 'codex') {
      provider = parts.shift();
    }

    if (parts[0]) {
      const parsed = Number.parseInt(parts[0], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
    }

    return { provider, limit };
  }

  formatSessionListText(provider, sessions) {
    const lines = [`Recent ${formatProviderName(provider)} sessions:`];

    if (sessions.length === 0) {
      lines.push('No local sessions found.');
      return lines.join('\n');
    }

    for (const [index, session] of sessions.entries()) {
      lines.push(`${index + 1}. ${shortenSessionId(session.id)} | ${formatSessionTimestamp(session.timestamp)}`);
      if (session.cwd) {
        lines.push(`Dir: ${session.cwd}`);
      }
      if (session.preview) {
        lines.push(`Summary: ${truncateSessionPreview(session.preview, 120)}`);
      }
      lines.push(`Bind: /${provider} ${session.id}`);
      lines.push('');
    }

    lines.push(
      provider === this.provider ? 'Use /use <n> to bind one of the sessions above.' : `Use /use ${provider} <n> to bind one of the sessions above.`
    );
    return lines.join('\n').trim();
  }

  async handleSessionsCommand(rawArgs = '', source = 'telegram') {
    const { provider, limit } = this.parseSessionListArguments(rawArgs);
    const sessions = loadRecentSessionRecords(provider, limit);
    this.sessionChoices[provider] = sessions;
    this.logCliEvent(source === 'cli' ? 'CLI sessions list' : 'Telegram sessions list', `${provider} (${sessions.length})`);

    const text = this.formatSessionListText(provider, sessions);
    if (source === 'cli') {
      this.writeCliLine(text);
      return;
    }

    await this.safeSendMessage(text);
  }

  parseUseArguments(rawArgs = '') {
    const parts = splitArgs(rawArgs);
    if (parts.length === 0) {
      return { provider: this.provider, index: null };
    }

    let provider = this.provider;
    let indexToken = parts[0];

    if (parts[0] === 'claude' || parts[0] === 'codex') {
      provider = parts[0];
      indexToken = parts[1];
    }

    const index = Number.parseInt(indexToken, 10);
    return {
      provider,
      index: Number.isFinite(index) && index > 0 ? index : null,
    };
  }

  async handleUseCommand(rawArgs = '', source = 'telegram') {
    const sourceLabel = source === 'cli' ? 'CLI' : 'Telegram';
    const { provider, index } = this.parseUseArguments(rawArgs);

    if (!index) {
      const usage = 'Usage: /use <n> or /use <provider> <n>. Run /sessions first.';
      if (source === 'cli') {
        this.writeCliLine(usage);
      } else {
        await this.safeSendMessage(usage);
      }
      return;
    }

    const choices = Array.isArray(this.sessionChoices[provider]) ? this.sessionChoices[provider] : [];
    if (choices.length === 0) {
      const message = `No cached ${provider} session list. Run /sessions ${provider} first.`;
      if (source === 'cli') {
        this.writeCliLine(message);
      } else {
        await this.safeSendMessage(message);
      }
      return;
    }

    const session = choices[index - 1];
    if (!session) {
      const message = `Session index ${index} is out of range for ${provider}.`;
      if (source === 'cli') {
        this.writeCliLine(message);
      } else {
        await this.safeSendMessage(message);
      }
      return;
    }

    const effective = this.switchProvider(provider);
    this.setBoundSessionIdForProvider(provider, session.id);
    this.forceNewNextPrompt = false;
    this.logCliEvent(`${sourceLabel} session bind`, `${provider} #${index} (${session.id})`);

    const text = [
      `Provider switched to ${provider}.`,
      `Session: ${session.id}`,
      session.cwd ? `Session directory: ${session.cwd}` : null,
      session.preview ? `Summary: ${truncateSessionPreview(session.preview, 120)}` : null,
      `Args: ${effective.providerArgs.length > 0 ? effective.providerArgs.join(' ') : '(none)'}`,
      'Explicit session binding updated.',
    ]
      .filter(Boolean)
      .join('\n');

    if (source === 'cli') {
      this.writeCliLine(text);
      return;
    }

    await this.safeSendMessage(text);
  }

  startLocalInputLoop() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return;
    }

    if (this.localInputInterface) {
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 1000,
    });

    this.localInputInterface = rl;
    this.writeCliLine('Local CLI input enabled. Type /help for local commands, or type a prompt directly.');
    rl.setPrompt('hey> ');
    rl.prompt();

    rl.on('line', line => {
      const value = String(line || '').trim();
      this.localInputQueue = this.localInputQueue
        .then(() => this.handleLocalInputLine(value))
        .catch(error => {
          this.logCliEvent('Local input error', error.message || String(error));
        })
        .finally(() => {
          if (this.running && this.localInputInterface) {
            this.localInputInterface.prompt();
          }
        });
    });

    rl.on('close', () => {
      this.localInputInterface = null;
    });
  }

  stopLocalInputLoop() {
    if (!this.localInputInterface) {
      return;
    }

    try {
      this.localInputInterface.close();
    } catch {
      // Ignore close failures.
    }

    this.localInputInterface = null;
  }

  async handleLocalInputLine(inputLine) {
    if (!this.running) {
      return;
    }

    const line = String(inputLine || '').trim();
    if (!line) {
      return;
    }

    if (line === '/help') {
      this.writeCliLine(
        [
          'Local CLI commands:',
          '/help - show this list',
          '/status - show current status',
          '/new - reset session (next prompt starts fresh)',
          '/stop - stop current execution and clear queued Telegram messages',
          '/claude [session-id] - switch to Claude, optionally bind a specific session',
          '/codex [session-id] - switch to Codex, optionally bind a specific session',
          '/sessions [provider] [count] - list recent local sessions',
          '/use <n> or /use <provider> <n> - bind a listed session',
          '/say <text> - send a raw message to Telegram',
          '/ask <prompt> - run prompt through provider and send response to Telegram',
          '/exit - stop HeyAgent',
          '',
          'Any plain text line is treated as /ask <line>.',
        ].join('\n')
      );
      return;
    }

    if (line === '/status') {
      this.writeCliLine(this.buildRuntimeStatusText());
      return;
    }

    if (line === '/new') {
      this.resetSessionMode();
      await this.safeSendMessage('Session reset from CLI. Your next message starts fresh.');
      return;
    }

    if (line === '/stop') {
      const stopped = this.requestStopCurrentPrompt('manual_stop');
      const clearedCount = this.clearQueuedTelegramMessages();

      if (stopped) {
        await this.safeSendMessage(`Stopping current ${formatProviderName(this.provider)} request and clearing queued messages...`, { from: 'CLI' });
      } else if (clearedCount > 0) {
        await this.safeSendMessage(`Cleared ${clearedCount} queued Telegram message${clearedCount === 1 ? '' : 's'}.`, { from: 'CLI' });
      } else {
        this.writeCliLine('No active request to stop.');
      }
      return;
    }

    if (line === '/sessions' || line.startsWith('/sessions ')) {
      const argument = line.slice('/sessions'.length).trim();
      await this.handleSessionsCommand(argument, 'cli');
      return;
    }

    if (line === '/use' || line.startsWith('/use ')) {
      const argument = line.slice('/use'.length).trim();
      await this.handleUseCommand(argument, 'cli');
      return;
    }

    if (line === '/claude' || line.startsWith('/claude ')) {
      const argument = line.slice('/claude'.length).trim();
      await this.handleProviderSwitchCommand('claude', argument, 'cli');
      return;
    }

    if (line === '/codex' || line.startsWith('/codex ')) {
      const argument = line.slice('/codex'.length).trim();
      await this.handleProviderSwitchCommand('codex', argument, 'cli');
      return;
    }

    if (line === '/exit') {
      this.running = false;
      this.writeCliLine('Stopping HeyAgent...');
      this.stopLocalInputLoop();
      return;
    }

    if (line.startsWith('/say ')) {
      const message = line.slice(5).trim();
      if (!message) {
        this.writeCliLine('Usage: /say <text>');
        return;
      }
      await this.safeSendMessage(message, { from: 'CLI' });
      return;
    }

    if (line.startsWith('/ask ')) {
      const prompt = line.slice(5).trim();
      if (!prompt) {
        this.writeCliLine('Usage: /ask <prompt>');
        return;
      }
      await this.queuePrompt(prompt, 'cli');
      return;
    }

    if (line.startsWith('/')) {
      this.writeCliLine('Unknown local command. Use /help.');
      return;
    }

    await this.queuePrompt(line, 'cli');
  }

  async ensureBridgeReady() {
    const storedToken = String(this.config.telegramBotToken || '').trim();
    let tokenConnected = false;

    if (storedToken) {
      tokenConnected = await this.connectToken(storedToken);
    }

    if (!tokenConnected) {
      this.config.clearPairing({ keepBotToken: false });
    }

    const needToken = !tokenConnected;
    const needPairing = !this.config.telegramChatId;

    if (!needToken && !needPairing) {
      return {
        chatId: this.config.telegramChatId,
      };
    }

    const setupMode = await this.selectSetupMode();
    if (setupMode === SETUP_MODE_PHONE) {
      return this.runPhoneOnboardingSetup({ needToken, needPairing });
    }

    return this.runManualSetup({ needToken, needPairing });
  }

  async selectSetupMode() {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      return select({
        message: 'Telegram setup mode',
        default: SETUP_MODE_PHONE,
        choices: [
          {
            name: 'Phone setup (recommended) — scan one QR code and complete guided steps on your phone',
            value: SETUP_MODE_PHONE,
          },
          {
            name: 'Manual fallback — no tunnel required; paste the bot token directly into the terminal',
            value: SETUP_MODE_MANUAL,
          },
        ],
      });
    }

    console.log('Interactive setup selection is unavailable in this terminal.');
    console.log('Using manual fallback setup (no tunnel).');
    return SETUP_MODE_MANUAL;
  }

  async runPhoneOnboardingSetup(options = {}) {
    const needToken = Boolean(options.needToken);
    const needPairing = Boolean(options.needPairing);
    let onboarding = null;

    try {
      onboarding = await createOnboardingSession({
        timeoutMs: 20 * 60 * 1000,
        onReady: url => {
          console.log('\nPhone setup (recommended).');
          console.log('Scan this QR code and complete the guided steps on your phone:\n');
          qrcode.generate(url, { small: true });
          console.log(`Link: ${url}\n`);
          console.log('Waiting for onboarding completion...');
        },
      });

      if (needToken) {
        while (this.running) {
          const token = await onboarding.waitForToken();
          const connected = await this.connectToken(token);
          if (connected) {
            onboarding.setTokenValidated({
              botUsername: this.config.telegramBotUsername,
            });
            break;
          }

          onboarding.setTokenInvalid('Telegram rejected this token. Check token and submit again.');
        }
      } else {
        onboarding.setTokenValidated({
          botUsername: this.config.telegramBotUsername,
          preconfigured: true,
        });
      }

      if (!this.running) {
        throw new Error('Setup cancelled');
      }

      let pairing = {
        chatId: this.config.telegramChatId,
      };

      if (needPairing) {
        pairing = await this.runPairingFlow({
          mode: 'onboarding',
          onPairLink: deepLink => onboarding.setPairLink(deepLink),
          onStatus: text => onboarding.setPairingStatus(text),
        });
      } else {
        onboarding.setPairingStatus('Chat already paired on this device.');
      }

      onboarding.markPaired({ chatId: pairing.chatId });
      await sleep(1500);
      return pairing;
    } catch (error) {
      if (onboarding) {
        onboarding.setError(error.message);
      }
      throw error;
    } finally {
      if (onboarding) {
        await onboarding.close();
      }
    }
  }

  async runManualSetup(options = {}) {
    const needToken = Boolean(options.needToken);
    const needPairing = Boolean(options.needPairing);

    if (needToken) {
      while (this.running) {
        if (!this.manualHelpShown) {
          printManualTokenSetupHelp();
          this.manualHelpShown = true;
        }

        const token = await promptLine('Telegram bot token: ');
        if (!token) {
          console.log('Token is required.');
          continue;
        }

        const connected = await this.connectToken(token.trim());
        if (connected) {
          break;
        }
      }
    }

    if (!this.running) {
      throw new Error('Setup cancelled');
    }

    if (needPairing) {
      return this.runPairingFlow({ mode: 'manual' });
    }

    return {
      chatId: this.config.telegramChatId,
    };
  }

  async connectToken(token) {
    const normalizedToken = String(token || '').trim();
    if (!TelegramApi.isLikelyToken(normalizedToken)) {
      console.error('This does not look like a valid Telegram bot token.');
      return false;
    }

    const previousToken = this.config.telegramBotToken;
    const telegram = new TelegramApi(normalizedToken);

    try {
      await telegram.ensurePollingMode();
      const me = await telegram.getMe();

      this.telegram = telegram;

      const tokenChanged = previousToken !== normalizedToken;
      this.config.setMany({
        telegramBotToken: normalizedToken,
        telegramBotUsername: me.username || null,
        telegramBotId: me.id === undefined || me.id === null ? null : String(me.id),
      });

      if (tokenChanged) {
        this.config.clearPairing();
      }

      return true;
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 401) {
        console.error('Telegram rejected the token (401 Unauthorized).');
      } else {
        console.error(`Token validation failed: ${error.message}`);
      }
      return false;
    }
  }

  resetSessionMode() {
    const updates = {};

    if (this.provider === 'codex') {
      updates.codexLastSessionId = null;
    }
    if (this.provider === 'claude') {
      updates.claudeLastSessionId = null;
    }

    this.forceNewNextPrompt = true;
    this.config.setMany(updates);
  }

  clearQueuedTelegramMessages() {
    const count = this.telegramPendingMessages.length;
    this.telegramPendingMessages = [];
    return count;
  }

  requestStopCurrentPrompt(reason = 'manual_stop') {
    const controller = this.activePromptAbortController;
    if (!controller || controller.signal.aborted) {
      return false;
    }

    this.activePromptAbortReason = reason;
    controller.abort();
    return true;
  }

  isPromptAbortError(error) {
    const message = error?.message ? String(error.message) : String(error || '');
    return /aborted/i.test(message);
  }

  startTelegramDispatch(groupAll = false) {
    if (!this.running) {
      return;
    }

    if (this.telegramDispatchScheduled) {
      return;
    }

    if (this.activePromptAbortController) {
      return;
    }

    if (this.telegramPendingMessages.length === 0) {
      return;
    }

    const pending = groupAll ? this.telegramPendingMessages.splice(0) : [this.telegramPendingMessages.shift()];
    const combinedPrompt = pending.join('\n').trim();
    if (!combinedPrompt) {
      return;
    }

    this.telegramDispatchScheduled = true;
    this.queuePrompt(combinedPrompt, 'telegram', {
      groupedCount: pending.length,
    })
      .catch(error => {
        this.logger.error(`Failed to process grouped Telegram messages: ${error.message}`);
      })
      .finally(() => {
        this.telegramDispatchScheduled = false;
        if (this.telegramPendingMessages.length > 0) {
          this.startTelegramDispatch(true);
        }
      });
  }

  async enqueueTelegramPrompt(text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) {
      return;
    }

    this.telegramPendingMessages.push(cleanText);

    if (this.activePromptAbortController || this.telegramDispatchScheduled) {
      return;
    }

    this.startTelegramDispatch(false);
  }

  async queuePrompt(prompt, source, options = {}) {
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) {
      return;
    }

    const run = async () => {
      const sourceLabel = source === 'cli' ? 'CLI' : 'Telegram';
      const providerLabel = formatProviderName(this.provider);
      const resume = !this.forceNewNextPrompt;
      const abortController = new globalThis.AbortController();
      const groupedCount = Number.isFinite(options.groupedCount) ? Math.max(1, Number(options.groupedCount)) : 1;
      this.logCliEvent(`${sourceLabel} -> ${providerLabel}`, cleanPrompt);
      this.activePromptAbortController = abortController;
      this.activePromptSource = source;
      this.activePromptAbortReason = null;

      try {
        if (source === 'telegram') {
          if (groupedCount > 1) {
            await this.safeSendMessage(`${providerLabel} is working on ${groupedCount} messages...`);
          } else {
            await this.safeSendMessage(`${providerLabel} is working...`);
          }
        }

        const response = await this.runProvider(cleanPrompt, resume, {
          abortSignal: abortController.signal,
        });

        this.forceNewNextPrompt = false;
        await this.safeSendMessage(response, { from: providerLabel });
      } catch (error) {
        if (abortController.signal.aborted || this.isPromptAbortError(error)) {
          return;
        }

        await this.safeSendMessage(`Error: ${error.message}`);
        this.logger.error(`Provider execution failed: ${error.message}`);
      } finally {
        if (this.activePromptAbortController === abortController) {
          this.activePromptAbortController = null;
          this.activePromptSource = null;
          this.activePromptAbortReason = null;
        }

        if (this.telegramPendingMessages.length > 0 && !this.telegramDispatchScheduled) {
          this.startTelegramDispatch(true);
        }
      }
    };

    this.promptQueue = this.promptQueue.then(run, run);
    await this.promptQueue;
  }

  async runPairingFlow(options = {}) {
    const mode = options.mode || 'manual';
    const onPairLink = typeof options.onPairLink === 'function' ? options.onPairLink : null;
    const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;

    const botUsername = this.config.telegramBotUsername;
    if (!botUsername) {
      throw new Error('Telegram bot username is unavailable. Create a bot with @BotFather first.');
    }

    const code = makePairCode();
    const deepLink = `https://t.me/${botUsername}?start=ha2_${code}`;

    if (mode === 'manual') {
      console.log('\nTelegram pairing is required (manual fallback).');
      console.log('1. Scan this QR code or open the link');
      console.log('2. Press START in Telegram');
      console.log('3. Keep this terminal open until pairing completes\n');
      qrcode.generate(deepLink, { small: true });
      console.log(`Link: ${deepLink}`);
      console.log('If needed, open your bot manually and press START.\n');
      console.log('Waiting for Telegram pairing...');
    } else {
      if (onPairLink) {
        onPairLink(deepLink);
      }
      if (onStatus) {
        onStatus('Open bot chat and press START. Waiting for Telegram pairing...');
      }
      console.log('\nWaiting for Telegram pairing from phone onboarding...');
    }

    let cursor = this.config.telegramUpdateCursor || 0;

    while (this.running) {
      try {
        const result = await this.telegram.getUpdates(cursor, 20);
        const nextCursor = Number.isFinite(result.nextCursor) ? result.nextCursor : cursor;
        if (nextCursor > cursor) {
          cursor = nextCursor;
          this.config.set('telegramUpdateCursor', cursor);
        }

        for (const message of result.messages) {
          if (message.chatType !== 'private') {
            continue;
          }

          if (!isPairStartMessage(message.text, code)) {
            continue;
          }

          if (!message.chatId) {
            continue;
          }

          this.config.setMany({
            telegramChatId: message.chatId,
            telegramChatUserId: message.userId || null,
          });

          if (onStatus) {
            onStatus(`Paired successfully (chat ${message.chatId}).`);
          }

          await this.telegram.sendMessage(message.chatId, `HeyAgent paired for ${this.provider}.\nSend /help for commands.`);

          return {
            chatId: message.chatId,
          };
        }
      } catch (error) {
        if (error instanceof TelegramApiError && error.status === 401) {
          this.config.clearPairing({ keepBotToken: false });
          if (onStatus) {
            onStatus('Telegram token became invalid. Restart setup.');
          }
          throw new Error('Telegram bot token is invalid. Restart and enter a new token.');
        }

        this.logger.warn(`Pair poll failed: ${error.message}`);
        await sleep(2000);
      }
    }

    throw new Error('Pairing cancelled');
  }

  async pollOnce() {
    const chatId = this.config.telegramChatId;
    const chatUserId = this.config.telegramChatUserId;
    const cursor = this.config.telegramUpdateCursor || 0;

    if (!chatId) {
      throw new Error('No Telegram chat is paired. Run `hey reset` then start again.');
    }

    try {
      const result = await this.telegram.getUpdates(cursor, 20);
      const nextCursor = Number.isFinite(result.nextCursor) ? result.nextCursor : cursor;
      if (nextCursor > cursor) {
        this.config.set('telegramUpdateCursor', nextCursor);
      }

      for (const message of result.messages) {
        if (!this.running) {
          break;
        }

        if (message.chatId !== chatId) {
          continue;
        }

        if (chatUserId && message.userId && message.userId !== chatUserId) {
          continue;
        }

        if (message.text && message.text.trim().startsWith('/')) {
          this.logCliEvent('Telegram command', message.text);
        }

        if (message.fileId) {
          await this.handleAttachmentMessage(message);
          continue;
        }

        await this.handleMessage(message.text || '');
      }
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 401) {
        this.config.clearPairing({ keepBotToken: false });
        this.running = false;
        throw new Error('Telegram bot token is invalid. Restart and enter a new token.');
      }

      this.logger.error(`Inbox poll failed: ${error.message}`);
      await sleep(2000);
    }
  }

  async handleMessage(rawText) {
    const text = String(rawText || '').trim();
    if (!text) {
      return;
    }

    if (text.startsWith('/')) {
      await this.handleCommand(text);
      return;
    }

    await this.enqueueTelegramPrompt(text);
  }

  isAudioAttachment(type) {
    return type === 'voice' || type === 'audio';
  }

  buildAttachmentPrompt(message, filePath) {
    const lines = [`The user sent a Telegram ${message.type || 'file'} attachment.`, `Local file path: ${filePath}`];

    if (message.fileName) {
      lines.push(`Original filename: ${message.fileName}`);
    }
    if (message.mimeType) {
      lines.push(`MIME type: ${message.mimeType}`);
    }
    if (Number.isFinite(message.fileSizeBytes) && message.fileSizeBytes > 0) {
      lines.push(`File size bytes: ${message.fileSizeBytes}`);
    }
    if (Number.isFinite(message.durationSec) && message.durationSec > 0) {
      lines.push(`Duration seconds: ${message.durationSec}`);
    }

    const userText = String(message.caption || message.text || '').trim();
    lines.push('');
    if (userText) {
      lines.push(`User message: ${userText}`);
    } else {
      lines.push('User message: (none)');
    }
    lines.push('Please inspect the file and respond to the user.');

    return lines.join('\n');
  }

  async handleAttachmentMessage(message) {
    const fileId = String(message.fileId || '').trim();
    if (!fileId) {
      return;
    }

    const durationText = Number.isFinite(message.durationSec) ? ` (${message.durationSec}s)` : '';
    this.logCliEvent(`Telegram -> ${message.type || 'Attachment'}`, `received${durationText}`);
    await this.safeSendMessage('Attachment received.');

    if (this.isAudioAttachment(message.type)) {
      await this.safeSendMessage(DICTATION_HINT_TEXT);
    }

    try {
      const downloadedPath = await this.telegram.downloadFile(fileId, ATTACHMENT_DOWNLOAD_DIR);
      const prompt = this.buildAttachmentPrompt(message, downloadedPath);
      await this.enqueueTelegramPrompt(prompt);
    } catch (error) {
      const messageText = error?.message ? String(error.message) : String(error);
      this.logger.error(`Attachment handling failed: ${messageText}`);
      await this.safeSendMessage(`Failed to handle attachment: ${messageText}`);
    }
  }

  async handleCommand(text) {
    const parts = String(text || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const command = String(parts[0] || '').toLowerCase();
    const argument = parts.slice(1).join(' ').trim();

    if (command === '/help') {
      await this.safeSendMessage(
        [
          'HeyAgent commands:',
          '/help - show command list',
          '/new - start a fresh session',
          '/stop - stop current execution and clear queued messages',
          '/claude [session-id] - switch to Claude, optionally bind a specific session',
          '/codex [session-id] - switch to Codex, optionally bind a specific session',
          '/sessions [provider] [count] - list recent local sessions',
          '/use <n> or /use <provider> <n> - bind a listed session',
          '/status - show current status',
          '',
          `Send any normal message to talk to ${this.provider}.`,
          DICTATION_HINT_TEXT,
        ].join('\n')
      );
      return;
    }

    if (command === '/new') {
      this.resetSessionMode();
      await this.safeSendMessage('Session reset. Your next message starts fresh.');
      return;
    }

    if (command === '/claude') {
      await this.handleProviderSwitchCommand('claude', argument, 'telegram');
      return;
    }

    if (command === '/codex') {
      await this.handleProviderSwitchCommand('codex', argument, 'telegram');
      return;
    }

    if (command === '/status') {
      await this.safeSendMessage(this.buildRuntimeStatusText());
      return;
    }

    if (command === '/sessions') {
      await this.handleSessionsCommand(argument, 'telegram');
      return;
    }

    if (command === '/use') {
      await this.handleUseCommand(argument, 'telegram');
      return;
    }

    if (command === '/stop') {
      const stopped = this.requestStopCurrentPrompt('manual_stop');
      const clearedCount = this.clearQueuedTelegramMessages();

      if (stopped) {
        await this.safeSendMessage(`Stopping current ${formatProviderName(this.provider)} request and clearing queued messages...`);
      } else if (clearedCount > 0) {
        await this.safeSendMessage(`Cleared ${clearedCount} queued message${clearedCount === 1 ? '' : 's'}.`);
      } else {
        await this.safeSendMessage('No active request to stop.');
      }
      return;
    }

    await this.safeSendMessage('Unknown command. Use /help.');
  }

  async runProvider(prompt, resume, options = {}) {
    const abortSignal = options.abortSignal || null;

    if (this.provider === 'claude') {
      const sessionId = this.config.claudeLastSessionId;
      const sessionRecord = resolveSessionRecord('claude', sessionId);
      return runClaudePrompt(prompt, {
        resume,
        extraArgs: this.providerArgs,
        cwd: sessionRecord?.cwd || process.cwd(),
        abortSignal,
        sessionId,
        onSessionId: sessionId => {
          this.setBoundSessionId(sessionId);
        },
      });
    }

    if (this.provider === 'codex') {
      const sessionId = this.config.codexLastSessionId;
      const sessionRecord = resolveSessionRecord('codex', sessionId);
      return runCodexPrompt(prompt, {
        resume,
        extraArgs: this.providerArgs,
        cwd: sessionRecord?.cwd || process.cwd(),
        abortSignal,
        sessionId,
        onSessionId: sessionId => {
          this.setBoundSessionId(sessionId);
        },
      });
    }

    throw new Error(`Unsupported provider: ${this.provider}`);
  }

  async safeSendMessage(text, options = {}) {
    const chatId = this.config.telegramChatId;
    const from = String(options.from || 'HeyAgent').trim() || 'HeyAgent';

    if (!chatId) {
      return;
    }

    this.logCliEvent(`${from} -> Telegram`, text);

    try {
      await this.telegram.sendMessage(chatId, text);
    } catch (error) {
      this.logger.error(`Outbox send failed: ${error.message}`);

      if (error instanceof TelegramApiError && error.status === 401) {
        this.config.clearPairing({ keepBotToken: false });
        this.running = false;
        console.error('Telegram bot token is invalid. Restart and enter a new token.');
      }
    }
  }
}

export default Bridge;
