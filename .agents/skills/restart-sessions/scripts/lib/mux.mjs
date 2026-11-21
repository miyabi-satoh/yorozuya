// claude を動かしている端末の道具（Herdr か Orca）を環境変数で見分け、どちらでも同じ形で呼べるようにする。
// Herdr の中なら HERDR_ENV=1、Orca の端末なら ORCA_TERMINAL_HANDLE がある。Orca の端末には HERDR_ENV を引き継がせていないが、
// 両方があれば Herdr を先にする（Herdr の中で Orca の CLI を叩いても、自分の端末には届かないため）。
// どちらでもなければ Herdr として扱う。どちらでもないときに Herdr の CLI が失敗して止まるのは、分ける前と同じ。

import * as herdr from './herdr.mjs';
import * as orca from './orca.mjs';

export function backend() {
  if (process.env.HERDR_ENV === '1') return 'herdr';
  if (process.env.ORCA_TERMINAL_HANDLE) return 'orca';
  return null;
}

export const isOrca = () => backend() === 'orca';

// 知らせや失敗の文に出す名前。
export const label = () => (isOrca() ? 'Orca' : 'Herdr');

export const lastError = () => (isOrca() ? orca.orcaError() : herdr.herdrError());

// 呼び出し元自身の { id, sid }。id は Herdr のペインID か Orca の端末のハンドル。取れなければ空文字。
export function self() {
  if (isOrca()) {
    const found = orca.selfSession();
    return { id: found?.handle ?? '', sid: found?.entry?.sessionId ?? '' };
  }
  const current = herdr.currentPane();
  return { id: current?.pane_id ?? '', sid: current?.agent_session?.value ?? '' };
}

// 入力を待っているか。Herdr は idle、Orca は done（ターンを終えて入力を待つ）。返すのは { idle, status }。
export function idleStatus(id) {
  if (isOrca()) {
    const status = orca.agentState(id);
    return { idle: status === 'done', status };
  }
  const status = herdr.agentStatus(id);
  return { idle: status === 'idle', status };
}

export const readScreen = (id) => (isOrca() ? orca.readScreen(id) : herdr.readScreen(id));
export const inputDraft = (id) => (isOrca() ? orca.inputDraft(id) : herdr.inputDraft(id));
export const backgroundWorkHint = (id) => (isOrca() ? orca.backgroundWorkHint(id) : herdr.backgroundWorkHint(id));
export const prompt = (id, text) => (isOrca() ? orca.prompt(id, text) : herdr.prompt(id, text));

// 見張り（watch-context.mjs）が読む claude の一覧。{ id, name, label, sid, cwd, status } の配列で、取れなければ null。
// blocked は承認や選択式の問いの待ち（Herdr の agent_status と Orca の state で同じ語）。
export function claudes() {
  if (isOrca()) return orca.claudeTerminals();
  const agents = herdr.herdrJson(['agent', 'list'])?.result?.agents;
  if (!Array.isArray(agents)) return null;
  return agents
    .filter((agent) => agent.agent === 'claude' && agent.pane_id)
    .map((agent) => ({
      id: agent.pane_id,
      name: agent.name,
      label: agent.terminal_title_stripped || agent.name || agent.pane_id,
      sid: agent.agent_session?.value || '',
      cwd: agent.cwd,
      status: agent.agent_status,
    }));
}
