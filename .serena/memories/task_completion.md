# Task Completion Checklist

No CI-enforced lint/format target exists. Before declaring a coding task done:

## Frontend changes
- `pnpm build` — runs `tsc` (type-check) + Vite build. Must pass.
- If UI was touched, exercise it via `pnpm tauri dev` (desktop) or `pnpm lan` (browser) and confirm the golden path.

## Backend (Rust) changes
- `cargo check --manifest-path src-tauri/Cargo.toml` at minimum.
- `cargo clippy --manifest-path src-tauri/Cargo.toml` if non-trivial.
- If a new Tauri command was added: confirm it is registered in `src-tauri/src/commands/mod.rs` AND reachable from the `codex-web` bin (it forwards via `/api/invoke/*`).

## Cross-cutting
- Version bumps: always via `pnpm version:bump` — never edit `Cargo.toml` / `package.json` / `tauri.conf.json` versions by hand.
- Don't commit. User handles git operations unless explicitly asked.
