# 技術スタック

## フロントエンド
- React 19、TypeScript ~5.8、Vite 7。
- Tailwind CSS v4。`@tailwindcss/vite` 経由。
- Tauri JS API は `@tauri-apps/api` 2.10 系。plugin は `dialog` 2.6 系、`opener` 2、`process` 2、`updater` 2.10 系。

## バックエンド Rust edition 2021
- Tauri 2.10 系。feature は基本的にプラットフォーム設定側で指定する。
- `tokio` full、`reqwest` json、`serde` / `serde_json`。
- 認証・暗号: `chacha20poly1305`、`sha2`、`base64`、`rand`。
- HTTP server: `tiny_http`。`codex-web` LAN mode で使う。
- その他: `chrono`、`uuid` v4、`dirs`、`webbrowser`、`urlencoding`、`url`、`flate2`、`futures`、`thiserror`、`anyhow`。

## パッケージマネージャー
- `pnpm` を使う。`pnpm-lock.yaml` が基準。npm / yarn は使わない。

## プラットフォーム別設定
- `src-tauri/tauri.conf.json` が base。`tauri.{macos,linux,windows}.conf.json` はビルド時の上書き設定。