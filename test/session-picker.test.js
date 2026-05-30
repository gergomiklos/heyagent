import assert from 'node:assert/strict';
import test from 'node:test';
import Bridge from '../src/bridge.js';
import {
  createProjectSessionKeyboard,
  createSessionKeyboard,
  createSessionProjectKeyboard,
  createTelegramBotCommands,
  formatSessionButtonLabel,
  groupSessionsByProject,
} from '../src/session-picker.js';

function makeSession(index, overrides = {}) {
  return {
    id: `session-${index}`,
    agentType: index % 2 === 0 ? 'codex' : 'claude',
    title: `Prompt ${index}`,
    lastUserMessage: `Last prompt ${index}`,
    lastUserMessageAt: '2026-05-29T09:45:00.000Z',
    project: `project-${index}`,
    cwd: `/tmp/project-${index}`,
    model: null,
    resumable: true,
    ...overrides,
  };
}

test('formatSessionButtonLabel shows title and provider in parentheses', () => {
  const label = formatSessionButtonLabel(
    makeSession(1, {
      agentType: 'claude',
      project: 'heyagent',
      title: 'Add Telegram session picker support',
    }),
    new Date('2026-05-29T10:00:00.000Z')
  );

  assert.equal(label, 'Add Telegram session picker support (Claude · 15m)');
});

test('formatSessionButtonLabel falls back to last user message', () => {
  const label = formatSessionButtonLabel(
    makeSession(2, {
      agentType: 'codex',
      project: null,
      title: null,
      lastUserMessage: 'Continue from here',
    }),
    new Date('2026-05-29T10:00:00.000Z')
  );

  assert.equal(label, 'Continue from here (Codex · 15m)');
});

test('formatSessionButtonLabel truncates long labels', () => {
  const label = formatSessionButtonLabel(
    makeSession(3, {
      title: 'This is an intentionally long prompt title that should not take over the Telegram keyboard',
    }),
    new Date('2026-05-29T10:02:00.000Z')
  );

  assert.ok(label.length <= 64);
  assert.ok(label.endsWith('...'));
});

test('formatSessionButtonLabel shows hour- and day-level ages', () => {
  const session = makeSession(4, {
    agentType: 'claude',
    title: 'Older work',
    lastUserMessageAt: '2026-05-29T08:00:00.000Z',
  });

  assert.equal(formatSessionButtonLabel(session, new Date('2026-05-29T11:00:00.000Z')), 'Older work (Claude · 3h)');
  assert.equal(formatSessionButtonLabel(session, new Date('2026-06-01T08:00:00.000Z')), 'Older work (Claude · 3d)');
});

test('createSessionKeyboard limits to 20 sessions and registers callback tokens', () => {
  const registered = new Map();
  const sessions = Array.from({ length: 25 }, (_, index) => makeSession(index + 1));
  const keyboard = createSessionKeyboard(sessions, session => {
    const token = `sess_${session.id}`;
    registered.set(token, session);
    return token;
  });

  assert.equal(keyboard.inline_keyboard.length, 20);
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'sess_session-1');
  assert.equal(keyboard.inline_keyboard[19][0].callback_data, 'sess_session-20');
  assert.equal(registered.size, 20);
  assert.equal(registered.get('sess_session-1').id, 'session-1');
});

test('groupSessionsByProject limits before grouping and keeps newest project first', () => {
  const sessions = Array.from({ length: 25 }, (_, index) =>
    makeSession(index + 1, {
      project: index === 24 ? 'outside-limit' : index % 2 === 0 ? 'alpha' : 'beta',
    })
  );

  const groups = groupSessionsByProject(sessions, { limit: 20 });

  assert.equal(groups.length, 2);
  assert.equal(groups[0].project, 'alpha');
  assert.equal(groups[0].sessions.length, 10);
  assert.equal(groups[1].project, 'beta');
  assert.equal(groups[1].sessions.length, 10);
  assert.equal(
    groups.some(group => group.project === 'outside-limit'),
    false
  );
});

