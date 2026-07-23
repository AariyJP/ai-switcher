<p align="center">
  <img src="src-tauri/icons/logo.svg" alt="AI Switcher" width="128" height="128">
</p>

<h1 align="center">AI Switcher</h1>

Codex、Claude Code、Claude Desktop、Cursor の複数アカウントを管理するデスクトップアプリ。
アカウントの切り替え、利用状況の確認、ウォームアップのスケジュールを簡単に行い、利用枠を自分でコントロールできます。

## 特徴

- **複数アカウント管理** – Codex、Claude Code、Claude Desktop の複数アカウントを一箇所で追加・リネーム・マスク・インポート・エクスポート・管理
- **クイック切り替え** – メインウィンドウ、ネイティブトレイメニュー、トレイポップアップからアカウントを切り替え
- **利用状況統計** – OAuth アカウントの累計トークン、日別集計、連続利用日数、活動傾向、よく使う連携先などを表示
- **手動リセットクレジット** – 各アカウントのプランバッジ横に利用可能な手動リセットクレジットを表示し、期限が近づくとハイライト
- **自動ウォームアップ** – 単一アカウントまたは全アカウントを手動で、あるいは 5 時間リセット後や指定した時刻に自動でウォームアップ
- **システムトレイ操作** – トレイポップアップからアカウント切り替え、利用枠・アクティブアカウント統計の確認、利用状況の再取得、メインウィンドウを開く、アプリの終了が可能
- **トレイ表示モード** – セッション利用率付きアプリアイコン、時間/週単位の利用率のみのテキスト表示、トレイアイコン非表示のいずれかを選択
- **macOS Dock 制御** – AI Switcher を Dock に表示するか、メニューバーのみのアプリとして動作させるかを選べ、初回終了時に確認プロンプトとトレイへのフォールバックあり
- **利用枠モニタリング** – 5 時間セッションと週次利用状況、リセットタイミング、クレジット、サブスクリプション期限をリアルタイムで表示
- **切り替えブロックからの復旧** – Codex/Claude のプロセスが起動中であることを検出し、アカウント切り替えを再試行する前に強制終了フローを提示
- **デュアルログインモード** – OAuth 認証、または既存の認証情報ファイルのインポートに対応
- **LAN ダッシュボード** – 同じ UI とアカウント操作を HTTP 経由で配信し、同じネットワーク上の別デバイスからも管理可能

## ダウンロード

### Windows

#### Microsoft Store

https://apps.microsoft.com/detail/9n060nm19l1q?mode=full  
<a href="https://apps.microsoft.com/detail/9n060nm19l1q?mode=full" target="_blank" rel="noopener noreferrer">
 <img src="https://get.microsoft.com/images/ja%20dark.svg" width="200"/>
</a>

#### WinGet

```bash
winget install AISwitcher.AISwitcher
```

### macOS

[リリースページ](https://github.com/AariyJP/ai-switcher/releases/latest)から[`AI.Switcher_aarch64.dmg`](https://github.com/AariyJP/ai-switcher/releases/latest/download/AI.Switcher_aarch64.dmg)をダウンロードしてください。

未署名のため「アプリが壊れている」と表示されたら以下を実行してください。

```bash
xattr -rc "/Applications/AI Switcher.app"
```

## 謝辞

AI Switcher は [Lampese](https://github.com/Lampese) 氏による [Codex Switcher](https://github.com/Lampese/codex-switcher) のフォークです。
