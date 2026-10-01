---
name: weekly-pace
description: Claude・Codex 双方の週次使用ペースを判定する。Claude側はステータスラインの Weekly%/Weekly Reset、Codex側は app-server の account/rateLimits/read から直接取る。ユーザーが「ペースどう」「ハイペースか」「Codex に投げたほうがいい？」と尋ねたときや、委譲できる作業をどちらに回すか自分で判断したいときに使う。
---

# 週次使用ペースの判定

## 仕事

Claude・Codex の週次枠を、リセットまで今のペースで使い続けたときの着地見込み%で判定する。

`Weekly: X% | Weekly Reset: Nd Hhr Mm` は、**アカウント全体で共有される週次（7日=168h）の使用量**。
どの claude ペインを読んでも同じ値になる。これを線形・比例で消費していくと仮定し、リセットまでの着地見込み%を概算する。
あくまで目安・参考程度。ペースそのもの（%/h）ではなく、着地見込みが100%を超えるかどうかだけを見る。

## やらないこと

- 実装そのものの主担当を、割り込みなく切り替える — 大きな切り替えは、これまでどおり一声かける。
- Codex から使うときに、どちらに回すかまで決める — Codex から使うときは、ペースを伝えるだけにとどめる。

## 出力

スクリプトの出力（判定と着地見込み）を、そのままユーザーに伝える。判定不可のときはその旨だけ伝える。

## 終わる条件

頼まれた側（Claude・Codex・両方）の判定を伝えた。Claude から両方を見たなら、どちらに回すかの判断まで済んだ。

## 止まる条件

無い。読み取りだけで、値が取れなければその旨を伝えて終える。

## 手順

### Claude側

1. claude ペインの画面を読む。Claude から使うなら自分のペインでよい（`herdr pane current --current` の `result.pane.pane_id`。`$HERDR_PANE_ID` はペインを移すと古いまま残ることがある）。ステータスラインは会話の文脈には入らないが、画面には出ている。Codex から使うなら、`herdr agent list` で claude のペインを選ぶ（どれでもよい、値は共有されている）。
   ```
   herdr pane read <pane_id> --source visible
   ```
2. 読んだテキストをそのまま渡す（`--json` を付けると数値で返る）。
   ```
   herdr pane read <pane_id> --source visible | node <このスキルのディレクトリ>/scripts/pace.mjs
   ```
3. 出力をそのままユーザーに伝える。判定不可（サイクル開始から経過2時間未満）のときはその旨だけ伝える。

### Codex側

Codex CLI の app-server（JSON-RPC、`account/rateLimits/read`）から直接取れる。画面を読む必要はない。
クォータは消費しない。

```
node <このスキルのディレクトリ>/scripts/codex-usage.mjs | node <このスキルのディレクトリ>/scripts/codex-pace.mjs
```

`codex-usage.mjs` 単体は `{accountId, planType, primary, secondary}` のJSONを返す（`primary`=5時間枠、`secondary`=週次枠、それぞれ `usedPercent`・`resetsAt`（UNIX秒）・`windowDurationMins`）。
リセット時刻はUIには出ないが、APIには載っている。

### 両方を見て判断する

この節は Claude から使うときの話。
両方のWeeklyペースを見て、片方がハイペース・もう片方に余裕があるなら、委譲できる作業（コードレビュー・機械的な変換・文書チェックなど、判断の質が落ちにくいもの）を余裕がある側に回してよい。Codex に任せる手順（スキルなど）を持っていれば、それに従う。

### 注意

- 週の頭（経過が短い）ほどノイズで数字が跳ねる。経過2時間未満はスクリプトが「判定不可」を返す。
- Claude・Codexとも「Weekly」はアカウント全体で共有される値。プロジェクトやセッションを問わず同じ数字になる。

## 合格条件

- 人が見る: 伝えた数字が、スクリプトの出力と同じ。自分で計算し直したり丸めたりしていない。
- 機械が見る: 無い。
