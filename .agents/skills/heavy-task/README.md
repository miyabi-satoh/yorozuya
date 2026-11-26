# heavy-task

重い処理（ビルド・テスト・依存の一括インストール・重いフック付きの push など）を始める前に、マシンの CPU の空きを測り、始める・待つ・ユーザーに聞くのどれかを決める。同じマシンで複数のエージェントのセッションを動かすとき、重い処理が重なってマシン全体が詰まるのを避ける。重い処理を始めたら60秒だけ鍵（[machine-locks](../machine-locks/README.md) の cpu の鍵）を置き、ほぼ同時に測ったほかのセッションが、始めたばかりの負荷を見落として重ねるのも防ぐ。

## 読む前に

- **始める瞬間の鍵には、[machine-locks](../machine-locks/README.md) が隣のフォルダーに要る。** 無ければ、鍵を使わずに CPU の空きだけを見る

- **何が重いかは、使う側のプロジェクトの `.claude/heavy-commands.json` に書く。** このファイルが無いプロジェクトでは、hook は既定のコマンドだけを見る（既定と書き方は下の「使い方」4）
- **hook と mod は Claude Code 用。** `SKILL.md` の手順そのものは、ほかのエージェントでも読める
- **hook が拾うコマンドには、`SKILL.md` の手順は要らない。** hook が同じ目安で測って止める。手順を使うのは、hook の無いエージェントと、hook が拾わないコマンド（下の「hook の見方」）
- **mod は Claude Code の function hooks（早期アクセスの API）に頼っている。** 版ごとに変わりうる。Claude Code 2.1.289 で確かめた
- **止めて知らせるところまで実物で通したのは macOS だけ。** hook が CPU の厳しさで止め、mod が空きを測り続けて知らせるところまで、macOS（Claude Code 2.1.289）で確かめた。始める瞬間の鍵は、macOS（Claude Code 2.1.332）で、hook が置き、ほかのセッションの重い処理を止めるところまでテストで確かめた。Windows 11（Claude Code 2.1.296・Node.js 26.5.0）では、CPU の空きを測るところまで確かめた。hook が止めるところと mod は試していない。Linux の測り方（`os.cpus()`）はコードにあるが、実物では試していない
- **`run-in-tab.mjs` を実物で通したのは macOS（Herdr 0.9.3・hc 0.1.21）だけ。** Windows では `pwsh` で流す形にしてあるが、試していない
- **`run-in-tab.mjs` のタブ名は、Claude Code の内部のファイル（`~/.claude/sessions/<pid>.json`）からセッションの名前を読む。** 公開された API ではないので、版によって読めなくなりうる。読めなければリポジトリの名前を付ける
- **CPU の空きだけを見る。** 測れないとき・入力が読めないときは、止めずに通す

## できること

- `SKILL.md`: hook が拾わない重い処理を始める直前に、CPU の空きを測る手順。CPU の空きが 10% を切っていれば、5分おきに3回（計15分）測り直し、それでも厳しければユーザーに聞く。打ち切られたときにマシンの状態を採取する手順もある
- `scripts/guard-heavy-commands.cjs`: Claude Code の PreToolUse の hook。重いコマンドを、CPU の空きが 10% を切っているときと、ほかのセッションが重い処理を始めて60秒のうちに止める。通したら、始める瞬間の鍵を置く。`--admit` で、hook の拾わない重い処理にも同じ判断をする
- `scripts/run-in-tab.mjs`: コマンドを Herdr の別のタブか hc の別の端末で流し、出力・終了コード・シグナルをファイルに残す。待つ側が打ち切られても、タブの処理は続き、`--attach` で待ち直せる。`--expect <分>` を過ぎても終わらなければ、タブは止めずに待つ側だけが 124 で返る（バックグラウンドで待つエージェントの目覚まし）
- `mod/`（heavy-wait）: hook が止めたのを見て、1分ごとに空きとほかのセッションの始める瞬間の鍵を見て、始めてよくなったら（15分たっても始められなければそのことも）セッションに知らせる。セッションは自分で測り直して待たずに、知らせを待つ間に軽い作業を進められる

## 使い方

1. `.agents/skills/heavy-task/` を、使う側の skill のディレクトリ（Claude Code なら `~/.claude/skills/` か、プロジェクトの `.claude/skills/`）に symlink で置く
2. hook を `~/.claude/settings.json` の `hooks` に足す（パスは置いた場所に合わせる）

   ```json
   "PreToolUse": [
     {
       "matcher": "Bash|PowerShell|Workflow",
       "hooks": [{ "type": "command", "command": "node \"<このディレクトリ>/scripts/guard-heavy-commands.cjs\"", "timeout": 10 }]
     }
   ]
   ```

