# weekly-pace

Claude と Codex の週次使用ペースを概算する。

## 読む前に

- **Claude 側は ccstatusline 系の表示（`Weekly: X% | Weekly Reset: Nd Hhr Mm`）と Herdr が前提。** claude ペインの画面を `herdr pane read` で読むので、どちらかが無ければ使えない
- **Codex 側は `codex` CLI が PATH に要る。** `codex app-server` の `account/rateLimits/read` から取る（クォータは消費しない）。codex-cli 0.157.0 で確認
- **線形・比例で消費すると仮定した、あくまで目安。** 実際の消費は波があるので、外れることがある
- **週の頭（経過が短い）ほど数字が跳ねる。** 経過2時間未満は判定不可として返す
- **Weekly% はアカウント全体で共有される値。** どの claude ペインを読んでも同じで、自分のペインを読んでもよい

## できること

Weekly% とリセットまでの残り時間から、そのペースのままだとリセット時に何%まで届きそうかを出す。

```
Weekly 8%（経過 7.5h / リセットまで残り 160.5h）→ このペースの着地見込み 179.2% … ハイペース（線形外挿の目安）
```

判定は「ハイペース」か「順調」の2択。何かを自動でするわけではなく、目安を出すだけ。

## 使い方

「ペースどう？」「ハイペース？」「Codex に投げたほうがいい？」のように尋ねる。

[restart-sessions](../restart-sessions/README.md) がこのスクリプトを使い、Claude がハイペースで Codex に余裕があるときに、再起動した新セッションへ Codex に作業を回すよう書き添える。

## 中身

| | |
| --- | --- |
| `SKILL.md` | 手順 |
| `scripts/pace.mjs` | Claude 側。画面のテキストから Weekly%・Weekly Reset を読み、着地見込みを計算する |
| `scripts/codex-usage.mjs` | Codex 側。app-server から5時間枠・週次枠の使用率とリセット時刻を JSON で取る |
| `scripts/codex-pace.mjs` | Codex 側。`codex-usage.mjs` の出力から週次枠の着地見込みを計算する |
