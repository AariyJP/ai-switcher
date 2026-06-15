# AI Switcher 作業ガイド

## アプリ概要

- AI Switcher は、複数の AI CLI アカウントを切り替えて使うための Tauri 2 デスクトップアプリ。
- 正式名称は `AI Switcher`。crate 名は `ai-switcher`、lib 名は `ai_switcher_lib`、bundle identifier は `ai-switcher.ai-switcher`。
- もともとは Codex CLI 向けのアカウント切り替えアプリだが、現在は Claude Code と Claude Desktop のアカウント管理、利用状況取得、ログアウト、ウォームアップにも対応している。
- デスクトップ版が主用途だが、`ai-web` bin による LAN ダッシュボードもあり、同じ command handler を HTTP 経由で再利用する。
- ローカル checkout ディレクトリ名は `ac-switcher` のままの場合がある。

## 大まかな設計

- `src/` は React 19 + TypeScript + Tailwind v4 + shadcn/ui のフロントエンド。
- `src/App.tsx` は主要画面、アカウント一覧、切り替え確認、プロセス検出、ウォームアップ導線をまとめる中心コンポーネント。
- `src/hooks/useAccounts.ts` はアカウント状態管理の基準となる hook。アカウント CRUD、import / export、usage refresh、warmup、switch などの UI 側入口を持つ。
- `src/lib/platform.ts` は Tauri desktop と LAN web の差を吸収する呼び出し層。Tauri command を呼ぶときは原則ここを経由する。
- `src/components/ui/` は shadcn/ui 系コンポーネント。破壊的確認は `AlertDialog`、汎用モーダルは `Dialog` を使う。
- `src-tauri/` は Rust バックエンド。
- `src-tauri/src/commands/` は Tauri command handler。`account`、`oauth`、`process`、`usage` などの領域ごとに分ける。
- `src-tauri/src/auth/` は認証情報保存、OAuth callback server、account switcher、token refresh を扱う。
- `src-tauri/src/api/usage.rs` は Codex / Claude 系の利用状況取得を扱う。
- `src-tauri/src/bin/ai-web.rs` は LAN ダッシュボード用の HTTP server entrypoint。
- `src-tauri/tauri.conf.json` が基本設定で、`tauri.{macos,linux,windows}.conf.json` は platform 別の上書き設定。
- `scripts/` には version bump、release、Tauri 実行用 shell wrapper がある。

## 重要な不変条件

- アプリ名関連の文字列は `Cargo.toml`、`package.json`、`tauri*.conf.json`、`scripts/release.mjs`、`scripts/bump-version.mjs` で整合させる。
- version は `pnpm version:bump` または `pnpm version:{patch,minor,major}` で同期する。`Cargo.toml`、`package.json`、`tauri.conf.json` の version を手で個別編集しない。
- 新しい Tauri command を追加したら、desktop から呼べるだけでなく、`ai-web` の `/api/invoke/*` 経由でも到達できる状態にする。
- フロントエンドから backend を呼ぶときは、できるだけ `src/lib/platform.ts` の helper を使い、ブラウザ版が壊れないようにする。
- Tauri event listener の cleanup は、`listen` 解決前に unmount される競合を考慮して `cancelled` flag と `unlisten` を組み合わせる。
- updater plugin の Cargo 依存は upstream に寄せるため残すが、この fork では runtime 登録しない。署名鍵と配布元が fork 用に整うまでは updater 機能を有効化しない。

## 依存関係マニフェスト

- `Cargo.toml`、`Cargo.lock`、`package.json`、`pnpm-lock.yaml` と関連するパッケージメタデータは、できるだけ `upstream/main` に近づける。
- 依存関係やパッケージメタデータは、この派生リポジトリのビルド、実行、アプリ識別情報の維持に不可避な場合だけ変更する。
- 依存バージョンやロックファイルを変更する前に `upstream/main` と比較し、この派生リポジトリ固有の理由が明確でない限り upstream 側を優先する。
- `cargo update` や package manager の広範な更新で lockfile を大きく動かさない。必要な場合も差分を確認し、目的外の更新は戻す。

## UI / TypeScript 方針

- shadcn/ui の設計に沿う。破壊的操作の確認には `AlertDialog` を使い、通常の編集・設定 modal には `Dialog` を使う。
- ボタンや form control は既存の `src/components/ui/` と `src/lib/utils.ts` の `cn` pattern に合わせる。
- `any`、不要な `unknown as`、不要な non-null assertion、過剰な optional chaining は避ける。型を狭める helper や既存 type を優先する。
- Tauri API はブラウザ実行時に存在しないため、動的 import と `isTauriRuntime()` guard を使う。
- 長い状態処理は hook に分ける。ただし既存の責務境界を崩す大きな抽象化は避ける。
- 生成するコードには新しいコメントを書かない。既存コメントは消さずに残す。

## Rust / Tauri 方針

- command は小さく保ち、domain ごとの file に置く。
- account / auth / usage / process の既存 module 境界に合わせ、横断的な変更は最小限にする。
- process kill や account switch など破壊的・状態変更を伴う command は、UI 側で確認導線を用意する。
- macOS / Windows / Linux の platform 差分は `tauri.{macos,linux,windows}.conf.json` と platform-specific module に閉じ込める。
- `scripts/tauri.sh` は `cargo` が PATH に無い場合に `~/.cargo/env` を読み込む。Tauri command はこの wrapper 経由で実行する。

## よく使うコマンド

- `pnpm install`: 依存関係を install する。
- `pnpm build`: `tsc && vite build`。型チェックと frontend build。
- `pnpm tauri dev`: desktop app を開発起動する。
- `pnpm tauri build`: production bundle を作る。出力先は `src-tauri/target/release/bundle/`。
- `pnpm dev`: Vite frontend のみ起動する。
- `pnpm lan`: frontend を build し、`ai-web` で LAN dashboard を配信する。
- `cargo check --manifest-path src-tauri/Cargo.toml`: Rust 側の最低限の確認。
- `cargo clippy --manifest-path src-tauri/Cargo.toml`: Rust 側の非自明な変更で使う。
- `pnpm version:bump <semver>`: Tauri / Cargo / frontend の version を指定値に揃える。

## 完了確認

- フロントエンドや UI を触ったら、最低限 `pnpm build` を通す。
- Tauri 起動や desktop 依存の変更を触ったら、`pnpm tauri dev` で起動確認する。
- Rust backend を触ったら、最低限 `cargo check --manifest-path src-tauri/Cargo.toml` を通す。
- production bundle への影響がある場合は `pnpm tauri build` も確認する。
- `git diff --check` で不要な whitespace がないことを確認する。

## Git / コミット

- コミットとプッシュはユーザーが行う。明示的に依頼された場合のみ実行する。
- GitHub remote へのコミットを依頼された場合は Conventional Commits に従い、英語で短く 1 行にする。
- コミット前に GPG 署名設定を確認し、作成後に署名が有効であることを確認する。
- ユーザー向けの回答と GitHub コメントは日本語で書く。
- PR / Issue / コミット参照をユーザー向け文章に書くときは、バッククォートで囲まない。自動リンクが壊れるため。
