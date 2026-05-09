import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
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
import { createVoiceTranscriber, formatVoiceTranscriberStatus } from './voice-transcriber.js';
import { createKokoroTts, formatKokoroTtsStatus } from './kokoro-tts.js';

const BOTFATHER_URL = 'https://t.me/BotFather';
const SETUP_MODE_PHONE = 'phone_onboarding';
const SETUP_MODE_MANUAL = 'manual_fallback';
const ATTACHMENT_DOWNLOAD_DIR = path.join(os.tmpdir(), 'heyagent-files');
const DICTATION_HINT_TEXT = 'Hint: use /call on for push-to-talk voice chat, /transcription on for transcript mode, or phone keyboard dictation.';
const TTS_CALLBACK_PREFIX = 'tts:';
const MAX_TTS_RESPONSE_CACHE_SIZE = 30;
const TELEGRAM_PROGRESS_FLUSH_MS = 1600;
const TELEGRAM_PROGRESS_MAX_CHARS = 3200;

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
  const chat = config.getAgentChat ? config.getAgentChat(config.activeAgentChatId) : null;
  if (provider === 'codex') {
    if (chat?.codexLastSessionId) {
      return chat.codexLastSessionId;
    }
    if (chat && chat.id !== 'default') {
      return null;
    }
    return config.codexLastSessionId || null;
  }
  if (provider === 'claude') {
    if (chat?.claudeLastSessionId) {
      return chat.claudeLastSessionId;
    }
    if (chat && chat.id !== 'default') {
      return null;
    }
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

function normalizeAgentChatId(name) {
  const normalized = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'default';
}

function getOptionValue(args = [], names = []) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (names.includes(arg)) {
      return String(args[index + 1] || '').trim();
    }

    for (const name of names) {
      const prefix = `${name}=`;
      if (arg.startsWith(prefix)) {
        return arg.slice(prefix.length).trim();
      }
    }
  }

  return '';
}

function setOptionValue(args = [], names = [], value = '', preferredName = names[0]) {
  const nextArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (names.includes(arg)) {
      index += 1;
      continue;
    }

    if (names.some(name => arg.startsWith(`${name}=`))) {
      continue;
    }

    nextArgs.push(arg);
  }

  const normalizedValue = String(value || '').trim();
  if (normalizedValue) {
    nextArgs.push(preferredName, normalizedValue);
  }

  return nextArgs;
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