test('createSessionProjectKeyboard renders every project as a project button with session count', () => {
  const registeredProjects = new Map();
  const sessions = [
    makeSession(1, { id: 'alpha-new', project: 'alpha', agentType: 'claude', title: 'New alpha work' }),
    makeSession(2, { id: 'beta-only', project: 'beta', agentType: 'codex', title: 'Only beta work' }),
    makeSession(3, { id: 'alpha-old', project: 'alpha', agentType: 'codex', title: 'Older alpha work' }),
  ];

  const keyboard = createSessionProjectKeyboard(sessions, group => {
    const token = `proj_${group.project}`;
    registeredProjects.set(token, group);
    return token;
  });

  assert.equal(keyboard.inline_keyboard.length, 2);
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'proj_alpha');
  assert.equal(keyboard.inline_keyboard[0][0].text, 'alpha (2)');
  assert.equal(keyboard.inline_keyboard[1][0].callback_data, 'proj_beta');
  assert.equal(keyboard.inline_keyboard[1][0].text, 'beta (1)');
  assert.deepEqual(
    registeredProjects.get('proj_alpha').sessions.map(session => session.id),
    ['alpha-new', 'alpha-old']
  );
  assert.deepEqual(
    registeredProjects.get('proj_beta').sessions.map(session => session.id),
    ['beta-only']
  );
});

test('createProjectSessionKeyboard shows new buttons for providers found in the project', () => {
  const registeredSessions = new Map();
  const registeredNewSessions = new Map();
  const group = {
    project: 'alpha',
    cwd: '/tmp/alpha',
    sessions: [
      makeSession(1, { id: 'alpha-claude', project: 'alpha', cwd: '/tmp/alpha', agentType: 'claude', title: 'Claude alpha' }),
      makeSession(2, { id: 'alpha-codex', project: 'alpha', cwd: '/tmp/alpha', agentType: 'codex', title: 'Codex alpha' }),
    ],
  };

  const keyboard = createProjectSessionKeyboard(
    group,
    session => {
      const token = `sess_${session.id}`;
      registeredSessions.set(token, session);
      return token;
    },
    entry => {
      const token = `new_${entry.provider}`;
      registeredNewSessions.set(token, entry);
      return token;
    },
    { now: new Date('2026-05-29T10:00:00.000Z') }
  );

  assert.deepEqual(
    keyboard.inline_keyboard[0].map(button => button.text),
    ['New Claude', 'New Codex']
  );
  assert.equal(keyboard.inline_keyboard[1][0].text, 'Claude alpha (Claude · 15m)');
  assert.equal(keyboard.inline_keyboard[2][0].text, 'Codex alpha (Codex · 15m)');
  assert.deepEqual(
    [...registeredNewSessions.values()],
    [
      { provider: 'claude', project: 'alpha', cwd: '/tmp/alpha' },
      { provider: 'codex', project: 'alpha', cwd: '/tmp/alpha' },
    ]
  );
  assert.equal(registeredSessions.size, 2);
});

test('createProjectSessionKeyboard hides providers absent from the project', () => {
  const registeredNewSessions = new Map();
  const group = {
    project: 'beta',
    cwd: '/tmp/beta',
    sessions: [makeSession(1, { id: 'beta-codex', project: 'beta', cwd: '/tmp/beta', agentType: 'codex', title: 'Codex beta' })],
  };

  const keyboard = createProjectSessionKeyboard(
    group,
    session => `sess_${session.id}`,
    entry => {
      const token = `new_${entry.provider}`;
      registeredNewSessions.set(token, entry);
      return token;
    },
    { visibleProviders: ['codex'], now: new Date('2026-05-29T10:00:00.000Z') }
  );

  assert.deepEqual(
    keyboard.inline_keyboard[0].map(button => button.text),
    ['New Codex']
  );
  assert.equal(keyboard.inline_keyboard[1][0].text, 'Codex beta (Codex · 15m)');
  assert.deepEqual([...registeredNewSessions.values()], [{ provider: 'codex', project: 'beta', cwd: '/tmp/beta' }]);
});

test('createTelegramBotCommands hides provider switches not in the visible provider set', () => {
  assert.deepEqual(
    createTelegramBotCommands(['codex']).map(command => command.command),
    ['help', 'new', 'stop', 'codex', 'projects', 'sessions', 'status']
  );
  assert.deepEqual(
    createTelegramBotCommands(['claude', 'codex']).map(command => command.command),
    ['help', 'new', 'stop', 'claude', 'codex', 'projects', 'sessions', 'status']
  );
});

