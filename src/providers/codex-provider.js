import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../process-runner.js';

function createOutputFile() {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), `heyagent-codex-${nonce}.txt`);
}

function pickValue(candidate) {
  return typeof candidate === 'string' ? candidate.trim() : '';
}

function extractFromContent(content, depth = 0) {
  if (depth > 6) {
    return '';
  }

  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string' && item.trim()) {
        parts.push(item.trim());
      } else if (item && typeof item === 'object') {
        const text =
          pickValue(item.text) ||
          pickValue(item.output_text) ||
          pickValue(item.output) ||
          extractFromContent(item.content, depth + 1) ||
          extractFromContent(item.message, depth + 1) ||
          extractFromContent(item.output, depth + 1);
        if (text) {
          parts.push(text);
        }
      }
    }
    return parts.join('\n').trim();
  }

  if (content && typeof content === 'object') {
    const direct = pickValue(content.text) || pickValue(content.output_text) || pickValue(content.output) || pickValue(content.delta);

    if (direct) {
      return direct;
    }

    return (
      extractFromContent(content.content, depth + 1) ||
      extractFromContent(content.message, depth + 1) ||
      extractFromContent(content.output, depth + 1) ||
      extractFromContent(content.response, depth + 1) ||
      extractFromContent(content.item, depth + 1) ||
      extractFromContent(content.result, depth + 1)
    );
  }

  return '';
}

function formatTail(text, maxLines = 30, maxChars = 2000) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return '';
  }

  const lines = normalized
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const tail = lines.slice(-maxLines).join('\n');
  if (tail.length <= maxChars) {
    return tail;
  }

  return tail.slice(-maxChars);
}

function collectSessionIdCandidates(event) {
  if (!event || typeof event !== 'object') {
    return [];
  }

  return [
    pickValue(event.session_id),
    pickValue(event.sessionId),
    pickValue(event.thread_id),
    pickValue(event.threadId),
    pickValue(event.session?.id),
    pickValue(event.thread?.id),
    pickValue(event.payload?.id),
    pickValue(event.payload?.session_id),
    pickValue(event.payload?.sessionId),
    pickValue(event.payload?.thread_id),
    pickValue(event.payload?.threadId),
    pickValue(event.data?.id),
    pickValue(event.data?.session_id),
    pickValue(event.data?.sessionId),
    pickValue(event.data?.thread_id),
    pickValue(event.data?.threadId),
    pickValue(event.result?.session_id),
    pickValue(event.result?.sessionId),
    pickValue(event.result?.thread_id),
    pickValue(event.result?.threadId),
    pickValue(event.response?.session_id),
    pickValue(event.response?.sessionId),
    pickValue(event.response?.thread_id),
    pickValue(event.response?.threadId),
  ].filter(Boolean);
}

