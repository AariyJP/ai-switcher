# Tech Stack

## Frontend
- React 19, TypeScript ~5.8, Vite 7
- Tailwind CSS v4 (via `@tailwindcss/vite`)
- Tauri JS APIs: `@tauri-apps/api` 2.10, plugins: `dialog` 2.6, `opener` 2, `process` 2, `updater` 2.10

## Backend (Rust, edition 2021)
- Tauri 2.10 (features empty — features set per-platform in conf)
- tokio (full), reqwest (json), serde / serde_json
- Auth/crypto: `chacha20poly1305`, `sha2`, `base64`, `rand`
- HTTP server: `tiny_http` (for `codex-web` LAN mode)
- Misc: `chrono`, `uuid` v4, `dirs`, `webbrowser`, `urlencoding`, `url`, `flate2`, `futures`, `thiserror`, `anyhow`

## Package manager
- `pnpm` (see `pnpm-lock.yaml`). Don't use npm/yarn.

## Per-platform config
- `src-tauri/tauri.conf.json` is the base; `tauri.{macos,linux,windows}.conf.json` provide overrides used at build time.
