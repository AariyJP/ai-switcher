# ai-switcher プロジェクト概要

複数の AI CLI アカウントを管理する Tauri 2 デスクトップアプリ。正式名称は **AI Switcher**。crate は `ai-switcher`、identifier は `ai-switcher.ai-switcher`。もともとは Codex CLI 向けだったが、現在は Claude Code のアカウント切り替えにも対応している。ローカルの checkout ディレクトリ名は `ac-switcher` のままの場合がある。

## 構成

- `src/`: React 19 + TypeScript + Tailwind v4 のフロントエンド。Vite を使用。
  - `components/`、`hooks/useAccounts.ts`、`lib/platform.ts`、`types/`。
- `src-tauri/`: Rust バックエンド。
  - `src/commands/`: Tauri command handler。`account`、`oauth`、`process`、`usage` など。
  - `src/auth/`: `auth.json` の保存、OAuth server、account switcher、token refresh。
  - `src/api/usage.rs`: quota / usage の polling。
  - `src/bin/ai-web.rs`: 代替 HTTP server entrypoint。`pnpm lan` で使う。
  - プラットフォーム別の `tauri.{linux,macos,windows}.conf.json` は上書き設定。
- `scripts/`: `bump-version.mjs`、`release.mjs`、`tauri.sh`。`tauri.sh` は cargo 環境の shim。

## 不変条件

- アプリ名関連の文字列は `Cargo.toml`、`package.json`、`tauri*.conf.json`、scripts 全体で `ai-switcher` / `AI Switcher` / `ai-switcher.ai-switcher` に揃える。気軽に rename しない。release tooling と bundle path が依存している。
- バージョンは Tauri / Cargo / frontend で同期する。変更は `pnpm version:bump` を使う。詳細は `mem:suggested_commands`。
- フロントエンドは Tauri `invoke` 経由でバックエンドと通信する。web/LAN mode の `ai-web` は同じ handler を `/api/invoke/*` として再公開する。

## 関連 memory

- 技術スタック: `mem:tech_stack`
- コマンド: `mem:suggested_commands`
- コード規約: `mem:conventions`
- 完了条件: `mem:task_completion`