# 調査の手順（サブエージェント向け）

ディスクの掃除候補を測って、目録（catalog.md）と突き合わせ、表で返す。**読み取りだけ。** 削除・移動・書き込み・prune 系のコマンド・他のセッションの操作はしない。

## 1. 目録の行を探す

catalog.md の行ごとに、「場所の引き方」でこの環境にあるかを調べ、あればサイズを測る。

- ビルド成果物（`target/` や `node_modules/` など）は、作業ディレクトリの中を名前で探す。`git check-ignore -q <path>` で無視対象と確かめられたものだけ載せる。
- 依頼で渡された「セッションの動いているプロジェクト」の中にあるものは「持ち主に頼む」に置く。
- 目録の「条件」を満たさない行は載せない。

## 2. 目録に無い大きいものを探す

測る場所の直下を測り、1GB 以上で目録に当たらないものを大きい順に「参考」に置く。正体が分かれば一言添える。1GB 以上のものの中は、目録に当たる場所が隠れていないか1段だけ降りて見る。

## 測り方

- **macOS / Linux:** `find <dir> -mindepth 1 -maxdepth 1 -exec du -sh -x {} + 2>/dev/null | sort -rh | head -20`（ドットで始まるものも含む）。
- **Windows:** Git Bash の `du` は遅すぎて使えない。PowerShell 7 で .NET の列挙を合計する。隠し属性のファイルも数え、ジャンクションなどのリパースポイントは二重に数えないよう飛ばす。

  ```powershell
  $dir  = '<dir>'
  $skip = [System.IO.FileAttributes]::ReparsePoint
  $o = [System.IO.EnumerationOptions]@{ RecurseSubdirectories = $true; IgnoreInaccessible = $true; AttributesToSkip = $skip }
  $rows = Get-ChildItem $dir -Directory -Force -ErrorAction SilentlyContinue | Where-Object { -not ($_.Attributes -band $skip) } | ForEach-Object {
    [pscustomobject]@{ GB = [math]::Round((($_.EnumerateFiles('*', $o) | Measure-Object Length -Sum).Sum) / 1GB, 2); Path = $_.FullName }
  }
  $files = (Get-ChildItem $dir -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  @($rows) + [pscustomobject]@{ GB = [math]::Round($files / 1GB, 2); Path = "$dir（直下のファイル）" } | Sort-Object GB -Descending | Select-Object -First 20
  ```

  `AttributesToSkip` の既定は Hidden と System で、指定しないと AppData が丸ごと抜ける。PowerShell 7 が無ければ、測れなかったこととして返す。OneDrive のフォルダはリパースポイント扱いで数えられない可能性がある（未確認）。

## 返す

区分（消せる / 持ち主に頼む / 参考）ごとの表を、サイズの大きい順に返す。「消せる」の行にはパス・サイズ・消し方・失うもの（目録のとおり）を載せる。測れなかった場所があれば理由を添える。測った生の出力は返さない。