test('showSessionPicker sends latest 10 sessions as a flat list', async () => {
  const data = {
    provider: 'codex',
    claudeArgs: [],
    codexArgs: [],
    claudeLastSessionId: null,
    codexLastSessionId: null,
    telegramChatId: 'chat-1',
  };
  const sentMessages = [];
  const config = {
    get claudeArgs() {
      return data.claudeArgs;
    },
    get codexArgs() {
      return data.codexArgs;
    },
    get claudeLastSessionId() {
      return data.claudeLastSessionId;
    },
    get codexLastSessionId() {
      return data.codexLastSessionId;
    },
    get telegramChatId() {
      return data.telegramChatId;
    },
    get telegramBotUsername() {
      return null;
    },
    set(key, value) {
      data[key] = value;
    },
    setMany(updates) {
      Object.assign(data, updates);
    },
    clearPairing() {},
  };
  const sessions = Array.from({ length: 12 }, (_, index) => makeSession(index + 1, { project: index < 6 ? 'alpha' : 'beta' }));
  const bridge = new Bridge(config, 'codex', [], {
    gatherSessions: async () => sessions,
  });
  bridge.logCliEvent = () => {};
  bridge.telegram = {
    sendMessage(chatId, text, options) {
      sentMessages.push({ chatId, text, options });
    },
  };

  await bridge.sessionPicker.showSessionPicker();

  assert.equal(sentMessages[0].chatId, 'chat-1');
  assert.match(sentMessages[0].text, /Kies een sessie/);
  assert.doesNotMatch(sentMessages[0].text, /project/);
  assert.equal(sentMessages[0].options.replyMarkup.inline_keyboard.length, 10);
  assert.ok(sentMessages[0].options.replyMarkup.inline_keyboard.every(row => row[0].callback_data.startsWith('sess_')));
  assert.equal(bridge.sessionPicker.sessionPickerEntries.size, 10);
  assert.equal(bridge.sessionPicker.sessionPickerProjectEntries.size, 0);
});

test('handleCommand opens project picker for projects command', async () => {
  const config = {
    get claudeArgs() {
      return [];
    },
    get codexArgs() {
      return [];
    },
    get claudeLastSessionId() {
      return null;
    },
    get codexLastSessionId() {
      return null;
    },
    get telegramChatId() {
      return 'chat-1';
    },
    get telegramBotUsername() {
      return 'RegelneefBot';
    },
    set() {},
    setMany() {},
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'claude', []);
  let showProjectPickerCalls = 0;
  bridge.sessionPicker.showProjectPicker = async () => {
    showProjectPickerCalls += 1;
  };
  bridge.safeSendMessage = async () => {
    throw new Error('Expected /projects command to open picker');
  };

  await bridge.handleCommand('/projects@RegelneefBot');

  assert.equal(showProjectPickerCalls, 1);
});

test('handleSessionPickerCallback selects provider session id and cwd', async () => {
  const data = {
    provider: 'claude',
    claudeArgs: [],
    codexArgs: [],
    claudeLastSessionId: null,
    codexLastSessionId: null,
    telegramChatId: 'chat-1',
  };
  const sentMessages = [];
  const answeredCallbacks = [];
  const config = {
    get claudeArgs() {
      return data.claudeArgs;
    },
    get codexArgs() {
      return data.codexArgs;
    },
    get claudeLastSessionId() {
      return data.claudeLastSessionId;
    },
    get codexLastSessionId() {
      return data.codexLastSessionId;
    },
    get telegramChatId() {
      return data.telegramChatId;
    },
    get telegramBotUsername() {
      return null;
    },
    set(key, value) {
      data[key] = value;
    },
    setMany(updates) {
      Object.assign(data, updates);
    },
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'claude', []);
  bridge.logCliEvent = () => {};
  bridge.telegram = {
    sendMessage(chatId, text) {
      sentMessages.push({ chatId, text });
    },
    answerCallbackQuery(callbackQueryId, text) {
      answeredCallbacks.push({ callbackQueryId, text });
    },
  };
  const session = makeSession(1, {
    agentType: 'codex',
    id: 'codex-session',
    cwd: '/Users/geert/code/selected',
    project: 'selected',
    title: 'Selected work',
  });
  bridge.sessionPicker.sessionPickerEntries.set('sess_token', session);

  await bridge.sessionPicker.handleSessionPickerCallback({
    type: 'callback',
    callbackQueryId: 'callback-1',
    data: 'sess_token',
    chatId: 'chat-1',
  });

  assert.equal(bridge.provider, 'codex');
  assert.equal(data.provider, 'codex');
  assert.equal(data.codexLastSessionId, 'codex-session');
  assert.equal(bridge.selectedSessionCwd, '/Users/geert/code/selected');
  assert.equal(bridge.forceNewNextPrompt, false);
  assert.deepEqual(answeredCallbacks, [{ callbackQueryId: 'callback-1', text: 'Codex geselecteerd' }]);
  assert.equal(sentMessages[0].chatId, 'chat-1');
  assert.match(sentMessages[0].text, /Selected Codex session/);
});

