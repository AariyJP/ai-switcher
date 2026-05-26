# ai-switcher — Project Core

Tauri 2 desktop app for managing multiple AI CLI accounts. Officially renamed to **AI Switcher** (crate `ai-switcher`, identifier `ai-switcher.ai-switcher`). Originally Codex CLI–focused; now also supports Claude Code account switching. Local checkout dir may still be `ac-switcher`.

## Layout

- `src/` — React 19 + TS + Tailwind v4 frontend (Vite).
  - `components/`, `hooks/useAccounts.ts`, `lib/platform.ts`, `types/`.
- `src-tauri/` — Rust backend.
  - `src/commands/` — Tauri command handlers (`account`, `oauth`, `process`, `usage`).
  - `src/auth/` — auth.json storage, OAuth server, account switcher, token refresh.
  - `src/api/usage.rs` — quota/usage polling.
  - `src/bin/ai-web.rs` — alternate HTTP server entrypoint (`pnpm lan`).
  - Per-platform `tauri.{linux,macos,windows}.conf.json` overrides.
- `scripts/` — `bump-version.mjs`, `release.mjs`, `tauri.sh` (cargo env shim).

## Invariants

- App-name strings are unified as `ai-switcher` / `AI Switcher` / `ai-switcher.ai-switcher` across `Cargo.toml`, `package.json`, `tauri*.conf.json`, scripts. Don't rename casually — release tooling and bundle paths depend on these.
- Version is kept in sync across Tauri, Cargo, frontend via `pnpm version:bump` (see `mem:suggested_commands`).
- Frontend talks to backend via Tauri `invoke`; the web/LAN mode (`ai-web`) re-exposes the same handlers at `/api/invoke/*`.

## See also

- Stack details: `mem:tech_stack`
- Commands: `mem:suggested_commands`
- Code style/conventions: `mem:conventions`
- What "done" means: `mem:task_completion`
