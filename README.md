# HeyAgent

### Get notified when Claude Code and Codex CLI need your attention!

HeyAgent supports most of the CLI coding agents, use it for free!

## Installation

Install globally via npm:

```bash
npm install -g heyagent
```

## Quick Start

1. Install the package globally
2. Run `hey claude` to start Claude Code with notifications
3. Or run `hey codex` to start OpenAI Codex CLI with notifications
4. Or run `hey gemini/droid/...` to start any CLI agent with notifications

## Usage

### Basic Commands

```bash
# Start Claude Code with notifications
hey claude

# Start Codex CLI with notifications
hey codex

# Start Gemini CLI with notifications
hey gemini

# Start basically any CLI coding agent with notifications!
hey [YOUR-AGENT]

# Pass arguments to Claude/Codex
hey claude --help
hey claude -c    # Continue last session
hey codex resume --latest    # Continue last session

# Configure notification settings
hey config

# Manage license for paid notification channels
hey license

# Toggle notifications
hey on           # Enable notifications
hey off          # Disable notifications

# Setup without starting Claude (hooks and slash commands)
hey setup claude

# Show help
hey help
```

### Notification Methods

HeyAgent supports multiple notification methods:

- **Desktop notifications** (default)
- **Email notifications\***
- **WhatsApp notifications\***
- **Telegram notifications\***
- **Slack notifications\***
- **Custom webhook notifications**

Configure your preferred method with `hey config`.

\*Pro notification channels require a license. Run `hey license` to set up.

### Slash Commands (within Claude Code only)

While Claude is running, you can use:

```
/hey on          # Enable notifications
/hey off         # Disable notifications
```

## How It Works

HeyAgent wraps your Claude Code or Codex CLI session:

- Claude Code: uses hooks and slash commands for event-driven notifications.
- Codex CLI: listens to stdout and sends a notification after inactivity.

## Requirements

- Node.js 18 or higher
- Claude Code CLI or OpenAI Codex CLI installed
- HeyAgent license for paid notification channels

## Support

- Official website: https://heyagent.dev
- Issues: Report bugs and feature requests on GitHub

## License

MIT License - see LICENSE file for details.
