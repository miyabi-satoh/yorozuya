# 調査の手順（サブエージェント向け）

ディスクの掃除候補を測って、目録（catalog.md）と突き合わせ、表で返す。**読み取りだけ。** 削除・移動・書き込み・prune 系のコマンド・他のセッションの操作はしない。

## 1. 目録の行を探す

catalog.md の行ごとに、「場所の引き方」でこの環境にあるかを調べ、あればサイズを測る。

- ビルド成果物（`target/` や `node_modules/` など）は、作業ディレクトリの中を名前で探す（Windows では `Get-ChildItem -Recurse` が遅いので、.NET の `EnumerateDirectories` で名前を探す）。`git check-ignore -q <path>` で無視対象と確かめられたものだけ載せる。
- 依頼で渡された「セッションの動いているプロジェクト」の中にあるものは「持ち主に頼む」に置く。どのセッションが動いているかは、渡された一覧だけで判断する（サブエージェントからは調べられないことがある）。
- 目録の「条件」を満たさない行は載せない。

## 2. 目録に無い大きいものを探す

測る場所の直下のフォルダと、1GB 以上の単独のファイル（仮想ディスクなど）を測り、目録に当たらないものを大きい順に「参考」に置く。正体が分かれば一言添える。1GB 以上のフォルダの中は、目録に当たる場所が隠れていないか1段だけ降りて見る。

測るのは依頼で渡された場所だけ。ディスク全体やシステムの領域は測らない。

## 測り方

どちらも1回の走査でフォルダの合計と大きいファイルの一覧を出す。数字は目安で、読めない場所は数えられない。

- **macOS / Linux:**
  - フォルダ: `find <dir> -mindepth 1 -maxdepth 1 -exec du -sh -x {} + 2>/dev/null | sort -rh | head -20`（ドットで始まるものも含む）
  - 大きいファイル: `find <dir> -xdev -type f -size +1G -exec ls -lh {} + 2>/dev/null`
- **Windows:** Git Bash の `du` や `Get-ChildItem -Recurse` は遅すぎて使えない。PowerShell 7 で .NET の列挙を使う。

  ```powershell
  $dir  = '<dir>'
  $skip = [System.IO.FileAttributes]::ReparsePoint
  $o = [System.IO.EnumerationOptions]@{ RecurseSubdirectories = $true; IgnoreInaccessible = $true; AttributesToSkip = $skip }
  $big = [System.Collections.Generic.List[object]]::new()
  $rows = @(foreach ($d in Get-ChildItem $dir -Directory -Force -ErrorAction SilentlyContinue | Where-Object { -not ($_.Attributes -band $skip) }) {
    $sum = 0L
    foreach ($f in $d.EnumerateFiles('*', $o)) { $sum += $f.Length; if ($f.Length -ge 1GB) { $big.Add($f) } }
    [pscustomobject]@{ GB = [math]::Round($sum / 1GB, 2); Path = $d.FullName }
  })
  $top = @(Get-ChildItem $dir -File -Force -ErrorAction SilentlyContinue)
  $top | Where-Object Length -ge 1GB | ForEach-Object { $big.Add($_) }
  $rows += [pscustomobject]@{ GB = [math]::Round((($top | Measure-Object Length -Sum).Sum) / 1GB, 2); Path = "$dir（直下のファイル）" }
  $rows | Sort-Object GB -Descending | Select-Object -First 20 | Format-Table -AutoSize
  $big  | Sort-Object Length -Descending | Select-Object @{ n = 'GB'; e = { [math]::Round($_.Length / 1GB, 2) } }, FullName | Format-Table -AutoSize
  ```

  `AttributesToSkip` の既定は Hidden と System で、指定しないと AppData が丸ごと抜ける。リパースポイントを飛ばすので、OneDrive や Dropbox のフォルダは数えられないことがある。PowerShell 7 が無ければ、測れなかったこととして返す。

## 返す

区分（消せる / 持ち主に頼む / 参考）ごとの表を、サイズの大きい順に返す。「消せる」の行にはパス・サイズ・消し方・失うもの（目録のとおり）を載せる。測れなかった場所があれば理由を添える。測った生の出力は返さない。
