# cleanup

ディスクのゴミの候補を調べてレポートし、選んだものだけ消す。

## 読む前に

- **今の書き方は Windows で削除まで1回通しただけ。** 1つ前の書き方では、macOS で削除まで1回、Windows でレポートまで2回通した。Linux では未確認
- **消せるのは目録（`references/catalog.md`）に載っている種類だけ。** 載っていないものは大きくても見せるだけで、消したければ目録に行を足す
- **選んだものは実際に消え、戻せないものもある。** レポートの「失うもの」を読んでから選ぶこと
- **削除できるかは Claude Code の権限の設定によって変わる。** 設定によってはできないことがある。詳しくは Anthropic の公式ドキュメント（[Configure permissions](https://code.claude.com/docs/en/permissions)）を参照

## できること

```
1. 空き容量を記録する
2. サブエージェントがバックグラウンドで測り、目録と突き合わせる（読み取りだけ）
3. 消せる / 持ち主に頼む / 参考 に分けてレポートする
4. 選ばれたものだけ消す
5. 空き容量の差を報告する
```

調査の間も、呼び出したセッションには別の頼みごとができる。セッションの動いているプロジェクトの成果物は消さず、そのセッションに頼む。スクリプトは持たない。

## 空きの見張り（disk-watch の mod）

`mod/` を Claude Code に読み込ませると（`CLAUDE_CODE_PLUGIN_DIRS` のフォルダに symlink を置くなど）、各セッションが起動の1分後と10分おきにホームのあるボリュームの空きを測る。ラインを切ると、そのセッションに「自分のリポジトリを片付ける」よう知らせ、セッションは `self-clean.md` に従ってユーザーに聞かずに片付ける。

- 同じリポジトリ（worktree を含む）を開くセッションが複数あっても、知らせるのは1つ。空きが戻るまで知らせ直さず、戻らなければ1時間おきに知らせ直す
- ラインと、共有のキャッシュ（npm・pnpm など）を片付ける担当のリポジトリは、`config.local.json` の `diskWatch` で決める（`config.example.json`）。既定は 20GB を切ったら知らせ、30GB で戻ったとみる。担当は無し
- Rust は、14日使っていないプロファイル・ターゲットと incremental を消し、それでも戻らなければ `debug/` を丸ごと消す。node_modules は消さない
- ユーザーに聞かずに消す。権限の設定で `rm` などが止められた行は、ほかを済ませてから、まとめて1回ユーザーに許可を聞く（Claude Code の `AskUserQuestion`）
- 実機で確かめたのは macOS（Claude Code 2.1.289）のみ

## 使い方

この skill を読み込んだ `claude` で `/cleanup` と打つ（Codex では `$cleanup`）。消す操作を含むので、「ゴミ掃除して」と頼むだけでは呼ばれない（`disable-model-invocation: true`。Codex 向けには `agents/openai.yaml` の `allow_implicit_invocation: false`）。

## 中身

| | |
| --- | --- |
| `SKILL.md` | 決まりと手順 |
| `agents/openai.yaml` | Codex で、頼まれただけでは呼ばれないようにする設定 |
| `references/survey.md` | 調査を任されたサブエージェントの手順と測り方 |
| `references/catalog.md` | 消してよいものの目録。場所・消し方・失うもの |
| `self-clean.md` | disk-watch の知らせを受けたセッションが、自分のリポジトリを片付ける手順 |
| `mod/` | disk-watch の mod。空きを測り、ラインを切ったらセッションに知らせる |
| `config.example.json` | disk-watch のラインと共有のキャッシュの担当の例 |