function buildStatusText(config, provider, providerArgs = [], sleepInhibitorState = null, voiceTranscriber = null, kokoroTts = null) {
  const bot = config.telegramBotUsername ? `@${config.telegramBotUsername}` : 'not set';
  const sessionId = getCurrentSessionId(config, provider);
  const activeChat = config.getAgentChat ? config.getAgentChat(config.activeAgentChatId) : null;
  const activeDirectory = activeChat?.cwd || process.cwd();
  const argsText = Array.isArray(providerArgs) && providerArgs.length > 0 ? providerArgs.join(' ') : '(none)';
  const sleepStatus = formatSleepInhibitorStatus(sleepInhibitorState);
  const transcriptionStatus = config.voiceTranscriptionEnabled ? 'on' : 'off';
  const callModeStatus = config.callModeEnabled ? 'on' : 'off';
  return [
    `Provider: ${provider}`,
    `Chat context: ${activeChat?.name || 'default'}`,
    `Args: ${argsText}`,
    `Sleep prevention: ${sleepStatus}`,
    `Call mode: ${callModeStatus}`,
    `Voice transcription: ${transcriptionStatus}, ${formatVoiceTranscriberStatus(voiceTranscriber)}`,
    `Kokoro TTS: ${formatKokoroTtsStatus(kokoroTts)}`,
    `Directory: ${activeDirectory}`,
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

function formatTelegramProgressText(providerLabel, text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    return `${providerLabel} is responding...`;
  }

  const tail =
    cleanText.length <= TELEGRAM_PROGRESS_MAX_CHARS
      ? cleanText
      : cleanText.slice(cleanText.length - TELEGRAM_PROGRESS_MAX_CHARS).replace(/^\S*\s*/, '');
  return `${providerLabel} is responding...\n\n${tail}`;
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
    this.voiceTranscriber = null;
    this.kokoroTts = null;
    this.ttsResponseCache = new Map();

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
      this.voiceTranscriber = await createVoiceTranscriber();
      this.kokoroTts = await createKokoroTts();

      if (this.sleepInhibitorState.active) {
        console.log(`Sleep prevention active (${this.sleepInhibitorState.backend}).`);
      } else {
        console.log(`Sleep prevention unavailable: ${this.sleepInhibitorState.reason || 'unknown error'}.`);
      }
      console.log(`Voice transcription: ${formatVoiceTranscriberStatus(this.voiceTranscriber)}.`);
      console.log(`Kokoro TTS: ${formatKokoroTtsStatus(this.kokoroTts)}.`);

      await mkdir(ATTACHMENT_DOWNLOAD_DIR, { recursive: true });

      const pairing = await this.ensureBridgeReady();
      this.config.setMany({
        provider: this.provider,
        telegramChatId: pairing.chatId,
      });
      if (this.initialSessionId) {
        this.setBoundSessionId(this.initialSessionId);
        this.forceNewNextPrompt = false;
      } else if (this.startMode === 'new') {
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
            : `HeyAgent connected to your last ${providerLabel} session for: ${this.getActiveCwd()}`;

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

  getActiveCwd() {
    const chat = this.config.getAgentChat(this.config.activeAgentChatId);
    return chat.cwd || process.cwd();
  }

  setBoundSessionId(sessionId) {
    const normalized = String(sessionId || '').trim() || null;
    const activeChatId = this.config.activeAgentChatId || 'default';
    const chatPatch = {
      provider: this.provider,
    };
    if (this.provider === 'codex') {
      chatPatch.codexLastSessionId = normalized;
      this.config.saveAgentChat(activeChatId, chatPatch);
      this.config.set('codexLastSessionId', normalized);
      return;
    }
    if (this.provider === 'claude') {
      chatPatch.claudeLastSessionId = normalized;
      this.config.saveAgentChat(activeChatId, chatPatch);
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
    this.config.saveAgentChat(this.config.activeAgentChatId, { provider });

    return effective;
  }

  setProviderArgs(args = []) {
    const effective = applyDefaultBypassArgs(this.provider, Array.isArray(args) ? args : []);
    this.providerArgs = effective.providerArgs;
    this.config.setMany({
      provider: this.provider,
      claudeArgs: this.provider === 'claude' ? this.providerArgs : this.config.claudeArgs,
      codexArgs: this.provider === 'codex' ? this.providerArgs : this.config.codexArgs,
    });
    this.config.saveAgentChat(this.config.activeAgentChatId, { provider: this.provider });
    return effective;
  }

  async handleProviderSwitchCommand(provider, rawArgs = '', source = 'telegram') {
    const sourceLabel = source === 'cli' ? 'CLI' : 'Telegram';
    const args = splitArgs(rawArgs);
    const effective = this.switchProvider(provider);
    const sessionId = this.getBoundSessionId() || '-';
    const argsText = effective.providerArgs.length > 0 ? effective.providerArgs.join(' ') : '(none)';

    this.logCliEvent(`${sourceLabel} provider switch`, provider);

    await this.safeSendMessage(
      [
        `Provider switched to ${provider}.`,
        `Session: ${sessionId}`,
        `Args: ${argsText}`,
        args.length > 0 ? 'Inline switch args are ignored. Use startup args to set defaults.' : null,
        effective.defaultBypassApplied ? 'Default bypass mode applied.' : null,
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  spawnReloadProcess() {
    const args = process.argv.slice(1);
    if (args.length === 0) {
      throw new Error('Cannot reload: current process command is unavailable.');
    }

    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      detached: false,
      stdio: 'inherit',
    });
    child.unref();
  }

  async handleReloadCommand(source = 'telegram') {
    const sourceLabel = source === 'cli' ? 'CLI' : 'Telegram';
    const stopped = this.requestStopCurrentPrompt('reload');
    const clearedCount = this.clearQueuedTelegramMessages();

    try {
      this.spawnReloadProcess();
    } catch (error) {
      await this.safeSendMessage(`Reload failed: ${error.message}`);
      return;
    }

    this.logCliEvent(`${sourceLabel} reload`, process.argv.slice(1).join(' '));
    await this.safeSendMessage(
      [
        'Reloading HeyAgent with the current command...',
        stopped ? 'Stopped the active provider run.' : null,
        clearedCount > 0 ? `Cleared ${clearedCount} queued message${clearedCount === 1 ? '' : 's'}.` : null,
      ]
        .filter(Boolean)
        .join('\n')
    );

    this.running = false;
    this.stopLocalInputLoop();
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
          '/chat new|switch|list|cwd|delete|status - manage agent chat contexts',
          '/reload - restart HeyAgent with the current command',
          '/stop - stop current execution and clear queued Telegram messages',
          '/claude - switch to Claude provider',
          '/codex - switch to Codex provider',
          '/model [name|clear] - show or set the active provider model',
          '/call on|off|status - push-to-talk voice turns with text replies',
          '/transcription on|off|status - control local Whisper transcription for Telegram audio',
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
      this.writeCliLine(
        buildStatusText(this.config, this.provider, this.providerArgs, this.sleepInhibitorState, this.voiceTranscriber, this.kokoroTts)
      );
      return;
    }

    if (line === '/new') {
      this.resetSessionMode();
      await this.safeSendMessage('Session reset from CLI. Your next message starts fresh.');
      return;
    }

    if (line === '/reload') {
      await this.handleReloadCommand('cli');
      return;
    }

    if (line === '/chat' || line.startsWith('/chat ') || line === '/context' || line.startsWith('/context ')) {
      const commandName = line.startsWith('/context') ? '/context' : '/chat';
      const argument = line.slice(commandName.length).trim();
      await this.handleAgentChatCommand(argument);
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

    if (line === '/model' || line.startsWith('/model ')) {
      const argument = line.slice('/model'.length).trim();
      await this.handleModelCommand(argument);
      return;
    }

    if (line === '/transcription' || line.startsWith('/transcription ')) {
      const argument = line.slice('/transcription'.length).trim();
      await this.handleTranscriptionCommand(argument);
      return;
    }

    if (line === '/call' || line.startsWith('/call ')) {
      const argument = line.slice('/call'.length).trim();
      await this.handleCallCommand(argument);
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
    this.config.saveAgentChat(this.config.activeAgentChatId, updates);
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

  storeTtsResponse(text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) {
      return null;
    }

    const responseId = crypto.randomBytes(6).toString('base64url');
    this.ttsResponseCache.set(responseId, {
      text: cleanText,
      createdAt: Date.now(),
      provider: this.provider,
    });

    while (this.ttsResponseCache.size > MAX_TTS_RESPONSE_CACHE_SIZE) {
      const oldestKey = this.ttsResponseCache.keys().next().value;
      this.ttsResponseCache.delete(oldestKey);
    }

    return responseId;
  }

  buildTtsReplyMarkup(responseId) {
    if (!this.kokoroTts?.available || !responseId) {
      return null;
    }

    return {
      inline_keyboard: [
        [
          {
            text: 'Build audio',
            callback_data: `${TTS_CALLBACK_PREFIX}${responseId}`,
          },
        ],
      ],
    };
  }

  createTelegramProgressReporter(providerLabel) {
    const chatId = this.config.telegramChatId;
    if (!chatId || !this.telegram) {
      return null;
    }

    let messageId = null;
    let text = '';
    let initialText = `${providerLabel} is working...`;
    let lastSentText = '';
    let flushTimer = null;
    let closed = false;
    let pendingFlush = Promise.resolve();

    const flush = async force => {
      if (closed && !force) {
        return;
      }

      const nextText = text.trim() ? formatTelegramProgressText(providerLabel, text) : initialText;
      if (!force && nextText === lastSentText) {
        return;
      }

      lastSentText = nextText;
      try {
        if (!messageId) {
          const sent = await this.safeSendMessage(nextText, { from: providerLabel });
          messageId = sent?.[0]?.message_id || null;
          return;
        }

        await this.telegram.editMessage(chatId, messageId, nextText);
      } catch (error) {
        this.logger.warn(`Telegram progress update failed: ${error.message}`);
      }
    };

    const scheduleFlush = () => {
      if (flushTimer || closed) {
        return;
      }

      flushTimer = setTimeout(() => {
        flushTimer = null;
        pendingFlush = pendingFlush
          .then(() => flush(false))
          .catch(error => {
            this.logger.warn(`Telegram progress flush failed: ${error.message}`);
          });
      }, TELEGRAM_PROGRESS_FLUSH_MS);
    };

    return {
      start: messageText => {
        initialText = String(messageText || '').trim() || `${providerLabel} is working...`;
        pendingFlush = pendingFlush
          .then(() => flush(true))
          .catch(error => {
            this.logger.warn(`Telegram progress start failed: ${error.message}`);
          });
      },
      push: chunk => {
        const value = String(chunk || '');
        if (!value || closed) {
          return;
        }
        text += value;
        scheduleFlush();
      },
      finish: async finalText => {
        closed = true;
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        await pendingFlush;

        if (!messageId) {
          return;
        }

        const doneText = String(finalText || '').trim() || `${providerLabel} response complete.`;
        if (doneText === lastSentText) {
          return;
        }

        try {
          await this.telegram.editMessage(chatId, messageId, doneText);
        } catch (error) {
          this.logger.warn(`Telegram progress completion failed: ${error.message}`);
        }
      },
    };
  }

  async sendAgentResponse(text, options = {}) {
    const responseId = this.storeTtsResponse(text);
    const replyMarkup = this.buildTtsReplyMarkup(responseId);

    await this.safeSendMessage(text, {
      ...options,
      telegramOptions: replyMarkup
        ? {
            reply_markup: replyMarkup,
          }
        : {},
    });
  }

  async queuePrompt(prompt, source, options = {}) {
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) {
      return;
    }

    const run = async () => {
      const sourceLabel = source === 'cli' ? 'CLI' : 'Telegram';
      const providerLabel = formatProviderName(this.provider);
      const activeChat = this.config.getAgentChat(this.config.activeAgentChatId);
      const resume = !this.forceNewNextPrompt && (Boolean(this.getBoundSessionId()) || activeChat.id === 'default');
      const abortController = new globalThis.AbortController();
      const groupedCount = Number.isFinite(options.groupedCount) ? Math.max(1, Number(options.groupedCount)) : 1;
      const progressReporter = source === 'telegram' ? this.createTelegramProgressReporter(providerLabel) : null;
      this.logCliEvent(`${sourceLabel} -> ${providerLabel}`, cleanPrompt);
      this.activePromptAbortController = abortController;
      this.activePromptSource = source;
      this.activePromptAbortReason = null;

      try {
        if (source === 'telegram') {
          const workingText = groupedCount > 1 ? `${providerLabel} is working on ${groupedCount} messages...` : `${providerLabel} is working...`;
          if (groupedCount > 1) {
            progressReporter?.start(workingText);
          } else {
            progressReporter?.start(workingText);
          }

          if (!progressReporter) {
            await this.safeSendMessage(workingText);
          }
        }

        const response = await this.runProvider(cleanPrompt, resume, {
          abortSignal: abortController.signal,
          onProgress: progressReporter?.push,
        });

        this.forceNewNextPrompt = false;
        await progressReporter?.finish(`${providerLabel} response complete.`);
        await this.sendAgentResponse(response, { from: providerLabel });
      } catch (error) {
        await progressReporter?.finish(`${providerLabel} response stopped.`);
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

      for (const callback of result.callbacks || []) {
        if (!this.running) {
          break;
        }

        if (callback.chatId !== chatId) {
          continue;
        }

        if (chatUserId && callback.userId && callback.userId !== chatUserId) {
          continue;
        }

        await this.handleCallback(callback);
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

  async handleCallback(callback) {
    const data = String(callback?.data || '').trim();
    if (!data.startsWith(TTS_CALLBACK_PREFIX)) {
      await this.telegram.answerCallbackQuery(callback.callbackQueryId, {
        text: 'Unknown action.',
        show_alert: false,
      });
      return;
    }

    const responseId = data.slice(TTS_CALLBACK_PREFIX.length);
    await this.handleBuildAudioCallback(callback, responseId);
  }

  async handleBuildAudioCallback(callback, responseId) {
    const cached = this.ttsResponseCache.get(responseId);
    if (!cached) {
      await this.telegram.answerCallbackQuery(callback.callbackQueryId, {
        text: 'That response is no longer available for audio.',
        show_alert: true,
      });
      return;
    }

    if (!this.kokoroTts?.available) {
      await this.telegram.answerCallbackQuery(callback.callbackQueryId, {
        text: 'Kokoro TTS is unavailable on this machine.',
        show_alert: true,
      });
      await this.safeSendMessage(`Kokoro TTS unavailable: ${this.kokoroTts?.reason || 'unknown error'}`);
      return;
    }

    await this.telegram.answerCallbackQuery(callback.callbackQueryId, {
      text: 'Building audio...',
      show_alert: false,
    });
    await this.safeSendMessage('Building audio with Kokoro TTS...');

    let generated = null;
    try {
      generated = await this.kokoroTts.synthesize(cached.text);
      await this.telegram.sendAudio(this.config.telegramChatId, generated.audioPath, {
        title: 'HeyAgent response',
        performer: formatProviderName(cached.provider),
        caption: 'Generated with Kokoro TTS.',
      });
      this.logCliEvent('Kokoro TTS -> Telegram', generated.audioPath);
    } catch (error) {
      const messageText = error?.message ? String(error.message) : String(error);
      this.logger.error(`Kokoro TTS failed: ${messageText}`);
      await this.safeSendMessage(`Failed to build audio: ${messageText}`);
    } finally {
      if (generated?.cleanup) {
        await generated.cleanup().catch(cleanupError => {
          this.logger.warn(`Failed to clean TTS temp files: ${cleanupError.message}`);
        });
      }
    }
  }

  isAudioAttachment(type) {
    return type === 'voice' || type === 'audio';
  }

  isTranscriptionRequest(message) {
    const userText = String(message?.caption || message?.text || '')
      .trim()
      .toLowerCase();
    return userText === '/transcription' || userText.startsWith('/transcription ');
  }

  buildTranscribedVoicePrompt(message, transcript, options = {}) {
    const lines = options.callMode
      ? ['The user is speaking through Telegram call mode.', '', 'Transcript:', transcript.trim()]
      : [`The user sent a Telegram ${message.type || 'audio'} message.`, '', 'Transcript:', transcript.trim()];
    const userText = String(message.caption || message.text || '').trim();
    const cleanedUserText = userText.replace(/^\/transcription(?:@\w+)?(?:\s+|$)/i, '').trim();

    if (cleanedUserText) {
      lines.push('', `User note: ${cleanedUserText}`);
    }

    if (options.callMode) {
      lines.push('', 'Respond naturally in text, as if this were your side of a voice call.');
    }

    return lines.join('\n');
  }

  async handleAudioTranscriptionMessage(message, options = {}) {
    const sendToProvider = options.sendToProvider !== false;
    const echoTranscript = options.echoTranscript !== false;
    if (!this.voiceTranscriber?.available) {
      await this.safeSendMessage(`Voice transcription unavailable: ${this.voiceTranscriber?.reason || 'unknown error'}`);
      return;
    }

    const kind = message.type === 'voice' ? 'voice note' : 'audio';
    const progressLines = [options.callMode ? `Listening to ${kind}...` : `Transcribing ${kind} with local Whisper...`];
    if (this.voiceTranscriber.modelCanDownload && this.voiceTranscriber.isModelReady) {
      const modelReady = await this.voiceTranscriber.isModelReady();
      if (!modelReady) {
        progressLines.push('Preparing the Whisper model first. The first run can take a minute.');
      }
    }
    await this.safeSendMessage(progressLines.join('\n'));

    try {
      const transcript = await this.voiceTranscriber.transcribeTelegramVoice(this.telegram, message.fileId);
      if (!sendToProvider) {
        await this.safeSendMessage(`Transcript:\n\n${transcript}`);
        return;
      }

      if (echoTranscript) {
        await this.safeSendMessage(`Transcript:\n\n${transcript}`);
      }
      await this.enqueueTelegramPrompt(this.buildTranscribedVoicePrompt(message, transcript, { callMode: options.callMode }));
    } catch (error) {
      const messageText = error?.message ? String(error.message) : String(error);
      this.logger.error(`Voice transcription failed: ${messageText}`);
      await this.safeSendMessage(`Failed to transcribe audio: ${messageText}`);
    }
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

    if (this.isAudioAttachment(message.type)) {
      const transcriptionRequest = this.isTranscriptionRequest(message);
      const callMode = this.config.callModeEnabled && !transcriptionRequest;
      if (transcriptionRequest || callMode || this.config.voiceTranscriptionEnabled) {
        await this.handleAudioTranscriptionMessage(message, {
          sendToProvider: !transcriptionRequest,
          echoTranscript: !callMode,
          callMode,
        });
        return;
      }

      await this.safeSendMessage('Audio received.');
      await this.safeSendMessage(DICTATION_HINT_TEXT);
    } else {
      await this.safeSendMessage('Attachment received.');
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
          '/chat new|switch|list|cwd|delete|status - manage agent chat contexts',
          '/reload - restart HeyAgent with the current command',
          '/stop - stop current execution and clear queued messages',
          '/claude - switch to Claude provider',
          '/codex - switch to Codex provider',
          '/model [name|clear] - show or set the active provider model',
          '/call on|off|status - push-to-talk voice turns with text replies',
          '/transcription on|off|status - control local Whisper transcription for audio messages',
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

    if (command === '/reload') {
      await this.handleReloadCommand('telegram');
      return;
    }

    if (command === '/chat' || command === '/context') {
      await this.handleAgentChatCommand(argument);
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

    if (command === '/model') {
      await this.handleModelCommand(argument);
      return;
    }

    if (command === '/transcription') {
      await this.handleTranscriptionCommand(argument);
      return;
    }

    if (command === '/call') {
      await this.handleCallCommand(argument);
      return;
    }

    if (command === '/status') {
      await this.safeSendMessage(
        buildStatusText(this.config, this.provider, this.providerArgs, this.sleepInhibitorState, this.voiceTranscriber, this.kokoroTts)
      );
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

  getActiveModel() {
    return getOptionValue(this.providerArgs, ['--model', '-m']);
  }

  async handleModelCommand(argument) {
    const value = String(argument || '').trim();
    const currentModel = this.getActiveModel();

    if (!value || value.toLowerCase() === 'status') {
      await this.safeSendMessage(
        [`Provider: ${this.provider}`, `Model: ${currentModel || 'default'}`, 'Use /model <name> to set, or /model clear to remove override.'].join(
          '\n'
        )
      );
      return;
    }

    if (value.toLowerCase() === 'clear' || value.toLowerCase() === 'default') {
      const nextArgs = setOptionValue(this.providerArgs, ['--model', '-m'], '', '--model');
      this.setProviderArgs(nextArgs);
      await this.safeSendMessage(`Model override cleared for ${this.provider}.`);
      return;
    }

    const nextArgs = setOptionValue(this.providerArgs, ['--model', '-m'], value, '--model');
    this.setProviderArgs(nextArgs);
    await this.safeSendMessage(`Model for ${this.provider} set to ${value}.`);
  }

  findAgentChat(identifier) {
    const needle = String(identifier || '').trim();
    if (!needle) {
      return null;
    }

    const normalizedId = normalizeAgentChatId(needle);
    const exact = this.config.getAgentChat(normalizedId);
    if (this.config.agentChats[normalizedId] || normalizedId === 'default') {
      return exact;
    }

    return this.config.listAgentChats().find(chat => chat.name.toLowerCase() === needle.toLowerCase()) || null;
  }

  formatAgentChatList() {
    const activeId = this.config.activeAgentChatId;
    const chats = this.config.listAgentChats();
    return chats
      .map(chat => {
        const marker = chat.id === activeId ? '*' : '-';
        const provider = chat.provider || this.provider;
        const codex = chat.codexLastSessionId ? 'codex session' : 'codex new';
        const claude = chat.claudeLastSessionId ? 'claude session' : 'claude new';
        const cwd = chat.cwd || process.cwd();
        return `${marker} ${chat.name} (${provider}, ${codex}, ${claude}, ${cwd})`;
      })
      .join('\n');
  }

  activateAgentChat(chat) {
    this.config.setActiveAgentChat(chat.id);

    const provider = chat.provider === 'claude' || chat.provider === 'codex' ? chat.provider : this.provider;
    if (provider !== this.provider) {
      this.switchProvider(provider);
    } else {
      this.config.saveAgentChat(chat.id, { provider });
    }

    this.forceNewNextPrompt = !getCurrentSessionId(this.config, this.provider);
  }

  async updateActiveAgentChatCwd(value) {
    const normalized = String(value || '').trim();
    if (!normalized || normalized === 'clear' || normalized === 'default') {
      this.config.saveAgentChat(this.config.activeAgentChatId, { cwd: null });
      return null;
    }

    const resolved = path.resolve(this.getActiveCwd(), normalized);
    const resolvedStat = await stat(resolved);
    if (!resolvedStat.isDirectory()) {
      throw new Error(`${resolved} is not a directory`);
    }
    this.config.saveAgentChat(this.config.activeAgentChatId, { cwd: resolved });
    return resolved;
  }

  async handleAgentChatCommand(argument) {
    const parts = splitArgs(argument);
    const action = String(parts[0] || 'status').toLowerCase();
    const value = parts.slice(1).join(' ').trim();

    if (action === 'status') {
      const active = this.config.getAgentChat(this.config.activeAgentChatId);
      await this.safeSendMessage(
        [
          `Active chat: ${active.name}`,
          `Provider: ${this.provider}`,
          `Directory: ${this.getActiveCwd()}`,
          `Session: ${getCurrentSessionId(this.config, this.provider) || 'new'}`,
          'Use /chat list, /chat new <name>, /chat switch <name>, /chat cwd <path>, or /chat delete <name>.',
        ].join('\n')
      );
      return;
    }

    if (action === 'list') {
      await this.safeSendMessage(`Agent chats:\n\n${this.formatAgentChatList()}`);
      return;
    }

    if (action === 'new' || action === 'create') {
      if (!value) {
        await this.safeSendMessage('Usage: /chat new <name>');
        return;
      }

      const chatId = normalizeAgentChatId(value);
      if (this.config.agentChats[chatId]) {
        await this.safeSendMessage(`Chat already exists: ${this.config.getAgentChat(chatId).name}`);
        return;
      }

      this.config.saveAgentChat(chatId, {
        name: value,
        provider: this.provider,
        cwd: this.getActiveCwd(),
        claudeLastSessionId: null,
        codexLastSessionId: null,
      });
      this.config.setActiveAgentChat(chatId);
      this.forceNewNextPrompt = true;
      await this.safeSendMessage(`Created and switched to chat: ${value}`);
      return;
    }

    if (action === 'switch' || action === 'use') {
      if (!value) {
        await this.safeSendMessage('Usage: /chat switch <name>');
        return;
      }

      const chat = this.findAgentChat(value);
      if (!chat) {
        await this.safeSendMessage(`Chat not found: ${value}`);
        return;
      }

      this.activateAgentChat(chat);
      await this.safeSendMessage(
        [
          `Switched to chat: ${chat.name}`,
          `Provider: ${this.provider}`,
          `Directory: ${this.getActiveCwd()}`,
          `Session: ${getCurrentSessionId(this.config, this.provider) || 'new'}`,
        ].join('\n')
      );
      return;
    }

    if (action === 'cwd' || action === 'cd' || action === 'dir') {
      const active = this.config.getAgentChat(this.config.activeAgentChatId);
      if (!value) {
        await this.safeSendMessage(`Directory for ${active.name}: ${this.getActiveCwd()}`);
        return;
      }

      try {
        const nextCwd = await this.updateActiveAgentChatCwd(value);
        await this.safeSendMessage(`Directory for ${active.name}: ${nextCwd || process.cwd()}`);
      } catch (error) {
        await this.safeSendMessage(`Cannot use directory: ${error.message}`);
      }
      return;
    }

    if (action === 'delete' || action === 'remove') {
      if (!value) {
        await this.safeSendMessage('Usage: /chat delete <name>');
        return;
      }

      const chat = this.findAgentChat(value);
      if (!chat || chat.id === 'default') {
        await this.safeSendMessage(chat?.id === 'default' ? 'Cannot delete the default chat.' : `Chat not found: ${value}`);
        return;
      }

      const wasActive = chat.id === this.config.activeAgentChatId;
      this.config.deleteAgentChat(chat.id);
      if (wasActive) {
        this.activateAgentChat(this.config.getAgentChat('default'));
      }
      await this.safeSendMessage(`Deleted chat: ${chat.name}`);
      return;
    }

    await this.safeSendMessage('Usage: /chat new|switch|list|cwd|delete|status');
  }

  async handleTranscriptionCommand(argument) {
    const action = String(argument || '')
      .trim()
      .toLowerCase();
    if (!action || action === 'status') {
      let modelStatus = null;
      if (this.voiceTranscriber?.available && this.voiceTranscriber.isModelReady) {
        const modelReady = await this.voiceTranscriber.isModelReady();
        modelStatus = `Model: ${modelReady ? 'ready' : 'not downloaded yet'} (${this.voiceTranscriber.modelPath})`;
      }

      await this.safeSendMessage(
        [
          `Voice transcription is ${this.config.voiceTranscriptionEnabled ? 'on' : 'off'}.`,
          `Backend: ${formatVoiceTranscriberStatus(this.voiceTranscriber)}`,
          modelStatus,
          'Use /transcription on or /transcription off.',
          'You can also send an audio or voice note with caption /transcription to transcribe it once without sending it to the agent.',
        ]
          .filter(Boolean)
          .join('\n')
      );
      return;
    }

    if (action === 'on') {
      if (!this.voiceTranscriber?.available) {
        await this.safeSendMessage(`Cannot enable transcription: ${this.voiceTranscriber?.reason || 'backend unavailable'}`);
        return;
      }

      this.config.set('voiceTranscriptionEnabled', true);
      await this.safeSendMessage(
        'Voice transcription enabled. Future Telegram voice/audio messages will be transcribed and sent to the active agent.'
      );
      return;
    }

    if (action === 'off') {
      this.config.set('voiceTranscriptionEnabled', false);
      await this.safeSendMessage('Voice transcription disabled. Audio attachments will be forwarded as files.');
      return;
    }

    await this.safeSendMessage('Usage: /transcription on|off|status');
  }

  async handleCallCommand(argument) {
    const action = String(argument || '')
      .trim()
      .toLowerCase();

    if (!action || action === 'status') {
      await this.safeSendMessage(
        [
          `Call mode is ${this.config.callModeEnabled ? 'on' : 'off'}.`,
          `Backend: ${formatVoiceTranscriberStatus(this.voiceTranscriber)}`,
          'Use /call on to make Telegram voice notes behave like push-to-talk turns.',
          'Use /call off to return audio messages to normal attachment/transcription handling.',
        ].join('\n')
      );
      return;
    }

    if (action === 'on') {
      if (!this.voiceTranscriber?.available) {
        await this.safeSendMessage(`Cannot enable call mode: ${this.voiceTranscriber?.reason || 'voice backend unavailable'}`);
        return;
      }

      this.config.set('callModeEnabled', true);
      await this.safeSendMessage('Call mode enabled. Send Telegram voice notes as push-to-talk turns; replies come back as text.');
      return;
    }

    if (action === 'off') {
      this.config.set('callModeEnabled', false);
      await this.safeSendMessage('Call mode disabled.');
      return;
    }

    await this.safeSendMessage('Usage: /call on|off|status');
  }

  async runProvider(prompt, resume, options = {}) {
    const abortSignal = options.abortSignal || null;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    if (this.provider === 'claude') {
      return runClaudePrompt(prompt, {
        resume,
        extraArgs: this.providerArgs,
        cwd: this.getActiveCwd(),
        abortSignal,
        sessionId: this.getBoundSessionId(),
        onSessionId: sessionId => {
          this.setBoundSessionId(sessionId);
        },
      });
    }

    if (this.provider === 'codex') {
      return runCodexPrompt(prompt, {
        resume,
        extraArgs: this.providerArgs,
        cwd: this.getActiveCwd(),
        abortSignal,
        onProgress,
        sessionId: this.getBoundSessionId(),
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
    const telegramOptions = options.telegramOptions || {};

    if (!chatId) {
      return;
    }

    this.logCliEvent(`${from} -> Telegram`, text);

    try {
      return await this.telegram.sendMessage(chatId, text, telegramOptions);
    } catch (error) {
      this.logger.error(`Outbox send failed: ${error.message}`);

      if (error instanceof TelegramApiError && error.status === 401) {
        this.config.clearPairing({ keepBotToken: false });
        this.running = false;
        console.error('Telegram bot token is invalid. Restart and enter a new token.');
      }
    }

    return null;
  }
}

export default Bridge;
