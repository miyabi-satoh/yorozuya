# weekly-pace

Claude と Codex の週次使用ペースを概算する。

## 読む前に

- **Claude 側は Claude Code のログインが前提。** Claude Code がログインに使う OAuth トークン（Linux・Windows は `~/.claude/.credentials.json`、macOS はキーチェーンの `Claude Code-credentials`）で、使用量 API（`https://api.anthropic.com/api/oauth/usage`）を読む。公開された API ではなく、ccstatusline や Omarchy も同じ API を読んでいる。トークンを更新するのは Claude Code 本体なので、しばらく起動していないと切れて取れない
- **macOS では、初めてキーチェーンを読むときに許可のダイアログが出ることがある**
- **API で取れないときは、画面からも読める。** ccstatusline 系の表示（`Weekly: X% | Weekly Reset: Nd Hhr Mm`）を `herdr pane read` で読んで渡す
- **Codex 側は `codex` CLI が PATH に要る。** `codex app-server` の `account/rateLimits/read` から取る（クォータは消費しない）。codex-cli 0.157.0 で確認
- **毎日の稼働の時間帯に線形・比例で消費すると仮定した、あくまで目安。** 既定の時間帯は 12〜20時（1日 8h）。経過も枠の長さも時間帯の中だけで数えるので、寝ている間に数字が動かない。時間帯は `--active-hours 9-17` か環境変数 `WEEKLY_PACE_ACTIVE_HOURS=9-17` で変える（`22-6` のような日をまたぐ書き方と、壁の時計で数える `0-24` も書ける）。実際の消費は波があるので、外れることがある
- **週の頭（経過が短い）ほど数字が跳ねる。** 稼働の時間帯の中の経過が2時間未満なら、判定不可として返す
- **Weekly% はアカウント全体で共有される値。** どのマシン・どのセッションで取っても同じ

## できること

Weekly% とリセットまでの残り時間から、そのペースのままだとリセット時に何%まで届きそうかを出す。

```
Weekly 20%（稼働 12〜20時で経過 10h / 枠 56h、リセットまで残り 142h）→ このペースの着地見込み 112% … ハイペース（線形外挿の目安）
```

判定は、着地見込みが 100% を超えると「ハイペース」、70% を下回ると「ローペース」、その間は「順調」。何かを自動でするわけではなく、目安を出すだけ。

## 使い方

「ペースどう？」「ハイペース？」「Codex に投げたほうがいい？」のように尋ねる。

[restart-sessions](../restart-sessions/README.md) がこのスクリプトを使い、Claude がハイペースで Codex に余裕があるときに、再起動した新セッションへ Codex に作業を回すよう書き添える。

## 中身

| | |
| --- | --- |
| `SKILL.md` | 手順 |
| `scripts/claude-usage.mjs` | Claude 側。使用量 API から5時間枠・週次枠の使用率とリセット時刻を JSON で取る（15分キャッシュ） |
| `scripts/pace.mjs` | Claude 側。`claude-usage.mjs` の出力（取れなければ画面のテキスト）から週次枠の着地見込みを計算する |
| `scripts/codex-usage.mjs` | Codex 側。app-server から5時間枠・週次枠の使用率とリセット時刻を JSON で取る |
| `scripts/codex-pace.mjs` | Codex 側。`codex-usage.mjs` の出力から週次枠の着地見込みを計算する |
| `scripts/projection.mjs` | 両方が使う、稼働の時間帯で数える着地見込みと判定 |
