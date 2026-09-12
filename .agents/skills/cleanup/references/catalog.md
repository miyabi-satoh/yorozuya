# 目録: 消してよいもの

**ここに載っている種類だけを消せる。** 載っていないものは消さない。足すときは、失うものを確かめてから行を足す。

パスは macOS / Linux の既定。Windows の既定は末尾の表。場所が違えば「場所の引き方」のコマンドで引く。コマンドの書式はバージョンで変わるので、実行前に `--help` で確かめる。

## パッケージマネージャのキャッシュ

| もの | 場所の引き方 | 消し方 | 失うもの |
| --- | --- | --- | --- |
| npm | `npm config get cache` | `npm cache clean --force` | 次のインストールのダウンロード |
| pnpm | `pnpm store path` | `pnpm store prune` | 同上 |
| pnpm の古いストア | `pnpm store path` の親にある、今のバージョン以外のフォルダ（`v3` `v10` など） | 削除 | 同上。`node_modules` とファイルを共有しているので、空く量はサイズより小さい（macOS は clone のため見積もれない） |
| yarn | Yarn 1 は `yarn cache dir`、2 以降は `yarn config get cacheFolder` | Yarn 1 は `yarn cache clean`、2 以降は `yarn cache clean --all` | 同上 |
| bun | `~/.bun/install/cache` | `bun pm cache rm`（`package.json` のあるディレクトリで実行する） | 同上 |
| pip | `pip cache dir` | `pip cache purge` | 同上 |
| uv | `uv cache dir` | `uv cache clean` | 同上 |
| Go ビルドキャッシュ | `go env GOCACHE` | `go clean -cache` | 次のビルド時間 |
| Go モジュール | `go env GOMODCACHE` | `go clean -modcache` | 再ダウンロード。その間オフラインでビルドできない |
| Cargo レジストリ | `~/.cargo/registry` の `cache/` と `src/` | 削除 | 同上 |
| Homebrew | `brew --cache` | `brew cleanup --prune=all`（先に `brew cleanup -n` で一覧を見せる） | ダウンロード済みのファイルと、**インストール済みの古いバージョン** |

## ツール

| もの | 場所の引き方 | 消し方 | 失うもの |
| --- | --- | --- | --- |
| mise の使われていない版 | `mise prune --dry-run` | `mise prune` | 記録に残っていないプロジェクトが使う版。そのプロジェクトで再インストールが要る |
| Rust の古いツールチェーン | `rustup toolchain list` | `rustup toolchain uninstall <name>` | そのバージョンを `rust-toolchain.toml` で固定したプロジェクトの再ダウンロード |
| Playwright のブラウザ | macOS `~/Library/Caches/ms-playwright`、Linux `~/.cache/ms-playwright` | `npx playwright uninstall --all` か削除 | E2E テスト前の再ダウンロード |
| Puppeteer のブラウザ | `~/.cache/puppeteer` | 削除 | 同上 |
| node-gyp のヘッダ | `~/.node-gyp`、`~/Library/Caches/node-gyp`、`~/.cache/node-gyp` | 削除 | ネイティブモジュールのビルド時の再ダウンロード |
| Electron | macOS `~/Library/Caches/electron`、Linux `~/.cache/electron` | 削除 | 再ダウンロード |
| Xcode DerivedData | `~/Library/Developer/Xcode/DerivedData` | 削除 | 次のビルド時間 |
| 使えないシミュレータ | `xcrun simctl list` | `xcrun simctl delete unavailable` | 無し |

## ビルド成果物

作業ディレクトリの中を名前で探す。**条件: git の無視対象で、セッションの動いていないプロジェクトにあること。** 動いているなら「持ち主に頼む」。

| もの | 探し方 | 消し方 | 失うもの |
| --- | --- | --- | --- |
| Rust `target/` | `find <dir> -type d -name target -prune`（隣に `Cargo.toml` があるもの） | `cargo clean` | 次のビルド時間 |
| `node_modules/` | `find <dir> -type d -name node_modules -prune`（隣に lockfile があるもの） | 削除 | 次の `install` |
| `.next/` `.nuxt/` `.svelte-kit/` `.turbo/` | 同上 | 削除 | 次のビルド時間 |

## Docker

| もの | 場所の引き方 | 消し方 | 失うもの |
| --- | --- | --- | --- |
| ビルドキャッシュ | `docker system df` | `docker builder prune` | 次のビルド時間 |
| 使われていないイメージ | `docker images` と `docker ps -a` | `docker image prune -a`（先に消えるイメージの一覧を見せる） | 再 pull か再ビルド |

## OS

| もの | 場所の引き方 | 消し方 | 失うもの |
| --- | --- | --- | --- |
| ゴミ箱 | macOS `~/.Trash`、Linux `~/.local/share/Trash`、Windows `C:\$Recycle.Bin` | ユーザーに空にしてもらう | 中身を戻せなくなる |
| 一時ファイル（Windows） | `%TEMP%` | 使用中のものを除いて削除 | 無し |

## Windows の既定の場所

| もの | 場所 |
| --- | --- |
| npm | `%LOCALAPPDATA%\npm-cache` |
| pnpm のストア | `pnpm store path` で引く |
| Playwright | `%LOCALAPPDATA%\ms-playwright` |
| Electron | `%LOCALAPPDATA%\electron\Cache` |
| Go ビルドキャッシュ | `%LOCALAPPDATA%\go-build` |
| Go モジュール | `%USERPROFILE%\go\pkg\mod` |
| uv | `%LOCALAPPDATA%\uv\cache` |

## 載せていないもの

- **Claude Code のデータ（`~/.claude`）** — 古いものは Claude Code が `cleanupPeriodDays`（既定 30 日）で自動で消す。溜まって困るなら、この日数を下げるよう案内する。
