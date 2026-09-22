# Yorozuya

Claude Code に持たせる skill の置き場。

skill は、決まったコマンドを順に叩くスクリプトではなく、Claude がその場で判断して進める手順として書いている（スクリプトを持つのは restart-sessions と weekly-pace で、どちらも後戻りできない連鎖か、読むだけの計算にとどめている）。実際に打つコマンドは、Claude Code のバージョン・権限の設定・CLAUDE.md などで変わる。うまくいかないときは、その場で指示を足すか調べさせる。

`.claude/skills/` から読み込んでいる（各 skill への symlink）。他のプロジェクトで使うなら、`.agents/skills/<skill>/` を自分の skill ディレクトリに置けばよい。

## skill 一覧

| skill | できること | 要るもの・実機確認 |
| --- | --- | --- |
| [restart-sessions](.agents/skills/restart-sessions/README.md) | [Herdr](https://herdr.dev) 上のセッションを、別のセッションから handoff を取って再起動する。コンテキストの使用率を見張って自動で促すこともできる | Herdr、handoff を書く別の skill。実機確認は macOS・Windows 11 |
| [weekly-pace](.agents/skills/weekly-pace/README.md) | 週次のトークン使用ペースを、ステータスラインの表示から概算する | ステータスラインに Weekly% が出ていること |
| [cleanup](.agents/skills/cleanup/README.md) | ディスクのゴミの候補を調べてレポートし、選んだものだけ消す | 削除まで通したのは Windows のみ |
| [machine-setup](.agents/skills/machine-setup/README.md) | 新しいマシンにアプリ・ツールを入れ、設定ファイルを取り込む | Claude Code。最後まで通したのは Ubuntu（Docker）のみ |

各 skill の前提・仕組み・使い方は、リンク先の README にある。運用ルール（このリポジトリでの決まり）は [AGENTS.md](AGENTS.md) にある。
