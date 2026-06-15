# Task 完了チェックリスト

CI で強制される lint / format target は無い。coding task を完了扱いにする前に、以下を確認する。

## フロントエンド変更
- `pnpm build`: `tsc` による型チェックと Vite build を実行する。必ず通す。
- UI を触った場合は `pnpm tauri dev` のデスクトップ、または `pnpm lan` のブラウザで主要な動線を確認する。

## バックエンド Rust 変更
- 最低限 `cargo check --manifest-path src-tauri/Cargo.toml` を実行する。
- 非自明な変更では `cargo clippy --manifest-path src-tauri/Cargo.toml` も実行する。
- 新しい Tauri command を追加した場合は、`src-tauri/src/commands/mod.rs` に登録されていることと、`codex-web` bin からも到達可能であることを確認する。`codex-web` は `/api/invoke/*` 経由で forward する。

## 横断的な確認
- Version bump は必ず `pnpm version:bump` を使う。`Cargo.toml`、`package.json`、`tauri.conf.json` の version を手で編集しない。
- コミットしない。git 操作はユーザーが行う。明示的に依頼された場合だけ実行する。