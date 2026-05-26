# Suggested Commands

## Dev / build
- `pnpm install` — install deps.
- `pnpm tauri dev` — run desktop app in dev.
- `pnpm tauri build` — production bundle → `src-tauri/target/release/bundle/`.
- `pnpm dev` — Vite-only frontend (no Tauri shell).
- `pnpm build` — `tsc && vite build` (type-check + frontend build).
- `pnpm lan` — build frontend and serve dashboard over HTTP via `ai-web` bin.
  - Env: `AI_SWITCHER_WEB_HOST`, `AI_SWITCHER_WEB_PORT`.

## Versioning / release
- `pnpm version:bump <semver>` — set exact version across Tauri/Cargo/frontend.
- `pnpm version:{patch,minor,major}` — bump.
- `pnpm release <patch|minor|major> [-- --push]` — bump + commit + tag (+ optional push).

## Rust direct
- `cargo run --manifest-path src-tauri/Cargo.toml --bin ai-web` — run LAN server directly.
- `cargo build --manifest-path src-tauri/Cargo.toml` — backend-only build (rare; usually go through Tauri).

## Darwin notes
- `scripts/tauri.sh` sources `~/.cargo/env` if `cargo` isn't on PATH — Tauri scripts go through it, so don't bypass.
- No project-wide lint/format command wired in `package.json`; rely on `tsc` (via `pnpm build`) and `cargo check`/`clippy` ad hoc.
