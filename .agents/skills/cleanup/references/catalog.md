# 掃除候補の目録

よく容量を食う定番の場所。**網羅ではなく当たりを付けるための一覧。** パスは macOS / Linux の既定で書き、Windows の既定は末尾の「Windows」にまとめた。場所が分からなければ道具のコマンド（`npm config get cache` など）で引く。

コマンドの書式はバージョンで変わる。実行前に `--help` で確かめる。

## パッケージマネージャのキャッシュ

どれも再生成できる。失うのは次のインストールでのダウンロード時間だけ。

| 道具 | 場所の引き方 | 消し方 |
| --- | --- | --- |
| npm | `npm config get cache` | `npm cache clean --force` |
| pnpm | `pnpm store path` | `pnpm store prune`（どのプロジェクトからも参照されないものだけ消える）。ストアのバージョン違い（`v3` `v10` など）が残っていれば、今のパスでないものは削除できる。`node_modules` とハードリンクを共有するので、空く量は `find <store> -type f -links 1` の分だけ（NTFS でこの数え方が正しいかは未確認） |
| yarn | `yarn cache dir` | `yarn cache clean` |
| bun | `~/.bun/install/cache` | `bun pm cache rm`（`package.json` のあるディレクトリで実行する。無いと失敗する） |
| pip | `pip cache dir` | `pip cache purge` |
| uv | `uv cache dir` | `uv cache prune`（全消しは `uv cache clean`） |
| Go ビルドキャッシュ | `go env GOCACHE` | `go clean -cache` |
| Go モジュール | `go env GOMODCACHE` | `go clean -modcache`（オフラインでビルドできなくなる） |
| Cargo レジストリ | `~/.cargo/registry` | 専用コマンドは標準に無い。`cache/` と `src/` は消しても再取得される |
| Homebrew | `brew --cache` | `brew cleanup --prune=all` |
| mise | `mise cache path` | `mise prune`（使われていない古いバージョンのツール）。`mise prune --dry-run` で消える候補と理由を読み取りだけで見られる |
| Gradle | `~/.gradle/caches` | Gradle を止めてから削除 |
| Maven | `~/.m2/repository` | 削除すると全依存を再ダウンロード。「失うものがある」寄り |

## ツールチェーン

| もの | 場所の引き方 | 消し方 | 失うもの |
| --- | --- | --- | --- |
| Rust の古いツールチェーン | `rustup toolchain list` | `rustup toolchain uninstall <name>` | そのバージョンを固定したプロジェクト（`rust-toolchain.toml`）が再ダウンロードする。固定の有無を確かめる |

## ビルド成果物

プロジェクトの中にある。**稼働中のプロジェクトなら「持ち主に頼む」。** 消す前に `git check-ignore -q` で無視対象か確かめる。

| もの | 探し方 | 消し方 |
| --- | --- | --- |
| Rust `target/` | `find <dir> -type d -name target -prune` | `cargo clean`（プロジェクトで） |
| `node_modules/` | `find <dir> -type d -name node_modules -prune` | 削除。lockfile があれば `install` で戻る |
| フレームワークの出力（`.next/` `.nuxt/` `.svelte-kit/` `.turbo/` など） | 同上 | 削除 |
| `dist/` `build/` | 同上 | **無視対象のときだけ。** コミットされている配布物のことがある |
| Python の仮想環境（`.venv/`） | 同上 | 削除。依存の定義ファイルから作り直せるか確かめる |

`target/` がすぐ膨らむなら、`[profile.dev] debug = "line-tables-only"` などデバッグ情報を減らす設定が効く。これは掃除ではなく持ち主の判断。

## テスト用ブラウザ・ネイティブビルドの素材

再生成できるが、再ダウンロードが大きい。

| もの | 場所 | 消し方 |
| --- | --- | --- |
| Playwright のブラウザ | macOS `~/Library/Caches/ms-playwright`、Linux `~/.cache/ms-playwright` | `npx playwright uninstall --all`、または削除 |
| Puppeteer のブラウザ | `~/.cache/puppeteer` | 削除 |
| node-gyp のヘッダ | `~/.node-gyp`、`~/Library/Caches/node-gyp`、`~/.cache/node-gyp` | 削除 |
| Electron | macOS `~/Library/Caches/electron`、Linux `~/.cache/electron` | 削除 |

## コンテナ・仮想環境

| もの | 測り方 | 消し方 | 失うもの |
| --- | --- | --- | --- |
| Docker | `docker system df` | `docker system prune`（止まったコンテナ・宙に浮いたイメージ・ビルドキャッシュ） | 止まったコンテナ。`-a` で未使用イメージ、`--volumes` でボリュームも消え、ボリュームはデータを失う |
| Docker のビルドキャッシュだけ | 同上 | `docker builder prune`（新しい版では `docker buildx prune` の別名） | 次のビルド時間 |

