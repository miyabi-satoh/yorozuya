// claude を動かしている端末の道具（hc・Herdr）を環境変数で見分け、どれでも同じ形で呼べるようにする。
// hc（herdr-core）の端末なら HC_TERMINAL_ID、Herdr の中なら HERDR_ENV=1 がある。
// hc を一番先に見る。hc の端末は hc の core を起動した環境を引き継ぐので、Herdr の中で起動した core の端末には HERDR_ENV=1 と
// HERDR_PANE_ID（core を起動したペインのもの）も入る（実測）。それを信じて Herdr の CLI を叩くと、別のペインに届く。
// どれでもなければ Herdr として扱う。どれでもないときに Herdr の CLI が失敗して止まるのは、分ける前と同じ。

import * as hc from './hc.mjs';
import * as herdr from './herdr.mjs';

export function backend() {
  if (process.env.HC_TERMINAL_ID) return 'hc';
  if (process.env.HERDR_ENV === '1') return 'herdr';
  return null;
}

export const isHc = () => backend() === 'hc';

// 知らせや失敗の文に出す名前。
export const label = () => (isHc() ? 'hc' : 'Herdr');

const pick = () => (isHc() ? hc : herdr);

export const lastError = () => (isHc() ? hc.hcError() : herdr.herdrError());

// 呼び出し元自身の { id, sid }。id は hc の端末の address か Herdr のペインID。取れなければ空文字。
export function self() {
  if (isHc()) {
    const id = hc.selfId();
    return { id, sid: hc.sessionOf(hc.terminalInfo(id)) };
  }
  const current = herdr.currentPane();
  return { id: current?.pane_id ?? '', sid: current?.agent_session?.value ?? '' };
}

// 入力を待っているか。Herdr は idle、hc は claude が知らせる語のままで idle か done。
// 返すのは { idle, status }。
export function idleStatus(id) {
  if (isHc()) {
    const status = hc.agentStatus(id);
    return { idle: status === 'idle' || status === 'done', status };
  }
  const status = herdr.agentStatus(id);
  return { idle: status === 'idle', status };
}

export const readScreen = (id) => pick().readScreen(id);
export const inputDraft = (id) => pick().inputDraft(id);
// 薄字の入力候補を書きかけとみなさない読み方。Herdr は色つきで読めるので inputDraft のまま。hc は1字打って確かめる（lib/hc.mjs）。
export const settledDraft = (id) => (isHc() ? hc.settledDraft(id) : herdr.inputDraft(id));
export const backgroundWorkHint = (id) => pick().backgroundWorkHint(id);
export const prompt = (id, text) => pick().prompt(id, text);

// 見張り（watch-context.mjs）が読む claude の一覧。{ id, name, label, sid, cwd, status } の配列で、取れなければ null。
// blocked は承認や選択式の問いの待ち（Herdr の agent_status・hc の status で同じ語）。
export function claudes() {
  if (isHc()) return hc.claudeTerminals();
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
