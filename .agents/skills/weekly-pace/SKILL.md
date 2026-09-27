---
name: weekly-pace
description: Claude・Codex 双方の週次使用ペースを判定する。Claude側はステータスラインの Weekly%/Weekly Reset、Codex側は app-server の account/rateLimits/read から直接取る。ユーザーが「ペースどう」「ハイペースか」「Codex に投げたほうがいい？」と尋ねたときや、委譲できる作業をどちらに回すか自分で判断したいときに使う。
---

`Weekly: X% | Weekly Reset: Nd Hhr Mm` は、**アカウント全体で共有される週次（7日=168h）の使用量**。
どの claude ペインを読んでも同じ値になる。これを線形・比例で消費していくと仮定し、リセットまでの着地見込み%を概算する。
あくまで目安・参考程度。ペースそのもの（%/h）ではなく、着地見込みが100%を超えるかどうかだけを見る。

## 手順（Claude側）

1. claude ペインの画面を読む。Claude から使うなら自分のペイン（`$HERDR_PANE_ID`）でよい。ステータスラインは会話の文脈には入らないが、画面には出ている。Codex から使うなら、`herdr agent list` で claude のペインを選ぶ（どれでもよい、値は共有されている）。
   ```
   herdr pane read <pane_id> --source visible
   ```
2. 読んだテキストをそのまま渡す（`--json` を付けると数値で返る）。
   ```
   herdr pane read <pane_id> --source visible | node <このスキルのディレクトリ>/scripts/pace.mjs
   ```
3. 出力をそのままユーザーに伝える。判定不可（サイクル開始から経過2時間未満）のときはその旨だけ伝える。

## 手順（Codex側）

Codex CLI の app-server（JSON-RPC、`account/rateLimits/read`）から直接取れる。画面を読む必要はない。
クォータは消費しない。

```
node <このスキルのディレクトリ>/scripts/codex-usage.mjs | node <このスキルのディレクトリ>/scripts/codex-pace.mjs
```

`codex-usage.mjs` 単体は `{accountId, planType, primary, secondary}` のJSONを返す（`primary`=5時間枠、`secondary`=週次枠、それぞれ `usedPercent`・`resetsAt`（UNIX秒）・`windowDurationMins`）。
リセット時刻はUIには出ないが、APIには載っている。

## 両方を見て判断する

この節は Claude から使うときの話。Codex から使うときは、ペースを伝えるだけにとどめる。
両方のWeeklyペースを見て、片方がハイペース・もう片方に余裕があるなら、委譲できる作業（コードレビュー・機械的な変換・文書チェックなど、判断の質が落ちにくいもの）を余裕がある側に回してよい。Codex に任せる手順（スキルなど）を持っていれば、それに従う。
実装そのものの主担当を割り込みなく変える、というような大きな切り替えは、これまでどおり一声かける。

## 注意

- 週の頭（経過が短い）ほどノイズで数字が跳ねる。経過2時間未満はスクリプトが「判定不可」を返す。
- Claude・Codexとも「Weekly」はアカウント全体で共有される値。プロジェクトやセッションを問わず同じ数字になる。
