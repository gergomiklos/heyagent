import fs from 'fs';
import path from 'path';
import os from 'os';
import Logger from '../logger.js';

class SlashCommandSetup {
  constructor() {
    this.logger = new Logger('slash-command-setup');
  }

  // Use global Claude commands directory only
  getCommandsPath() {
    return path.join(os.homedir(), '.claude', 'commands');
  }

  // Create /hey slash command for toggling notifications
  setupCommands() {
    const commandsPath = this.getCommandsPath();
    const heyCommandPath = path.join(commandsPath, 'hey.md');

    const commandContent = `---
description: Toggle HeyAgent notifications on/off
---

When the user runs '/hey on', immediately run the 'hey on' command to start the HeyAgent notification service.
When the user runs '/hey off', immediately run the 'hey off' command to stop the HeyAgent notification service.
When the user runs '/hey' with other arguments, pass them through: 'hey $ARGUMENTS'

!hey $ARGUMENTS`;

    // Ensure commands directory exists
    if (!fs.existsSync(commandsPath)) {
      fs.mkdirSync(commandsPath, { recursive: true });
    }

    // Write hey.md command file
    fs.writeFileSync(heyCommandPath, commandContent);
    this.logger.info(`Created custom claude slash command: ${heyCommandPath}`);

    return commandsPath;
  }

  // Remove /hey slash command
  cleanupCommands() {
    const commandsPath = this.getCommandsPath();
    const heyCommandPath = path.join(commandsPath, 'hey.md');

    if (fs.existsSync(heyCommandPath)) {
      fs.unlinkSync(heyCommandPath);
      this.logger.info(`Removed custom claude slash command: ${heyCommandPath}`);
    }

    return commandsPath;
  }
}

export default SlashCommandSetup;
