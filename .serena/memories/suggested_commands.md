# 推奨コマンド

## 開発 / ビルド
- `pnpm install`: 依存関係を install する。
- `pnpm tauri dev`: デスクトップアプリを開発モードで起動する。
- `pnpm tauri build`: 本番用 bundle を作成する。出力先は `src-tauri/target/release/bundle/`。
- `pnpm dev`: Vite のフロントエンドだけを起動する。Tauri shell は使わない。
- `pnpm build`: `tsc && vite build`。型チェックとフロントエンドのビルドを実行する。
- `pnpm lan`: フロントエンドをビルドし、`ai-web` bin で dashboard を HTTP 配信する。
  - 環境変数: `AI_SWITCHER_WEB_HOST`、`AI_SWITCHER_WEB_PORT`。

## バージョン管理 / リリース
- `pnpm version:bump <semver>`: Tauri / Cargo / フロントエンドの version を指定 version に揃える。
- `pnpm version:{patch,minor,major}`: version を bump する。
- `pnpm release <patch|minor|major> [-- --push]`: bump、commit、tag を行う。`--push` 指定時のみ push も行う。

## Rust 直接実行
- `cargo run --manifest-path src-tauri/Cargo.toml --bin ai-web`: LAN server を直接起動する。
- `cargo build --manifest-path src-tauri/Cargo.toml`: バックエンドのみビルドする。通常は Tauri 経由を使うため頻度は低い。

## macOS 注意点
- `scripts/tauri.sh` は `cargo` が PATH に無い場合に `~/.cargo/env` を source する。Tauri script はこれを経由するため、むやみに bypass しない。
- `package.json` には project 全体の lint / format command は無い。`pnpm build` 経由の `tsc` と、必要に応じた `cargo check` / `clippy` を使う。