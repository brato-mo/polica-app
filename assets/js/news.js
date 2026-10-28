// MYJYSK tasks and news: what is kept on the phone, what counts as the employee's own, and what is new.
// Pure functions, no access to the page or the phone.

// task roles that every store employee gets (as opposed to Store Manager, Deputy Store Manager)
export const STAFF_ROLES = ['store staff', 'store staff - part timers', 'sve uloge', 'all roles'];

export const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').trim();

/** "Jasmin Omerika, 294641" -> [['jasmin','omerika'], ['294641']]: each entry matches when all its words are there. */
export function meTokens(me) {
  return String(me || '').split(/[,;]/).map((p) => fold(p).split(/\s+/).filter((w) => w.length >= 2)).filter((ws) => ws.length);
}

const whoMatches = (who, tokens) => {
  const w = fold(who);
  return !!w && tokens.some((ws) => ws.every((x) => w.includes(x)));
};

/** A task is the employee's: it is on his own task list, it is for every store employee, or it names him. */
export function isMine(t, myIds, tokens) {
  if (myIds.has(t.id)) return true;
  if (STAFF_ROLES.includes(fold(t.role))) return true;
  return whoMatches(t.who, tokens) || whoMatches(t.role, tokens);
}

/** The tasks that concern the employee, open ones first by due date; done ones are left out. */
export function myTasks(st, me) {
  if (!st) return [];
  const tokens = meTokens(me);
  const myIds = new Set((st.my || []).map((t) => t.id));
  const by = new Map();
  for (const t of [...(st.my || []), ...(st.loc || [])]) {
    if (t.done || by.has(t.id) || !isMine(t, myIds, tokens)) continue;
    by.set(t.id, t);
  }
  return [...by.values()].sort(byDue);
}

export const byDue = (a, b) => String(a.end || '9').localeCompare(String(b.end || '9')) || String(a.title).localeCompare(String(b.title));

/**
 * Puts a new read next to what was kept. seen: id -> when it was first seen (0 for the very first read, so that
 * nothing is "new" then). viewedAt: when the employee last left the Vijesti screen; later ids are new to him.
 */
export function merge(prev, data, at) {
  const first = !prev || !prev.at || !prev.seen;
  const seen = {};
  const lists = ['my', 'loc', 'news', 'sys'];
  for (const k of lists) {
    for (const x of data[k] || []) {
      if (!x || !x.id) continue;
      const was = prev && prev.seen ? prev.seen[x.id] : undefined;
      seen[x.id] = was !== undefined ? was : first ? 0 : at;
    }
  }
  return {
    at,
    my: data.my || [], loc: data.loc || [], news: data.news || [], sys: data.sys || [],
    locTotal: data.locTotal || (data.loc || []).length, newsTotal: data.newsTotal || (data.news || []).length,
    seen, viewedAt: prev && prev.viewedAt ? prev.viewedAt : at, login: false,
  };
}

export const isNew = (st, id) => !!st && !!st.seen && (st.seen[id] || 0) > (st.viewedAt || 0);

/** The last 8:00 before now: data read before it is from "yesterday". */
export function lastMorning(now, hour = 8) {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** "2026-11-03" -> how far the due date is: text and how urgent (over, soon, ok). */
export function due(end, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(end || '');
  if (!m) return { date: '', left: '', cls: '' };
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const t = new Date(now);
  t.setHours(0, 0, 0, 0);
  const days = Math.round((d - t) / 86400000);
  const date = `${+m[3]}.${+m[2]}.`;
  if (days < 0) return { date, left: days === -1 ? 'istekao jučer' : `istekao prije ${-days} dana`, cls: 'is-over' };
  if (days === 0) return { date, left: 'danas', cls: 'is-soon' };
  if (days === 1) return { date, left: 'sutra', cls: 'is-soon' };
  return { date, left: `za ${days} dana`, cls: days <= 3 ? 'is-soon' : '' };
}

/** "2026-10-27T15:13:42" -> "27.10." */
export function dayText(at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(at || '');
  return m ? `${+m[3]}.${+m[2]}.` : '';
}
