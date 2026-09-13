# Yorozuya

Claude Code に持たせる skill の置き場。

skill は、決まったコマンドを順に叩くスクリプトではなく、Claude がその場で判断して進める手順として書いている（スクリプトは restart-sessions の後戻りできない部分だけ）。実際に打つコマンドは、Claude Code のバージョン・権限の設定・CLAUDE.md などで変わる。うまくいかないときは、その場で指示を足すか調べさせる。

| skill | できること |
| --- | --- |
| `restart-sessions` | [Herdr](https://herdr.dev) 上のセッションを、別のセッションから handoff を取って再起動する |
| `cleanup` | ディスクのゴミを調べてレポートし、目録に載っている種類の中から選んだものだけ消す（Windows で削除まで1回通しただけ） |
| `machine-setup` | 新しいマシンに、選んだアプリ・ツールを入れ、設定ファイルを取り込む（実機では未確認） |

`.claude/skills/` から読み込んでいる。他のプロジェクトで使うなら、`.agents/skills/<skill>/` を自分の skill ディレクトリに置けばよい。

## restart-sessions

### 読む前に

- **Herdr が要る。** tmux ではない
- **macOS でしか実機確認していない**
- **handoff（引き継ぎ資料）を書く skill が別に要る。** 既定は [Matt Pocock 氏の skills](https://github.com/mattpocock/skills) の `/mattpocock-skills:handoff`。差し替えられる
- **Claude Code と Herdr の、公式に保証されていない振る舞いに頼っている。** どちらの更新でも壊れうる（[頼っている外部の振る舞い](#頼っている外部の振る舞い)）
- **対象のセッションを終了させる道具。** 走っているバックグラウンドの処理は巻き添えになる
- **照合と `/exit` は一続きにできない。** herdr にはセッションを指定して送る手段が無いので、照合した直後に同じペインの中身が入れ替わると、入れ替わった相手に届く。実行中は対象のペインを他から操作しないこと

### できること

ひとつのセッションが、別のセッションを handoff を取ってから再起動する。

```
1. 引き継ぎ資料を書かせる
2. claude を終了させる
3. 起動する
4. 資料を読ませる
```

呼び出し元のセッション自身も、自ペインを分割して立て直せる。

### 仕組み

**判断はセッションが持ち、スクリプトは後戻りできない連鎖だけを引き受ける。**

依頼はペインの入力欄に打ち込む。handoff の skill は `disable-model-invocation` なものが多く、メッセージからは呼べないため。**結果は打ち込まず、対象に返信させる。**
資料の絶対パスは対象が言葉で返してくるので、画面を覗いて探す必要がない。

```
呼び出し元 → herdr agent prompt でペインに依頼を打ち込む
対象      → 資料を書き、絶対パスを添えて返信する
呼び出し元 → ファイルの存在を確かめる
呼び出し元 → scripts/restart.mjs に渡す（/exit → 起動 → 読ませる）
```

`/exit` と起動の間、対象はセッションの無いペインになる。
ここでターンをまたぐと対象が取り残されるので、**この4手だけは1つのプロセスで走り切る。**

### 使い方

1. ターミナルで [Herdr](https://herdr.dev) を起動する
2. このリポジトリを clone したディレクトリに移動する
3. `claude` を起動する

あとは Claude に頼む。**スクリプトを直接叩く必要はない。**

> このペインのセッションを再起動して
>
> 自分自身を再起動して

### 中身

| | |
| --- | --- |
| `.agents/skills/restart-sessions/SKILL.md` | 手順と判断の基準 |
| `.agents/skills/restart-sessions/scripts/` | 後戻りできない連鎖だけ |
| `AGENTS.md` | このリポジトリでの運用ルール。`CLAUDE.md` から import している |

スクリプトが外部に呼び出すのは `herdr` と `node` だけ。Claude Code と handoff の skill は「読む前に」のとおり別に要る。

### 頼っている外部の振る舞い

公式に保証されたインターフェースではないので、更新で壊れうる。

**Claude Code**

- `/exit` の後、前景のプロセスグループがシェルに戻る
- `@<path>` で資料が読み込まれる

**Herdr**

- `herdr agent list` / `agent get` / `agent prompt` / `agent start` / `pane process-info` / `pane current` / `pane split` の JSON 出力の構造
- 終了の確認画面が出れば `blocked` と判定する
- 承認・質問ダイアログ待ちの相手には `agent prompt` が届かない（`agent_blocked` で弾かれる）
- エージェント終了後に名前が外れる
- 閉じたペインのIDは使い回されない（照合したペインと `/exit` や `pane close` を送るペインが同じであることは、これに頼っている）

壊れたときは、このどれが変わったかから当たりを付ける。
止まり方は SKIP と FAIL で、どちらも**対象のセッションには手を付けていない**か、`claude --resume <ID>` で戻せる状態で止まる。

## cleanup

### 読む前に

- **今の書き方は Windows で削除まで1回通しただけ。** 1つ前の書き方では、macOS で削除まで1回、Windows でレポートまで2回通した。Linux では未確認
- **消せるのは目録（`references/catalog.md`）に載っている種類だけ。** 載っていないものは大きくても見せるだけで、消したければ目録に行を足す
- **選んだものは実際に消え、戻せないものもある。** レポートの「失うもの」を読んでから選ぶこと
- **削除できるかは Claude Code の権限の設定によって変わる。** 設定によってはできないことがある。詳しくは Anthropic の公式ドキュメント（[Configure permissions](https://code.claude.com/docs/en/permissions)）を参照

### できること

```
1. 空き容量を記録する
2. サブエージェントがバックグラウンドで測り、目録と突き合わせる（読み取りだけ）
3. 消せる / 持ち主に頼む / 参考 に分けてレポートする
4. 選ばれたものだけ消す
5. 空き容量の差を報告する
```

調査の間も、呼び出したセッションには別の頼みごとができる。セッションの動いているプロジェクトの成果物は消さず、そのセッションに頼む。スクリプトは持たない。

### 使い方

この skill を読み込んだ `claude` に頼む。

> ゴミ掃除して
>
> ディスクが足りないので空けて

### 中身

| | |
| --- | --- |
| `.agents/skills/cleanup/SKILL.md` | 決まりと手順 |
| `.agents/skills/cleanup/references/survey.md` | 調査を任されたサブエージェントの手順と測り方 |
| `.agents/skills/cleanup/references/catalog.md` | 消してよいものの目録。場所・消し方・失うもの |

## machine-setup

### 読む前に

- **Claude の Pro / Max / Team / Enterprise の契約と、別の端末の Claude App が要る。** 新しいマシンの Claude Code を、スマホなどから [Remote Control](https://code.claude.com/docs/en/remote-control) で操作する。Remote Control は claude.ai でのログインが要り、API キーでは使えない。Team / Enterprise では、オーナーが管理画面で有効にしておく必要がある
- **この手順そのものは、まだ実機で通していない。** 元にした個人のセットアップスクリプトは macOS と Windows で動かしたが、一発では通らず、再起動や順番の修正が要った。そのとき直したところは `references/os-notes.md` に入れてある
- **既定の権限設定では、コマンドを打つたびに承認を求められる。** スマホから承認し続けるか、起動するときに権限のモードを選ぶ。詳しくは Anthropic の公式ドキュメント（[Configure permissions](https://code.claude.com/docs/en/permissions)）を参照
- **ホームの設定ファイルを差し替える。** 取ってきた設定ファイルとぶつかる既存のファイル（rc ファイルや `~/.claude/` の中身など）は、確かめたうえで退避して差し替える。ログインシェルも変えることがある
- **新しいマシンの前でやることがある。** Claude Code のインストールと `/rc`、認証（`gh auth login` や SSH 鍵）、sudo や管理者権限の確認画面、再起動のあとの起動し直し
- **確認は途中でも出る。** 既にあるファイルの退避、ログインシェルの変更、sudo の要る大きな変更は、実行の前に確かめてくる。なるべく最初にまとめて聞くが、放っておけば最後まで進むとは限らない
- **入れるものは、その場で選ぶ。** `references/genres.md` にはジャンルだけを書いてあり、ジャンルごとの候補は Claude が知識から出す。候補は時期や Claude のモデルによって変わり、新しいツールや知られていないツールは出てこないことがある。決まった一覧があるなら、頼むときにその URL を渡す。認証なしで読める URL なら最初に、そうでなければ設定ファイルを取ってきたあとで読む
- **入れ方はその場で公式の情報を見て決める。** 同じものでも、時期によって打つコマンドが変わる

### できること

```
0. 入れるもの（ジャンルごとの候補から選ぶ）、設定ファイルの置き場所・取ってくる手段・管理ツール、あとで確認が要ることを聞く
1. パッケージマネージャを用意する
2. 設定ファイルを取ってくる道具（git, gh など）を入れる
3. 認証してもらい、設定ファイルを取ってくる
4. 選んだアプリ・ツール・言語・フォントを入れる
5. 設定ファイルを展開する
6. シェルと初期設定
7. 再起動のあとで確かめることを書き、報告する
```

進み具合は `~/machine-setup-progress.md` に書くので、再起動でセッションが切れても続きから頼める。

### 使い方

新しいマシンには、まだこのリポジトリも skill も無い。スマホなど別の端末の Claude App から頼む。

1. 新しいマシンに Claude Code を入れる。2026-09 時点のコマンドは次のとおりで、変わっていることがあるので[公式ドキュメント](https://code.claude.com/docs/en/setup)も見る
   - macOS / Ubuntu / WSL: `curl -fsSL https://claude.ai/install.sh | bash`（Ubuntu で curl が無ければ、先に `sudo apt update && sudo apt install -y curl`）
   - Windows (PowerShell): `irm https://claude.ai/install.ps1 | iex`
2. 作業用のディレクトリ（例: `~/machine-setup`）を作って移り、`claude` を起動する。Remote Control の前提になる信頼の確認は、このディレクトリに保存される（ホームディレクトリには保存されない）
3. ログインしていなければ `/login` で claude.ai にログインし、`/rc` で Remote Control を有効にする
4. 別の端末の Claude App から、そのセッションに送る

> https://raw.githubusercontent.com/miyabi-satoh/yorozuya/main/.agents/skills/machine-setup/SKILL.md を curl -fsSL で取って読み、その手順でこのマシンをセットアップして

Windows では `curl` を `curl.exe` にする。fork したなら、URL の `miyabi-satoh` を自分のものに替える。自分の一覧を使うなら「一覧は <URL>」と添える。

再起動のあとは、新しいマシンで同じ作業用のディレクトリに移って `claude` を起動し直し、`/rc` を打って次を送る。`claude` が見つからなければ、`~/.local/bin/claude` をフルパスで打つ。

> ~/machine-setup-progress.md を読んで続けて

このリポジトリを clone してあるマシンでは、`claude` にそのまま頼めばよい。

### 中身

| | |
| --- | --- |
| `.agents/skills/machine-setup/SKILL.md` | 決まりと手順 |
| `.agents/skills/machine-setup/references/genres.md` | 入れるもののジャンルと、候補の出し方 |
| `.agents/skills/machine-setup/references/os-notes.md` | OS ごとに、過去に実機で詰まったところ |
