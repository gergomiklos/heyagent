import path from 'path';
import os from 'os';

/**
 * Get the Claude Code configuration directory.
 * Respects CLAUDE_CONFIG_DIR environment variable, falls back to ~/.claude
 * @returns {string} The Claude configuration directory path
 */
export function getClaudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
