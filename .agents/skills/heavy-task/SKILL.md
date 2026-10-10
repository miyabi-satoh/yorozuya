---
name: heavy-task
description: 重い処理を始める前に、マシンの負荷を確かめて始めてよいかを決める手順。フルビルド・全体テスト・docker build・依存の一括インストール・大規模なインデックス作成や変換・多数のエージェントを並列に起動する Workflow・重い pre-push フック付きの git push など、CPU・メモリ・ディスクを長時間大きく使う処理のうち、guard-heavy-commands の hook が拾わないもの（hook の無いエージェント、`.claude/heavy-commands.json` に無いコマンド）を始めるときと、重い処理がメモリ不足で打ち切られたときに使う。
---

# 重い処理を始める前の負荷の確かめ方

同じマシンで複数のエージェントのセッションが動いていることがある。重い処理が重なるとマシン全体が詰まるため、始める前に負荷を確かめる。

## 仕事

始める直前に CPU とメモリの負荷を測り、始める・待つ・ユーザーに聞くのどれかを決める。

## やらないこと

- `guard-heavy-commands.cjs` の hook が拾うコマンドを、この手順で測らない — hook が流す瞬間に同じ目安で測って止めるので、二重になる（→「Claude Code では」）。
- 他のセッションへ開始・終了を知らせない — 受け取った側のチャットが汚れる。負荷は各自が測れるので知らせは要らない（入力を奪う処理は測れないので `input-takeover` で知らせる）。
- 数秒で終わる軽いコマンドには使わない。

## 出力

始めるか待つかの判断。メモリが逼迫の目安に当たったときは、その値をユーザーに伝える。打ち切られたときは、採取したマシンの状態（scratchpad に保存）と、打ち切られた時刻・要約の報告。

## 終わる条件

処理を始めたとき、またはユーザーに待つか強行するかを聞いたとき。打ち切られたときは、採取と報告を済ませて流し直したとき。

## 止まる条件

次のときは推測で埋めずに止まり、ユーザーに聞く。測れないときは止めずに始める。

- 承認が要る操作の手前: 15分待っても CPU が厳しいまま、強行するか決めるとき。

## 手順

1. 始める直前に負荷を測る。load average は使わない。重い処理が始まってから跳ね上がるため、始める前の値では見分けられない。
   - macOS: `top -l 2 -n 0 -s 1 | grep 'CPU usage' | tail -1` と `sysctl -n kern.memorystatus_vm_pressure_level`
   - Linux: `vmstat 1 2 | tail -1`、`cat /proc/pressure/memory`、`free -m`
   - Windows（PowerShell）: `$os = Get-CimInstance Win32_OperatingSystem; "CPU $((Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average)% / MemFree $([math]::Round($os.FreePhysicalMemory / $os.TotalVisibleMemorySize * 100))%"`
2. CPU の空きが 10% を切っていれば「厳しい」とみなし、始めない（macOS は `idle`、Linux は `vmstat` の `id`、Windows は使用率 90% 以上）。
   - すぐにはユーザーに聞かない。5分待って測り直すのを3回（計15分）繰り返し、それでも厳しいときに初めて、待ち続けるか強行するかを聞く。
   - 待つ間は先に軽い作業を進めてよい。
3. メモリは参考にとどめ、逼迫していても止めない。目安に当たったら、その値をユーザーに伝えてから始める。
   - macOS: pressure level が 4（critical）。2（warning）はメモリ 8GB のマシンだと待機中でも出るので目安にしない。`memory_pressure` の空き % は圧縮とスワップを空きに数え、詰まっていても 30〜40% と出るので使わない。
   - Linux: `/proc/pressure/memory` の `some avg10` が 10 を超える、または `free -m` の `available` が総量の 20% を切っている。
   - Windows: 上のコマンドの `MemFree` が 10% を切っている（スタンバイを空きに数えないので、Linux より低い値にしてある）。

## Claude Code では

- `guard-heavy-commands.cjs` hook（このスキルの `scripts/`）が、重いコマンドを流す瞬間に手順 1〜3 と同じ目安で測り、CPU が厳しければ止め、メモリが目安に当たれば値を知らせる。hook が拾うコマンドは、この手順で測らずにそのまま流す。hook も、測れないときは止めずに通す。
  - 拾うコマンドは、プロジェクトの `.claude/heavy-commands.json` で決まる（書き方と既定は `README.md` の「使い方」）。
  - 拾わないのは、`.claude/heavy-commands.json` が無いプロジェクトのコマンド、一覧に無いコマンド、ほかのコマンドの引数として渡すコマンド（`herdr pane run <ペイン> "pnpm dev"` など）。これらは手順 1〜3 で測る。繰り返し流すコマンドは `heavy-commands.json` に足す。
- hook に止められたときは、heavy-wait の mod（このスキルの `mod/`）が1分ごとに空きを測り、空いたとき（15分たっても厳しいときも）にプラグインのメッセージで知らせる。自分で測り直して待たず、知らせを待つ間に軽い作業を進める。
- mod が無いときや、hook が拾わないコマンドを自分で測って待つときは、foreground の `sleep` が使えないので、`Monitor` などで待つ。
- macOS と Linux の Claude Code は、OS からメモリ逼迫の通知を受けると、バックグラウンドの Bash を "stopped because the system is running low on memory" で打ち切る（セッションが30分以上アイドルで、ターンもサブエージェントも動いていないとき）。フォアグラウンドの Bash と Monitor は対象外。Windows では打ち切られないので、下の2つは要らない。
  - 10分以内に終わる処理は、`run_in_background` を使わず、フォアグラウンドで `timeout: 600000` を付けて走らせる。時間切れでバックグラウンドに回ると打ち切りの対象になる。
  - 10分を超える処理はバックグラウンドで走らせ、打ち切られたら負荷を測り直してから流し直す。
- 打ち切られたら、流し直す前に、その場でマシンの状態を採取する。直後の値が打ち切り直前の状態に近い。結果は scratchpad に保存し、打ち切られた時刻と要約をユーザーに報告する。
  - macOS: `sysctl -n kern.memorystatus_vm_pressure_level`、`vm_stat`、`sysctl -n vm.swapusage`、`ps -Ao rss,comm | sort -rn | head -15`、`pgrep -x node | wc -l`
  - macOS のカーネルログ: `/usr/bin/log show --last 30m --style compact --predicate 'sender == "kernel" AND eventMessage CONTAINS "memorystatus"'`。`memorystatus_available_pages` と `compressor_size` の推移で、逼迫に至る流れを追える。zsh では `log` が組み込みコマンドに奪われるため、フルパスで呼ぶ。
  - macOS の Jetsam レポート: `/Library/Logs/DiagnosticReports/JetsamEvent-*.ips` に同じ時刻のものがあれば、OS がプロセスを強制終了している。全プロセスのメモリ使用量が載っている。
  - Linux: `cat /proc/pressure/memory`、`free -m`、`ps aux --sort=-rss | head -15`、`journalctl -k --since '-30min' | grep -iE 'oom|out of memory'`

## 合格条件

- 人が見る: hook が拾わない重い処理は、始める前の CPU とメモリの値を測ってから始めている。厳しいときに15分待たずに聞いていない。
- 機械が見る: 無い（hook が拾うコマンドは、CPU の厳しいときの開始を hook が止める）。