test('handleSessionPickerCallback stops active prompt and clears queued messages before switching', async () => {
  const data = {
    provider: 'claude',
    claudeArgs: [],
    codexArgs: [],
    claudeLastSessionId: 'old-claude-session',
    codexLastSessionId: null,
    telegramChatId: 'chat-1',
  };
  const config = {
    get claudeArgs() {
      return data.claudeArgs;
    },
    get codexArgs() {
      return data.codexArgs;
    },
    get claudeLastSessionId() {
      return data.claudeLastSessionId;
    },
    get codexLastSessionId() {
      return data.codexLastSessionId;
    },
    get telegramChatId() {
      return data.telegramChatId;
    },
    get telegramBotUsername() {
      return null;
    },
    set(key, value) {
      data[key] = value;
    },
    setMany(updates) {
      Object.assign(data, updates);
    },
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'claude', []);
  bridge.logCliEvent = () => {};
  bridge.telegram = {
    sendMessage() {},
    answerCallbackQuery() {},
  };
  const abortController = new globalThis.AbortController();
  bridge.activePromptAbortController = abortController;
  bridge.telegramPendingMessages = ['queued for old session'];
  bridge.sessionPicker.sessionPickerEntries.set(
    'sess_token',
    makeSession(1, {
      agentType: 'codex',
      id: 'codex-session',
      cwd: '/Users/geert/code/selected',
    })
  );

  await bridge.sessionPicker.handleSessionPickerCallback({
    type: 'callback',
    callbackQueryId: 'callback-1',
    data: 'sess_token',
    chatId: 'chat-1',
  });

  assert.equal(abortController.signal.aborted, true);
  assert.equal(bridge.activePromptAbortReason, 'session_switch');
  assert.deepEqual(bridge.telegramPendingMessages, []);
  assert.equal(bridge.provider, 'codex');
  assert.equal(data.codexLastSessionId, 'codex-session');
});

test('handleSessionProjectCallback shows new-session buttons and existing sessions for a project', async () => {
  const data = {
    provider: 'claude',
    claudeArgs: [],
    codexArgs: [],
    claudeLastSessionId: null,
    codexLastSessionId: null,
    telegramChatId: 'chat-1',
  };
  const sentMessages = [];
  const answeredCallbacks = [];
  const config = {
    get claudeArgs() {
      return data.claudeArgs;
    },
    get codexArgs() {
      return data.codexArgs;
    },
    get claudeLastSessionId() {
      return data.claudeLastSessionId;
    },
    get codexLastSessionId() {
      return data.codexLastSessionId;
    },
    get telegramChatId() {
      return data.telegramChatId;
    },
    get telegramBotUsername() {
      return null;
    },
    set(key, value) {
      data[key] = value;
    },
    setMany(updates) {
      Object.assign(data, updates);
    },
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'claude', []);
  bridge.logCliEvent = () => {};
  bridge.telegram = {
    sendMessage(chatId, text, options) {
      sentMessages.push({ chatId, text, options });
    },
    answerCallbackQuery(callbackQueryId, text) {
      answeredCallbacks.push({ callbackQueryId, text });
    },
  };
  bridge.sessionPicker.sessionPickerProjectEntries.set('proj_alpha', {
    project: 'alpha',
    cwd: '/tmp/alpha',
    sessions: [
      makeSession(1, { id: 'alpha-claude', project: 'alpha', cwd: '/tmp/alpha', agentType: 'claude', title: 'Claude alpha work' }),
      makeSession(2, { id: 'alpha-codex', project: 'alpha', cwd: '/tmp/alpha', agentType: 'codex', title: 'Codex alpha work' }),
    ],
  });

  await bridge.sessionPicker.handleSessionProjectCallback({
    type: 'callback',
    callbackQueryId: 'callback-1',
    data: 'proj_alpha',
    chatId: 'chat-1',
  });

  assert.deepEqual(answeredCallbacks, [{ callbackQueryId: 'callback-1', text: 'alpha' }]);
  assert.equal(sentMessages[0].chatId, 'chat-1');
  assert.match(sentMessages[0].text, /Kies een sessie voor alpha/);
  assert.deepEqual(
    sentMessages[0].options.replyMarkup.inline_keyboard[0].map(button => button.text),
    ['New Claude', 'New Codex']
  );
  assert.equal(sentMessages[0].options.replyMarkup.inline_keyboard.length, 3);
  assert.equal(new Set([...bridge.sessionPicker.sessionPickerEntries.values()].map(session => session.id)).size, 2);
  assert.deepEqual(
    [...bridge.sessionPicker.newSessionProjectEntries.values()].map(entry => entry.provider),
    ['claude', 'codex']
  );
});