3. mod を使うなら、`mod/` をプラグインのフォルダーとして読み込ませる（`claude --plugin-dir <このディレクトリ>/mod`、または `~/.claude/settings.json` の `env` の `CLAUDE_CODE_PLUGIN_DIRS`）
   - 新しく足した mod は、そのとき動いているセッションには、起動し直すまで読み込まれない（読み込み済みの mod のファイルは、保存すれば読み直される）。動いているセッションは再起動する。再起動しないと、hook は重い処理を止めるのに、空いた知らせは届かない
4. 重いコマンドを、プロジェクトの `.claude/heavy-commands.json` に書く

   ```json
   {
     "defaults": true,
     "heavy": ["just ci", "pnpm build", { "regex": "^(pnpm|npm)( run)? (check|lint)\\b" }],
     "light": ["cargo check"]
   }
   ```

   - `defaults`: `true` なら、cargo・pnpm・npm・yarn・go・docker のビルド・テスト・インストールと、Workflow、pre-push のフックがある `git push` も重いとみなす。書かなければ `true`。既定を外すなら `false` と書く
   - ファイルを置かなければ、`{ "defaults": true }` と同じ
   - `heavy`: コマンドの頭の語の並び。語の並びで書けないものは `{ "regex": "..." }`
   - `light`: `heavy` や既定から外すもの

## hook の見方

- 引用符の中身と heredoc の本文は見ず、コマンドの位置（行頭、`;` `&` `|` `(` の後）に来たものだけを見る
- ほかのコマンドの引数として渡したコマンドは拾わない（`ssh <ホスト> "pnpm build"` など）。例外は `herdr pane run <ペイン> <コマンド>`・`hc run [オプション] <コマンド>`（オプションの後の残り全部）・`hc send <端末> <文>`（次の1語）・`node run-in-tab.mjs ... -- <コマンド>` で、ペインへ送るコマンドも同じように見る（ペインの ID を `$(...)` でその場に書いた形と、`run-in-tab.mjs` のパスを引用で書いた形は拾わない）
- hc の端末（`HC_TERMINAL_ID` がある）・Herdr の中（`HERDR_ENV=1`）では、重いコマンドをペインへ送らずに流すと、CPU の空きにかかわらず止めて `run-in-tab.mjs` を案内する（Workflow は対象外）
- 止めた理由の文は、`CPU の空きが N% で、10% を切っているため、重い処理を止めました` か、`ほかのセッションが重い処理を始めたところなので、重い処理を止めました` で始まる。Claude Code はツールの結果の頭に `PreToolUse:<ツール> hook error: ` を付けて返す（2.1.289 で実測）。mod はこの形で見分ける
- ユーザーが強行を認めたときは、コマンドの頭に `CLAUDE_FORCE_HEAVY=1` を付けると通る（PowerShell は `$env:CLAUDE_FORCE_HEAVY=1;`、Workflow は script に `// CLAUDE_FORCE_HEAVY=1` の注釈）
- 始める瞬間の鍵は、hook の入力の `session_id` で持ち主を見分ける。同じセッションの続きの重い処理は止めない
- `node scripts/guard-heavy-commands.cjs --admit --what <何をするか>` で、hook と同じ判断をして、始めてよければ鍵を置いて 0、待つなら理由を出して 1 で返る（`SKILL.md` の手順）
- `node scripts/guard-heavy-commands.cjs --ready <セッション>` で、hook と同じ測り方の CPU の空きと、ほかのセッションの始める瞬間の鍵を JSON で1行出す（mod が使う）

## 中身

| | |
| --- | --- |
| `SKILL.md` | 手順 |
| `scripts/guard-heavy-commands.cjs` | PreToolUse の hook と、`--admit`・`--ready` |
| `scripts/guard-heavy-commands.test.cjs` | hook のテスト（`node --test scripts/guard-heavy-commands.test.cjs`） |
| `scripts/run-in-tab.mjs` | 別のタブで流すスクリプト |
| `scripts/run-in-tab.test.mjs` | そのテスト（`node --test scripts/run-in-tab.test.mjs`。macOS・Linux 用。hc・herdr は偽物に置き換える） |
| `mod/` | heavy-wait の mod（テストは `claude plugin test mod`） |
