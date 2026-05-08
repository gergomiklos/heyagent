import { createWriteStream } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { runProcess } from './process-runner.js';

const CHECK_TIMEOUT_MS = 10 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_MODEL_NAME = 'ggml-base.en.bin';
const DEFAULT_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
const MAX_DOWNLOAD_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MODEL_DIR = path.join(os.homedir(), '.heyagent', 'models');
const DEFAULT_MODEL_PATH = path.join(DEFAULT_MODEL_DIR, DEFAULT_MODEL_NAME);
const PLATFORM = os.platform();

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

function getBinaryCandidates(binaryName) {
  const defaults = [binaryName];

  if (PLATFORM === 'darwin') {
    return uniqueValues([...defaults, `/opt/homebrew/bin/${binaryName}`, `/usr/local/bin/${binaryName}`, `/usr/bin/${binaryName}`]);
  }

  if (PLATFORM === 'linux') {
    return uniqueValues([...defaults, `/usr/local/bin/${binaryName}`, `/usr/bin/${binaryName}`, `/bin/${binaryName}`]);
  }

  if (PLATFORM === 'win32') {
    return uniqueValues([...defaults, `${binaryName}.exe`]);
  }

  return defaults;
}

function buildUnavailableState(reason) {
  return {
    available: false,
    backend: 'local',
    reason,
    async transcribeTelegramVoice() {
      throw new Error(reason);
    },
  };
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasCommand(command, args = ['--help']) {
  try {
    await runProcess(command, args, { timeoutMs: CHECK_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function resolveBinary(options = {}) {
  const name = String(options.name || '').trim();
  if (!name) {
    return null;
  }

  const checkArgs = Array.isArray(options.checkArgs) && options.checkArgs.length > 0 ? options.checkArgs : ['--help'];
  const envVarName = String(options.envVarName || '').trim();
  const envOverride = envVarName ? String(process.env[envVarName] || '').trim() : '';

  const candidates = uniqueValues([
    envOverride,
    ...getBinaryCandidates(name),
    ...(Array.isArray(options.extraCandidates) ? options.extraCandidates : []),
  ]);

  for (const candidate of candidates) {
    const isAbsolute = path.isAbsolute(candidate);
    if (isAbsolute && !(await fileExists(candidate))) {
      continue;
    }

    if (await hasCommand(candidate, checkArgs)) {
      return candidate;
    }
  }

  return null;
}

async function convertToWav(ffmpegCommand, inputPath, outputPath) {
  const result = await runProcess(
    ffmpegCommand,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-ac', '1', '-ar', '16000', outputPath],
    {
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
    }
  );

  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || 'ffmpeg conversion failed').trim());
  }
}

async function runWhisperCli(whisperCliCommand, wavPath, modelPath, outputPrefix) {
  const result = await runProcess(whisperCliCommand, ['-m', modelPath, '-f', wavPath, '-otxt', '-of', outputPrefix], {
    timeoutMs: TRANSCRIBE_TIMEOUT_MS,
  });

  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `whisper-cli exited with code ${result.code}`).trim());
  }

  const transcriptPath = `${outputPrefix}.txt`;
  const text = (await readFile(transcriptPath, 'utf8')).trim();
  if (!text) {
    throw new Error('whisper-cli returned an empty transcript');
  }

  return text;
}

function toErrorMessage(error) {
  return error?.message ? String(error.message) : String(error);
}

function openHttpStream(url, redirectsRemaining = MAX_DOWNLOAD_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      const statusCode = Number(response.statusCode || 0);

      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error(`Too many redirects while downloading model from ${url}`));
          return;
        }

        const redirectUrl = new URL(response.headers.location, url).toString();
        resolve(openHttpStream(redirectUrl, redirectsRemaining - 1));
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Model download failed with HTTP ${statusCode}`));
        return;
      }

      resolve(response);
    });

    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error(`Model download timed out after ${Math.floor(DOWNLOAD_TIMEOUT_MS / 1000)} seconds`));
    });

    request.on('error', reject);
  });
}

async function downloadModelFile(targetPath) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.download-${Date.now()}`;

  try {
    const stream = await openHttpStream(DEFAULT_MODEL_URL);
    await pipeline(stream, createWriteStream(tempPath));
    await rename(tempPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw new Error(`Failed to download ${DEFAULT_MODEL_NAME}: ${toErrorMessage(error)}`);
  }
}

