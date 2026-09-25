// 環境ごとの設定（config.local.json）を読む。リポジトリには入れず、形は config.example.json にある。
// ステータスラインの表示や閾値の好みは使う人ごとに違うので、スクリプトの既定値には埋めない。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CONFIG = fileURLToPath(new URL('../../config.local.json', import.meta.url));

// 無ければ {}。読めない・JSON でないときは error に理由を入れて返す（黙って既定値で走らせない）。
export function loadConfig() {
  let text;
  try {
    text = readFileSync(CONFIG, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { config: {}, error: '' };
    return { config: {}, error: `${CONFIG} を読めない: ${error.message}` };
  }
  try {
    const config = JSON.parse(text);
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      return { config: {}, error: `${CONFIG} の中身がオブジェクトではない` };
    }
    return { config, error: '' };
  } catch (error) {
    return { config: {}, error: `${CONFIG} を JSON として読めない: ${error.message}` };
  }
}
