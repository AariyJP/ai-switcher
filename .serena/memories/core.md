# ac-switcher — Project Core

Tauri 2 desktop app for managing multiple AI CLI accounts. Originally Codex CLI–focused (`codex-switcher`); the `develop` branch adds Claude Code account switching, hence the repo rename to `ac-switcher` (AI CLI switcher).

## Layout

- `src/` — React 19 + TS + Tailwind v4 frontend (Vite).
  - `components/`, `hooks/useAccounts.ts`, `lib/platform.ts`, `types/`.
- `src-tauri/` — Rust backend.
  - `src/commands/` — Tauri command handlers (`account`, `oauth`, `process`, `usage`).
  - `src/auth/` — auth.json storage, OAuth server, account switcher, token refresh.
  - `src/api/usage.rs` — quota/usage polling.
  - `src/bin/codex-web.rs` — alternate HTTP server entrypoint (`pnpm lan`).
  - Per-platform `tauri.{linux,macos,windows}.conf.json` overrides.
- `scripts/` — `bump-version.mjs`, `release.mjs`, `tauri.sh` (cargo env shim).

## Invariants

- App-name strings still say `codex-switcher` in `Cargo.toml`, `package.json`, `tauri.conf.json` even though the repo dir is `ac-switcher`. Don't rename casually — release tooling and bundle paths depend on these.
- Version is kept in sync across Tauri, Cargo, frontend via `pnpm version:bump` (see `mem:suggested_commands`).
- Frontend talks to backend via Tauri `invoke`; the web/LAN mode (`codex-web`) re-exposes the same handlers at `/api/invoke/*`.

## See also

- Stack details: `mem:tech_stack`
- Commands: `mem:suggested_commands`
- Code style/conventions: `mem:conventions`
- What "done" means: `mem:task_completion`