async function resolveModelPath(modelPathFromEnv) {
  const explicitPath = String(modelPathFromEnv || '').trim();
  if (explicitPath) {
    if (!(await fileExists(explicitPath))) {
      throw new Error(`Whisper model not found: ${explicitPath}`);
    }

    return {
      modelPath: explicitPath,
      modelHint: 'custom',
      modelCanDownload: false,
      isModelReady: async () => true,
      ensureModelReady: async () => explicitPath,
    };
  }

  const cacheCandidates = [DEFAULT_MODEL_PATH, path.join(os.homedir(), '.cache', 'whisper.cpp', DEFAULT_MODEL_NAME)];
  for (const candidate of cacheCandidates) {
    if (await fileExists(candidate)) {
      return {
        modelPath: candidate,
        modelHint: 'auto (cached)',
        modelCanDownload: false,
        isModelReady: async () => true,
        ensureModelReady: async () => candidate,
      };
    }
  }

  let ensurePromise = null;

  return {
    modelPath: DEFAULT_MODEL_PATH,
    modelHint: 'auto (downloads on first voice note)',
    modelCanDownload: true,
    isModelReady: async () => fileExists(DEFAULT_MODEL_PATH),
    async ensureModelReady() {
      if (await fileExists(DEFAULT_MODEL_PATH)) {
        return DEFAULT_MODEL_PATH;
      }

      if (!ensurePromise) {
        ensurePromise = downloadModelFile(DEFAULT_MODEL_PATH)
          .then(() => DEFAULT_MODEL_PATH)
          .finally(() => {
            ensurePromise = null;
          });
      }

      return ensurePromise;
    },
  };
}

export async function createVoiceTranscriber() {
  const ffmpegCommand = await resolveBinary({
    name: 'ffmpeg',
    envVarName: 'HEYAGENT_FFMPEG_PATH',
    checkArgs: ['-version'],
  });
  if (!ffmpegCommand) {
    return buildUnavailableState('ffmpeg is not installed or not available on PATH.');
  }

  const whisperCliCommand = await resolveBinary({
    name: 'whisper-cli',
    envVarName: 'HEYAGENT_WHISPER_CLI_PATH',
    checkArgs: ['--help'],
  });
  if (!whisperCliCommand) {
    return buildUnavailableState('whisper-cli is not installed or not available on PATH.');
  }

  let modelResolver;
  try {
    modelResolver = await resolveModelPath(process.env.HEYAGENT_WHISPER_MODEL);
  } catch (error) {
    return buildUnavailableState(toErrorMessage(error));
  }

  return {
    available: true,
    backend: 'ffmpeg + whisper-cli',
    ffmpegCommand,
    whisperCliCommand,
    modelPath: modelResolver.modelPath,
    modelHint: modelResolver.modelHint,
    modelCanDownload: modelResolver.modelCanDownload,
    isModelReady: modelResolver.isModelReady,
    reason: null,
    async transcribeTelegramVoice(telegramApi, fileId) {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'heyagent-voice-'));
      try {
        const inputPath = await telegramApi.downloadFile(fileId, tmpDir);
        const wavPath = path.join(tmpDir, 'voice.wav');
        const outputPrefix = path.join(tmpDir, 'transcript');
        const modelPath = await modelResolver.ensureModelReady();

        await convertToWav(ffmpegCommand, inputPath, wavPath);
        return await runWhisperCli(whisperCliCommand, wavPath, modelPath, outputPrefix);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

export function formatVoiceTranscriberStatus(state) {
  if (!state || !state.available) {
    const reason = state?.reason ? ` (${state.reason})` : '';
    return `unavailable${reason}`;
  }

  const modelHint = state.modelHint ? `, model: ${state.modelHint}` : '';
  return `enabled (${state.backend}${modelHint})`;
}
