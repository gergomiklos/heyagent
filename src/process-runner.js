import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

export function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd || process.cwd();
  const signal = options.signal || null;
  const onStdout = typeof options.onStdout === 'function' ? options.onStdout : null;
  const onStderr = typeof options.onStderr === 'function' ? options.onStderr : null;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let completed = false;

    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timeout = null;

    const onAbort = () => {
      if (completed) {
        return;
      }

      completed = true;
      clearTimeout(timeout);
      child.kill('SIGTERM');
      reject(new Error(`${command} aborted`));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timeout = setTimeout(() => {
      if (completed) {
        return;
      }
      completed = true;
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${Math.floor(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      if (onStdout) {
        onStdout(text);
      }
    });

    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      if (onStderr) {
        onStderr(text);
      }
    });

    child.on('error', error => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeout);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      reject(error);
    });

    child.on('close', code => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeout);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
