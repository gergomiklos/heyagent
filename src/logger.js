import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

let logDirEnsured = false;

class Logger {
  constructor(service = 'heyagent') {
    this.service = service;
    this.logDir = path.join(os.homedir(), '.heyagent', 'logs');
  }

  getLogFile() {
    const date = new Date().toLocaleDateString('en-CA');
    return path.join(this.logDir, `heyagent-${date}.log`);
  }

  async ensureLogDir() {
    if (logDirEnsured) return;

    try {
      await fs.access(this.logDir);
    } catch {
      await fs.mkdir(this.logDir, { recursive: true });
    }
    logDirEnsured = true;
  }

  async writeToFile(logEntry) {
    await this.ensureLogDir();
    await fs.appendFile(this.getLogFile(), logEntry, 'utf8');
  }

  log(level, msg) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level.toUpperCase()}] [${this.service}] ${msg}\n`;

    // Fire-and-forget async write
    this.writeToFile(logEntry).catch(err => {
      process.stderr.write(`Logging failed: ${err.message}\n`);
    });
  }

  error(msg) {
    this.log('error', msg);
  }

  info(msg) {
    this.log('info', msg);
  }

  warn(msg) {
    this.log('warn', msg);
  }

  debug(msg) {
    this.log('debug', msg);
  }
}

export default Logger;