test('handleSessionProjectCallback does not auto-select single-session projects', async () => {
  const data = {
    provider: 'claude',
    claudeArgs: [],
    codexArgs: [],
    claudeLastSessionId: null,
    codexLastSessionId: null,
    telegramChatId: 'chat-1',
  };
  const sentMessages = [];
  const config = {
    get claudeArgs() {
      return data.claudeArgs;
    },
    get codexArgs() {
      return data.codexArgs;
    },
    get claudeLastSessionId() {
      return data.claudeLastSessionId;
    },
    get codexLastSessionId() {
      return data.codexLastSessionId;
    },
    get telegramChatId() {
      return data.telegramChatId;
    },
    get telegramBotUsername() {
      return null;
    },
    set(key, value) {
      data[key] = value;
    },
    setMany(updates) {
      Object.assign(data, updates);
    },
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'claude', []);
  bridge.logCliEvent = () => {};
  bridge.telegram = {
    sendMessage(chatId, text, options) {
      sentMessages.push({ chatId, text, options });
    },
    answerCallbackQuery() {},
  };
  bridge.sessionPicker.sessionPickerProjectEntries.set('proj_beta', {
    project: 'beta',
    cwd: '/tmp/beta',
    sessions: [makeSession(1, { id: 'beta-codex', project: 'beta', cwd: '/tmp/beta', agentType: 'codex', title: 'Codex beta work' })],
  });

  await bridge.sessionPicker.handleSessionProjectCallback({
    type: 'callback',
    callbackQueryId: 'callback-1',
    data: 'proj_beta',
    chatId: 'chat-1',
  });

  assert.match(sentMessages[0].text, /Kies een sessie voor beta/);
  assert.deepEqual(
    sentMessages[0].options.replyMarkup.inline_keyboard[0].map(button => button.text),
    ['New Codex']
  );
  assert.equal(data.codexLastSessionId, null);
  assert.equal(bridge.forceNewNextPrompt, false);
});

