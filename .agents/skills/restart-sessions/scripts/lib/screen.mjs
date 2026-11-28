// 画面末尾の選択式の問いを見つける。
export function dialogOpen(screen) {
  if (screen === null) return false;
  return screen.split("\n").filter((line) => line.trim() !== "").slice(-3).some((line) => /Esc to cancel/.test(line));
}
