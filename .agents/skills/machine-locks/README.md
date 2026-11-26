# machine-locks

同じマシンで動く複数のエージェントのセッションが、キーボードとマウスや CPU を取り合って互いの作業を壊さないよう、資源ごとに1つの鍵をマシンに置く土台。[input-takeover](../input-takeover/README.md)（キーボード・マウス・フォーカス）と [heavy-task](../heavy-task/README.md)（CPU）が使う。

## 読む前に

- **この skill だけでは、何も止まらない。** 鍵を見て操作を止めるのは、資源ごとの方針を持つ skill の mod と hook。鍵を置くかどうか・了承を取るか・何を止めるかも、そちらで決める
- **input-takeover と heavy-task は、この skill を隣のフォルダーから読む。** 3つとも同じ clone への symlink で置く。写すなら、3つを同じ親のフォルダーに並べる
- **持ち主が落ちたかを見るのは、Claude Code のセッションだけ。** Claude Code の内部のファイル（`~/.claude/sessions/<pid>.json`）からセッションのプロセスを引く。公開された API ではないので、版によって読めなくなりうる。読めなければ、見込みの時刻だけで外れる
- **実物で通したのは macOS（Claude Code 2.1.332・Node.js）だけ。** 取り合いはファイルを排他で作れるか（`O_EXCL`）で決めるので、Windows・Linux でも同じに動くはずだが、試していない

## できること

- 資源ごとに鍵を1つ置く（`~/.claude/locks/<資源>.json`）。持ち主・作業フォルダ・何をするか・始めた時刻・見込みの時刻を持つ
- 同時に置きに来ても、置けるのは1つだけ（ファイルを扱う間は、排他で作る取り合いのファイルで順番を決める）
- 見込みの時刻を過ぎた鍵と、持ち主の Claude Code が落ちた鍵は、外れたものとみなす
- 同じ作業フォルダのセッションの鍵を、立ち上がり直す前の自分の鍵として引き継ぐ（資源ごとに選ぶ）
- 前の置き場（`~/.claude/input-takeover.json`）に置かれた input の鍵も、効いている間は見る

## 使い方

`.agents/skills/machine-locks/` を、input-takeover・heavy-task と同じように symlink で置く。Claude Code では、mod と hook が呼ぶので、自分で呼ぶことはない。ほかのエージェントは、方針の skill の手順のとおりに `node scripts/locks.cjs` を呼ぶ（`SKILL.md`）。

## 中身

| | |
| --- | --- |
| `SKILL.md` | 鍵の扱い方 |
| `scripts/locks.cjs` | 鍵を置く・延ばす・外す・見る（ライブラリとコマンド） |
| `scripts/locks.test.cjs` | そのテスト（`node --test scripts/locks.test.cjs`） |
