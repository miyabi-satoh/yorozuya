# Yorozuya

Claude Code に持たせる skill の置き場。

skill は、決まったコマンドを順に叩くスクリプトではなく、Claude がその場で判断して進める手順として書いている（スクリプトを持つのは restart-sessions で、後戻りできない連鎖と、読むだけの処理（見張り・会話ログの抜き出し）にとどめている）。実際に打つコマンドは、Claude Code のバージョン・権限の設定・CLAUDE.md などで変わる。うまくいかないときは、その場で指示を足すか調べさせる。

使うには、`.agents/skills/<skill>/` を使う側のプロジェクトの skill ディレクトリ（Claude Code なら `.claude/skills/`）に置く。clone した先への symlink にすると、pull した更新がそのまま届く。写したなら、restart-sessions の `config.local.json` を使う側の `.gitignore` に足す（このリポジトリの `.gitignore` は効かない）。restart-sessions のコンテキストの見張りは、mod（`mod/`）を読み込ませれば各セッションが自分を見張る。mod を使わずに外から見張るなら、使う側の `.claude/settings.json` に SessionStart の hook を置く（[restart-sessions の README](.agents/skills/restart-sessions/README.md#使い方)）。heavy-task の hook も `settings.json` に置く（[heavy-task の README](.agents/skills/heavy-task/README.md#使い方)）。

## skill 一覧

| skill | できること | 要るもの・実機確認 |
| --- | --- | --- |
| [restart-sessions](.agents/skills/restart-sessions/README.md) | [Herdr](https://herdr.dev) 上のセッションを、会話ログを引き継いで再起動する。SessionStart の hook を置いたプロジェクトで起動すると、コンテキストの使用率を見張り、知らせの出たセッションを確認なしで再起動する | Herdr。見張りには、使用率を出すステータスラインと `config.local.json`。実機確認は macOS・Windows 11 |
| [weekly-pace](.agents/skills/weekly-pace/README.md) | Claude と Codex の週次枠の使用ペースを概算する。restart-sessions が、Claude がハイペースのとき再起動した先に Codex へ作業を回すよう書き添えるのに使う | Claude 側は Herdr と、Weekly を出すステータスライン。Codex 側は `codex` CLI |
| [heavy-task](.agents/skills/heavy-task/README.md) | 重い処理を始める前に CPU とメモリを測り、始めるか待つかを決める。hook が CPU の厳しいときに重いコマンドを止め、mod が空いたらセッションに知らせる | 何が重いかを書く、使う側の `.claude/heavy-commands.json`。hook と mod は Claude Code 用（mod は 2.1.289 の function hooks）。実機確認は macOS のみ |
| [cleanup](.agents/skills/cleanup/README.md) | ディスクのゴミの候補を調べてレポートし、選んだものだけ消す。mod が空きを見張り、ラインを切ったら各セッションに自分のリポジトリを片付けさせる | 削除まで通したのは Windows のみ。mod は Claude Code 用で、実機確認は macOS のみ |
| [machine-setup](.agents/skills/machine-setup/README.md) | 新しいマシンにアプリ・ツールを入れ、設定ファイルを取り込む | Claude Code。最後まで通したのは Ubuntu（Docker）のみ |

各 skill の前提・仕組み・使い方は、リンク先の README にある。skill に手を入れるときの決まりは [AGENTS.md](AGENTS.md) にある。
