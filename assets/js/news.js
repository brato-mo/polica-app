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
  const imp = data.kb ? important(data, at) : (prev && prev.imp) || [];
  const all = { ...data, imp };
  for (const k of ['my', 'loc', 'news', 'sys', 'imp']) {
    for (const x of all[k] || []) {
      if (!x || !x.id) continue;
      const was = prev && prev.seen ? prev.seen[x.id] : undefined;
      seen[x.id] = was !== undefined ? was : first ? 0 : at;
    }
  }
  return {
    at,
    my: data.my || [], loc: data.loc || [], news: data.news || [], sys: data.sys || [],
    locTotal: data.locTotal || (data.loc || []).length, newsTotal: data.newsTotal || (data.news || []).length,
    imp, kb: data.kb || (prev && prev.kb) || null,
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

// ------------------------------------------------ store concept: planograms and updates ("Važno")

const DEPT_BS = { '01': 'Posteljina', '02': 'Kupaonica', '03': 'Madraci', '04': 'Namještaj', '05': 'Kućanstvo', '06': 'Kućni tekstil', '07': 'Oprema za prozore', '08': 'Jorgani i jastuci', '09': 'Vrt', '10': 'Spremanje i čišćenje', '11': 'Božić' };
/** "05 Homeware" -> "05 Kućanstvo"; other folders keep their name. */
export function deptName(topic) {
  const m = /^(\d{2})\b/.exec(topic || '');
  return m && DEPT_BS[m[1]] ? `${m[1]} ${DEPT_BS[m[1]]}` : String(topic || '');
}
export const deptNo = (topic) => { const m = /^(\d{2})\b/.exec(topic || ''); return m ? m[1] : ''; };

const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };

/** "17.10.26" / "17.10.2026" -> "2026-10-17" */
export function isoDate(d, m, y) {
  const yy = String(y).length === 2 ? 2000 + +y : +y;
  return `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The entries of an "Ažuriranja" text: blocks between rows of stars, a block may start with its date. */
export function updateEntries(u, max = 3) {
  const out = [];
  for (const raw of String(u.text || '').split(/\*{5,}/)) {
    const b = raw.trim();
    if (!b) continue;
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})\.?\s*:?\s*/.exec(b);
    const body = m ? b.slice(m[0].length).trim() : b;
    let lines = body.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!lines.length) continue;
    const id = `u:${u.id}:${hash(lines.join(' ').slice(0, 300))}`;
    if (/^(trenutno )?nema (novih )?ažuriranja/i.test(lines[0])) continue; // "nothing new" is not news
    // a heading on its own line ("Sljedeći dijelovi su ažurirani:", "Samo XL trgovine") goes together with the next line
    if (lines.length > 1 && (/:\s*$/.test(lines[0]) || lines[0].length < 30)) lines = [`${lines[0].replace(/:\s*$/, '')}: ${lines[1]}`, ...lines.slice(2)];
    out.push({
      id, kind: 'upd', dept: u.dept, path: u.path, dated: !!m,
      date: m ? isoDate(m[1], m[2], m[3]) : '',
      title: lines[0].slice(0, 160), text: lines.slice(1).join(' · ').slice(0, 500),
    });
  }
  // a block without its own date belongs to the newest dated one (or to the page's last change)
  const newest = out.filter((e) => e.dated).map((e) => e.date).sort().pop() || String(u.upd || '').slice(0, 10);
  for (const e of out) if (!e.date) e.date = newest;
  return out.slice(0, max);
}

/** "Važno": dated concept updates per department, concepts changed in the last month, and the system status. */
export function important(data, now, { conceptDays = 30, sysDays = 14 } = {}) {
  const kb = data.kb || {};
  const out = [];
  for (const u of kb.upds || []) for (const e of updateEntries(u)) out.push(e);
  for (const c of kb.concepts || []) {
    const t = Date.parse(c.upd);
    if (!t || now - t > conceptDays * 86400000) continue;
    out.push({ id: `c:${c.id}:${String(c.upd).slice(0, 10)}`, kind: 'concept', dept: c.dept, path: c.path, date: String(c.upd).slice(0, 10), title: c.title.replace(/^\s*1\)\s*/, ''), text: '' });
  }
  for (const a of data.sys || []) {
    const t = Date.parse(a.at);
    if (t && now - t > sysDays * 86400000) continue;
    out.push({ id: `s:${a.id}`, kind: 'sys', dept: '', path: a.path, date: String(a.at).slice(0, 10), title: a.title, text: a.text.slice(0, 500) });
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/**
 * The planograms of the store: links of the country (org), left or right side, standard or compact. One per
 * planogram (same sis + sub), named after the link text.
 */
export function planLinks(kb, { org = '1014BIH', side = 'left', compact = false } = {}) {
  const by = new Map();
  for (const p of (kb && kb.plans) || []) {
    if (org && p.org !== org) continue;
    if (!p.text || !/^https:\/\//.test(p.url)) continue;
    const tag = `${p.sub} ${p.text}`;
    const isLeft = /\bleft\b|lijev/i.test(tag), isCompact = /compact/i.test(tag);
    if ((side === 'left') !== isLeft || compact !== isCompact) continue;
    if (!/planogra|planogam/i.test(p.text)) continue; // display guides (IDG) and the like are not shelf planograms
    const key = `${p.sis}|${p.sub}`;
    if (!by.has(key)) by.set(key, { key, url: p.url, dept: p.dept, text: p.text, name: `${p.text.replace(/[\\/:*?"<>|]+/g, ' ').trim()}.pdf` });
  }
  return [...by.values()].sort((a, b) => a.dept.localeCompare(b.dept) || a.text.localeCompare(b.text));
}