function parseCodexJsonLines(rawText) {
  const lines = rawText
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const texts = [];
  const errors = [];
  const sessionIds = [];
  let streamedText = '';

  for (const line of lines) {
    if (!line.startsWith('{')) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      const eventType = pickValue(event.type).toLowerCase();
      const sessionIdCandidates = collectSessionIdCandidates(event);
      for (const sessionId of sessionIdCandidates) {
        sessionIds.push(sessionId);
      }

      if (event.type === 'result' && event.is_error) {
        if (Array.isArray(event.errors)) {
          errors.push(...event.errors.map(error => String(error)));
        }
        if (typeof event.error === 'string') {
          errors.push(event.error);
        }
      }

      if (eventType.includes('error') || event.is_error) {
        const errorText =
          pickValue(event.error) || pickValue(event.message) || extractFromContent(event.errors) || extractFromContent(event.result?.error);
        if (errorText) {
          errors.push(errorText);
        }
      }

      if (eventType.endsWith('.delta') && pickValue(event.delta)) {
        streamedText += event.delta;
      }

      const directText =
        pickValue(event.text) || pickValue(event.message) || pickValue(event.output_text) || pickValue(event.output) || pickValue(event.delta);
      const contentText =
        extractFromContent(event.content) ||
        extractFromContent(event.message?.content) ||
        extractFromContent(event.response?.content) ||
        extractFromContent(event.response?.output) ||
        extractFromContent(event.item) ||
        extractFromContent(event.result);

      if (directText) {
        texts.push(directText);
      }
      if (contentText) {
        texts.push(contentText);
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  if (streamedText.trim()) {
    texts.push(streamedText.trim());
  }

  return {
    text: texts.length > 0 ? texts[texts.length - 1] : '',
    error: errors.length > 0 ? errors[errors.length - 1] : '',
    sessionId: sessionIds.length > 0 ? sessionIds[sessionIds.length - 1] : '',
  };
}

function extractProgressText(event) {
  if (!event || typeof event !== 'object') {
    return '';
  }

  const eventType = pickValue(event.type).toLowerCase();
  const delta = typeof event.delta === 'string' ? event.delta : '';
  if (eventType.endsWith('.delta') && delta) {
    return delta;
  }

  return '';
}

function createCodexProgressParser(onProgress) {
  if (typeof onProgress !== 'function') {
    return null;
  }

  let pending = '';
  return chunk => {
    pending += String(chunk || '');
    const lines = pending.split('\n');
    pending = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('{')) {
        continue;
      }

      try {
        const event = JSON.parse(line);
        const progressText = extractProgressText(event);
        if (progressText) {
          onProgress(progressText);
        }
      } catch {
        // Ignore partial or non-event output.
      }
    }
  };
}

export async function runCodexPrompt(prompt, options = {}) {
  const resume = Boolean(options.resume);
  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
  const sessionId = pickValue(options.sessionId);
  const onSessionId = typeof options.onSessionId === 'function' ? options.onSessionId : null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const cwd = options.cwd || process.cwd();
  const abortSignal = options.abortSignal || null;
  const outputFile = resume ? null : createOutputFile();
  const parseProgressChunk = createCodexProgressParser(onProgress);

  const args = resume
    ? sessionId
      ? ['exec', ...extraArgs, 'resume', '--json', sessionId, '--', prompt]
      : ['exec', ...extraArgs, 'resume', '--json', '--last', '--', prompt]
    : ['exec', ...extraArgs, '--json', '--output-last-message', outputFile, '--', prompt];

  try {
    const result = await runProcess('codex', args, {
      cwd,
      timeoutMs: 20 * 60 * 1000,
      signal: abortSignal,
      onStdout: parseProgressChunk,
    });

    const parsed = parseCodexJsonLines(result.stdout || '');
    if (parsed.sessionId && onSessionId) {
      onSessionId(parsed.sessionId);
    }

    let output = '';

    if (outputFile && fs.existsSync(outputFile)) {
      output = fs.readFileSync(outputFile, 'utf8').trim();
    }

    if (!output) {
      output = parsed.text;

      if (!output) {
        output = parsed.error;
      }

      if (!output && result.code !== 0) {
        output = parsed.error || (result.stderr || '').trim();
      }
    }

    if (!output && result.code !== 0) {
      throw new Error((result.stderr || '').trim() || `Codex exited with code ${result.code}`);
    }

    if (!output) {
      const stderrTail = formatTail(result.stderr || '');
      const stdoutTail = formatTail(result.stdout || '');

      if (stderrTail) {
        return `Codex returned no assistant message.\n\nstderr tail:\n${stderrTail}`;
      }
      if (stdoutTail) {
        return `Codex returned no assistant message.\n\nstdout tail:\n${stdoutTail}`;
      }
      return 'Codex returned no assistant message.';
    }

    return output;
  } finally {
    try {
      if (outputFile) {
        fs.unlinkSync(outputFile);
      }
    } catch {
      // Ignore temp cleanup failures.
    }
  }
}
