# Repository Guidelines

## Project Structure & Module Organization
- Node.js ESM CLI (Node 18+). Entry: `bin/hey.js`.
- `src/` core:
  - `index.js` bootstraps the wrapper; `config.js` reads/writes `~/.heyagent/config.json`; `logger.js` logs to `~/.heyagent/logs/`.
  - `notification.js` sends desktop/webhook/Pro notifications.
  - `claude/` integrates with Claude: `claude-wrapper.js`, `hook.js`, `hook-setup.js`, `slash-command-setup.js` (writes to `~/.claude/`).
  - `codex/` integrates with Codex CLI: `codex-wrapper.js` (stdout-listening, no hooks).
- Tooling: `eslint.config.js`, `.prettierrc`, `package.json`. See `README.md` for usage.

## Build, Test, and Development Commands
- `npm start -- claude [args]` — run the CLI locally (e.g., `npm start -- claude -c`).
- `npm start -- codex [args]` — run Codex path (e.g., `npm start -- codex -c`).
- `npm run lint` / `npm run lint:fix` — lint code / auto‑fix.
- `npm run format` / `npm run format:check` — format with Prettier / verify formatting.
- `npm run check` — run lint and formatting checks.
- `npm run pack:test` — smoke‑test the packed CLI in a temp app.
- `npm run pack` — build a `.tgz`; `npm run pack:install` installs it globally for manual testing.

## Coding Style & Naming Conventions
- Prettier: 2‑space indent, semicolons, single quotes, `printWidth: 150`, `trailingComma: es5`, `arrowParens: avoid`.
- ESLint (flat config): `prefer-const`, `no-var`, `no-unused-vars` (ignore `_` args), `no-console` allowed.
- Files: lowercase kebab‑case (e.g., `config-setup.js`). Classes in PascalCase; functions/vars in camelCase.
- ESM only (`type: module`). Use `import`/`export`, no CommonJS.

## Testing Guidelines
- No formal unit tests yet. Use `npm run pack:test` for a quick smoke test.
- If adding tests, prefer Node’s built‑in `node:test`. Name files `*.test.js` alongside source or under `test/`; keep tests fast and side‑effect free.

## Commit & Pull Request Guidelines
- Commits: concise, imperative (e.g., "Add Slack webhook validation"); optional prefixes (`feat:`, `fix:`) welcome but not required.
- PRs: include summary, rationale, CLI examples (command + output), and any config/log paths touched.
- Link related issues; call out user‑visible changes and behavior risks.

## Security & Configuration Tips
- Do not commit real license keys, webhook URLs, phone numbers, or chat IDs.
- Setup modifies user files: `~/.heyagent/*` and `~/.claude/*`. Back up before testing changes to hook/command setup.
- Network calls target `https://www.heyagent.dev/` for validation/notifications; handle failures gracefully.


