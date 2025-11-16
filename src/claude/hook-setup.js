import fs from 'fs';
import path from 'path';
import Logger from '../logger.js';
import { getClaudeConfigDir } from './claude-config.js';

class HookSetup {
  constructor() {
    this.logger = new Logger('hook-setup');
    // settings.json schema for reference ({hooks: {Stop: [{hooks: [{type, command}]}]}}):
    this.hookCommand = {
      type: 'command',
      command: 'hey claude-hook',
    };
    this.hookTypes = ['Stop', 'Notification'];
  }

  // Use global Claude settings file only
  getSettingsPath() {
    return path.join(getClaudeConfigDir(), 'settings.json');
  }

  loadSettings(settingsPath) {
    try {
      if (fs.existsSync(settingsPath)) {
        return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      }
    } catch (error) {
      this.logger.error(`Error reading settings file ${settingsPath}: ${error.message}`);
    }
    return {};
  }

  saveSettings(settingsPath, settings) {
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (error) {
      this.logger.error(`Error saving settings file ${settingsPath}: ${error.message}`);
      throw error;
    }
  }

  // Check if command already exists in hooks array
  hasHook(hooks, command) {
    return hooks?.some(hookGroup => hookGroup.hooks?.some(hook => hook.command === command));
  }

  // Add hook command to settings if not already present
  addHook(settings, type) {
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks[type]) settings.hooks[type] = [];

    if (!this.hasHook(settings.hooks[type], this.hookCommand.command)) {
      settings.hooks[type].push({ hooks: [this.hookCommand] });
    }

    return settings;
  }

  // Remove hook command from settings and clean up empty groups
  removeHook(settings, type) {
    settings.hooks[type] = settings.hooks[type]
      .map(hookGroup => {
        return { hooks: hookGroup.hooks?.filter(hook => hook.command !== this.hookCommand.command) || [] };
      })
      .filter(hookGroup => hookGroup.hooks.length > 0);

    return settings;
  }

  setupHooks() {
    const settingsPath = this.getSettingsPath();
    const settings = this.loadSettings(settingsPath);

    this.hookTypes.forEach(type => this.addHook(settings, type));

    this.saveSettings(settingsPath, settings);
    this.logger.info(`Claude hooks configured in: ${settingsPath}`);

    return settingsPath;
  }

  cleanupHooks() {
    const settingsPath = this.getSettingsPath();

    if (!fs.existsSync(settingsPath)) {
      this.logger.info('No settings file found, nothing to clean up');
      return settingsPath;
    }

    const settings = this.loadSettings(settingsPath);

    if (!settings.hooks) {
      this.logger.info('No hooks found in settings, nothing to clean up');
      return settingsPath;
    }

    this.hookTypes.forEach(type => this.removeHook(settings, type));
    this.saveSettings(settingsPath, settings);
    this.logger.info(`Claude hooks removed from: ${settingsPath}`);

    return settingsPath;
  }
}

export default HookSetup;
