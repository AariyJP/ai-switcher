# Conventions

## Code comments
- Per global user rule: **do not add new comments** in generated code. Preserve existing ones if present.

## Commits
- User handles commits/pushes — do not commit unless explicitly asked.
- When asked: Conventional Commits, short & concise. Verify GPG signing is on.
- Don't backtick PR/issue/commit refs in user-facing text (breaks autolinks).

## Language
- User-facing replies and any GitHub comments: **Japanese**.

## Frontend
- React 19 function components + hooks (`src/hooks/useAccounts.ts` is the canonical state hook for accounts).
- Tailwind v4 utility-first; no CSS modules.
- Tauri invocations go through helpers in `src/lib/platform.ts` so the same UI works under desktop and the `codex-web` LAN dashboard.

## Backend
- Tauri commands registered from `src-tauri/src/commands/mod.rs`; each domain (account/oauth/process/usage) is its own file.
- Auth/credential persistence lives under `src-tauri/src/auth/storage.rs`; switching logic in `auth/switcher.rs`; OAuth callback HTTP in `auth/oauth_server.rs`.
- `ai-web` (bin) re-uses the same command functions and exposes them at `/api/invoke/<cmd>` — keep new commands callable from both.

## App-identity strings
- Crate name is `ai-switcher`, lib is `ai_switcher_lib`, bundle identifier is `net.aariy.ai-switcher`, product name is "AI Switcher". Changes to these must stay in sync across `Cargo.toml`, `package.json`, `tauri*.conf.json`, `scripts/release.mjs`, and `scripts/bump-version.mjs`.
