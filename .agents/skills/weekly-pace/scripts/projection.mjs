// pace.mjs・codex-pace.mjs が共有する、着地見込みの計算。
//
// 使うのは毎日の稼働の時間帯だけと仮定し、経過も週の長さも稼働の時間帯の中の時間で数える。壁の時計で数えると、
// 寝ている間も経過が進み、朝に見るとローペース・夕方に見るとハイペースのように、見る時刻で判定が揺れるため。
// 時間帯の外で使った分は、使用率には入るので、その後の稼働の時間に使ったものとして数える。

// 既定の稼働の時間帯（ローカル時刻の時。始まりを含み、終わりを含まない）。1日 8h の稼働を前提にした、作者の作業の時間帯。
// 人によって違うので、--active-hours か環境変数で変える。
export const DEFAULT_ACTIVE_HOURS = '12-20';
export const ACTIVE_HOURS_ENV = 'WEEKLY_PACE_ACTIVE_HOURS';

// 稼働の時間がこれより短いと、使用率の端数で数字が跳ねるので判定しない。
const MIN_ACTIVE_ELAPSED_HOURS = 2;
// 着地見込みがこれを下回ると、リセットで3割以上を捨てることになるので「ローペース」と出す。
const LOW_PACE_PERCENT = 70;

// "12-20" → {start: 12, end: 20}。"22-6" のように日をまたぐ書き方と、"0-24"（終日。壁の時計で数えるのと同じ）も受ける。
export function parseActiveHours(spec) {
  const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(spec ?? '');
  const [start, end] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN];
  if (!(start >= 0 && start <= 23 && end >= 0 && end <= 24 && start !== end)) {
    throw new Error(`稼働の時間帯は "12-20" のように 開始時-終了時 で書く（0〜24、開始と終了は別の時刻）: "${spec}"`);
  }
  return { start, end };
}

// コマンドの引数（--active-hours）、環境変数、既定の順に読む。
export function activeHoursFrom(args, env = process.env) {
  const i = args.indexOf('--active-hours');
  if (i >= 0) return parseActiveHours(args[i + 1]);
  return parseActiveHours(env[ACTIVE_HOURS_ENV] || DEFAULT_ACTIVE_HOURS);
}

function at(day, hour) {
  // setHours はローカル時刻で数えるので、夏時間の切り替わりの日も壁の時計の時刻に合う。24 は翌日の 0 時になる。
  const d = new Date(day);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

// [fromMs, toMs) のうち、毎日の稼働の時間帯に入る時間（h）。
export function activeHoursBetween(fromMs, toMs, { start, end }) {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  // 日をまたぐ時間帯は前の日に始まるので、1日前から数える。
  const day = new Date(fromMs);
  day.setDate(day.getDate() - 1);
  day.setHours(0, 0, 0, 0);
  while (day.getTime() < toMs) {
    const windowStart = at(day, start);
    const windowEnd = end > start ? at(day, end) : at(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1), end);
    total += Math.max(0, Math.min(toMs, windowEnd) - Math.max(fromMs, windowStart));
    day.setDate(day.getDate() + 1);
  }
  return total / 3_600_000;
}

// 枠の始まりから今までの稼働の時間で使った率を、枠の終わりまでの稼働の時間へ伸ばす。
export function project({ pct, resetsAtMs, windowHours, nowMs = Date.now(), activeHours }) {
  const windowStartMs = resetsAtMs - windowHours * 3_600_000;
  const activeElapsedHours = activeHoursBetween(windowStartMs, nowMs, activeHours);
  const activeTotalHours = activeHoursBetween(windowStartMs, resetsAtMs, activeHours);
  const projected =
    activeElapsedHours < MIN_ACTIVE_ELAPSED_HOURS ? null : (pct / activeElapsedHours) * activeTotalHours;
  return { activeElapsedHours, activeTotalHours, projected, verdict: verdictOf(projected) };
}

export function verdictOf(projected) {
  if (projected === null) return null;
  if (projected > 100) return 'ハイペース';
  if (projected < LOW_PACE_PERCENT) return 'ローペース';
  return '順調';
}

const fmt1 = (n) => Math.round(n * 10) / 10;

// 人が読む一行。label は "Weekly" か "Codex Weekly"。
export function describe(label, pct, remainingHours, { start, end }, { activeElapsedHours, activeTotalHours, projected, verdict }) {
  const hours = `稼働 ${start}〜${end}時で経過 ${fmt1(activeElapsedHours)}h / 枠 ${fmt1(activeTotalHours)}h`;
  if (projected === null) {
    return `${label} ${pct}%（${hours}）・ 稼働の時間がまだ短い。判定不可（目安にするには経過が短すぎる）`;
  }
  return `${label} ${pct}%（${hours}、リセットまで残り ${fmt1(remainingHours)}h）→ このペースの着地見込み ${fmt1(projected)}% … ${verdict}（線形外挿の目安）`;
}