**仮想ディスクと VM は「触らない」。** 仮想ディスク（`.vhd` `.vhdx` `.vdi` `.vmdk`）、VirtualBox などの VM フォルダ、サンドボックス用のイメージ（Claude デスクトップの `vm_bundles` など）は現用のことが多く、目録に無くても最大の塊になりやすい。持ち主に確かめる。

Docker Desktop のディスク（macOS `Docker.raw`、Windows `docker_data.vhdx`）は、中のイメージを prune しても自動では縮まないことがある。縮める手順は確かめていない。

## macOS の開発ツール

| もの | 場所 | 消し方 | 失うもの |
| --- | --- | --- | --- |
| Xcode DerivedData | `~/Library/Developer/Xcode/DerivedData` | 削除 | 次のビルド時間 |
| 使えないシミュレータ | `xcrun simctl list` | `xcrun simctl delete unavailable` | 無し |
| 実機のサポートファイル | `~/Library/Developer/Xcode/iOS DeviceSupport` | 古い OS バージョンのフォルダを削除 | その OS の実機デバッグ時に再取得 |

## OS

| もの | 場所 | 消し方 | 失うもの |
| --- | --- | --- | --- |
| ゴミ箱 | macOS `~/.Trash`、Linux `~/.local/share/Trash`、Windows `C:\$Recycle.Bin\<SID>` | ユーザーに空にしてもらうか削除 | 戻せなくなる。「失うものがある」 |
| 一時ファイル | Windows `%TEMP%` | 使用中のものを除いて削除 | 無し |
| APFS ローカルスナップショット | `tmutil listlocalsnapshots /` | `tmutil thinlocalsnapshots / <バイト数> 4` | その時点への Time Machine の復元 |

`~/Library/Caches` 全体を消すのはやめておく。アプリごとに中身の性質が違うので、大きいものを1つずつ正体を確かめる。

## Windows

道具のキャッシュの既定の場所。多くは `%LOCALAPPDATA%` の下にある。

| もの | 場所 |
| --- | --- |
| npm | `%LOCALAPPDATA%\npm-cache` |
| pnpm のメタデータキャッシュ | `%LOCALAPPDATA%\pnpm-cache` |
| Playwright | `%LOCALAPPDATA%\ms-playwright` |
| Electron | `%LOCALAPPDATA%\electron\Cache` |
| Go ビルドキャッシュ | `%LOCALAPPDATA%\go-build` |
| Go モジュール | `%USERPROFILE%\go\pkg\mod` |
| uv | `%LOCALAPPDATA%\uv\cache` |
| mise | `%TEMP%\mise`（`%TEMP%` の掃除と重なる） |

**触らない。** `pagefile.sys` と `hiberfil.sys`（OS の設定で変えるもので、削除するものではない）、`C:\Windows`（整理には DISM と管理者権限が要る。ユーザーに案内するだけ）、`%LOCALAPPDATA%\Microsoft\WinGet\Packages`（インストール先）。

Windows では `find -mtime` などの走査が遅い。測り方は survey.md の「測り方」を使う。

## Claude Code のデータ（`~/.claude`）

**古いデータは Claude Code が自動で掃除する。** `cleanupPeriodDays`（既定 30 日、最小 1）より古い会話ログ・サブエージェントの記録・`tool-results/`・`file-history/`・`paste-cache/`・`tasks/`・`shell-snapshots/`・`debug/` などが対象。溜まって困るなら、手で消すより `cleanupPeriodDays` を下げることを案内する。

手で消すなら、失うものは次のとおり（公式ドキュメント「Explore the .claude directory」）。

| 消すもの | 失うもの |
| --- | --- |
| `projects/` の会話ログ | 過去のセッションの resume・continue・rewind |
| `file-history/` | 過去のセッションのチェックポイント復元 |
| `history.jsonl` | 上矢印での入力履歴・`Ctrl+R` の検索 |
| `tasks/` | resume したセッションが引き継ぐタスクリスト |
| `debug/` `plans/` `image-cache/` `session-env/` `shell-snapshots/` `backups/` | 利用者から見えるものは無し |

1つのプロジェクトの分をまとめて消すなら `claude project purge <path> --dry-run` で計画を見てから。

**触らない。** `~/.claude.json`、`~/.claude/settings.json`、`~/.claude/plugins/`（認証・設定・インストール済みプラグイン）、`projects/*/memory/`（メモリ）、`.credentials.json`、`agent-memory/`、`jobs/` と `daemon/`。起動中のセッションの会話ログと `tool-results/` も消さない。
