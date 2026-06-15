# Memory 管理

## 発見モデル

- 基本原則は、参照をたどる段階的な発見と memory graph の構築。
- 初期状態では agent に memory 名の一覧だけが渡される。
- agent は最上位 entrypoint として `mem:core` を読む。
- `mem:core` には、主要な project domain を扱う他 memory への参照を置く。
- 参照先 memory には、さらに具体的な memory への参照を置いてよい。graph の深さは project の複雑さに合わせる。
- 関連 memory は topic / folder でまとめ、構造を明示する。folder はフロントエンド / バックエンドのような project 構造でも、デバッグ / アーキテクチャのような topic でもよい。
- memory 参照はバッククォート内で `mem:` prefix を使う。例: `mem:frontend/core`。
- 参照文は、いつ何を読むべきかが分かるように書く。memory 名だけより具体的な案内にする。
- memory 自体には「いつ読むか」を書かない。それは参照元 memory の責務。

## 文体

- agent 向けの密度の高いメモとして書く。長い説明文ではなく、不変条件と短い bullet を優先する。
- よくあるミスを防ぐ場合を除き、明らかな背景説明、理由、例は避ける。
- task 固有ではなく、長く使える一般化された guidance を残す。

## 追加・更新の基準

- 将来の再調査コストを減らす、安定した非自明な project convention だけを追加・更新する。
- 追加しないもの: すぐ読める事実、一般的な言語・framework 知識、一回限りの task note、変わりやすい行単位の詳細、近いうちに変わる可能性が高い挙動。

## 管理操作

- memory rename は Serena の memory rename tool 経由で行うと参照が自動更新される。
- stale memory の確認が必要な場合は `serena memories check` で report を確認する。