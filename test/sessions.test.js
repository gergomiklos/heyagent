import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gatherSessions, parseClaudeSessionFile, parseCodexSessionFile } from '../src/sessions.js';

async function makeHome() {
  return mkdtemp(path.join(os.tmpdir(), 'heyagent-sessions-'));
}

async function writeJsonl(filePath, entries) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, entries.map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n'));
}

test('gatherSessions combines Claude and Codex sessions sorted newest first', async () => {
  const homeDir = await makeHome();
  const claudeFile = path.join(homeDir, '.claude', 'projects', '-Users-geert-code-alpha', 'claude-1.jsonl');
  const codexFile = path.join(homeDir, '.codex', 'sessions', '2026', '05', '29', 'codex-1.jsonl');

  await writeJsonl(claudeFile, [
    {
      type: 'user',
      timestamp: '2026-05-29T08:00:00.000Z',
      message: { content: [{ type: 'text', text: 'start Claude work' }] },
    },
    {
      type: 'assistant',
      message: { model: 'claude-sonnet-4-20250514' },
    },
  ]);
  await writeJsonl(codexFile, [
    {
      type: 'session_meta',
      timestamp: '2026-05-29T09:00:00.000Z',
      payload: {
        id: 'codex-1',
        cwd: '/Users/geert/code/beta',
        timestamp: '2026-05-29T09:00:00.000Z',
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-05-29T10:00:00.000Z',
      payload: {
        role: 'user',
        content: [{ type: 'input_text', text: 'continue Codex work' }],
      },
    },
  ]);

  const sessions = await gatherSessions({ homeDir, maxAgeDays: 3650 });

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, 'codex-1');
  assert.equal(sessions[0].agentType, 'codex');
  assert.equal(sessions[0].project, 'beta');
  assert.equal(sessions[1].id, 'claude-1');
  assert.equal(sessions[1].agentType, 'claude');
  assert.equal(sessions[1].project, 'alpha');
});

test('parseClaudeSessionFile ignores corrupt lines and returns last user message', async () => {
  const homeDir = await makeHome();
  const filePath = path.join(homeDir, 'claude.jsonl');
  await writeJsonl(filePath, [
    '{not-json',
    {
      type: 'user',
      timestamp: '2026-05-29T08:00:00.000Z',
      message: { content: [{ type: 'text', text: 'first question' }] },
    },
    {
      type: 'user',
      timestamp: '2026-05-29T09:00:00.000Z',
      message: { content: [{ type: 'text', text: 'latest question' }] },
    },
  ]);

  const session = parseClaudeSessionFile(filePath, 'claude-session', '-Users-geert-code-myproject');

  assert.equal(session.id, 'claude-session');
  assert.equal(session.title, 'first question');
  assert.equal(session.lastUserMessage, 'latest question');
  assert.equal(session.lastUserMessageAt, '2026-05-29T09:00:00.000Z');
  assert.equal(session.cwd, '/Users/geert/code/myproject');
});

test('gatherSessions uses Codex thread names from session index', async () => {
  const homeDir = await makeHome();
  const codexFile = path.join(homeDir, '.codex', 'sessions', '2026', '05', '29', 'codex-title.jsonl');
  const indexFile = path.join(homeDir, '.codex', 'session_index.jsonl');

  await writeJsonl(codexFile, [
    {
      type: 'session_meta',
      timestamp: '2026-05-29T09:00:00.000Z',
      payload: {
        id: 'codex-title',
        cwd: '/Users/geert/code/heyagent',
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-05-29T10:00:00.000Z',
      payload: {
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /Users/geert/code/heyagent' }],
      },
    },
  ]);
  await writeJsonl(indexFile, [
    {
      id: 'codex-title',
      thread_name: 'Voeg sessiekeuze toe',
      updated_at: '2026-05-29T10:00:00.000Z',
    },
  ]);

  const sessions = await gatherSessions({ homeDir, maxAgeDays: 3650 });

  assert.equal(sessions[0].id, 'codex-title');
  assert.equal(sessions[0].title, 'Voeg sessiekeuze toe');
});

test('gatherSessions uses Claude Desktop local session titles', async () => {
  const homeDir = await makeHome();
  const claudeFile = path.join(homeDir, '.claude', 'projects', '-Users-geert-code-bvgeert', 'claude-title.jsonl');
  const localSessionFile = path.join(
    homeDir,
    'Library',
    'Application Support',
    'Claude',
    'claude-code-sessions',
    'workspace',
    'project',
    'local-session.json'
  );

  await writeJsonl(claudeFile, [
    {
      type: 'user',
      timestamp: '2026-05-29T08:00:00.000Z',
      message: { content: 'pull' },
    },
  ]);
  await mkdir(path.dirname(localSessionFile), { recursive: true });
  await writeFile(
    localSessionFile,
    JSON.stringify({
      sessionId: 'local-1',
      cliSessionId: 'claude-title',
      title: 'Telegram plugin installation',
    })
  );

  const sessions = await gatherSessions({ homeDir, maxAgeDays: 3650 });

  assert.equal(sessions[0].id, 'claude-title');
  assert.equal(sessions[0].title, 'Telegram plugin installation');
});

test('parseCodexSessionFile skips sessions without a user message', async () => {
  const homeDir = await makeHome();
  const filePath = path.join(homeDir, 'codex.jsonl');
  await writeJsonl(filePath, [
    {
      type: 'session_meta',
      timestamp: '2026-05-29T09:00:00.000Z',
      payload: { id: 'codex-empty', cwd: '/Users/geert/code/empty' },
    },
  ]);

  assert.equal(parseCodexSessionFile(filePath), null);
});

test('gatherSessions skips files older than maxAgeDays', async () => {
  const homeDir = await makeHome();
  const oldFile = path.join(homeDir, '.codex', 'sessions', '2026', '05', '29', 'old.jsonl');
  await writeJsonl(oldFile, [
    {
      type: 'session_meta',
      timestamp: '2026-05-29T09:00:00.000Z',
      payload: { id: 'old-session', cwd: '/Users/geert/code/old' },
    },
    {
      type: 'response_item',
      timestamp: '2026-05-29T10:00:00.000Z',
      payload: { role: 'user', content: [{ type: 'input_text', text: 'old prompt' }] },
    },
  ]);
  await utimes(oldFile, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));

  const sessions = await gatherSessions({ homeDir, maxAgeDays: 1 });

  assert.deepEqual(sessions, []);
});
