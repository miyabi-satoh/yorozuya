# 放置のあとの `/clear`

`IDLE` を受けたときの手順。対象に何も書かせず、**呼び出し元が旧セッションのJSONLトランスクリプトから抜き出した会話ログ**で、`/clear` と続きのプロンプトを流す。
SKILL.md の「手順」の4（`extract-transcript.mjs`）と同じ抽出なので、画面のスクロールバックと違って前半も欠けない。`/clear` は新セッションの開始にあたるので、旧セッションのJSONLはそこで書き込みが止まるだけでファイルは残る。`/clear` の前でも後でも抽出できる。元の会話は `claude --resume <セッションID>` で戻せる（知らせの列のID）。

hc の端末では、`hc` で同じことをする（ペインは端末の address。SKILL.md の「hc の端末では」）。状態は `hc get <address> --json` の `status.state` が `idle` か `done` なら入力を待っている。書きかけは `hc read <address>` の入力欄（色が無いので、`Try "…"` の案内のほかは書きかけとみなす）。送るのは `env -u HC_TERMINAL_ID hc send <address> "<文>"`（claude の端末の中から送ると hc が文を `<hc from=…>` で包み、`/clear` が効かないため）。Windows の Git Bash（MSYS）から送るときは、`MSYS_NO_PATHCONV=1 env -u HC_TERMINAL_ID hc send <address> "/clear"` と前に付ける。付けないと `/clear` がパスに書き換わり、`/clear` として届かない。

1. ペインとセッションIDを引き直す。IDが違えば済んでいるので捨てる。`agent_status` が `idle` でなければ（`working`・`blocked`）流さない。入力欄に書きかけがあれば（`herdr pane read <pane> --source visible --format ansi` で、薄字でない文字がある）流さない。`/clear` が書きかけの末尾につながって送信される。
   モードラインに Monitor・バックグラウンドのサブエージェントが見えていたら流さない（`N monitor`・`N tasks` など）。`/clear` の後にどうなるかを確かめていないため。見送ったら、次の `IDLE`（張り直した見張りが出す）で改めて見る。
   バックグラウンドのシェル（`N shells`）だけなら流す。シェルは `/clear` の後も動き続け、終わりの知らせは `/clear` の後の会話に届いてターンを起こす（2.1.289 で確認）。見送ると、その知らせが冷えた大きい会話のターンを起こし、読み直しになる。流すときは、手順4の1行を `idleClearPrompt('<資料の絶対パス>', true)` で作る。終わる一文が外れ（シェルは exit-self.md の終わらない条件）、シェルの終わりの知らせが届いたら会話ログの予定に沿って続けてよい、という一文が付く。
2. `scripts/extract-transcript.mjs <セッションID> --out <出力先の絶対パス>` で会話ログを抜き出す。前の資料のつなぎ方は SKILL.md の「手順」の4と同じ。絶対パスにするのは、次の抜き出しが 絶対パスの資料だけをつなぐため（相対パスだと黙って外れる）。
3. `herdr agent prompt <pane> "/clear"` を送り、3秒ほど待って画面が空（使用率が 0%）になったのを確かめる。
   Windows の Git Bash（MSYS）から送るときは、`MSYS_NO_PATHCONV=1 herdr agent prompt <pane> "/clear"` と前に付ける。付けないと `/clear` がパスとみなされて `C:/Program Files/Git/clear` に書き換わり、`/clear` として届かない。
4. 続けて、`scripts/lib/prompts.mjs` の `idleClearPrompt` が作る1行（`node -e` で `idleClearPrompt('<資料の絶対パス>')` を出す）を、`herdr agent prompt <pane> "<その1行>"` で送る。中身は、資料を読んで状況を短く確かめ、ユーザーの答え待ちなら同じ問いを出し直し、前任が依頼を終えて報告も済ませていれば `exit-self.md` で終わり、どちらでもなければ作業を始めずに指示を待つ、というもの。仕事を終えたまま放置で残ったセッションも、ここで終わる。
   `after-restart.md` を使わないのは、状態メモが無く、75分以上放置されていたペインが自分で作業を再開しないようにするため。
5. 確認なしで流すかは `OVER` と同じ（`confirm`）。
6. 報告は SKILL.md の「手順」の7と同じく、打った手と成否まで。新セッションの応答の中身は写さない。

`/clear` も新しいセッション開始として扱われるので、SessionStart の hook（挨拶など）が対象の応答に混ざることがある。
実機の確認は 2026-09-21（2.1.278、`herdr agent prompt` で `/clear` が効き、3秒後に続きを送って通った）。