test('handleNewSessionCallback selects provider, project cwd and fresh session mode', async () => {
  const data = {
    provider: 'codex',
    claudeArgs: [],
    codexArgs: [],
    claudeLastSessionId: 'old-claude-session',
    codexLastSessionId: 'old-codex-session',
    telegramChatId: 'chat-1',
  };
  const sentMessages = [];
  const answeredCallbacks = [];
  const config = {
    get claudeArgs() {
      return data.claudeArgs;
    },
    get codexArgs() {
      return data.codexArgs;
    },
    get claudeLastSessionId() {
      return data.claudeLastSessionId;
    },
    get codexLastSessionId() {
      return data.codexLastSessionId;
    },
    get telegramChatId() {
      return data.telegramChatId;
    },
    get telegramBotUsername() {
      return null;
    },
    set(key, value) {
      data[key] = value;
    },
    setMany(updates) {
      Object.assign(data, updates);
    },
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'codex', []);
  bridge.logCliEvent = () => {};
  bridge.telegram = {
    sendMessage(chatId, text) {
      sentMessages.push({ chatId, text });
    },
    answerCallbackQuery(callbackQueryId, text) {
      answeredCallbacks.push({ callbackQueryId, text });
    },
  };
  const abortController = new globalThis.AbortController();
  bridge.activePromptAbortController = abortController;
  bridge.telegramPendingMessages = ['queued for old session'];
  bridge.sessionPicker.newSessionProjectEntries.set('new_alpha_claude', {
    provider: 'claude',
    project: 'alpha',
    cwd: '/tmp/alpha',
  });

  await bridge.sessionPicker.handleNewSessionCallback({
    type: 'callback',
    callbackQueryId: 'callback-1',
    data: 'new_alpha_claude',
    chatId: 'chat-1',
  });

  assert.equal(abortController.signal.aborted, true);
  assert.equal(bridge.activePromptAbortReason, 'session_switch');
  assert.deepEqual(bridge.telegramPendingMessages, []);
  assert.equal(bridge.provider, 'claude');
  assert.equal(data.provider, 'claude');
  assert.equal(data.claudeLastSessionId, null);
  assert.equal(data.codexLastSessionId, 'old-codex-session');
  assert.equal(bridge.selectedSessionCwd, '/tmp/alpha');
  assert.equal(bridge.forceNewNextPrompt, true);
  assert.deepEqual(answeredCallbacks, [{ callbackQueryId: 'callback-1', text: 'New Claude' }]);
  assert.match(sentMessages[0].text, /New Claude session selected/);
});

test('handleCommand accepts bot-suffixed sessions command from Telegram menu', async () => {
  const config = {
    get claudeArgs() {
      return [];
    },
    get codexArgs() {
      return [];
    },
    get claudeLastSessionId() {
      return null;
    },
    get codexLastSessionId() {
      return null;
    },
    get telegramChatId() {
      return 'chat-1';
    },
    get telegramBotUsername() {
      return 'RegelneefBot';
    },
    set() {},
    setMany() {},
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'claude', []);
  let showSessionPickerCalls = 0;
  bridge.sessionPicker.showSessionPicker = async () => {
    showSessionPickerCalls += 1;
  };
  bridge.safeSendMessage = async () => {
    throw new Error('Expected /sessions command to open picker');
  };

  await bridge.handleCommand('/sessions@RegelneefBot');

  assert.equal(showSessionPickerCalls, 1);
});

test('configureTelegramCommands registers one short session menu command for the paired chat', async () => {
  const config = {
    get claudeArgs() {
      return [];
    },
    get codexArgs() {
      return [];
    },
    get claudeLastSessionId() {
      return null;
    },
    get codexLastSessionId() {
      return null;
    },
    get telegramChatId() {
      return '6314031751';
    },
    get telegramBotUsername() {
      return 'RegelneefBot';
    },
    set() {},
    setMany() {},
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'claude', [], {
    gatherSessions: async () => [makeSession(1, { agentType: 'claude' }), makeSession(2, { agentType: 'codex' })],
  });
  const calls = [];

  await bridge.sessionPicker.configureTelegramCommands({
    async setCommands(commands, options) {
      calls.push({ commands, options });
    },
  });

  assert.deepEqual(
    calls[0].commands.map(command => command.command),
    ['help', 'new', 'stop', 'claude', 'codex', 'projects', 'sessions', 'status']
  );
  assert.equal(calls[0].commands.find(command => command.command === 'sessions')?.description, 'Choose session');
  assert.equal(calls[0].commands.find(command => command.command === 'projects')?.description, 'Choose project');
  assert.deepEqual(calls[0].options, { chatId: '6314031751' });
});

test('handleLocalInputLine opens the session picker for /sessions', async () => {
  const config = {
    get claudeArgs() {
      return [];
    },
    get codexArgs() {
      return [];
    },
    get claudeLastSessionId() {
      return null;
    },
    get codexLastSessionId() {
      return null;
    },
    get telegramChatId() {
      return 'chat-1';
    },
    get telegramBotUsername() {
      return 'RegelneefBot';
    },
    set() {},
    setMany() {},
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'claude', []);
  bridge.running = true;
  let showSessionPickerCalls = 0;
  bridge.sessionPicker.showSessionPicker = async () => {
    showSessionPickerCalls += 1;
  };
  bridge.writeCliLine = message => {
    throw new Error(`Expected /sessions local command to open picker, got: ${message}`);
  };

  await bridge.handleLocalInputLine('/sessions');

  assert.equal(showSessionPickerCalls, 1);
});
