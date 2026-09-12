# Yorozuya

[Herdr](https://herdr.dev) 上で動いている Claude Code のセッションを、別のセッションから再起動するための skill。

## 読む前に

- **Herdr が要る。** tmux ではない
- **macOS でしか実機確認していない**
- **handoff（引き継ぎ資料）を書く skill が別に要る。** 既定は [Matt Pocock 氏の skills](https://github.com/mattpocock/skills) の `/mattpocock-skills:handoff`。差し替えられる
- **Claude Code と Herdr の、公式に保証されていない振る舞いに頼っている。** どちらの更新でも壊れうる（[頼っている外部の振る舞い](#頼っている外部の振る舞い)）
- **対象のセッションを終了させる道具。** 走っているバックグラウンドの処理は巻き添えになる
- **照合と `/exit` は一続きにできない。** herdr にはセッションを指定して送る手段が無いので、照合した直後に同じペインの中身が入れ替わると、入れ替わった相手に届く。実行中は対象のペインを他から操作しないこと

## できること

ひとつのセッションが、別のセッションを handoff を取ってから再起動する。

```
1. 引き継ぎ資料を書かせる
2. claude を終了させる
3. 起動する
4. 資料を読ませる
```

呼び出し元のセッション自身も、自ペインを分割して立て直せる。

## 仕組み

**判断はセッションが持ち、スクリプトは後戻りできない連鎖だけを引き受ける。**

依頼はペインの入力欄に打ち込む。handoff の skill は `disable-model-invocation` なものが多く、メッセージからは呼べないため。**結果は打ち込まず、対象に返信させる。**
資料の絶対パスは対象が言葉で返してくるので、画面を覗いて探す必要がない。

```
呼び出し元 → herdr agent prompt でペインに依頼を打ち込む
対象      → 資料を書き、絶対パスを添えて返信する
呼び出し元 → ファイルの存在を確かめる
呼び出し元 → scripts/restart.mjs に渡す（/exit → 起動 → 読ませる）
```

`/exit` と起動の間、対象はセッションの無いペインになる。
ここでターンをまたぐと対象が取り残されるので、**この4手だけは1つのプロセスで走り切る。**

## 使い方

1. ターミナルで [Herdr](https://herdr.dev) を起動する
2. このリポジトリを clone したディレクトリに移動する
3. `claude` を起動する

あとは Claude に頼む。**スクリプトを直接叩く必要はない。**

> このペインのセッションを再起動して
>
> 自分自身を再起動して

`.claude/skills/` から skill を読み込んでいる。他のプロジェクトで使うなら、`.agents/skills/restart-sessions/` を自分の skill ディレクトリに置けばよい。

## 中身

| | |
| --- | --- |
| `.agents/skills/restart-sessions/SKILL.md` | 手順と判断の基準 |
| `.agents/skills/restart-sessions/scripts/` | 後戻りできない連鎖だけ |
| `AGENTS.md` | このリポジトリでの運用ルール。`CLAUDE.md` から import している |

スクリプトが外部に呼び出すのは `herdr` と `node` だけ。Claude Code と handoff の skill は「読む前に」のとおり別に要る。

## 頼っている外部の振る舞い

公式に保証されたインターフェースではないので、更新で壊れうる。

**Claude Code**

- `/exit` の後、前景のプロセスグループがシェルに戻る
- `@<path>` で資料が読み込まれる

**Herdr**

- `herdr agent list` / `agent get` / `agent prompt` / `agent start` / `pane process-info` / `pane current` / `pane split` の JSON 出力の構造
- 終了の確認画面が出れば `blocked` と判定する
- 承認・質問ダイアログ待ちの相手には `agent prompt` が届かない（`agent_blocked` で弾かれる）
- エージェント終了後に名前が外れる
- 閉じたペインのIDは使い回されない（照合したペインと `/exit` や `pane close` を送るペインが同じであることは、これに頼っている）

壊れたときは、このどれが変わったかから当たりを付ける。
止まり方は SKIP と FAIL で、どちらも**対象のセッションには手を付けていない**か、`claude --resume <ID>` で戻せる状態で止まる。
