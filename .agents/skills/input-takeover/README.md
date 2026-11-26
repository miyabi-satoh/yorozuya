# input-takeover

同じマシンで動く複数のエージェントのセッションが、キーボード・マウス・フォーカスを同時に奪い合って、クリックや入力が互いの窓に入るのを防ぐ。奪う前にユーザーの了承を取り、マシンに1つの鍵（[machine-locks](../machine-locks/README.md) の input の鍵）を置き、終わったら外してユーザーに知らせる。

## 読む前に

- **[machine-locks](../machine-locks/README.md) が隣のフォルダーに要る。** mod は鍵を machine-locks の `scripts/locks.cjs` で扱う。無ければ、入力を奪う操作を全部止める
- **mod は Claude Code 用。** Claude Code の function hooks（早期アクセスの API）に頼っていて、版ごとに変わりうる。Claude Code 2.1.332 で確かめた。`SKILL.md` の手順そのものは、ほかのエージェントでも読める
- **mod が見分けるのは、コマンドの名前と API の名前だけ。** `osascript`・`cliclick`・`xdotool`・`screencapture`（窓か範囲を指して撮るだけのものを除く）と、PowerShell の SendKeys・UI Automation。スクリプトの中で使うものは見分けられないので、`SKILL.md` の手順で自分で鍵を置く
- **鍵は、鍵を見るセッションどうしのかち合いだけを減らす。** 鍵を見ないエージェントやユーザーの手元の操作には効かない

## できること

- 入力を奪う操作の前に、何をどのくらいの時間奪うかと、その間にユーザーがしてよいこと・いけないことを、ダイアログで問う（通知が届くので、席を外していても気づける）。了承から10分のうちは、鍵を持ったまま別の操作に移るときに問い直さない
- 鍵の無い入力を奪う操作と、ほかのセッションの鍵が効いている間の操作を止める
- 鍵を返したとき・持ち主のセッションが終わったとき・落ちたとき・見込みの時間を過ぎたときに、会話・toast・OS の通知でユーザーに知らせる（同じマシンの1つのセッションだけが出す）
- 立ち上がり直したセッションが、前の自分（同じ作業フォルダのセッション）の鍵を引き継ぐ
- 環境ごとの注意（キーボードとマウスをほかのマシンと共有しているなど）を、設定ファイルからダイアログとセッションに出す

## 使い方

1. `.agents/skills/input-takeover/` と `.agents/skills/machine-locks/` を、使う側の skill のディレクトリ（Claude Code なら `~/.claude/skills/`）に symlink で置く
2. mod を使うなら、`mod/` をプラグインのフォルダーとして読み込ませる（`claude --plugin-dir <このディレクトリ>/mod`、または `~/.claude/settings.json` の `env` の `CLAUDE_CODE_PLUGIN_DIRS`）。新しく足した mod は、動いているセッションには、起動し直すまで読み込まれない
3. 環境ごとの注意があれば、`~/.claude/input-takeover-rules.json` に書く（書き方は `SKILL.md` の「環境ごとの注意」）。無ければ、このマシンのキーボードとマウスに触れないでもらうことだけを問う

## 中身

| | |
| --- | --- |
| `SKILL.md` | 手順 |
| `mod/` | 鍵のツール・止める見張り・知らせ（テストは `claude plugin test mod`） |
