# heavy-task

重い処理（ビルド・テスト・依存の一括インストール・重いフック付きの push など）を始める前に、マシンの CPU とメモリを測り、始める・待つ・ユーザーに聞くのどれかを決める。同じマシンで複数のエージェントのセッションを動かすとき、重い処理が重なってマシン全体が詰まるのを避ける。

## 読む前に

- **何が重いかは、使う側のプロジェクトの `.claude/heavy-commands.json` に書く。** このファイルが無いプロジェクトでは、hook は既定のコマンドだけを見る（既定と書き方は下の「使い方」4）
- **hook と mod は Claude Code 用。** `SKILL.md` の手順そのものは、ほかのエージェントでも読める
- **hook が拾うコマンドには、`SKILL.md` の手順は要らない。** hook が同じ目安で測って止める。手順を使うのは、hook の無いエージェントと、hook が拾わないコマンド（下の「hook の見方」）
- **mod は Claude Code の function hooks（早期アクセスの API）に頼っている。** 版ごとに変わりうる。Claude Code 2.1.289 で確かめた
- **止めて知らせるところまで実物で通したのは macOS だけ。** hook が CPU の厳しさで止め、mod が空きを測り続けて知らせるところまで、macOS（Claude Code 2.1.289）で確かめた。Windows 11（Claude Code 2.1.296・Node.js 26.5.0）では、`--idle` が CPU の空きを返すところまで確かめた。hook が止めるところと mod は試していない。Linux の測り方（`/proc`・`os.cpus()`）はコードにあるが、実物では試していない
- **CPU だけで止める。** メモリの逼迫は止めず、値を Claude に知らせるだけ。測れないとき・入力が読めないときは、止めずに通す

## できること

- `SKILL.md`: hook が拾わない重い処理を始める直前に、CPU とメモリを測る手順。CPU の空きが 10% を切っていれば、5分おきに3回（計15分）測り直し、それでも厳しければユーザーに聞く。打ち切られたときにマシンの状態を採取する手順もある
- `scripts/guard-heavy-commands.cjs`: Claude Code の PreToolUse の hook。重いコマンドを、CPU の空きが 10% を切っているときに止める
- `mod/`（heavy-wait）: hook が止めたのを見て、1分ごとに空きを測り、空いたら（15分たっても厳しければそのことも）セッションに知らせる。セッションは自分で測り直して待たずに、知らせを待つ間に軽い作業を進められる

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

3. mod を使うなら、`mod/` をプラグインのフォルダとして読み込ませる（`claude --plugin-dir <このディレクトリ>/mod`、または `~/.claude/settings.json` の `env` の `CLAUDE_CODE_PLUGIN_DIRS`）
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
- ほかのコマンドの引数として渡したコマンドは拾わない（`ssh <ホスト> "pnpm build"` など）。例外は `herdr pane run <ペイン> <コマンド>` で、ペインへ送るコマンドも同じように見る
- 止めた理由の文は、`CPU の空きが N% で、10% を切っているため、重い処理を止めました` で始まる。Claude Code はツールの結果の頭に `PreToolUse:<ツール> hook error: ` を付けて返す（2.1.289 で実測）。mod はこの形で見分ける
- ユーザーが強行を認めたときは、コマンドの頭に `CLAUDE_FORCE_HEAVY=1` を付けると通る（PowerShell は `$env:CLAUDE_FORCE_HEAVY=1;`、Workflow は script に `// CLAUDE_FORCE_HEAVY=1` の注釈）
- `node scripts/guard-heavy-commands.cjs --idle` で、hook と同じ測り方の CPU の空き（%）を1行出す（mod が使う）

## 中身

| | |
| --- | --- |
| `SKILL.md` | 手順 |
| `scripts/guard-heavy-commands.cjs` | PreToolUse の hook と、`--idle` の測り方 |
| `scripts/guard-heavy-commands.test.cjs` | hook のテスト（`node --test scripts/guard-heavy-commands.test.cjs`） |
| `mod/` | heavy-wait の mod（テストは `claude plugin test mod`） |
