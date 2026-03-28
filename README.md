# HeyAgent CLI

HeyAgent CLI is a bidirectional Telegram bridge for Claude Code and Codex.
Send and receive Telegram messages with Codex or Claude (and switch any time).

Fully free, fully open source, and fully local — no server or external storage required.

### v2 Update

Note: before v2, this project focused on notification integration for CLI coding agents.

## Installation

```bash
npm install -g heyagent
```

## Usage

```bash
# Resume latest session (default)
hey claude
hey codex

# Create new session
hey claude --new
hey codex --new

# Run with explicit session id
hey claude --session [SESSION-ID]   # resumes given session
hey codex --session [SESSION-ID]    # resumes given session

# Show local pairing/session status
hey status

# Reset Telegram setup (clears bot token + chat pairing)
hey reset

# Non-interactive reset
hey reset --yes
```

## Setup and Pairing Flow

Start with `hey claude` or `hey codex`.

On first run, HeyAgent will:

1. Ask for setup mode:
   - **Phone setup** (recommended) — scan one QR code and complete guided steps on your phone
   - **Manual fallback** — no tunnel required; paste the bot token directly into the terminal
2. In phone setup mode, CLI starts a temporary local server exposed via a Cloudflare Quick Tunnel and shows a single QR code. (This same tool is handy for reaching your local dev environment from your phone.)
3. Complete guided steps on phone:
   - Open BotFather
   - Create your own bot
   - Submit bot token
   - Open bot chat and press START
4. CLI validates token, waits for pairing, and stores bot + chat locally.

Manual fallback avoids tunneling completely:

1. Create your own bot
2. Paste bot token into the terminal.
3. CLI shows bot opening link/QR for pairing.

If recommended phone onboarding fails in your environment, install system `cloudflared`
(for example `brew install cloudflared`) or choose manual fallback.

## Telegram Commands

Inside Telegram:

- `/help` list commands
- `/new` force next prompt to run as a new session
- `/claude [session-id]` switch active provider to Claude, optionally binding a specific local session
- `/codex [session-id]` switch active provider to Codex, optionally binding a specific local session
- `/sessions [provider] [count]` list recent local sessions for Claude or Codex
- `/use <n>` or `/use <provider> <n>` bind one of the sessions from the latest `/sessions` list
- `/status` show provider, directory, bot, session, and pairing
- `/stop` stop current execution and clear queued messages

Any other text message is forwarded to the active agent.
For voice input, keyboard dictation on your phone is recommended.

## Local CLI Input

When running in an interactive terminal, HeyAgent also accepts live local input.

- Plain text: run prompt through provider and send response to Telegram
- `/ask <prompt>` same as plain text
- `/say <text>` send raw message directly to Telegram
- `/new` force next prompt to start a fresh session
- `/stop` stop current execution and clear queued Telegram messages
- `/claude [session-id]` switch to Claude, optionally binding a specific local session
- `/codex [session-id]` switch to Codex, optionally binding a specific local session
- `/sessions [provider] [count]` list recent local sessions
- `/use <n>` or `/use <provider> <n>` bind one of the sessions from the latest list
- `/status` print local bridge status
- `/help` show local commands
- `/exit` stop the running bridge

CLI logs are shown for inbound Telegram commands, local prompts, and outgoing messages.

## Provider Execution

Default runtime:

- `claude --dangerously-skip-permissions -p --output-format json "<prompt>"`
- `codex exec --dangerously-bypass-approvals-and-sandbox --json "<prompt>"`

You can override default bypass behavior by passing explicit provider permission flags, for example:

- `hey claude --permission-mode acceptEdits`
- `hey codex --full-auto`

Session startup strategy:

- `--new` force first prompt to start fresh session
- `--session <session-id>` : resumes the session given by its id
- default (no startup flag): same as `--resume` / `--continue`, resume latest in current provider/project

## Session Selection

HeyAgent can bind a provider to a specific local session after startup.

Examples:

```bash
# List recent Claude sessions
/sessions claude

# Switch to the first listed Claude session
/use claude 1

# Bind a specific Codex session id directly
/codex 019d2a28-4b23-74e2-a660-b7acde2dd541
```

When HeyAgent has local metadata for the selected session, it restores the provider using that
session's recorded working directory. This is especially useful for Claude sessions, which are
scoped to the original project directory.

## Notes

- Fully local-served
- Sleep prevention is always enabled while bridge is running.
- Lid-close sleep is not reliably controllable by app-level code:
  - macOS: use clamshell mode setup (external power/display/input) for closed-lid operation.
  - Windows/Linux: requires OS power settings or admin-level policy changes.
- Polling-only runtime (no webhooks).
- One chat per running CLI process.
- If you send new messages while a request is in progress, HeyAgent queues and groups those messages into the next run.
- Telegram attachments are forwarded to the active provider (documents, images, audio, voice notes, and videos).
- Config is stored at `~/.heyagent/config.json`
- `/use` depends on the most recent `/sessions` result in the current running HeyAgent process.

## License

MIT License - see LICENSE file for details.
