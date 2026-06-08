# 規約

## コードコメント
- グローバルルールに従い、生成するコードには新しいコメントを書かない。既存コメントは消さずに残す。

## コミット
- コミットとプッシュはユーザーが行う。明示的に依頼された場合のみ実行する。
- 依頼された場合は Conventional Commits に従い、短く簡潔な 1 行にする。GPG 署名が有効であることを確認する。
- ユーザー向けの文章では PR / Issue / コミット参照をバッククォートで囲まない。自動リンクが壊れるため。

## 言語
- ユーザーへの回答と GitHub コメントは必ず日本語にする。

## フロントエンド
- React 19 の関数コンポーネントと hooks を使う。`src/hooks/useAccounts.ts` がアカウント状態管理の基準となる hook。
- Tailwind v4 のユーティリティファースト。CSS Modules は使わない。
- Tauri 呼び出しは `src/lib/platform.ts` のヘルパー経由にする。デスクトップ版と `codex-web` の LAN ダッシュボード版の両方で同じ UI が動くようにする。

## バックエンド
- Tauri command は `src-tauri/src/commands/mod.rs` から登録する。各領域は `account` / `oauth` / `process` / `usage` のようにファイルを分ける。
- 認証情報の永続化は `src-tauri/src/auth/storage.rs`、切り替え処理は `auth/switcher.rs`、OAuth callback HTTP は `auth/oauth_server.rs` に置く。
- `ai-web` bin は同じ command 関数を再利用し、`/api/invoke/<cmd>` で公開する。新しい command は Tauri と web/LAN の両方から呼べる状態にする。

## 依存関係マニフェスト
- `Cargo.toml`、`Cargo.lock`、`package.json`、`pnpm-lock.yaml` と関連するパッケージメタデータは、できるだけ `upstream/main` に近づける。
- 依存関係やパッケージメタデータは、この派生リポジトリのビルド、実行、アプリ識別情報の維持に不可避な場合だけ変更する。
- 依存バージョンやロックファイルを変更する前に `upstream/main` と比較し、この派生リポジトリ固有の理由が明確でない限り upstream 側を優先する。

## アプリ識別情報の文字列
- crate 名は `ai-switcher`、lib は `ai_switcher_lib`、bundle identifier は `ai-switcher.ai-switcher`、product name は `AI Switcher`。これらを変更する場合は `Cargo.toml`、`package.json`、`tauri*.conf.json`、`scripts/release.mjs`、`scripts/bump-version.mjs` の整合性を保つ。