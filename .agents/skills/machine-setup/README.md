# machine-setup

新しいマシンに、選んだアプリ・ツールを入れ、設定ファイルを取り込む。

## 読む前に

- **最後まで通したのは、Ubuntu 24.04.4（arm64）の Docker コンテナで、Claude Code 2.1.270 を使った1回だけ。** GUI アプリ、OS の再起動、systemd を使うもの、macOS、Windows では試していない。手順と `references/os-notes.md` が OS ごとに扱うのは macOS・Ubuntu・WSL・Windows で、ほかの Linux の節は無い
- **Claude Code が要る。ターミナルはもう1つあると、ずっと楽に進められる。** Claude Code の `!` で打ったコマンドとは対話できないので、sudo のパスワードの入力などは、もう1つのターミナルで打つ。1つしか無いときは、Claude Code を終了してコマンドを打ち、同じディレクトリで `claude --continue` を打って戻る
- **スマホやデスクトップの Claude アプリがあると楽。** アプリから [Remote Control](https://code.claude.com/docs/en/remote-control) でつなぐと、問いに答えるのが楽になる。無くても進められる。ただし Remote Control は、API キーでログインした Claude Code では使えない
- **既定の権限設定では、コマンドを打つたびに承認を求められる。** 承認し続けるか、起動するときに権限のモードを選ぶ（[Configure permissions](https://code.claude.com/docs/en/permissions)）
- **入れるものと入れ方は、その場で決まる。** ジャンルごとの候補は Claude の知識から出るので、モデルや時期で変わり、新しいツールは出てこないことがある。入れ方は公式の情報を見て決めるので、同じものでも時期で打つコマンドが変わる。決まった一覧があるなら、頼むときにその URL を渡す（認証なしで読める URL なら最初に、そうでなければ設定ファイルを取ってきたあとで読む）

## できること

```
0. 使う言語、入れるもの（ジャンルごとの候補から選ぶ）、設定ファイルの置き場所・取ってくる手段・管理ツールなどを、1問ずつ聞く
1. パッケージマネージャを用意する
2. 設定ファイルを取ってくる道具（git, gh など）を入れる
3. 認証してもらい、設定ファイルを取ってくる
4. 選んだアプリ・ツール・言語・フォントを入れる
5. 設定ファイルを展開する
6. シェルと初期設定
7. 再起動のあとで確かめることを書き、報告する
```

進み具合は `~/machine-setup-progress.md` に書くので、再起動でセッションが切れても続きから頼める。スクリプトは持たない。

## 使い方

新しいマシンには、まだこのリポジトリも skill も無い。skill の URL を渡して読ませる。

1. 新しいマシンに Claude Code を入れる。2026-09 時点のコマンドは次のとおりで、変わっていることがあるので[公式ドキュメント](https://code.claude.com/docs/en/setup)も見る
   - macOS / Ubuntu / WSL: `curl -fsSL https://claude.ai/install.sh | bash`（Ubuntu で curl が無ければ、先に `sudo apt update && sudo apt install -y curl`）
   - Windows (PowerShell): `irm https://claude.ai/install.ps1 | iex`
2. できれば、新しいマシンでターミナルを2つ開く。1つは Claude 用、もう1つは管理者権限の要るコマンド（sudo や、Windows では管理者の PowerShell）や `gh auth login` などを自分で打つ用
3. Claude 用のターミナルで、作業用のディレクトリ（例: `~/machine-setup`）を作って移り、`claude` を起動する。初めて起動するとログインの方法を聞かれ、ブラウザで認証する。Remote Control を使うなら、claude.ai のアカウントでログインする
4. 以下の指示を送る。Claude 用のターミナルに直接打ってもよいし、スマホやデスクトップの Claude アプリから [Remote Control](https://code.claude.com/docs/en/remote-control) でつないで送ってもよい（アプリからだと、問いに答えるのが楽）。Remote Control を使うなら、先に `/rc` を打つ。Remote Control の前提になる信頼の確認は、作業用のディレクトリでは記録されるが、ホームディレクトリでは記録されない

> https://raw.githubusercontent.com/miyabi-satoh/yorozuya/main/.agents/skills/machine-setup/SKILL.md を curl -fsSL で取って読み、その手順でこのマシンをセットアップして

Windows では `curl` を `curl.exe` にする。fork したなら、URL の `miyabi-satoh` を自分のものに替える。自分の一覧を使うなら「一覧は <URL>」と添える。

再起動のあとは、新しいマシンで同じ作業用のディレクトリに移って `claude` を起動し直し、以下の指示を送る（Remote Control を使うなら、つながっていなければ `/rc` を打つ）。

> ~/machine-setup-progress.md を読んで続けて

このリポジトリを clone してあるマシンでも、作業用のディレクトリで `claude` を起動し、URL の代わりに clone した `SKILL.md` のパスを渡して読ませる。このリポジトリのディレクトリで起動すると、`AGENTS.md` の Yorozuya セッションの決まり（ほかのプロジェクトのファイルは編集しない、など）が読み込まれる。

## 中身

| | |
| --- | --- |
| `SKILL.md` | 決まりと手順 |
| `references/genres.md` | 入れるもののジャンルと、候補の出し方 |
| `references/os-notes.md` | OS ごとに、インストールの途中で詰まりやすいところと、その対処 |

## 頼っている外部の振る舞い

公式に保証されていないものも含むので、更新で変わりうる。

**Claude Code**

- `!` で打ったコマンドとは対話できない（公式ドキュメントは、コマンドと出力を会話に取り込み表示する、とだけ書き、入力を受け付けるとは書いていない。2.1.270 で `! sudo -v` が「a terminal is required to read the password」で止まった。制御端末が無く標準入力が `/dev/null` になることは [anthropics/claude-code#92635](https://github.com/anthropics/claude-code/issues/92635) に実測がある）
- Remote Control の前提になる信頼の確認は、ホームディレクトリでは記録されない（公式ドキュメント）
- 選択肢で答える問い（AskUserQuestion）は、選択肢が2〜4個で、「他のもの」が自動で付く（2.1.270 の本体の記述）
- 選択肢で答える問い（AskUserQuestion）に、Remote Control でつないだアプリからも答えられる（2.1.270 で確かめた）
- Windows で Git for Windows が無いと、コマンドは PowerShell で打たれる（公式ドキュメント。試していない）

**その他**

- skill を `raw.githubusercontent.com` から curl で取れる
- ジャンルごとの候補を出すときの、Claude の知識
- 各ツールの公式のインストール手順
