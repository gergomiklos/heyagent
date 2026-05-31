import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramApi, buildSendMessageOptions, normalizeCallback, normalizeMessage } from '../src/telegram-api.js';

test('normalizeMessage keeps text message behavior', () => {
  const message = normalizeMessage({
    update_id: 10,
    message: {
      message_id: 20,
      text: '  /sessions  ',
      chat: { id: 30, type: 'private' },
      from: { id: 40 },
    },
  });

  assert.deepEqual(message, {
    updateId: 10,
    messageId: 20,
    chatId: '30',
    chatType: 'private',
    userId: '40',
    type: 'text',
    text: '/sessions',
    caption: '',
    fileId: null,
    fileName: null,
    mimeType: null,
    fileSizeBytes: null,
    durationSec: null,
  });
});

test('normalizeCallback returns callback query details', () => {
  const callback = normalizeCallback({
    update_id: 11,
    callback_query: {
      id: 'callback-1',
      data: 'sess_123',
      from: { id: 41 },
      message: {
        message_id: 21,
        chat: { id: 31, type: 'private' },
      },
    },
  });

  assert.deepEqual(callback, {
    updateId: 11,
    type: 'callback',
    callbackQueryId: 'callback-1',
    data: 'sess_123',
    chatId: '31',
    chatType: 'private',
    userId: '41',
    messageId: 21,
  });
});

test('normalizeCallback ignores callbacks without data', () => {
  assert.equal(
    normalizeCallback({
      update_id: 12,
      callback_query: {
        id: 'callback-2',
        from: { id: 42 },
      },
    }),
    null
  );
});

test('buildSendMessageOptions includes inline keyboard reply markup', () => {
  const replyMarkup = {
    inline_keyboard: [[{ text: 'Claude | project | 1m | title', callback_data: 'sess_1' }]],
  };

  assert.deepEqual(buildSendMessageOptions({ replyMarkup }), {
    reply_markup: replyMarkup,
  });
});

test('buildSendMessageOptions returns empty object without options', () => {
  assert.deepEqual(buildSendMessageOptions(), {});
});

test('setCommands forwards bot commands to the default scope when unpaired', async () => {
  const calls = [];
  const api = Object.create(TelegramApi.prototype);
  api.bot = {
    async setMyCommands(commands, options) {
      calls.push({ commands, options });
    },
  };
  const commands = [
    { command: 'sessions', description: 'Choose a recent Claude or Codex session' },
    { command: 'status', description: 'Show current status' },
  ];

  await api.setCommands(commands);

  assert.deepEqual(calls, [{ commands, options: undefined }]);
});

test('setCommands scopes bot commands to the paired chat only', async () => {
  const calls = [];
  const api = Object.create(TelegramApi.prototype);
  api.bot = {
    async setMyCommands(commands, options) {
      calls.push({ commands, options });
    },
  };
  const commands = [
    { command: 'sessions', description: 'Choose a recent Claude or Codex session' },
    { command: 'status', description: 'Show current status' },
  ];

  await api.setCommands(commands, { chatId: '6314031751' });

  assert.deepEqual(calls, [{ commands, options: { scope: { type: 'chat', chat_id: 6314031751 } } }]);
});
