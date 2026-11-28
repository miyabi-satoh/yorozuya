import path from 'node:path';

// Windows では WSL の bash.exe を避け、Git for Windows の bash だけを選ぶ。
export function shellFor(command, platform, env, exists) {
  if (platform !== 'win32') return [env.SHELL || 'sh', ['-c', command]];
  const configured = env.CLAUDE_CODE_GIT_BASH_PATH;
  const paths = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const candidates = [
    configured,
    ...paths.filter(dir => exists(path.win32.join(dir, 'git.exe'))).map(dir => path.win32.resolve(dir, '..', 'bin', 'bash.exe')),
    env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  const bash = candidates.find(file => exists(file));
  if (bash) return [bash, ['-c', command]];
  // pwsh は終了コードを丸めるので、自分で返す。
  return ['pwsh', ['-NoProfile', '-Command', `${command}\n$ok = $?; if (-not $ok) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }`]];
}
