import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process-runner.js';

const CHECK_TIMEOUT_MS = 60 * 1000;
const SYNTHESIZE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_LANG = 'a';
const DEFAULT_VOICE = 'af_heart';
const DEFAULT_SPEED = 1.0;
const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kokoro-synthesize.py');

function toErrorMessage(error) {
  return error?.message ? String(error.message) : String(error);
}

function uniqueValues(values = []) {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .map(value => String(value).trim())
        .filter(Boolean)
    ),
  ];
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasCommand(command, args = ['--version']) {
  try {
    await runProcess(command, args, { timeoutMs: CHECK_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function getPythonCandidates() {
  return uniqueValues([process.env.HEYAGENT_KOKORO_PYTHON, 'python3.12', 'python3.11', 'python3.10', 'python3', 'python']);
}

async function isUsablePythonCommand(command) {
  const isAbsolute = path.isAbsolute(command);
  if (isAbsolute && !(await fileExists(command))) {
    return false;
  }

  return hasCommand(command);
}

async function resolvePythonWithKokoro() {
  const candidates = getPythonCandidates();
  let sawPython = false;
  const dependencyErrors = [];

  for (const candidate of candidates) {
    const isAbsolute = path.isAbsolute(candidate);
    if (isAbsolute && !(await fileExists(candidate))) {
      continue;
    }

    if (!(await isUsablePythonCommand(candidate))) {
      continue;
    }

    sawPython = true;

    try {
      await checkKokoroDependencies(candidate);
      return {
        pythonCommand: candidate,
        error: null,
      };
    } catch (error) {
      dependencyErrors.push(`${candidate}: ${toErrorMessage(error)}`);
    }
  }

  return {
    pythonCommand: null,
    error: sawPython
      ? `Kokoro Python dependencies are unavailable. Checked: ${dependencyErrors.join(' | ')}`
      : 'python3 is not installed or not available on PATH.',
  };
}

async function checkKokoroDependencies(pythonCommand) {
  const result = await runProcess(pythonCommand, ['-c', 'import kokoro, soundfile, numpy; print("ok")'], { timeoutMs: CHECK_TIMEOUT_MS });

  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || 'Kokoro Python dependencies are not installed.').trim());
  }
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function prepareTtsText(text, maxChars) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 44)).trim()}\n\nResponse truncated for audio.`;
}

function buildUnavailableState(reason) {
  return {
    available: false,
    backend: 'kokoro',
    reason,
    async synthesize() {
      throw new Error(reason);
    },
  };
}

export async function createKokoroTts() {
  const runtime = await resolvePythonWithKokoro();
  const pythonCommand = runtime.pythonCommand;
  if (!pythonCommand) {
    return buildUnavailableState(
      `${runtime.error || 'python3 is not installed or not available on PATH.'} Install with: python3 -m pip install 'kokoro>=0.9.4' soundfile numpy`
    );
  }

  const lang = String(process.env.HEYAGENT_KOKORO_LANG || DEFAULT_LANG).trim() || DEFAULT_LANG;
  const voice = String(process.env.HEYAGENT_KOKORO_VOICE || DEFAULT_VOICE).trim() || DEFAULT_VOICE;
  const speed = parsePositiveNumber(process.env.HEYAGENT_KOKORO_SPEED, DEFAULT_SPEED);
  const maxChars = Math.floor(parsePositiveNumber(process.env.HEYAGENT_TTS_MAX_CHARS, DEFAULT_MAX_CHARS));

  return {
    available: true,
    backend: 'kokoro',
    pythonCommand,
    lang,
    voice,
    speed,
    maxChars,
    reason: null,
    async synthesize(text) {
      const preparedText = prepareTtsText(text, maxChars);
      if (!preparedText) {
        throw new Error('No text available for audio.');
      }

      const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'heyagent-tts-'));
      const textPath = path.join(tmpDir, 'input.txt');
      const outputPath = path.join(tmpDir, 'response.wav');

      try {
        await mkdir(tmpDir, { recursive: true });
        await writeFile(textPath, preparedText, 'utf8');

        const result = await runProcess(
          pythonCommand,
          [SCRIPT_PATH, '--text-file', textPath, '--output', outputPath, '--voice', voice, '--lang', lang, '--speed', String(speed)],
          { timeoutMs: SYNTHESIZE_TIMEOUT_MS }
        );

        if (result.code !== 0) {
          throw new Error((result.stderr || result.stdout || `Kokoro exited with code ${result.code}`).trim());
        }

        await readFile(outputPath);
        return {
          audioPath: outputPath,
          cleanup: () => rm(tmpDir, { recursive: true, force: true }),
        };
      } catch (error) {
        await rm(tmpDir, { recursive: true, force: true });
        throw error;
      }
    },
  };
}

export function formatKokoroTtsStatus(state) {
  if (!state || !state.available) {
    const reason = state?.reason ? ` (${state.reason})` : '';
    return `unavailable${reason}`;
  }

  return `enabled (${state.backend}, voice: ${state.voice}, lang: ${state.lang}, max chars: ${state.maxChars})`;
}
