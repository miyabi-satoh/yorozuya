# OS ごとの注意

OS ごとに、インストールの途中で詰まりやすいところと、その対処。「確かめてから」と付けた項目には、実機での裏付けが無い。「〜を入れたなら」の項目は、それを入れたときに当てはまる。

## 全 OS

- **mise を入れたなら、mise で入れた言語やツールは今のシェルの PATH に無い。** `mise exec <tool> -- <command>` で呼ぶか、`mise where <tool>` の `bin` をフルパスで使う。
- **mise の go で `go install` したものは、GOPATH ではなく go のインストール先の bin（GOBIN）に入る。** 場所は `mise exec go -- go env GOBIN` で見る。go のバージョンに紐づくので、`mise exec go -- <入れたコマンド>` で呼ぶ。設定ファイルの管理ツールを `go install` で入れるときに当たる。
- **`gh auth login` で HTTPS を選び、git の認証も gh に任せたなら、`~/.gitconfig` に git の認証の設定（credential helper）が書かれる。** 設定ファイルが `~/.gitconfig` を持っていると、展開でぶつかる。credential の節を `~/.config/git/config`（`~/.gitconfig` と一緒に読まれる）に移してから展開し、`git ls-remote` で認証が通るか確かめる。設定ファイルが `~/.config/git/config` も持っているなら、移し先をユーザーに聞く。`~/.gitconfig` が symlink になったあとの `git config --global` は、取ってきた設定ファイルの中身を書き換える。
- **rhysd/dotfiles を使うなら、`link --dry` の `Exist:` では衝突を見分けられない。** 宛先に何かあるだけで出るので、正しいリンクでも、居座った実ファイルでも同じ行になる。リンクされたかは `dotfiles list` で確かめる（mapping にあるのに出ないものは、リンクされていない）。

## macOS

- **Apple Silicon では、Homebrew は入れた直後は PATH に無い（`/opt/homebrew/bin/brew`）。** 使うコマンドと同じ呼び出しの頭で `eval "$(/opt/homebrew/bin/brew shellenv)"` を読み込む。Intel の `/usr/local/bin` は最初から PATH にある。インストーラが案内する `~/.zprofile` への追記は、SKILL.md の決まり5のとおりステップ6で扱う。
- **Homebrew のインストーラには sudo が要る。** SKILL.md の決まり9のとおりに用意する。端末の無い呼び出しでは非対話で動き、sudo が通らないと中止する（確かめてから）。Xcode Command Line Tools が無ければ一緒に入り、git も使えるようになる（確かめてから）。
- **`/bin/bash` は 3.2。** その場で書くシェルスクリプトは、3.2 で動く書き方にする（連想配列は 4 から）。
- **Homebrew の zsh をログインシェルにするなら、先に `/etc/shells` に登録する（sudo）。** macOS 標準の `/bin/zsh` は登録済み。変更が効くのは新しいターミナルから。

## Ubuntu / WSL

- **mise を mise.run で入れたなら、`~/.local/bin` に入り、今のシェルの PATH に無い。** フルパスで呼ぶ。
- **GUI アプリが apt に無ければ、flatpak か snap で入れる**（WSL では GUI アプリを入れない。確かめてから）。
- **apt がロックで失敗したら、自動更新（unattended-upgrades など）が終わるのを待って再試行する（確かめてから）。** ロックの持ち主は `sudo lsof /var/lib/dpkg/lock-frontend` で見る。ロックファイルは消さずに待つ（消すと動いている更新を壊す）。中断した dpkg は `sudo dpkg --configure -a` で直す。
- **Docker Engine を入れたなら、docker グループへの追加（sudo が要る）は再ログインするまで効かない（確かめてから）。**
- **WSL の `/etc/wsl.conf` の変更は、Windows 側で `wsl --shutdown` するまで効かない（確かめてから）。** 打つと WSL の中の Claude Code も止まるので、ステップ7に回す。

## Windows

- **Git for Windows を最初に入れる（`Git.Git`）。** Claude Code は、Git for Windows が無いと PowerShell でコマンドを打ち、あると Git Bash の Bash ツールを使う（公式ドキュメント）。途中で入れても、Claude Code を起動し直すまで Bash ツールには切り替わらない見込み（確かめてから）。それまでは、bash のコマンドを PowerShell に読み替える。
- **winget は、最初にソースの規約に同意しておく**（`winget list --accept-source-agreements` など）。winget が無ければ App Installer を入れる（入れ方は確かめてから）。
- **winget の次の終了コードは、入っていたものとして成功に数える。** `-1978335135`（`0x8A150061`、入っている版がある）と `-1978335189`（`0x8A15002B`、当てはまる更新が無い。入っていて新しい版が無いときに返る）。
- **winget で入れたものは、動いている PowerShell の PATH に載らない。** 使うコマンドと同じ呼び出しの頭で、レジストリから読み直す。

  ```powershell
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  ```

  User の PATH に書き足すときは、User の値だけに足す。読み直した `$env:Path` をそのまま User に書き込むと、Machine の分が重なって膨らむ。
- **uutils.coreutils を入れたなら、winget で入れても PATH に登録されない。** 本体は `%LOCALAPPDATA%\Microsoft\WinGet\Packages\uutils.coreutils*` の下にある。
- **yazi を入れたなら、Git for Windows に付いてくる `file.exe` を使わせる。** 環境変数 `YAZI_FILE_ONE` にその場所（既定では `C:\Program Files\Git\usr\bin\file.exe`）を入れる。
- **マシン全体へのインストールでは、UAC の確認画面が出る（確かめてから）。** Claude Code からは押せない。ステップ0で「押せる人がいない」と答えられていたら、その項目は後回しにして記録する。管理者で入れるものは、一般ユーザーで入れるものと分けてまとめると、確認画面に答える回数が減る。
- **PowerShell のプロファイルで mise を読み込んでいるなら、新しい PowerShell で PATH が効いているか確かめる。** `mise env --shell=pwsh` の出力は `${Env:PATH}=` の形なので、`$env:` で始まる行だけを拾う絞り込みでは PATH が足されない。
- **設定ファイルを symlink で展開するには、開発者モードか管理者権限が要るはず（確かめてから）。** Git Bash の `ln -s` は、`MSYS=winsymlinks:nativestrict` が無いと symlink ではなくコピーを作る（確かめてから）。ステップ5の確かめで symlink になっていなければ、これを疑う。
- **Windows PowerShell 5.1 の既定の実行ポリシーでは、`.ps1` をそのまま実行できない（確かめてから）。** 管理者のスクリプトは、SKILL.md の決まり9のとおり `-ExecutionPolicy Bypass -File` で、その実行だけ許す。プロファイルが読まれないときも実行ポリシーを確かめる。PowerShell 7 の既定は RemoteSigned。
