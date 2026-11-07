// @APP@: scan or type an article, see its picture and where it stands on the shelf.
import * as core from './core.js';
import * as store from './store.js';
import * as docs from './docs.js';
import * as news from './news.js';
import * as ar from './ar.js';
import * as smcheck from './smcheck.js';
import * as tips from './tips.js';
import * as minusop from './minusop.js';

const A = window.Android;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const S = {
  plans: [], // { id, name, size, imported, key, title, concept, deadline, sections, pages, count, plan }
  index: core.buildIndex([]),
  user: { recent: [], learned: {}, changes: {}, orders: null },
  stack: [{ id: 'home', state: null }],
  item: null, // { num, info, loc, focus }
  importTarget: null,
  busy: false,
  refreshing: false,
  tried: new Set(), // barcodes already asked in StoreFront this session
  storeCb: null,
  mode: 'plan', // home tab: 'plan' (planograms), 'orders' (customer orders) or 'news' (MYJYSK tasks and news)
  ar: { busy: '', scores: {}, notes: {}, err: null, done: null }, // AR screen: what is being done, the chosen scores and comments
  mj: { busy: false, open: new Set(), loc: 'open', more: false }, // Vijesti screen: reading now, opened news, filter of the store's tasks
  planMore: new Set(), // "<plan id>|<status>": cards whose whole row of article numbers is open on the Planogrami screen
};

// ------------------------------------------------------------------ helpers

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}
const artikala = (n) => `${n} ${plural(n, 'artikal', 'artikla', 'artikala')}`;

function dateBs(ms) {
  const d = new Date(ms);
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}.`;
}

function fixtureText(d) {
  if (!d) return '';
  const out = [];
  const m = /Shelf\s*(\d+)\s*cm/i.exec(d);
  if (/hanging\s*bar|\bbar\b/i.test(d)) out.push('šipka za vješanje');
  else if (m) out.push(`polica ${m[1]} cm`);
  if (/w\/?\s*light/i.test(d)) out.push('sa svjetlom');
  if (/lock/i.test(d)) out.push('zaključana');
  if (/rub\.?\s*mat/i.test(d)) out.push('s gumenom podlogom');
  return out.length ? out.join(', ') : d;
}
const isBar = (d) => /hanging\s*bar|\bbar\b/i.test(d || '');

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// --------------------------------------------------------------------- data

function saveUser() { store.write('user.json', S.user); }

function savePlansList() {
  store.write('plans.json', S.plans.map(({ plan, ...meta }) => meta));
}

function rebuildIndex() {
  const byAge = S.plans.slice().sort((a, b) => a.imported - b.imported);
  S.index = core.buildIndex(byAge.map((p) => ({ id: p.id, plan: p.plan })));
  eanSoon(3000);
}

// ------------------------------------------- barcodes of the planogram articles, from StoreFront
// A planogram has the 7-digit article numbers, the goods carry EAN barcodes. StoreFront knows which barcodes belong
// to which article (read only): asked once for every planogram article (again after 30 days), kept in eans.json
// = { m: { ean: num }, done: { num: time } }, so a scanned barcode opens its place at once, without StoreFront.
let eanData = null, eanBusy = false, eanTimer = 0, eanPause = 0;
function eanStore() {
  if (!eanData) {
    eanData = store.read('eans.json', null);
    if (!eanData || typeof eanData !== 'object') eanData = {};
    eanData.m = eanData.m || {};
    eanData.done = eanData.done || {};
  }
  return eanData;
}
function eanSoon(ms) { clearTimeout(eanTimer); eanTimer = setTimeout(eanSync, ms); }
function eanSync() {
  if (eanBusy || !A.storeTask || Date.now() < eanPause || !S.index) return;
  const d = eanStore(), old = Date.now() - 30 * 86400000;
  const nums = [...S.index.byNum.keys()].filter((n) => /^\d{7}$/.test(n) && !(d.done[n] > old)).slice(0, 200);
  if (!nums.length) return;
  eanBusy = true;
  const ok = stCall({ mode: 'eans', nums }, (r) => {
    eanBusy = false;
    if (r.how !== 'ok' || !r.res) { eanPause = Date.now() + 10 * 60000; eanSoon(10 * 60000 + 1000); return; }
    const now = Date.now();
    for (const x of r.res.list || []) {
      if (!/^\d{7}$/.test(String(x.num))) continue;
      d.done[x.num] = now;
      for (const e of x.eans || []) if (/^\d{8,14}$/.test(String(e))) d.m[e] = x.num;
    }
    store.write('eans.json', d);
    eanSoon(1500); // the next 200, if there are more
  });
  if (!ok) eanBusy = false;
}
/** The article a barcode belongs to by StoreFront's own list, or ''. */
const eanOf = (code) => (eanStore().m[String(code || '').replace(/\s+/g, '')] || '');

function dropFiles(id) {
  A.removePdf(`${id}.pdf`);
  A.removeThumbs(id);
  pageCache.drop(id);
  store.remove(`plan-${id}.json`);
  docs.forget(id);
}

/** Planograms whose every section is now covered by newer PDFs are not needed any more. */
function pruneSuperseded() {
  const gone = [];
  for (const p of S.plans.slice()) {
    const codes = [...core.sectionCodes(p.plan)];
    if (!codes.length || codes.some((c) => S.index.owner.get(c) === p.id)) continue;
    S.plans = S.plans.filter((x) => x.id !== p.id);
    delete S.user.changes[p.id];
    dropFiles(p.id);
    gone.push(p);
  }
  if (gone.length) rebuildIndex();
  return gone;
}

function load() {
  const u = store.read('user.json', null);
  if (u) S.user = { recent: [], learned: {}, changes: {}, orders: null, ...u };
  migrate158();
  const list = store.read('plans.json', []);
  S.plans = [];
  for (const meta of list) {
    const plan = store.read(`plan-${meta.id}.json`, null);
    if (plan && plan.items) S.plans.push({ ...meta, plan });
  }
  rebuildIndex();
}

/**
 * Records of 1.57 and older, once. Lines waiting for Regulacija were put there by 1.57 also when the answer to the
 * Regulacija never came (a dropped connection counted as "not sent"): some of them may have gone through. Each is
 * marked "from 1.57" and cannot be sent again until the employee has checked it (Minus lista → Čeka Regulaciju).
 */
function migrate158() {
  const u = S.user;
  if (!u || (u.dataVer || 0) >= 158) return;
  for (const p of u.minusPending || []) if (p && typeof p === 'object') p.legacy = true;
  u.dataVer = 158;
  saveUser();
}

/** Every place an article is shown, across all planograms. */
function locationsOf(num) {
  const out = [];
  for (const e of S.index.byNum.get(num) || []) {
    const meta = S.plans.find((p) => p.id === e.id);
    for (const oc of e.it.oc) out.push({ e, meta, oc, place: core.placeOf(e.plan, oc) });
    if (!e.it.oc.length) {
      // only on a product list: show its shelf on the drawing; the list itself only when no drawing has that shelf
      const seen = new Set();
      for (const r of e.it.rw) {
        const oc = core.shelfOfRow(e.plan, r);
        if (oc) {
          const k = `${oc.p}:${oc.g}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ e, meta, oc, row: r, place: core.placeOf(e.plan, oc) });
        } else {
          out.push({ e, meta, row: r, place: null });
        }
      }
      if (!e.it.rw.length) out.push({ e, meta, place: null });
    }
  }
  return out;
}

function nameOf(num) {
  for (const e of S.index.byNum.get(num) || []) if (e.it.nm) return e.it.nm;
  return '';
}

/** The article's picture, or null. */
function pictureOf(num) {
  const url = (id, plan) => `/files/thumbs/${id}/${num}.webp?v=${plan.v || 1}`;
  for (const e of S.index.byNum.get(num) || []) if (e.it.im) return url(e.id, e.plan);
  for (const p of S.plans) if (p.plan.items[num] && p.plan.items[num].im) return url(p.id, p.plan);
  return null;
}

// ------------------------------------------- pictures from StoreFront
// StoreFront names the article's picture (read only), the phone fetches it from JYSK's own image server and keeps it:
// sf-pics.json = { num: { f: file name | '' (StoreFront has none), at } }. A picture is asked for once; "none" is
// asked again after a week. Nothing is asked without a StoreFront sign-in.
const SF_DIR = 'sf-slike';
let sfMap = null;
const sfPend = new Set();
let sfBusy = false, sfTimer = 0, sfPause = 0;
function sfPics() {
  if (!sfMap) { sfMap = store.read('sf-pics.json', {}) || {}; if (typeof sfMap !== 'object' || Array.isArray(sfMap)) sfMap = {}; }
  return sfMap;
}
const sfKnownNone = (num) => { const p = sfPics()[num]; return !!p && !p.f && Date.now() - (p.at || 0) < 7 * 86400000; };
const sfSrc = (num) => { const p = sfPics()[num]; return p && p.f ? `/files/thumbs/${SF_DIR}/${encodeURIComponent(p.f)}` : null; };

/** An article's picture. StoreFront's picture comes first (it is the article's own; a picture cut out of a
 *  planogram PDF can belong to the neighbour). Until StoreFront's is here, or when StoreFront has none, the
 *  planogram's is shown. StoreFront's is asked for when the row is on screen.
 *  big: a tap on the picture opens it large (not for rows that open something themselves). */
function thumb(num, cls = '', big = false) {
  const own = pictureOf(num);
  if (!/^\d{7}$/.test(String(num || ''))) return `<span class="thumb ${cls}">${own ? `<img src="${own}" alt="" loading="lazy" decoding="async">` : icon('box')}</span>`;
  const b = big ? ` data-bigok="1"` : '';
  const sf = sfSrc(num);
  if (sf) return `<span class="thumb thumb-sf ${cls}" data-pic="${esc(num)}"${b}${big ? ` data-big="${esc(num)}"` : ''}><img src="${sf}" alt="" loading="lazy" decoding="async"></span>`;
  const want = sfKnownNone(num) ? '' : ' data-want="1"';
  return `<span class="thumb ${cls}" data-pic="${esc(num)}"${b}${want}>${own ? `<img src="${own}" alt="" loading="lazy" decoding="async">` : icon('box')}</span>`;
}

/** Thumb of a row that opens nothing itself: a tap on the picture opens it large. */
const sfThumb = (num) => thumb(num, '', true);

// a picture is asked for only once its row is on the screen (a long Rasprodaja list does not ask for hundreds)
const sfSeen = 'IntersectionObserver' in window
  ? new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      sfSeen.unobserve(e.target);
      if (e.target.dataset.want) sfWant(e.target.dataset.pic);
    }
  }, { rootMargin: '200px' })
  : null;
function sfWatch(root) {
  for (const el of root.querySelectorAll ? root.querySelectorAll('[data-want]') : []) {
    if (sfSeen) sfSeen.observe(el); else sfWant(el.dataset.pic);
  }
}
new MutationObserver((ms) => {
  for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.dataset && n.dataset.want) sfWatch(n.parentNode || n); else sfWatch(n); }
}).observe(document.documentElement, { childList: true, subtree: true });

function sfWant(num) {
  const p = sfPics()[num];
  if (p && (p.f || Date.now() - (p.at || 0) < 7 * 86400000)) return;
  if (!A.fetchSfPictures || !A.storeTask) return;
  sfPend.add(num);
  clearTimeout(sfTimer);
  sfTimer = setTimeout(sfAsk, 600);
}

function sfAsk() {
  if (sfBusy || !sfPend.size || Date.now() < sfPause) return;
  const nums = [...sfPend].slice(0, 40);
  nums.forEach((n) => sfPend.delete(n));
  sfBusy = true;
  const ok = stCall({ mode: 'pics', nums }, (r) => {
    if (r.how !== 'ok' || !r.res) {
      sfBusy = false;
      nums.forEach((n) => sfPend.add(n));
      sfPause = Date.now() + 5 * 60000; // not signed in or no connection: again in a few minutes, not in a loop
      return;
    }
    const list = (r.res.pics || []).map((x) => ({ num: x.num, url: x.m || x.s || '' }));
    if (!list.length) { sfBusy = false; sfAsk(); return; }
    A.fetchSfPictures(JSON.stringify(list));
  });
  if (!ok) { sfBusy = false; nums.forEach((n) => sfPend.add(n)); }
}

window.onSfPictures = (list) => {
  sfBusy = false;
  const m = sfPics();
  for (const x of list || []) {
    if (!/^\d{7}$/.test(String(x.num))) continue;
    m[x.num] = { f: String(x.file || ''), at: Date.now() };
    const src = sfSrc(x.num);
    if (!src) continue;
    for (const el of document.querySelectorAll(`[data-pic="${x.num}"]`)) {
      el.classList.add('thumb-sf');
      el.removeAttribute('data-want');
      if (el.dataset.bigok) el.dataset.big = x.num;
      el.innerHTML = `<img src="${src}" alt="" decoding="async">`;
    }
  }
  store.write('sf-pics.json', m);
  if (sfPend.size) setTimeout(sfAsk, 300);
};

function sfBig(num, el) {
  const src = sfSrc(num);
  if (!src) return;
  const row = el && el.closest('.item');
  const nm = nameOf(num) || (row && row.querySelector('.item-name') ? row.querySelector('.item-name').textContent : '');
  openSheet({ title: `${num} ${nm || ''}`.trim(), body: `<div class="sf-big"><img src="${src}" alt=""></div><p class="hint">Slika iz StoreFronta.</p>`, actions: [{ label: 'Zatvori', onClick: closeSheet }] });
}

const isFav = (num) => (S.user.favs || []).includes(num);
function toggleFav(num) {
  const f = S.user.favs || [];
  S.user.favs = f.includes(num) ? f.filter((n) => n !== num) : [num, ...f].slice(0, 40);
  saveUser();
  toast(isFav(num) ? 'Dodano u favorite' : 'Uklonjeno iz favorita');
}

/** One tap on a code: it goes to the phone's clipboard. */
function copyCode(num) {
  try { A.copyText(num); toast(`Šifra ${num} kopirana`); } catch (e) {
    try { navigator.clipboard.writeText(num); toast(`Šifra ${num} kopirana`); } catch (e2) { toast('Kopiranje ne radi u ovoj verziji.'); }
  }
}

function rememberRecent(num) {
  S.user.recent = [{ num, t: Date.now() }, ...S.user.recent.filter((r) => r.num !== num)].slice(0, 15);
  saveUser();
}

// --------------------------------------------------------------- navigation
// S.stack holds { id, state } for each open screen; back() restores the one below.

function show(id, how = 'enter') {
  for (const s of $$('.screen')) {
    const on = s.id === id;
    s.classList.toggle('is-active', on);
    s.classList.remove('enter', 'enter-back');
    if (on && how) { void s.offsetWidth; s.classList.add(how); }
  }
}

function top() { return S.stack[S.stack.length - 1]; }

function go(id, state = null, { replace = false } = {}) {
  const t = top();
  // the list stays where it was: coming back, the screen below opens at the same place
  const below = $(`#${t.id} .scroll`);
  if (below) t.scroll = below.scrollTop;
  if (replace && t.id !== 'home') S.stack[S.stack.length - 1] = { id, state };
  else S.stack.push({ id, state });
  show(id, replace ? 'enter-back' : 'enter');
  const sc = $(`#${id} .scroll`);
  if (sc) sc.scrollTop = 0;
}

function back() {
  if (S.stack.length <= 1) return false;
  const left = S.stack.pop();
  if (left.id === 'viewer') viewer.close();
  const t = top();
  show(t.id, 'enter-back');
  // coming back from the planogram view, the article screen is still as it was
  if (t.id === 'item' && S.item !== t.state) { S.item = t.state; renderItem(); }
  if (t.id === 'missing') renderMissing(t.state);
  if (t.id === 'changes') renderChanges(t.state);
  if (t.id === 'attach') renderAttach();
  if (t.id === 'minus') renderMinus();
  if (t.id === 'plans') renderPlans();
  if (t.id === 'ar') renderAr();
  if (t.id === 'top') renderTop();
  if (t.id === 'smdm') renderSm();
  if (t.id === 'soon') renderSoon();
  if (t.id === 'audit') renderAudit();
  if (t.id === 'tips') renderTips();
  if (t.id === 'home') renderHome();
  const sc = $(`#${t.id} .scroll`);
  if (sc && t.scroll) { const y = t.scroll; sc.scrollTop = y; requestAnimationFrame(() => { sc.scrollTop = y; }); }
  return true;
}

window.handleBack = () => {
  if (!$('#sheet').hidden) {
    if (sheet.dismissible) closeSheet();
    return true;
  }
  return back();
};

// --------------------------------------------------------------------- rows

function pills(place, row, more = 0) {
  let h;
  if (place && place.segment) {
    h = `<span class="pill">Modul <b>${esc(place.module)}</b></span><span class="pill">${isBar(place.fixture) ? 'Šipka' : 'Polica'} <b>${esc(place.shelf)}</b></span><span class="pill">Notch <b>${esc(place.notch)}</b></span>`;
  } else if (row && row.fx) {
    h = `<span class="pill pill-muted">${esc(row.fx)}</span>`;
  } else {
    h = '<span class="pill pill-muted">Bez mjesta na crtežu</span>';
  }
  if (more > 0) h += `<span class="more">+${more} ${plural(more, 'mjesto', 'mjesta', 'mjesta')}</span>`;
  return `<span class="pills">${h}</span>`;
}

// ------------------------------------------------------------ customer orders

const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s.-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

function ageText(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 2) return 'upravo sada';
  if (m < 60) return `prije ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `prije ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'jučer' : `prije ${d} dana`;
}

/** Customer orders (Ispunjen, Stigao) that contain this article. */
function ordersOf(num) {
  const o = S.user.orders;
  if (!o || !o.list) return [];
  const out = [];
  for (const ord of o.list) {
    for (const it of ord.items || []) if (it.num === num) out.push({ ord, qty: it.qty, st: it.st });
  }
  return out;
}

function ordersBlock(num, { after = false, label = '' } = {}) {
  const o = S.user.orders;
  const hits = ordersOf(num);
  if (!o) return after ? `<button class="btn btn-soft btn-block btn-small store-btn" type="button" data-orders="1">${icon('link')}Provjeri narudžbe kupaca</button>` : '';
  if (hits.length && !after) {
    const rows = hits.map(({ ord, qty, st }) => `<div class="ord-row">
        <div><b>${esc(custName(ord))}</b>${ord.ph && cfg().phone ? `<a class="ord-tel" href="tel:${esc(String(ord.ph).replace(/[^\d+]/g, ''))}">${esc(ord.ph)}</a>` : ''}${madeHtml(ord)}<small>${esc(ord.no.slice(-6))}${ord.date ? ` · dostava ${esc(ord.date)}` : ''}</small>${st === 'Otvoreno' ? '<small class="ord-wait">Nije zaprimljeno: roba još nije stigla ili paleta nije zaprimljena</small>' : st === 'Popunjeno' ? '<small class="ord-ok">Roba zaprimljena, u magacinu je</small>' : st === 'Završeno' ? '<small class="ord-done">Kupac je ovo već preuzeo</small>' : st ? `<small>${esc(st)}</small>` : ''}${noteHtml(ord)}</div>
        <div class="ord-r"><span class="ord-chip">${esc(ord.status || ord.tab)}</span><em>${qty > 0 ? `${qty} kom` : ''}</em></div>
      </div>`).join('');
    const stale = Date.now() - o.at > cfg().stale * 3600 * 1000;
    return `<section class="ord ord-hit"><div class="ord-head">${icon('info')}<span>${hits.length > 1 ? `Kupci su naručili ovaj artikal (${hits.length})` : 'Kupac je naručio ovaj artikal'}</span></div>${label ? `<div class="ord-sub">${esc(label)}</div>` : ''}${rows}${stale ? `<p class="ord-none" style="color:inherit">Podaci su ${esc(ageText(o.at))}. <button class="link" type="button" data-orders="1">Osvježi</button></p>` : ''}</section>`;
  }
  if (!hits.length && after) {
    return `<p class="ord-none">Nema narudžbi kupaca za ovaj artikal (Aktivan, Zakasnio, Stigao, Ispunjen), stanje ${esc(ageText(o.at))}. <button class="link" type="button" data-orders="1">Osvježi</button></p>`;
  }
  return '';
}

// ----------------------------------------------------------------- app updates

function renderUpdate() {
  const u = S.update;
  const b = $('#updateBar');
  if (!b) return;
  const show = u && ['downloading', 'ready', 'available', 'permission'].includes(u.state);
  b.hidden = !show;
  if (!show) return;
  const nm = esc(u.name || '');
  b.dataset.state = u.state;
  if (u.state === 'downloading') b.innerHTML = `<span class="work-dot"></span><span><b>Preuzimam novu verziju ${nm}</b><small>${u.pct || 0}%</small></span>`;
  else if (u.state === 'permission') b.innerHTML = `${icon('info')}<span><b>Dozvoli instalaciju</b><small>Uključi „Dozvoli iz ovog izvora“ pa se vrati u @APP@ i tapni opet</small></span><span class="go">Instaliraj</span>`;
  else b.innerHTML = `${icon('info')}<span><b>Nova verzija ${nm} je ${u.state === 'ready' ? 'spremna' : 'dostupna'}</b>${u.notes ? `<small>${esc(String(u.notes).split('\n')[0])}</small>` : ''}</span><span class="go">${u.state === 'ready' ? 'Instaliraj' : 'Preuzmi'}</span>`;
}

function checkUpdate(manual = false) {
  if (!A.checkUpdate) return;
  if (!manual && !cfg().upd) return;
  S.updChecked = Date.now();
  S.updManual = manual;
  A.checkUpdate(true);
}

function installUpdate() {
  if (S.update && S.update.state === 'available') { A.checkUpdate(true); return; }
  const r = A.installUpdate();
  if (r === 'permission') S.update = { ...(S.update || {}), state: 'permission' };
  else if (r !== 'ok') { toast('Instalacija nije uspjela. Pokušaj opet za koji trenutak.'); S.update = null; }
  renderUpdate();
}

// ------------------------------------------------------- first screen: sign-in

/** Shown until the employee signs in (or chooses "Kasnije" for this start). Nothing else is shown before it. */
function gateNeeded() {
  if (S.gateLater) return false;
  // only when no login is kept at all; a refused one is said in a line (the sessions may well still be open)
  try { return !!A.loginState && A.loginState() === 'none'; } catch (e) { return false; }
}

function showGate(msg = '') {
  const g = $('#gate');
  if (!g) return;
  g.hidden = false;
  setGateMsg(msg);
  setTimeout(() => { if (!$('#gateUser').value) $('#gateUser').focus(); }, 300);
}

function setGateMsg(msg) {
  const m = $('#gateMsg');
  m.textContent = msg || '';
  m.hidden = !msg;
}

function hideGate() {
  $('#gate').hidden = true;
  $('#gatePass').value = '';
}

function gateBusy(on) {
  $('#gateGo').disabled = on;
  $('#gateGo').textContent = on ? 'Provjeravam prijavu…' : 'Prijavi se';
}

$('#gateForm')?.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const u = $('#gateUser').value.trim(), p = $('#gatePass').value;
  if (!u || !p) { setGateMsg('Upiši korisničko ime i lozinku.'); return; }
  setGateMsg('');
  gateBusy(true);
  try { A.saveLogin(u, p); } catch (e) { gateBusy(false); setGateMsg('Ova verzija aplikacije ne zna prijavu. Javi se meni.'); }
});

$('#gateEye')?.addEventListener('click', () => {
  const f = $('#gatePass');
  f.type = f.type === 'password' ? 'text' : 'password';
  $('#gateEye').textContent = f.type === 'password' ? 'Prikaži' : 'Sakrij';
  $('#gateEye').setAttribute('aria-label', f.type === 'password' ? 'Prikaži lozinku' : 'Sakrij lozinku');
});

$('#gateLater')?.addEventListener('click', () => { S.gateLater = true; hideGate(); });

window.onLoginSaved = (ok, why) => {
  gateBusy(false);
  if (ok) {
    hideGate();
    toast('Prijava je uspjela.');
    checkOnline();
    renderHome();
    return;
  }
  if (why === 'offline') {
    // the login is kept; StoreFront cannot be reached right now, so it is checked again later
    hideGate();
    toast('Prijava je sačuvana. Provjeri kad budeš na mreži.');
    checkOnline();
    return;
  }
  const W = {
    refused: 'StoreFront ne prihvata ovu lozinku. Provjeri je i pokušaj ponovo.',
    empty: 'Upiši korisničko ime i lozinku.',
    save: 'Prijava se ne može sačuvati na ovom telefonu.',
  };
  $('#gatePass').value = '';
  setGateMsg(W[why] || 'Prijava nije uspjela. Pokušaj ponovo.');
};

function checkOnline() {
  try { if (A.storeStatus) A.storeStatus(); } catch (e) { /* ignore */ }
}
window.onStoreStatus = (on, counts) => {
  const e = $('#onl');
  if (!e) return;
  if (on && counts) {
    S.site = {};
    for (const p of String(counts).split(',')) { const [k, v] = p.split(':'); S.site[k] = +v; }
    renderOrdersBar();
    // the orders are read only when the employee taps (the bar then says what changed)
  }
  e.hidden = false;
  e.className = 'onl ' + (on ? 'is-on' : 'is-off');
  e.textContent = on ? 'online' : 'offline';
};
setInterval(() => { if (!document.hidden && top().id === 'home') checkOnline(); }, 300000);

window.onUpdate = (r) => {
  if (!r) return;
  if (r.state === 'none') {
    S.update = null;
    if (S.updManual) toast('Imaš najnoviju verziju.');
  } else if (r.state === 'error') {
    S.update = null;
    // the reason is shown too: a network problem and a file that does not match are different things
    if (S.updManual) toast(`Provjera nije uspjela${r.msg ? ` (${String(r.msg).slice(0, 80)})` : ''}. Provjeri vezu.`);
  } else S.update = r;
  if (r.state !== 'downloading') S.updManual = false;
  renderUpdate();
  if (top().id === 'settings') renderSettings();
};

// ----------------------------------------------- articles to sell out (status 21 / 81)

const CLR_ST = ['21', '81'];
S.clr = { st: 'all', sort: 'stock', q: '', peek: false, dept: 'home', busy: '' }; // peek: show the Christmas / New Year articles for now
// with the background StoreFront jobs the list is read through StoreFront's own search (assets/store-task.js clear):
// the department's own product groups (no cleaning, laundry or storage of other departments), or furniture
const clrNew = () => !!A.storeTask;
/** The list that is shown: { at, st, group, list } of the department (home) or of furniture, or the old read. */
function clrSrc(dept = S.clr.dept) {
  if (!clrNew()) return S.user.clear;
  const d = (S.user.clr2 || {})[dept];
  return d && d.list ? { at: d.at, st: CLR_ST, group: dept === 'furn' ? '4' : cfg().group, list: d.list, dept } : null;
}
const clrStatuses = () => CLR_ST.filter((k) => cfg().clr[k]);
const whole = (n) => { try { return Math.round(n).toLocaleString('de-DE'); } catch (e) { return String(Math.round(n)); } };
const money = (n) => { try { return Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch (e) { return Number(n).toFixed(2); } };
const dmy = (s) => String(s || '').replace(/-/g, '.');

function refreshClearance() {
  if (clrNew()) { loadClr2(S.clr.dept); return; }
  const st = clrStatuses();
  if (!st.length) { toast('Uključi bar jedan status u postavkama.'); return; }
  if (!A.clearance) { toast('Ova verzija ne zna čitati listu.'); return; }
  A.clearance(JSON.stringify(st), cfg().group);
}

function openClearance() {
  renderClearance();
  go('clearance');
  if (!(clrSrc() && clrSrc().list)) refreshClearance();
}

/**
 * The stored list as it is shown. What matters is selling the articles off, so an article with nothing in stock never
 * shows (StoreFront is asked for articles in stock, but this does not depend on it). Christmas and New Year articles
 * (a name with one of the words in the settings) are left out too, unless the setting is off or the screen was asked
 * to show them for now (`peek`; the list screen's own switch, other screens pass false). `xmas` counts them, `flag`
 * says which ones they are.
 */
function clrView(peek = S.clr.peek, src = clrSrc()) {
  const c = src;
  // furniture: also what is on display (DM) with nothing in stock; without a replacement number still sold
  const all = (c && c.list ? c.list : []).filter((x) => (c.dept === 'furn' ? (core.inStock(x) || x.dm > 0) && !x.succ : core.inStock(x)));
  const words = cfg().noxmas ? core.wordMatcher(cfg().xmas) : null;
  const test = words && c && c.dept !== 'furn' ? (name, x) => words(name) || (x && String(x.group || '').startsWith('512')) : words && !(c && c.dept) ? words : null;
  if (!test) return { list: all, xs: [], xmas: 0, flag: () => false };
  const xs = all.filter((x) => test(x.name, x));
  const hit = new Set(xs.map((x) => x.num));
  return { list: peek ? all : all.filter((x) => !hit.has(x.num)), xs, xmas: xs.length, flag: (x) => hit.has(x.num) };
}

function renderClearBar() {
  const b = $('#clearBar');
  if (!b) return;
  const has = S.plans.length > 0;
  b.hidden = !has;
  if (!has) return;
  const c = clrSrc('home');
  const ic = icon('box');
  if (!c || !c.list) {
    b.innerHTML = `${ic}<span><b>Artikli za rasprodaju</b><small>Status ${clrStatuses().join(' i ')} sa zalihom, iz StoreFronta</small></span><span class="go">Učitaj</span>`;
    return;
  }
  const v = clrView(false, c);
  const n = (s) => v.list.filter((x) => x.st === s).length;
  b.innerHTML = `${ic}<span><b>Za rasprodaju: ${v.list.length}</b><small>${c.st.map((k) => `Status ${k}: ${n(k)}`).join(' · ')} · ${esc(ageText(c.at))}</small></span><span class="go">Otvori</span>`;
}

function clrFiltered() {
  const c = clrSrc();
  if (!c || !c.list) return [];
  const toks = norm(S.clr.q).split(/\s+/).filter(Boolean);
  let list = clrView().list.filter((x) => S.clr.st === 'all' || x.st === S.clr.st);
  if (toks.length) {
    list = list.filter((x) => {
      const hay = norm(`${x.num} ${x.name}`);
      return toks.every((t) => hay.includes(t));
    });
  }
  const val = (x) => (x.price || 0) * x.stock;
  const by = S.clr.sort;
  if (by === 'num') return list.sort((a, b) => a.num.localeCompare(b.num));
  list.sort((a, b) => (by === 'value' ? val(b) - val(a) : by === 'new' ? core.dateKey(b.chg) - core.dateKey(a.chg) : b.stock - a.stock) || a.name.localeCompare(b.name, 'bs'));
  // furniture: what stands on display with nothing in stock comes first (customers do not see it)
  if (c.dept === 'furn') list.sort((a, b) => (+(b.dm > 0 && b.stock <= 0)) - (+(a.dm > 0 && a.stock <= 0)));
  return list;
}

/** Reads the list of the department (home: its own product groups, no Christmas) or of furniture. */
function loadClr2(dept) {
  if (S.clr.busy) return;
  S.clr.busy = dept;
  renderClearance();
  const run = () => {
    const used = deptUsed().map((x) => x.id).filter((id) => !id.startsWith('512')); // Christmas is never on this list
    const arg = dept === 'furn' ? { cats: ['4'] } : used.length ? { cats: used } : { cat: cfg().group || '5' };
    const ok = stCall({ mode: 'clear', ...arg }, (r) => {
      S.clr.busy = '';
      if (r.how === 'ok' && r.res && Array.isArray(r.res.list)) {
        const list = r.res.list.slice(0, 600).filter((x) => /^\d{7}$/.test(x.num)).map((x) => ({
          num: x.num, name: String(x.name || ''), st: String(x.st || ''), unit: String(x.unit || 'KOM'), stock: +x.stock || 0, free: +x.free || 0,
          sm: +x.sm || 0, dm: +x.dm || 0, price: x.price ? +x.price : null, reg: x.reg ? +x.reg : null, chg: String(x.chg || '').slice(0, 10).replace(/\./g, '-'),
          group: String(x.group || ''), groupName: String(x.groupName || ''), succ: x.succ && /^\d{7}$/.test(x.succ.num) ? { num: x.succ.num, st: String(x.succ.st || '') } : null,
        }));
        S.user.clr2 = { ...(S.user.clr2 || {}), [dept]: { at: Date.now(), list } };
        saveUser();
        const n = clrView(false, clrSrc(dept)).list.length;
        toast(`Učitano: ${n} ${plural(n, 'artikal', 'artikla', 'artikala')}`);
      } else {
        toast(r.how === 'login' ? 'StoreFront traži prijavu.' : 'Lista se nije mogla učitati. Pokušaj ponovo.');
      }
      if (top().id === 'clearance') renderClearance();
      if (top().id === 'plans') renderPlans();
      renderClearBar();
    });
    if (!ok) { S.clr.busy = ''; renderClearance(); }
  };
  if (dept === 'home') withDept(run); else run();
}

/** A furniture row (or one with a DM): on display with nothing in stock means customers do not see it as in stock. */
function clrRowFurn(x, xm) {
  const shown = x.dm > 0;
  const hidden = shown && x.stock <= 0;
  const cut = x.reg != null && x.price != null && x.reg > x.price;
  const meta = [x.chg ? `Status od ${dmy(x.chg)}` : '', x.groupName].filter(Boolean).join(' · ');
  return `<div class="clr-furn${hidden ? ' is-hidden' : ''}">
    <button class="item clr-item" type="button" data-store="${esc(x.num)}">
      ${thumb(x.num)}
      <span class="item-main">
        <span class="code">${esc(x.num)}<span class="pill pill-st pill-st${esc(x.st)}">Status ${esc(x.st)}</span>${shown ? `<span class="pill pill-dm">Na izlogu · DM ${whole(x.dm)}</span>` : ''}${xm ? '<span class="pill pill-st pill-xmas">Božić</span>' : ''}</span>
        <span class="item-name">${esc(x.name) || 'Bez naziva'}</span>
        <span class="clr-line"><b>${whole(x.stock)} ${esc(x.unit || 'KOM')}</b> na zalihi${x.price != null ? ` · ${money(x.price)} KM` : ''}${cut ? ` <s>${money(x.reg)}</s>` : ''}</span>
        ${meta ? `<span class="clr-sub">${esc(meta)}</span>` : ''}
      </span>
      ${icon('chev', 'chev')}
    </button>
    ${hidden ? `<div class="clr-dm"><span>${x.stock + x.dm > 0
      ? `Zaliha ${whole(x.stock)}, a ${x.dm > 1 ? `${whole(x.dm)} komada stoje` : 'komad stoji'} u DM: kupci ${x.dm > 1 ? 'ih' : 'ga'} ne vide na zalihi. Kad se skine s DM, zaliha pređe sa ${whole(x.stock)} na ${whole(x.stock + x.dm)}.`
      : `Zaliha ${whole(x.stock)} uz DM ${whole(x.dm)}: izloženi komad je vjerovatno prodan, a DM nije skinut. Kad se skine s DM, zaliha bude ${whole(x.stock + x.dm)} (tačno stanje).`}</span>
      <button class="btn btn-soft btn-small" type="button" data-clr-dm="${esc(x.num)}" ${S.clr.busy ? 'disabled' : ''}>Skini s DM (DM na 0)</button></div>` : ''}
  </div>`;
}

async function clrDmOff(num) {
  const src = clrSrc();
  const x = src && src.list.find((y) => y.num === num);
  if (!x || S.clr.busy) return;
  const yes = await ask(`Skinuti ${num} s DM?`, `<p>${esc(x.name)}</p><p>DM ${whole(x.dm)} → 0 (SM ostaje ${whole(x.sm)}). Zaliha ${whole(x.stock)} → ${whole(x.stock + x.dm)}${x.stock + x.dm > 0 ? `: kupci ${x.dm > 1 ? 'ih' : 'ga'} vide kao dostupan` : ': izloženi komad je prodan, stanje postaje tačno'}. Sprema se odmah u StoreFront pod tvojom prijavom.</p>`,
    [{ label: 'Skini s DM', kind: 'btn-primary', value: true }, { label: 'Odustani', value: false }]);
  if (!yes) return;
  S.clr.busy = 'dm';
  renderClearList();
  const ok = stCall({ mode: 'smset', items: [{ num, sm: x.sm, dm: 0 }] }, (r) => {
    S.clr.busy = '';
    if (r.how === 'ok' && r.res && (r.res.done || []).includes(num)) {
      x.stock += x.dm;
      x.free += x.dm;
      x.dm = 0;
      saveUser();
      toast('Skinuto s DM. Zaliha se u StoreFrontu osvježi za koji trenutak.');
    } else {
      toast(r.how === 'login' ? 'StoreFront traži prijavu.' : 'Nije spremljeno. Pokušaj ponovo.');
    }
    if (top().id === 'clearance') renderClearance();
  });
  if (!ok) { S.clr.busy = ''; renderClearList(); }
}

function clrRow(x, xm) {
  if (x.dm > 0 || (clrSrc() && clrSrc().dept === 'furn')) return clrRowFurn(x, xm);
  const cut = x.reg != null && x.price != null && x.reg > x.price;
  const free = x.free !== x.stock ? ` (slobodno ${whole(x.free)})` : '';
  const meta = [x.chg ? `Status od ${dmy(x.chg)}` : '', x.dd && !x.dd.endsWith('-9998') ? `DD ${dmy(x.dd)}` : ''].filter(Boolean).join(' · ');
  return `<button class="item clr-item" type="button" data-store="${esc(x.num)}">
    ${thumb(x.num)}
    <span class="item-main">
      <span class="code">${esc(x.num)}<span class="pill pill-st pill-st${esc(x.st)}">Status ${esc(x.st)}</span>${xm ? '<span class="pill pill-st pill-xmas">Božić</span>' : ''}</span>
      <span class="item-name">${esc(x.name) || 'Bez naziva'}</span>
      <span class="clr-line"><b>${whole(x.stock)} ${esc(x.unit || 'KOM')}</b> na zalihi${free}${x.price != null ? ` · ${money(x.price)} KM` : ''}${cut ? ` <s>${money(x.reg)}</s>` : ''}</span>
      ${meta ? `<span class="clr-sub">${esc(meta)}</span>` : ''}
    </span>
    ${icon('chev', 'chev')}
  </button>`;
}

function renderClearList() {
  const c = clrSrc();
  if (!c || !$('#clrList')) return;
  const v = clrView();
  const list = clrFiltered();
  const value = list.reduce((s, x) => s + (x.price || 0) * Math.max(0, x.stock), 0);
  const usual = cfg().xmas === core.XMAS_WORDS; // with the words of the settings changed the name "Christmas" would not be true
  const here = v.xs.filter((x) => S.clr.st === 'all' || x.st === S.clr.st).length; // in the status that is open
  const xm = here || (S.clr.peek && v.xmas) ? `<button class="clr-xmas" type="button" data-clr-xmas="1">${S.clr.peek
    ? `Prikazani su i ${usual ? 'božićni i novogodišnji' : 'sakriveni po riječima iz postavki'}${here ? `: ${here}` : ''} · Sakrij`
    : `Sakriveno ${usual ? 'božićnih i novogodišnjih' : 'po riječima iz postavki'}: ${here} · Prikaži`}</button>` : '';
  const hid = c.dept === 'furn' ? list.filter((x) => x.dm > 0 && x.stock <= 0).length : 0;
  $('#clrSum').innerHTML = `<b>${list.length} ${plural(list.length, 'artikal', 'artikla', 'artikala')}</b><small>Vrijednost zalihe ${whole(value)} KM · ${esc(ageText(c.at))}${c.dept === 'furn' ? ' · bez zamjenske šifre' : ''}</small>${hid ? `<small class="clr-hid">Na izlogu (DM) sa zalihom 0 ili manje: ${hid} (prvi na listi)</small>` : ''}${xm}`;
  $('#clrList').innerHTML = list.length ? `<div class="list">${list.map((x) => clrRow(x, S.clr.peek && v.flag(x))).join('')}</div>` : '<p class="empty">Nema artikala za ovaj izbor.</p>';
  const lim = (c.limited || []);
  const notes = [];
  if (lim.length) notes.push(`StoreFront kaže da za status ${lim.join(' i ')} ima previše rezultata, pa taj dio liste nije učitan.`);
  for (const x of c.short || []) notes.push(`Status ${x.st}: StoreFront javlja ${x.found} artikala, a pročitano ih je ${x.got}.`);
  $('#clrNote').textContent = notes.join(' ');
}

/** What the last reading found, for the box at the bottom of the screen (to be shown to whoever fixes the reader). */
function clrDetails(open) {
  const i = S.user.clrInfo;
  if (!i) return '';
  const L = [];
  for (const p of i.parts || []) {
    L.push(p.limited ? `Status ${p.st}: StoreFront kaže da ima previše rezultata` : `Status ${p.st}: StoreFront javlja ${p.found < 0 ? '?' : p.found}, pročitano ${p.got}`);
    if (p.ex) L.push(`Kartica: ${p.ex}`);
  }
  const d = i.diag;
  if (d) {
    L.push(`Čitanje je stalo kod statusa ${d.st} (${i.how === 'partial' ? 'djelimično' : 'ništa pročitano'}).`);
    if (d.last) L.push(`Stranica javlja: pronađeno ${d.last.f}, kartica ${d.last.r}${d.last.m ? ', previše rezultata' : ''}`);
    if (d.page) {
      L.push(`Redova teksta: ${d.page.lines}, kartica: ${d.page.cards}`);
      if (d.page.head) L.push(`Početak: ${d.page.head}`);
      if (d.page.first) L.push(`Prva kartica: ${d.page.first}`);
      if (d.page.tail) L.push(`Kraj: ${d.page.tail}`);
    }
  }
  if (i.err) L.push(`Greška: ${i.err}`);
  if (!L.length) return '';
  return `<details class="clr-diag"${open ? ' open' : ''}><summary>Detalji čitanja</summary><pre>${esc(L.join('\n').slice(0, 2400))}</pre></details>`;
}

function renderClearance() {
  const body = $('#clearBody');
  const c = clrSrc();
  const seg = clrNew() ? `<div class="seg clr-dept" role="tablist">${[['home', 'Homeware'], ['furn', 'Namještaj']].map(([v, t]) => `<button class="seg-btn" type="button" role="tab" aria-selected="${S.clr.dept === v}" data-clr-dept="${v}">${t}</button>`).join('')}</div>` : '';
  if (clrNew() && S.clr.busy === S.clr.dept) {
    body.innerHTML = `${seg}<p class="count-line"><i class="mj-busy"></i> ${S.deptBusy ? 'Prvi put: tražim grupe tvog odjela iz planograma…' : `Čitam ${S.clr.dept === 'furn' ? 'namještaj' : 'tvoj odjel'} sa statusom 21 i 81 iz StoreFronta… (do pola minute)`}</p>`;
    return;
  }
  if (clrNew() && (!c || !c.list)) {
    body.innerHTML = `${seg}<p class="empty">Lista još nije učitana.</p><button class="btn btn-primary btn-block" type="button" data-act="clear-refresh">${icon('refresh')}Učitaj iz StoreFronta</button>`;
    return;
  }
  if (!c || !c.list) {
    const failed = S.user.clrInfo && S.user.clrInfo.how !== 'cancelled' && (S.user.clrInfo.diag || S.user.clrInfo.err || (S.user.clrInfo.parts || []).some((p) => p.got === 0 && !p.limited && p.found !== 0));
    body.innerHTML = `<p class="empty">${failed ? 'Nisam uspio pročitati listu.' : 'Lista još nije učitana.'}</p>
      <button class="btn btn-primary btn-block" type="button" data-act="clear-refresh">${icon('refresh')}${failed ? 'Pokušaj ponovo' : 'Učitaj iz StoreFronta'}</button>
      <p class="hint">Čitaju se artikli sa statusom ${clrStatuses().join(' i ')} koji su na zalihi u grupi Kućanstvo.</p>${clrDetails(failed)}`;
    return;
  }
  const v = clrView();
  const n = (s) => v.list.filter((x) => x.st === s).length;
  if (S.clr.st !== 'all' && !c.st.includes(S.clr.st)) S.clr.st = 'all';
  const sts = [['all', `Svi (${v.list.length})`], ...c.st.map((k) => [k, `${k} (${n(k)})`])];
  const sorts = [['stock', 'Količina'], ['value', 'Vrijednost'], ['num', 'Šifra'], ['new', 'Novi status']];
  body.innerHTML = `${seg}<div class="clr-sum" id="clrSum"></div>
    <div class="clr-tools">
      <div class="seg seg-sm" role="radiogroup" aria-label="Status">${sts.map(([v, t]) => `<button class="seg-btn" type="button" role="radio" aria-checked="${S.clr.st === v}" data-clr-st="${v}">${t}</button>`).join('')}</div>
      <form class="search" id="clrForm" role="search" autocomplete="off">
        <svg class="ico search-ico" aria-hidden="true"><use href="#i-search"/></svg>
        <input id="clrQ" type="search" inputmode="search" enterkeyhint="search" placeholder="Šifra ili naziv artikla" aria-label="Traži u listi" spellcheck="false" autocapitalize="off" autocorrect="off" value="${esc(S.clr.q)}">
      </form>
      <div class="clr-sort"><span>Poredaj:</span>${sorts.map(([v, t]) => `<button class="chip" type="button" aria-pressed="${S.clr.sort === v}" data-clr-sort="${v}">${t}</button>`).join('')}</div>
    </div>
    <div id="clrList"></div><p class="clr-note" id="clrNote"></p>${clrDetails(false)}`;
  $('#clrQ').addEventListener('input', (e) => { S.clr.q = e.target.value; renderClearList(); });
  $('#clrForm').addEventListener('submit', (e) => { e.preventDefault(); $('#clrQ').blur(); });
  renderClearList();
}

window.onClearance = (r) => {
  if (!r || r.how === 'cancelled') return;
  const prev = S.user.clear;
  const want = clrStatuses();
  const got = {};
  const limited = [];
  const short = [];
  const info = [];
  for (const p of Array.isArray(r.parts) ? r.parts : []) {
    if (!/^\d{2}$/.test(p.st) || !want.includes(p.st)) continue;
    if (p.limited) { limited.push(p.st); info.push({ st: p.st, found: -1, got: 0, limited: true }); continue; }
    const rows = core.parseArticleCards(p.text, p.st);
    got[p.st] = rows;
    if (p.found > 0 && rows.length < p.found) short.push({ st: p.st, found: p.found, got: rows.length });
    info.push({ st: p.st, found: typeof p.found === 'number' ? p.found : -1, got: rows.length, ex: String(p.text || '').split(/\n{2,}/)[0].split('\n').join(' | ').slice(0, 420) });
  }
  const dg = r.diag && typeof r.diag === 'object' ? r.diag : null;
  S.user.clrInfo = { at: r.at || Date.now(), how: String(r.how || ''), parts: info, diag: dg ? JSON.parse(JSON.stringify(dg, (k, v) => (typeof v === 'string' ? v.slice(0, 800) : v))) : null, err: String(r.err || '').slice(0, 80) };
  if (!Object.keys(got).length) {
    saveUser();
    toast(limited.length ? `StoreFront: za status ${limited.join(' i ')} ima previše rezultata.` : 'Nisam uspio pročitati artikle. Detalji su na ekranu Za rasprodaju.');
    if (top().id === 'clearance') renderClearance();
    return;
  }
  // a status that was read replaces its old rows; one that could not be read keeps what was there
  const list = [];
  for (const st of want) list.push(...(got[st] || (prev && prev.list ? prev.list.filter((x) => x.st === st) : [])));
  S.user.clear = { at: r.at || Date.now(), st: want, group: r.group || cfg().group, list, limited, short };
  saveUser();
  const partial = r.how !== 'ok' || limited.length || short.length;
  const shown = clrView(false, S.user.clear).list.length; // what the list will show: only the ones in stock, without Christmas
  toast(partial ? 'Lista je učitana samo djelimično.' : `Učitano: ${shown} ${plural(shown, 'artikal', 'artikla', 'artikala')}`);
  if (top().id === 'clearance') renderClearance();
  if (top().id === 'plans') renderPlans();
  renderClearBar();
};

// ----------------------------------------------------------------- settings

const DEFAULTS = {
  vib: true, // short buzz when a barcode is read
  mode: 'plan', // search that is open when the app starts
  auto: true, // ask StoreFront about unknown barcodes without a tap
  tabs: { Aktivan: true, Zakasnio: true, Stigao: true, Ispunjen: true }, // customer-order tabs that are read
  name: true, // show the customer's name
  phone: true, // show the customer's phone
  stale: 12, // hours after which the orders data is called old
  theme: 'auto', // auto = follows the phone, or light / dark
  watch: false, // look at the order numbers in the background and send a notification
  clr: { 21: true, 81: true }, // statuses on the list of articles to sell
  group: '5', // product group of that list (5 = the department's own)
  noxmas: true, // leave Christmas and New Year articles out of that list
  xmas: core.XMAS_WORDS, // the words that make a name a Christmas / New Year one
  upd: true, // look for a new version of the app when it is opened
  mj: true, // read MYJYSK every morning at 8:00 and send a notification when there is something new
  mjMe: null, // who the employee is in MYJYSK (names, numbers, comma between); null = not known yet (filled once from StoreFront, kept on the phone)
  plSide: 'left', // the store's planograms: left or right side
  plCompact: false, // SC 3.0 Compact store
  plOrg: '1014BIH', // the country whose planograms are taken
  plOff: null, // planograms not taken: { '<sis>|<sub>': true }; null = only the Christmas one with the wall left out
};
const cfg = () => ({ ...DEFAULTS, ...(S.user.settings || {}), tabs: { ...DEFAULTS.tabs, ...((S.user.settings || {}).tabs || {}) }, clr: { ...DEFAULTS.clr, ...((S.user.settings || {}).clr || {}) } });
function setCfg(patch) {
  S.user.settings = { ...(S.user.settings || {}), ...patch };
  saveUser();
}

const sw = (key, label, sub, on) => `<div class="set-row"><div class="set-txt"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</div>
  <button class="switch" type="button" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-set="${key}"><i></i></button></div>`;
const choice = (key, label, opts, cur) => `<div class="set-row set-col"><div class="set-txt"><b>${label}</b></div>
  <div class="seg seg-sm" role="radiogroup" aria-label="${esc(label)}">${opts.map(([v, t]) => `<button class="seg-btn" type="button" role="radio" aria-checked="${String(v) === String(cur)}" data-choice="${key}" data-v="${v}">${t}</button>`).join('')}</div></div>`;
const act = (id, label, sub, danger) => `<button class="set-act${danger ? ' is-danger' : ''}" type="button" data-act="${id}"><span class="set-txt"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span>${icon('chev', 'chev')}</button>`;

function renderSettings() {
  const c = cfg();
  const o = S.user.orders;
  const learned = Object.keys(S.user.learned || {}).length;
  const tabNames = [['Aktivan', 'Aktivan'], ['Zakasnio', 'Zakasnio'], ['Stigao', 'Stigao'], ['Ispunjen', 'Ispunjen']];
  $('#settingsBody').innerHTML = `
  <section class="set-block"><h3>Izgled</h3><div class="set-card">
    ${choice('theme', 'Tema', [['auto', 'Kao telefon'], ['light', 'Svijetla'], ['dark', 'Tamna']], c.theme)}
  </div></section>

  ${(() => {
    let st = 'none';
    try { st = A.loginState ? A.loginState() : (A.plansLoginKept && A.plansLoginKept() ? 'ok' : 'none'); } catch (e) { /* older shell */ }
    const line = st === 'ok' ? 'Uključena. Kad te MYJYSK ili StoreFront odjavi, @APP@ se sama ponovo prijavi. Ista lozinka se koristi i za potvrdu Minus liste, pa ništa ne kucaš.'
      : st === 'refused' ? 'Lozinka nije prihvaćena (možda je promijenjena). Upiši novu, do tada se aplikacija ne prijavljuje sama.'
      : 'Isključena. Upiši korisničko ime i lozinku i aplikacija se sama prijavljuje kad te sistem odjavi.';
    let last = '';
    try {
      const [at, what, host] = String((A.loginLast && A.loginLast()) || '').split('|');
      const W = { sent: 'poslano korisničko ime i lozinka', refused: 'stranica je odbila lozinku', stopped: 'nije pokušano (lozinka ranije odbijena)', nologin: 'nije pokušano (nema sačuvane lozinke)', noform: 'stranica za prijavu otvorena, ali forma nije pronađena', link: 'otvorena nova sesija', retry: 'forma se vratila bez greške, pokušano još jednom', error: 'greška pri popunjavanju' };
      if (+at && W[what]) {
        const d = new Date(+at);
        last = `Zadnji pokušaj: ${d.getDate()}.${d.getMonth() + 1}. u ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} · ${W[what]}${host ? ` (${esc(host)})` : ''}`;
      }
    } catch (e) { /* older shell */ }
    return `<section class="set-block"><h3>Prijava</h3><div class="set-card">
    <div class="set-row"><div class="set-txt"><b>Automatska prijava</b><small class="${st === 'refused' ? 'is-bad' : ''}">${line}</small>${last ? `<small>${last}</small>` : ''}</div></div>
    ${act('login-set', st === 'none' ? 'Upiši korisničko ime i lozinku' : 'Promijeni korisničko ime i lozinku', 'Isti za MYJYSK, StoreFront i planograme. Ostaju samo na ovom telefonu, šifrovani.')}
    ${st !== 'none' ? act('login-forget', 'Zaboravi korisničko ime i lozinku', 'Brišu se s ovog telefona', true) : ''}
  </div></section>`;
  })()}

  <section class="set-block"><h3>Pretraga i skeniranje</h3><div class="set-card">
    ${choice('mode', 'Pri otvaranju', mjOn() ? [['plan', 'Planogrami'], ['orders', 'Narudžbe'], ['news', 'Vijesti']] : [['plan', 'Planogrami'], ['orders', 'Narudžbe']], c.mode)}
    ${sw('vib', 'Vibracija pri skeniranju', 'Kratka vibracija kad se barkod pročita', c.vib)}
    ${sw('auto', 'StoreFront traži nepoznate barkodove', 'Kad barkod nije poznat, sam se pita StoreFront (bez dodira dugmeta)', c.auto)}
  </div></section>

  <section class="set-block"><h3>Narudžbe kupaca</h3><div class="set-card">
    <div class="set-row set-col"><div class="set-txt"><b>Koje narudžbe čitati</b><small>Manje kartica znači kraće čitanje. Završene narudžbe se nikad ne čitaju.</small></div>
      <div class="chips">${tabNames.map(([k, t]) => `<button class="chip" type="button" role="checkbox" aria-checked="${c.tabs[k]}" data-tab="${k}">${t}</button>`).join('')}</div></div>
    ${sw('name', 'Prikaži ime kupca', '', c.name)}
    ${sw('phone', 'Prikaži telefon kupca', '', c.phone)}
    ${sw('watch', 'Obavijest o novim narudžbama', 'Svakih pola sata u pozadini (7–21 h) gleda brojeve u StoreFrontu i javi obavijest. Android može odgoditi provjeru, a radi samo dok si prijavljen.', c.watch)}
    ${choice('stale', 'Upozori da su podaci stari nakon', [[6, '6 h'], [12, '12 h'], [24, '24 h']], c.stale)}
    ${act('orders-refresh', 'Osvježi narudžbe sada', o ? `${o.list.length} narudžbi, ${esc(ageText(o.at))}` : 'Još nisu učitane')}
    ${act('orders-clear', 'Obriši narudžbe s telefona', 'Imena, telefoni i artikli se brišu s ovog telefona', true)}
  </div></section>

  <section class="set-block"><h3>Za rasprodaju</h3><div class="set-card">
    <div class="set-row set-col"><div class="set-txt"><b>Koji statusi</b><small>Artikli s ovim statusom koji su na zalihi u prodavnici (grupa Kućanstvo)</small></div>
      <div class="chips">${CLR_ST.map((k) => `<button class="chip" type="button" role="checkbox" aria-checked="${c.clr[k]}" data-cst="${k}">Status ${k}</button>`).join('')}</div></div>
    ${sw('noxmas', 'Sakrij božićne i novogodišnje artikle', 'Ne prikazuju se artikli kojima u nazivu piše neka od riječi ispod. Lista ih i dalje čita, pa se mogu vratiti.', c.noxmas)}
    ${c.noxmas ? `<div class="set-row set-col"><div class="set-txt"><b>Riječi za sakrivanje</b><small>Odvoji zarezom. Veliko ili malo slovo i č, ć, š, ž, đ nisu bitni, a riječ se traži na početku riječi u nazivu.</small></div>
      <input class="set-input" id="xmasWords" type="text" value="${esc(c.xmas)}" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Riječi za sakrivanje"></div>` : ''}
    ${act('clear-refresh', 'Učitaj listu sada', clrSrc() && clrSrc().list ? `${clrView().list.length} artikala, ${esc(ageText(clrSrc().at))}` : 'Još nije učitana')}
    ${act('clear-clear', 'Obriši listu s telefona', '', true)}
  </div></section>

  ${mjOn() ? `<section class="set-block"><h3>Vijesti (MYJYSK)</h3><div class="set-card">
    ${sw('mj', 'Svako jutro u 8:00', 'Zadaci i vijesti iz MYJYSK se sami učitaju, a obavijest dođe kad ima nešto novo. Android može pomjeriti za koju minutu. Radi dok si prijavljen u MYJYSK.', c.mj)}
    <div class="set-row set-col"><div class="set-txt"><b>Ja u MYJYSK</b><small>Ime i prezime ili broj, odvojeno zarezom. Zadaci na kojima piše ovo idu pod „Za mene“, kao i zadaci za Store Staff i sve uloge. Čuva se samo na ovom telefonu; ako je prazno, aplikacija ga jednom uzme iz StoreFronta.</small></div>
      <input class="set-input" id="mjMe" type="text" value="${esc(mjMe())}" autocapitalize="words" autocorrect="off" spellcheck="false" aria-label="Ja u MYJYSK"></div>
    ${act('mj-refresh', 'Osvježi sada', S.user.mj && S.user.mj.at ? `Stanje ${esc(ageText(S.user.mj.at))}` : 'Još nije učitano')}
  </div></section>

  <section class="set-block"><h3>Planogrami iz MYJYSK</h3><div class="set-card">
    ${choice('plSide', 'Strana trgovine', [['left', 'Lijeva'], ['right', 'Desna']], c.plSide)}
    ${sw('plCompact', 'SC 3.0 Compact trgovina', 'Uključi samo ako je trgovina Compact', c.plCompact)}
    ${planChips()}
    ${act('pl-check', 'Provjeri nove planograme', planCheckLine())}
    ${act('mj-clear', 'Obriši vijesti i zadatke s telefona', '', true)}
  </div></section>` : ''}

  <section class="set-block"><h3>Podaci</h3><div class="set-card">
    ${act('plans', 'Planogrami', `${S.plans.length} na telefonu`)}
    ${act('recent', 'Obriši zadnje traženo', `${S.user.recent.length} artikala`, true)}
    ${act('learned', 'Zaboravi povezane barkodove', `${learned} povezanih`, true)}
    ${act('signout', 'Odjavi se iz StoreFronta', 'Sljedeći put se ponovo prijaviš na njihovoj stranici', true)}
    ${backupsOf().map((b) => act('restore:' + b.name, `Vrati kopiju ${b.name.startsWith('vraceno') ? 'od prije vraćanja' : 'od prije nadogradnje'}`, `${new Date(b.at).toLocaleString('bs-BA')} · ${b.files} datoteka. Planogrami i prijava ostaju. Dodirni dvaput.`, true)).join('')}
  </div></section>

  ${sandboxOn() ? `<section class="set-block"><h3>TEST: simulacija slanja</h3><div class="set-card">
    <div class="set-row set-col"><div class="set-txt"><b>Ova verzija ništa ne šalje</b><small>Minus lista, Regulacija, SM/DM i AR se ne šalju u StoreFront ni MYJYSK. Čitanje radi normalno. Ovdje biraš kako se odigrano slanje završi.</small></div></div>
    ${SIMS.map(([k, label, sub]) => `<button class="set-row set-act" type="button" data-sim="${k}"><div class="set-txt"><b>${k === simNow() ? '● ' : ''}${esc(label)}</b><small>${esc(sub)}</small></div></button>`).join('')}
  </div></section>` : ''}
  <section class="set-block"><h3>O aplikaciji</h3><div class="set-card">
    <div class="set-row"><div class="set-txt"><b>@APP@</b><small>Verzija ${esc(A.version())} · ${esc(A.device())}</small></div></div>
    ${S.crash ? `<div class="set-row set-col"><div class="set-txt"><b>Zadnja greška</b><small class="crash">${esc(S.crash.slice(0, 700))}</small></div></div>${act('crash-clear', 'Obriši zapis o grešci', '')}` : ''}
    ${sw('upd', 'Provjeri nove verzije pri otvaranju', 'Nova verzija se sama preuzme, a ti samo potvrdiš instalaciju', c.upd)}
    ${S.update && S.update.state === 'ready' ? act('upd-install', `Instaliraj verziju ${esc(S.update.name || '')}`, 'Spremna je za instalaciju')
      : S.update && S.update.state === 'downloading' ? `<div class="set-row"><div class="set-txt"><b>Preuzimam ${esc(S.update.name || '')}</b><small>${S.update.pct || 0}%</small></div></div>`
      : act('upd-check', 'Provjeri nove verzije sada', '')}
    ${act('diag-copy', 'Kopiraj dijagnostiku', 'Zadnja upozorenja i greške aplikacije, bez lozinki, tokena i ličnih brojeva. Samo za slanje kad nešto ne radi.')}
  </div></section>`;
}

// test builds only (Sandbox): how a played Minus/Regulacija sending ends
const sandboxOn = () => { try { return !!(A.sandbox && A.sandbox()); } catch (e) { return false; } };
const simNow = () => { try { return (A.sim && A.sim()) || 'ok'; } catch (e) { return 'ok'; } };
const SIMS = [
  ['ok', 'Uspjeh', 'Oba koraka prihvaćena → Potvrđeno'],
  ['drop-minus', 'Pad mreže na Minus listi', 'Odgovor ne stigne → Ishod nepoznat'],
  ['drop-adjust', 'Pad mreže na Regulaciji', 'Minus prihvaćen, Regulacija bez odgovora → Ishod nepoznat'],
  ['500-minus', 'Greška servera na Minus listi', '→ Ishod nepoznat'],
  ['422-adjust', 'Regulacija odbijena', '→ Djelimično završeno, Regulacija čeka'],
  ['auth', 'Pogrešna lozinka', '→ Neuspjelo, ništa nije promijenjeno'],
  ['hang-minus', 'Bez odgovora na Minus listi', 'Za test zatvaranja aplikacije; nakon 2 min → Ishod nepoznat'],
  ['hang-adjust', 'Bez odgovora na Regulaciji', 'Za test zatvaranja aplikacije; nakon 2 min → Ishod nepoznat'],
  ['slow', 'Sporo (15 s po koraku)', 'Za test zatvaranja ili isključenja interneta usred slanja'],
];

/** Copies of the records the phone made before an update (newest first). */
const backupsOf = () => { try { return JSON.parse((A.backups && A.backups()) || '[]'); } catch (e) { return []; } };

function onSettingsClick(t) {
  if (t.dataset.act && t.dataset.act.startsWith('restore:')) {
    const name = t.dataset.act.slice(8);
    if (S.restoreArmed !== name) { S.restoreArmed = name; toast('Dodirni još jednom za vraćanje kopije. Sadašnji podaci se prvo sačuvaju.'); setTimeout(() => { S.restoreArmed = null; }, 5000); return; }
    S.restoreArmed = null;
    let ok = false;
    try { ok = !!A.restoreBackup(name); } catch (e) { ok = false; }
    toast(ok ? 'Kopija vraćena. Učitavam…' : 'Vraćanje nije uspjelo. Podaci od prije pokušaja su sačuvani kao nova kopija ovdje.');
    return;
  }
  if (t.dataset.sim) { try { A.setSim(t.dataset.sim); } catch (e) { /* not a test build */ } renderSettings(); toast('Simulacija: ' + (SIMS.find((x) => x[0] === t.dataset.sim) || [])[1]); return; }
  if (t.dataset.set) {
    const k = t.dataset.set;
    setCfg({ [k]: !cfg()[k] });
    if (k === 'watch') syncWatch(true);
    if (k === 'mj') syncMyjysk(true);
  } else if (t.dataset.choice) {
    const k = t.dataset.choice;
    setCfg({ [k]: k === 'stale' ? +t.dataset.v : t.dataset.v });
    if (k === 'theme') applyTheme();
  } else if (t.dataset.cst) {
    const clr = { ...cfg().clr, [t.dataset.cst]: !cfg().clr[t.dataset.cst] };
    if (!Object.values(clr).some(Boolean)) { toast('Bar jedan status mora biti uključen.'); return; }
    setCfg({ clr });
  } else if (t.dataset.tab) {
    const tabs = { ...cfg().tabs, [t.dataset.tab]: !cfg().tabs[t.dataset.tab] };
    if (!Object.values(tabs).some(Boolean)) { toast('Bar jedna kartica mora biti uključena.'); return; }
    setCfg({ tabs });
  } else if (t.dataset.act) {
    const a = t.dataset.act;
    if (a === 'plans') { renderPlans(); go('plans'); return; }
    if (a === 'orders-refresh') { refreshOrders(); return; }
    if (a === 'clear-refresh') { refreshClearance(); return; }
    if (a === 'mj-refresh') { refreshMyjysk(false); toast('Učitavam iz MYJYSK…'); return; }
    if (a === 'pl-check') { checkPlans(); return; }
    if (a === 'login-set') { S.loginWait = true; A.plansLogin(''); return; }
    if (a === 'login-forget') { try { A.plansLogout(); } catch (e) { /* older shell */ } toast('Korisničko ime i lozinka su obrisani s telefona.'); }
    if (a === 'diag-copy') {
      let log = '';
      try { log = A.readText('diag.log') || ''; } catch (e) { log = ''; }
      const head = `@APP@ ${A.version ? A.version() : ''}\n`;
      try { A.copyText(head + (log ? log.split('\n').slice(-120).join('\n') : '(nema zapisa)')); toast('Dijagnostika kopirana'); } catch (e) { toast('Kopiranje ne radi u ovoj verziji.'); }
      return;
    }
    if (a === 'mj-clear') { S.user.mj = null; saveUser(); store.remove(MJ_FILE); toast('Vijesti i zadaci su obrisani s telefona.'); }
    if (a === 'clear-clear') { S.user.clear = null; S.user.clr2 = null; saveUser(); toast('Lista je obrisana s telefona.'); }
    if (a === 'crash-clear') { try { A.clearCrash(); } catch (e) { /* ignore */ } S.crash = ''; }
    if (a === 'upd-check') { checkUpdate(true); toast('Tražim novu verziju…'); return; }
    if (a === 'upd-install') { installUpdate(); return; }
    if (a === 'orders-clear') { S.user.orders = null; saveUser(); toast('Narudžbe su obrisane s telefona.'); }
    if (a === 'recent') { S.user.recent = []; saveUser(); toast('Zadnje traženo je obrisano.'); }
    if (a === 'learned') { S.user.learned = {}; saveUser(); toast('Povezani barkodovi su zaboravljeni.'); }
    if (a === 'signout') { A.clearStorefront(); S.user.store = null; saveUser(); toast('Odjavljen si iz StoreFronta.'); }
  }
  renderSettings();
  renderHome();
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
const custName = (ord) => (cfg().name ? titleCase(ord.name) : `Narudžba ${ord.no.slice(-6)}`);
const telOf = (p) => String(p || '').replace(/[^\d+]/g, '');
const stBadge = (st) => (st === 'Otvoreno' ? '<span class="ol-st is-open">nije zaprimljeno</span>'
  : st === 'Popunjeno' ? '<span class="ol-st is-ok">zaprimljeno</span>'
  : st === 'Završeno' ? '<span class="ol-st is-done">kupac preuzeo</span>' : st ? `<span class="ol-st">${esc(st)}</span>` : '');
const noteHtml = (ord) => (ord.note ? `<div class="ord-note"><span>Opis računa</span>${esc(ord.note)}</div>` : '');
const madeHtml = (ord) => (ord.made ? `<small class="ocard-made">Kreirano ${esc(ord.made)}</small>` : '');

function orderCard(ord, hit) {
  const lines = (ord.items || []).map((it) => `<li class="${hit && hit(it) ? 'is-hit' : ''}"><span class="code">${esc(it.num)}</span><span class="ol-name">${esc(it.name)}</span><span class="ol-q">${it.qty > 0 ? `${it.qty} kom` : ''}</span>${stBadge(it.st)}</li>`).join('');
  return `<article class="ocard">
    <div class="ocard-top"><b>${esc(custName(ord))}</b><span class="ord-chip">${esc(ord.status || ord.tab)}</span></div>
    ${ord.ph && cfg().phone ? `<a class="ord-tel" href="tel:${esc(telOf(ord.ph))}">${esc(ord.ph)}</a>` : ''}
    ${madeHtml(ord)}
    <small class="ocard-meta">${esc(ord.no.slice(-6))} · ${esc(ord.tab)}${ord.date ? ` · dostava ${esc(ord.date)}` : ''}</small>
    ${noteHtml(ord)}
    ${lines ? `<ul class="olines">${lines}</ul>` : ''}
  </article>`;
}

/** Compact: one line per order, the matching lines only; more orders on the screen at once. */
function orderRowCompact(ord, hit) {
  const items = ord.items || [];
  const shown = hit ? items.filter((it) => hit(it)) : items;
  const lines = (shown.length ? shown : items).slice(0, 3).map((it) => `<span class="oc-line"><span class="code">${esc(it.num)}</span> ${it.qty > 0 ? `${it.qty} kom ` : ''}${stBadge(it.st)}</span>`).join('');
  const more = items.length - Math.min(3, (shown.length ? shown : items).length);
  return `<button class="ocard ocard-c" type="button" data-oq="${esc(ord.no)}">
    <span class="ocard-top"><b>${esc(custName(ord))}</b><span class="ord-chip">${esc(ord.status || ord.tab)}</span></span>
    <span class="oc-lines">${lines}${more > 0 ? `<span class="oc-more">+${more}</span>` : ''}</span>
  </button>`;
}

const ordViewSwitch = () => `<div class="seg-mini" role="group" aria-label="Prikaz narudžbi"><button type="button" data-ovw="cards" aria-pressed="${!cfg().ordCompact}">Detaljno</button><button type="button" data-ovw="compact" aria-pressed="${!!cfg().ordCompact}">Kompaktno</button></div>`;

function runOrdersSearch() {
  const q = $('#q').value.trim();
  $('#clearQ').hidden = !q;
  const box = $('#results');
  box.hidden = false;
  $('#recentWrap').hidden = true;
  const o = S.user.orders;
  if (!o) { box.innerHTML = '<p class="empty">Narudžbe još nisu učitane. Tapni „Učitaj“ iznad.</p>'; return; }
  if (!q) {
    // what is waiting for goods: lines that are still "Otvoreno", per article
    const by = new Map();
    for (const ord of o.list) {
      for (const it of ord.items || []) {
        if (it.st !== 'Otvoreno') continue;
        const e = by.get(it.num) || { num: it.num, name: it.name, qty: 0, n: 0 };
        e.qty += it.qty || 0;
        e.n += 1;
        by.set(it.num, e);
      }
    }
    const arr = [...by.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    box.innerHTML = `<p class="count-line">Čeka prijem robe: ${arr.length ? artikala(arr.length) : 'ništa'}</p>`
      + (arr.length ? `<div class="list">${arr.map((e) => `<button class="item" type="button" data-oq="${esc(e.num)}">
          <span class="item-main"><span class="code">${esc(e.num)}</span><span class="item-name">${esc(e.name) || 'Bez naziva'}</span>
          <span class="pills"><span class="pill pill-order">${e.qty} kom, ${e.n} ${plural(e.n, 'narudžba', 'narudžbe', 'narudžbi')}</span></span></span>${icon('chev', 'chev')}</button>`).join('')}</div>` : '')
      + '<p class="empty">Ili upiši šifru artikla, ime kupca, telefon ili broj narudžbe.</p>';
    return;
  }
  const d = q.replace(/[\s/+()-]/g, '');
  const digits = /^\d{3,}$/.test(d);
  const toks = norm(q).split(/\s+/).filter(Boolean);
  const found = [];
  for (const ord of o.list) {
    let ok = false;
    if (digits) {
      ok = (ord.items || []).some((it) => (d.length >= 7 ? it.num === d.slice(0, 7) : it.num.includes(d)))
        || ord.no.includes(d) || String(ord.ph || '').replace(/\D/g, '').includes(d);
    } else {
      const hay = norm(`${ord.name} ${ord.no} ${ord.note || ''} ${(ord.items || []).map((it) => it.name).join(' ')}`);
      ok = toks.every((t) => hay.includes(t));
    }
    if (ok) found.push(ord);
  }
  if (!found.length) { box.innerHTML = `<p class="empty">Nema narudžbi za „${esc(q)}“ (stanje ${esc(ageText(o.at))}).</p>`; return; }
  const exact = digits && d.length >= 7 ? d.slice(0, 7) : '';
  const hit = exact ? (it) => it.num === exact : digits ? (it) => it.num.includes(d) : (it) => toks.some((t) => norm(it.name).includes(t));
  let head = `${found.length} ${plural(found.length, 'narudžba', 'narudžbe', 'narudžbi')}`;
  if (exact) {
    const qty = found.reduce((n, ord) => n + (ord.items || []).filter((it) => it.num === exact).reduce((m, it) => m + (it.qty || 0), 0), 0);
    const nm = (found[0].items || []).find((it) => it.num === exact);
    head = `Artikal ${exact}${nm && nm.name ? ` · ${esc(nm.name)}` : ''}<br>${head}${qty ? `, ukupno ${qty} kom` : ''}`;
  }
  // a search for one order number shows that order in full, whatever the view
  const compact = cfg().ordCompact && !(found.length === 1 && found[0].no.includes(d) && digits);
  const max = compact ? 150 : 40;
  box.innerHTML = `<div class="ord-head"><p class="count-line">${head}${found.length > max ? ` (prikazano prvih ${max})` : ''} · stanje ${esc(ageText(o.at))}</p>${ordViewSwitch()}</div>`
    + found.slice(0, max).map((ord) => (compact ? orderRowCompact(ord, hit) : orderCard(ord, hit))).join('');
}

function setMode(m) {
  if (S.mode === 'news' && m !== 'news') seenNews();
  S.mode = m;
  $('#q').value = '';
  renderHome();
  if (m === 'news') freshenMyjysk();
}

function refreshOrders() {
  // orders with open lines are read again: goods may have been received since
  const known = ((S.user.orders && S.user.orders.list) || [])
    .filter((x) => x.items && x.items.length && x.ph !== undefined && x.items.every((i) => i.st === 'Popunjeno')).map((x) => x.no);
  const t = cfg().tabs;
  A.orders(JSON.stringify(known), JSON.stringify(['Ispunjen', 'Stigao', 'Zakasnio', 'Aktivan'].filter((k) => t[k])));
}

const TABS_ALL = ['Aktivan', 'Zakasnio', 'Stigao', 'Ispunjen'];
// how many orders StoreFront shows in a tab: an order is in several tabs at once (Aktivan holds every open one)
const inTab = (list, k) => list.filter((x) => (Array.isArray(x.tabs) && x.tabs.length ? x.tabs : [x.tab]).includes(k)).length;
// numbers of the last full read, for the enabled tabs: "Aktivan:92,Stigao:45"
const baseCounts = () => {
  const o = S.user.orders;
  if (!o) return '';
  const t = cfg().tabs;
  return TABS_ALL.filter((k) => t[k]).map((k) => `${k}:${inTab(o.list, k)}`).join(',');
};
const syncWatch = (ask) => { try { if (A.watch) A.watch(!!cfg().watch, baseCounts(), !!ask); } catch (e) { /* ignore */ } };
// what StoreFront shows now against what was read: [['Aktivan', +3], ...]
function siteDiff() {
  const o = S.user.orders;
  if (!o || !S.site) return [];
  const t = cfg().tabs;
  return TABS_ALL.filter((k) => t[k] && S.site[k] != null)
    .map((k) => [k, S.site[k] - inTab(o.list, k)]).filter((x) => x[1] !== 0);
}

function renderOrdersBar() {
  const b = $('#ordersBar');
  // customer orders come from StoreFront: they work without any planogram on the phone
  const has = S.plans.length > 0 || S.mode === 'orders';
  b.hidden = !has;
  if (!has) return;
  const o = S.user.orders;
  const ic = icon('info');
  if (!o) {
    b.innerHTML = `${ic}<span><b>Narudžbe kupaca</b><small>Učitaj iz StoreFronta, pa @APP@ javi kad je artikal naručen</small></span><span class="go">Učitaj</span>`;
  } else {
    const c = (t) => inTab(o.list, t);
    const df = siteDiff();
    if (df.length) {
      b.innerHTML = `${ic}<span><b>Na StoreFrontu ima promjena</b><small>${df.map(([k, n]) => `${k} ${n > 0 ? '+' : ''}${n}`).join(', ')} · ${esc(ageText(o.at))}</small></span><span class="go">Osvježi</span>`;
      return;
    }
    b.innerHTML = `${ic}<span><b>Narudžbe kupaca: ${o.list.length}</b><small>Aktivan ${c('Aktivan')}, Zakasnio ${c('Zakasnio')}, Stigao ${c('Stigao')}, Ispunjen ${c('Ispunjen')} · ${esc(ageText(o.at))}</small></span><span class="go">Osvježi</span>`;
  }
}

function itemRow(num, { attr = 'data-num', sub = '' } = {}) {
  const locs = locationsOf(num);
  const first = locs[0];
  return `<button class="item" type="button" ${attr}="${esc(num)}">
    ${thumb(num)}
    <span class="item-main">
      <span class="code">${esc(num)}</span>
      <span class="item-name">${esc(nameOf(num)) || 'Bez naziva'}</span>
      ${first ? pills(first.place, first.row, locs.length - 1) : ''}
      ${ordersOf(num).length ? '<span class="pills"><span class="pill pill-order">Naručio kupac</span></span>' : ''}
      ${sub}
    </span>
    ${icon('chev', 'chev')}
  </button>`;
}

// ------------------------------------------------------- Vijesti (MYJYSK)

const MJ_FILE = 'myjysk-in.json'; // the last read, also written by the 8:00 job of the phone
const mjOn = () => { try { return !!(A.myjyskOn && A.myjyskOn()); } catch (e) { return false; } };
const mjMe = () => {
  const c = cfg().mjMe;
  if (c != null) return c;
  try { return (A.myjyskMe && A.myjyskMe()) || ''; } catch (e) { return ''; }
};
const syncMyjysk = (ask) => { try { if (mjOn() && A.myjyskDaily) A.myjyskDaily(!!cfg().mj, !!ask); } catch (e) { /* older shell */ } };

/** Something new for the employee since he last looked at Vijesti (a red dot on the tab). */
function newsWaiting() {
  const st = S.user.mj;
  if (!st || !st.at) return false;
  return news.myTasks(st, mjMe()).some((t) => news.isNew(st, t.id)) || st.news.some((a) => news.isNew(st, a.id)) || impItems(st).some((x) => x.fresh);
}

function seenNews() {
  if (!S.user.mj) return;
  S.user.mj.viewedAt = Date.now();
  saveUser();
}

function takeMyjysk(r) {
  if (!r || r.how !== 'ok' || !r.data) return false;
  const at = +r.at || Date.now();
  if (S.user.mj && S.user.mj.at >= at) return false;
  S.user.mj = news.merge(S.user.mj, r.data, at);
  saveUser();
  return true;
}

/** What the 8:00 job read while the app was closed. */
function pickupMyjysk() {
  if (!mjOn()) return;
  const r = store.read(MJ_FILE, null);
  if (!r) return;
  if (r.how === 'login' && (!S.user.mj || !S.user.mj.at || r.at > S.user.mj.at)) {
    if (S.user.mj) { S.user.mj.login = true; saveUser(); }
    else S.user.mj = { at: 0, my: [], loc: [], news: [], sys: [], seen: {}, login: true };
  }
  takeMyjysk(r);
}

/** Reads again when the kept data is from before this morning's 8:00. */
function freshenMyjysk() {
  const st = S.user.mj;
  if (!st || !st.at || st.at < news.lastMorning(Date.now())) refreshMyjysk(false);
}

function refreshMyjysk(visible) {
  if (!mjOn()) return;
  if (S.mj.busy && !visible) return;
  if (!navigator.onLine) { S.mj.err = 'offline'; if (S.mode === 'news') renderNews(); return; } // kept data stays shown
  S.mj.err = '';
  S.mj.busy = !visible;
  try { A.myjysk(!!visible); } catch (e) { S.mj.busy = false; toast('Ova verzija aplikacije ne zna čitati MYJYSK.'); }
  if (S.mode === 'news') renderNews();
}

window.onMyjysk = (r) => {
  S.mj.busy = false;
  const after = S.mj.after;
  if (after === 'plans' && r && r.how !== 'login') S.mj.after = null;
  S.mj.err = r && r.how === 'error' ? (navigator.onLine ? 'error' : 'offline') : r && r.how === 'login' ? 'login' : '';
  if (r && r.how === 'ok') {
    takeMyjysk(r);
    store.write(MJ_FILE, { how: 'ok', at: +r.at || Date.now(), data: r.data });
  } else if (r && r.how === 'login') {
    if (!S.user.mj) S.user.mj = { at: 0, my: [], loc: [], news: [], sys: [], seen: {} };
    S.user.mj.login = true;
    saveUser();
  } else if (r && r.how === 'error') {
    toast(navigator.onLine ? 'MYJYSK nije odgovorio (greška na njihovoj strani). Ranije učitano ostaje.' : 'Nema internet veze. Ranije učitano ostaje.');
  }
  renderHome();
  if ($('#settings').classList.contains('is-active')) renderSettings();
  if (S.ar.after && r && r.how !== 'cancelled') { S.ar.after = false; if (r.how === 'ok' && top().id === 'ar') arLoad(); }
  if (after === 'plans') {
    if (r && r.how === 'ok') startPlanDownload();
    else if (r && r.how === 'login') {
      openSheet({ title: 'Prijavi se u MYJYSK', body: '<p>Za provjeru planograma treba prijava u MYJYSK. Poslije prijave provjera ide dalje sama.</p>',
        actions: [{ label: 'Prijavi se', kind: 'btn-primary', onClick: () => { closeSheet(); refreshMyjysk(true); } }, { label: 'Odustani', kind: 'btn-quiet', onClick: () => { S.mj.after = null; closeSheet(); } }] });
    } else { closeSheet(); if (!r || r.how !== 'cancelled') toast('MYJYSK nije odgovorio, provjera planograma nije urađena.'); }
  }
};

window.openNews = () => {
  while (S.stack.length > 1) back();
  setMode('news');
};

const NEWS_SHOWN = 12;

function taskRow(st, t, { role = false } = {}) {
  const d = news.due(t.end, Date.now());
  const meta = [d.date ? `rok ${d.date}${t.time && t.time !== '00:00' ? ` u ${t.time}` : ''}` : '', role && t.role ? t.role : '', t.eff ? `${t.eff} min` : ''].filter(Boolean).join(' · ');
  return `<button class="mj-row" type="button" ${t.path ? `data-mj-open="${esc(t.path)}"` : 'disabled'}>
    <span class="mj-main"><span class="mj-title">${news.isNew(st, t.id) ? '<span class="mj-new">NOVO</span>' : ''}${esc(t.title)}</span>${meta ? `<span class="mj-meta">${esc(meta)}</span>` : ''}</span>
    ${d.left ? `<span class="mj-due ${d.cls}">${esc(d.left)}</span>` : ''}${t.path ? icon('chev', 'chev') : ''}
  </button>`;
}

function newsRow(st, a) {
  const open = S.mj.open.has(a.id);
  const meta = [a.kb, a.by, news.dayText(a.at), a.att ? `${a.att} ${plural(a.att, 'prilog', 'priloga', 'priloga')}` : ''].filter(Boolean).join(' · ');
  return `<div class="mj-news"><button class="mj-row" type="button" data-mj-x="${esc(a.id)}" aria-expanded="${open}">
    <span class="mj-main"><span class="mj-title">${news.isNew(st, a.id) ? '<span class="mj-new">NOVO</span>' : ''}${esc(a.title)}</span><span class="mj-meta">${esc(meta)}</span></span>
  </button>${open ? `<div class="mj-text">${esc(a.text) || 'Bez teksta u pregledu.'}${a.path ? `<br><button class="text-btn" type="button" data-mj-open="${esc(a.path)}">Otvori vijest</button>` : ''}</div>` : ''}</div>`;
}

// ------------------------------------------------------------------ Minus lista (StoreFront, only read)

function renderStoreBars() { renderTipsBar(); renderTopBar(); renderSmBar(); renderSoonBar(); }

function renderMinusBar() {
  const b = $('#minusBar');
  if (!b) return;
  const has = S.plans.length > 0;
  b.hidden = !has;
  if (!has) return;
  const m = S.user.minus;
  const ic = icon('info');
  if (!m || !m.items) {
    b.innerHTML = `${ic}<span><b>Minus lista</b><small>Artikli u minusu, iz StoreFronta</small></span><span class="go">Učitaj</span>`;
    return;
  }
  const map = minusTargets(m.items);
  const ready = m.items.filter((x) => (map.get(x.num) || {}).target).length;
  const pend = (S.user.minusPending || []).length;
  const open = minusop.locks(S.minusOp) ? ' · <b>ishod nepoznat, provjeri</b>' : '';
  b.innerHTML = `${ic}<span><b>Minus lista: ${m.items.length}</b><small>${ready} spremno za ispravku${pend ? ` · ${pend} čeka Regulaciju` : ''}${open} · ${esc(ageText(m.at))}</small></span><span class="go">Otvori</span>`;
}

/** The record of the last sending, kept by the phone (survives closing the app and restarts). */
function minusOpNow() {
  try { const t = A.minusOp && A.minusOp(); S.minusOp = t ? JSON.parse(t) : null; } catch (e) { /* older shell: no record */ }
  return S.minusOp || null;
}

/** The status card of the last sending, with the read-only check and the employee's own decision for an unknown one. */
function minusOpCard() {
  const op = S.minusOp;
  const d = minusop.describe(op);
  if (!d) return '';
  // an old finished sending is not worth a card; an open one always is
  if (!d.lock && op.state !== 'unknown' && Date.now() - (op.end || op.at || 0) > 12 * 3600000) return '';
  const when = op.at ? new Date(op.at).toLocaleString('bs-BA', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  let more = '';
  if (op.state === 'unknown' && !op.resolved) {
    const ev = S.minusCheck && S.minusCheck.id === op.id ? S.minusCheck : null;
    const tm = (t) => (t ? new Date(t).toLocaleString('bs-BA', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–');
    const STEPS = { start: 'čitanje Minus liste', check: 'provjera liste', user: 'provjera korisnika', minus: 'Minus lista', adjust: 'Regulacija zalihe' };
    const http = op.http || {};
    const httpTxt = (k) => (http[k] ? `HTTP ${http[k]}` : 'bez odgovora');
    // what the phone itself knows about this sending, before anything is read from StoreFront
    const facts = `<div class="op-facts">
      <div><span>Počelo</span><b>${esc(tm(op.at))}</b></div>
      <div><span>Završeno / prekinuto</span><b>${esc(tm(op.end))}</b></div>
      <div><span>Stiglo do koraka</span><b>${esc(STEPS[op.step] || op.step || '–')}</b></div>
      ${op.kind === 'adjust' ? '' : `<div><span>StoreFront za Minus listu</span><b>${esc(http.minus ? httpTxt('minus') : op.minusOk || op.step === 'adjust' ? 'prihvaćeno' : op.step === 'minus' ? 'bez odgovora' : 'nije poslano')}</b></div>`}
      <div><span>StoreFront za Regulaciju</span><b>${esc(op.step === 'adjust' || op.kind === 'adjust' ? httpTxt('adjust') : 'nije poslano')}</b></div>
      <div><span>Razlog</span><b>${esc({ mreza: 'veza prekinuta', timeout: 'isteklo vrijeme', prekinuto: 'aplikacija zatvorena ili prekinuta' }[op.why] || op.why || '–')}</b></div>
    </div>`;
    const MV = { '911': 'smanjenje (911)', '912': 'povećanje (912)', '921': '921', '922': '922', '251': 'prodaja', '252': 'povrat', '101': 'prijem' };
    const moveList = (list, want) => (list.length ? `<ul class="op-moves">${list.map((m) => `<li class="${m.exact ? 'is-exact' : ''}">${esc(tm(m.t))} · <b>${m.q > 0 ? '+' : ''}${esc(mq(m.q))}</b> · ${esc(MV[m.type] || m.type || '?')} · ${m.mine ? 'tvojim korisnikom' : 'drugi korisnik'} · ${esc(m.when)} slanja${m.exact ? ' · <b>tačno očekivano</b>' : ''}</li>`).join('')}</ul>`
      : `<p class="op-none">Nema kretanja od 6 sati prije slanja (očekivano ${esc(want)}).</p>`);
    const W = { seen: 'tačno jedno očekivano kretanje', none: 'očekivano kretanje se ne vidi', unclear: 'nejasno: više mogućih ili isto i prije slanja', skip: '' };
    const rows = (op.items || []).map((it) => {
      const n = Math.abs(it.qty);
      const l = ev && ev.res && ev.res.lines.find((x) => x.num === it.num);
      const what = op.kind === 'adjust' ? `<b>${esc(it.target)}</b> ukloni ${mq(n)} · kod 53`
        : `<b>${esc(it.num)}</b> ${mq(it.qty)} → 0 · <b>${esc(it.target)}</b> ukloni ${mq(n)}`;
      if (!l) return `<div class="mp-row"><div class="mp-txt"><span>${what}</span></div></div>`;
      const minusPart = op.kind === 'adjust' ? '' : `<div class="op-ev"><b>Minus lista ${esc(it.num)}</b> (očekivano +${esc(mq(n))}): ${esc(W[l.minus])}
          <small>Sada na Minus listi: ${l.stillMinus == null ? 'nije na listi' : esc(mq(l.stillMinus))}</small>${moveList(l.numMoves, '+' + mq(n))}</div>`;
      return `<div class="mp-row"><div class="mp-txt"><span>${what}</span>${minusPart}
        <div class="op-ev"><b>Regulacija ${esc(it.target)}</b> (očekivano -${esc(mq(n))}): ${esc(W[l.adjust])}${moveList(l.targetMoves, '-' + mq(n))}</div></div></div>`;
    }).join('');
    const evText = ev ? (ev.busy ? '<p class="count-line"><i class="mj-busy"></i> Čitam historiju zalihe iz StoreFronta…</p>'
      : ev.err ? `<p class="att-from">Provjera nije uspjela (${esc(ev.err)}). Pogledaj u StoreFrontu.</p>`
        : `<p class="att-from op-warnline">Ovo nije dokaz. StoreFront ne daje broj operacije, a historija zalihe nema ni komentar ni razlog (53/103). Isto kretanje je mogao napraviti neko drugi ili ti ručno. Uporedi u StoreFrontu, pa odluči. Pročitano ${esc(tm(ev.at))}.</p>`) : '';
    more = `${facts}${rows}${evText}
      <button class="btn btn-block" type="button" data-op-check ${ev && ev.busy ? 'disabled' : ''}>Provjeri u StoreFrontu (samo čitanje)</button>
      <div class="mp-head"><button class="text-btn" type="button" data-sf-page="minus">Otvori Minus listu</button><button class="text-btn" type="button" data-sf-page="adjust">Otvori Regulaciju</button></div>
      <p class="att-from">Kad provjeriš u StoreFrontu, reci šta si našao. Tek tada se može slati ponovo.</p>
      ${op.kind !== 'adjust' && op.step === 'minus'
    ? `<button class="btn btn-block" type="button" data-op-resolve="done">Provjerio sam: Minus lista je prošla</button>
      <button class="btn btn-block" type="button" data-op-resolve="notdone">Provjerio sam: Minus lista nije prošla</button>`
    : `<button class="btn btn-block" type="button" data-op-resolve="done">Provjerio sam: prošlo je</button>
      <button class="btn btn-block" type="button" data-op-resolve="notdone">Provjerio sam: nije prošlo</button>`}`;
  }
  return `<section class="mj-sec mp op-card op-${d.tone}" aria-live="polite"><div class="sec-head"><h2>${esc(d.label)}</h2><small>${esc(when)}</small></div>
    <p class="att-from">${esc(d.text)}</p>${more}</section>`;
}

function minusOpCheck() {
  const op = S.minusOp;
  if (!op || op.state !== 'unknown') return;
  S.minusCheck = { id: op.id, busy: true };
  const ok = stCall({ mode: 'opcheck', items: (op.items || []).map((x) => ({ num: x.num, target: x.target })), since: op.at }, (r) => {
    S.minusCheck = r.how === 'ok' ? { id: op.id, at: Date.now(), res: minusop.evidence(op, r.res) } : { id: op.id, err: r.how === 'login' ? 'traži prijavu' : 'greška' };
    if (top().id === 'minus') renderMinus();
  });
  if (!ok) S.minusCheck = { id: op.id, err: 'ova verzija to ne zna' };
  renderMinus();
}

/** Read only: the stock history of the replacement numbers of the lines 1.57 left waiting for Regulacija. */
function legacyCheck() {
  const items = (S.user.minusPending || []).filter((p) => p && p.legacy && p.target);
  if (!items.length) return;
  const since = Date.now() - 14 * 86400000;
  S.legacyCheck = { busy: true };
  const ok = stCall({ mode: 'opcheck', items: items.map((x) => ({ num: x.num, target: x.target })), since: since + 6 * 3600000 }, (r) => {
    S.legacyCheck = r.how === 'ok' ? { res: minusop.evidence({ kind: 'adjust', at: since, end: Date.now(), items }, r.res) } : { err: r.how === 'login' ? 'traži prijavu' : 'greška' };
    if (top().id === 'minus') renderMinus();
  });
  if (!ok) S.legacyCheck = { err: 'ova verzija to ne zna' };
  renderMinus();
}

/** The employee's own decision on an unknown sending, after he checked it in StoreFront. */
function minusOpResolve(how) {
  const op = S.minusOp;
  if (!op || op.state !== 'unknown' || !A.minusOpResolve) return;
  let rec = null;
  try { const t = A.minusOpResolve(op.id, how); rec = t ? JSON.parse(t) : null; } catch (e) { rec = null; }
  if (!rec) { toast('Nije zapisano. Pokušaj ponovo.'); return; }
  S.minusOp = rec;
  const items = rec.items || [];
  const minusOnly = rec.kind !== 'adjust' && rec.step === 'minus';
  if (how === 'done' && minusOnly) {
    // it stopped at Minus lista: that went through, Regulacija zalihe was never sent and still has to be done
    const d = S.user.minusDone || (S.user.minusDone = {});
    for (const x of items) d[`${x.num}|${x.qty}|1`] = Date.now();
    const have = new Set((S.user.minusPending || []).map((p) => p.num));
    S.user.minusPending = [...(S.user.minusPending || []), ...items.filter((x) => x.target && !have.has(x.num))];
  } else if (how === 'done') {
    const d = S.user.minusDone || (S.user.minusDone = {});
    for (const x of items) {
      if (rec.kind !== 'adjust') d[`${x.num}|${x.qty}|1`] = Date.now();
      d[`${x.num}|${x.qty}|2`] = Date.now();
    }
    if (rec.kind === 'adjust') {
      const nums = new Set(items.map((x) => x.num));
      S.user.minusPending = (S.user.minusPending || []).filter((p) => !nums.has(p.num));
    }
  } else if (rec.kind !== 'adjust' && rec.step === 'adjust') {
    // Minus lista was accepted, Regulacija did not go through: only Regulacija is left, sent when the employee taps it
    const have = new Set((S.user.minusPending || []).map((p) => p.num));
    S.user.minusPending = [...(S.user.minusPending || []), ...items.filter((x) => !have.has(x.num))];
  }
  saveUser();
  toast(how === 'done' ? (minusOnly ? 'Zapisano: Minus lista je prošla. Regulacija zalihe čeka u „Čeka Regulaciju“.' : 'Zapisano: prošlo je.') : 'Zapisano: nije prošlo. Slanje je ponovo moguće.');
  S.minusCheck = null;
  renderMinus();
  setTimeout(loadMinus, 500);
}

function loadMinus() {
  if (S.minusBusy) return;
  S.minusBusy = true;
  try { A.minus(); } catch (e) { S.minusBusy = false; toast('Ova verzija aplikacije ne zna čitati Minus listu.'); }
  if (top().id === 'minus') renderMinus();
}

function openMinus() {
  renderMinus();
  go('minus');
  if (!S.user.minus || Date.now() - (S.user.minus.at || 0) > 10 * 60 * 1000) loadMinus();
}

window.onMinus = (r) => {
  S.minusBusy = false;
  if (!r) return;
  if (r.how === 'ok') {
    S.user.minus = { at: r.at || Date.now(), items: r.items || [], total: r.meta && r.meta.total || 0, other: (r.meta && r.meta.other) || [] };
    const live = new Set((r.items || []).map((x) => `${x.num}|${x.qty}|`));
    const d = S.user.minusDone || {};
    for (const k of Object.keys(d)) if (!live.has(k.replace(/[12]$/, ''))) delete d[k];
    const nums = new Set((r.items || []).map((x) => x.num));
    const pk = S.user.minusPick || {};
    for (const k of Object.keys(pk)) if (!nums.has(k)) delete pk[k];
    saveUser();
  } else {
    toast(r.how === 'login' ? 'StoreFront traži prijavu. Prijavi se (Narudžbe → Osvježi) pa pokušaj ponovo.' : 'Minus lista se nije mogla učitati. Pokušaj ponovo.');
  }
  if (top().id === 'minus') renderMinus();
  if (top().id === 'home') renderHome();
};

/** The substitution chain with the store's stock of each number ({num, st, stock}); an older read kept only future
 * replacement numbers, which are not where the goods are: those are left out until the next read. */
const chainOf = (x) => (x.subs || []).filter((c) => c && typeof c === 'object');
const mq = (n) => (Number.isInteger(n) ? String(n) : String(n).replace('.', ','));

/**
 * Where each article in minus gets its goods back from: the replacement number with stock. Numbers the employee picked
 * (S.user.minusPick) count first; a replacement shared by several articles is given out only as far as its stock goes.
 * Answer: Map num -> {target: {num, st, stock}, left} or {why, pos} when it needs the employee.
 */
function minusTargets(items) {
  const picks = S.user.minusPick || {};
  const used = {};
  // goods already promised to a Regulacija that is still waiting: that stock is not free for a new line
  for (const p of S.user.minusPending || []) if (p && p.target) used[p.target] = (used[p.target] || 0) + Math.abs(+p.qty || 0);
  const out = new Map();
  const order = items.slice().sort((a, b) => (picks[b.num] ? 1 : 0) - (picks[a.num] ? 1 : 0) || a.qty - b.qty);
  for (const x of order) {
    if (!(x.qty < 0)) continue;
    const ch = chainOf(x);
    if (!ch.length) continue;
    const pos = ch.filter((c) => typeof c.stock === 'number' && c.stock > 0);
    const need = Math.abs(x.qty);
    let t = null;
    if (picks[x.num]) t = pos.find((c) => c.num === picks[x.num]) || null;
    else if (pos.length === 1) t = pos[0];
    if (!t) {
      out.set(x.num, { why: !pos.length ? 'none' : picks[x.num] ? 'gone' : 'many', pos });
      continue;
    }
    const free = t.stock - (used[t.num] || 0);
    if (free < need) { out.set(x.num, { why: 'short', pos, t, free }); continue; }
    used[t.num] = (used[t.num] || 0) + need;
    out.set(x.num, { target: t, left: free - need });
  }
  return out;
}
/** The number the goods really are under (for one article). */
function minusTarget(x) {
  const r = S.minusMap && S.minusMap.get(x.num);
  return r && r.target ? r.target : null;
}

/** The comments StoreFront takes (at most 50 characters): Minus lista, then Regulacija zalihe. */
const minusComments = (x, t) => [`Zamjena: ${x.num} na 0, roba pod ${t.num}`, `Zamjena: prodano pod ${x.num}`];

function minusRow(x) {
  const qty = `${mq(x.qty)} ${esc(x.unit || 'KOM')}`;
  const ch = chainOf(x);
  const t = minusTarget(x);
  const sub = ch.length
    ? `<span class="pills">${t ? `<span class="pill pill-order">Roba pod šifrom ${esc(t.num)} (${esc(mq(t.stock))} kom)</span>` : ''}</span>
       <span class="store-line">Zaliha zamjenskih: ${ch.map((c) => `${esc(c.num)}${c.st ? ` (${esc(c.st)})` : ''}${typeof c.stock === 'number' ? ` ${esc(mq(c.stock))}` : ''}`).join(' · ')}</span>`
    : x.subsErr ? '<span class="pills"><span class="pill pill-muted">Zamjene nisu pročitane</span></span>' : '<span class="pills"><span class="pill pill-muted">Nema zamjene</span></span>';
  const line = `<span class="store-line minus-qty">${qty}${x.st ? ` · status ${esc(x.st)}` : ''}${x.blocked ? ` · blokirano ${esc(mq(x.blocked))}` : ''}</span>`;
  if (S.index.byNum.has(x.num)) return itemRow(x.num, { sub: `${sub}${line}` });
  return `<div class="item item-static">${sfThumb(x.num)}<span class="item-main">
    <span class="code">${esc(x.num)}</span><span class="item-name">${esc(x.name) || 'Bez naziva'}</span>
    ${sub}<span class="pills"><span class="pill pill-muted">Nije u tvojim planogramima</span>${ordersOf(x.num).length ? '<span class="pill pill-order">Naručio kupac</span>' : ''}</span>${line}</span></div>`;
}

/** An article with replacements that the plan can not decide: why, and (when several have stock) a pick. */
function minusDecideRow(x) {
  const r = S.minusMap.get(x.num) || {};
  const pos = r.pos || [];
  const why = r.why === 'none' ? 'Nijedna zamjenska šifra nema zalihu: provjeri uzrok (dostava, blagajna, popis) i prebroji.'
    : r.why === 'short' ? `Šifra ${esc(r.t.num)} ima samo ${esc(mq(r.free))} kom za ovaj artikal, a minus je ${esc(mq(x.qty))}. Prebroji i odluči sam.`
    : r.why === 'gone' ? 'Šifra koju si izabrao više nema zalihu. Izaberi ponovo.'
    : 'Više zamjenskih šifri ima zalihu. Izaberi pod kojom je roba prodana:';
  const picks = r.why === 'many' || r.why === 'gone'
    ? `<div class="chips mp-picks">${pos.map((c) => `<button class="chip" type="button" data-mp-pick="${esc(x.num)}|${esc(c.num)}">${esc(c.num)} · ${esc(mq(c.stock))} kom</button>`).join('')}</div>` : '';
  return `<div class="mp-row mp-decide"><div class="mp-txt"><span><b>${esc(x.num)}</b> ${esc(x.name)} · <b class="minus-qty">${esc(mq(x.qty))}</b></span><small>${why}</small>${picks}
    <small>Zaliha zamjenskih: ${chainOf(x).map((c) => `${esc(c.num)} ${typeof c.stock === 'number' ? esc(mq(c.stock)) : '?'}`).join(' · ')}</small></div></div>`;
}

/** The shift plan: Minus lista back to 0 on the number in minus, Regulacija zalihe minus the same on the number with stock. */
function minusPlan(list) {
  const one = list.filter((x) => minusTarget(x));
  const pending = (S.user.minusPending || []).filter((p) => p && p.target);
  if (!one.length && !pending.length) return '';
  const done = S.user.minusDone || {};
  const key = (x, step) => `${x.num}|${x.qty}|${step}`;
  const row = (x, step) => {
    const k = key(x, step);
    const n = Math.abs(x.qty);
    const t = minusTarget(x);
    const r = S.minusMap.get(x.num);
    const ord = ordersOf(t.num).length ? ' · <b>naručio kupac</b>' : '';
    const what = step === 1
      ? `<b>${esc(x.num)}</b> ${esc(x.name)}<br>upiši brojano: <b>0</b> (sad ${mq(x.qty)})`
      : `<b>${esc(t.num)}</b> ${esc(nameOf(t.num) || '')}<br>ukloni <b>${mq(n)}</b> · kod <b>53</b> · poslije ostaje <b>${mq(r.left)}</b> kom${ord}`;
    const com = minusComments(x, t)[step - 1];
    return `<div class="mp-row${done[k] ? ' is-done' : ''}">
      <button class="mp-check" type="button" role="checkbox" aria-checked="${!!done[k]}" aria-label="Urađeno" data-mp-done="${esc(k)}"></button>
      <div class="mp-txt"><span>${what}</span><small>${esc(com)}</small></div>
      <button class="text-btn" type="button" data-mp-copy="${esc(com)}">Kopiraj</button></div>`;
  };
  const left = (step) => one.filter((x) => !done[key(x, step)]).length;
  const busy = S.minusApplying || minusop.locks(S.minusOp) ? 'disabled' : '';
  const legacy = pending.filter((p) => p.legacy);
  const lc = S.legacyCheck;
  const MVL = { '911': 'smanjenje (911)', '912': 'povećanje (912)' };
  const tm = (t) => new Date(t).toLocaleString('bs-BA', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  const legacyRow = (p) => {
    const l = lc && lc.res && lc.res.lines.find((x) => x.num === p.num);
    const moves = l ? (l.targetMoves.length ? `<ul class="op-moves">${l.targetMoves.map((m) => `<li class="${m.q === -Math.abs(p.qty) && m.mine ? 'is-exact' : ''}">${esc(tm(m.t))} · <b>${m.q > 0 ? '+' : ''}${esc(mq(m.q))}</b> · ${esc(MVL[m.type] || m.type || '?')} · ${m.mine ? 'tvojim korisnikom' : 'drugi korisnik'}${m.q === -Math.abs(p.qty) && m.mine ? ' · <b>ista količina</b>' : ''}</li>`).join('')}</ul>` : '<p class="op-none">U zadnje 2 sedmice nema kretanja zalihe za ovu šifru.</p>') : '';
    return `<div class="mp-row"><div class="mp-txt"><span><b>${esc(p.target)}</b> ukloni <b>${mq(Math.abs(p.qty))}</b> · kod 53${p.legacy ? ' · <b>iz 1.57, provjeri</b>' : ''}</span><small>${esc(p.c2)}</small>${moves}</div></div>`;
  };
  const legacyBox = legacy.length ? `<p class="att-from op-warnline">${legacy.length} ${plural(legacy.length, 'red je', 'reda su', 'redova je')} ovdje stavila verzija 1.57, koja je i prekinutu vezu brojala kao „nije prošlo“. Neki su možda ipak prošli. Prije slanja provjeri u StoreFrontu (Regulacija zalihe, historija zalihe).</p>
      ${lc && lc.busy ? '<p class="count-line"><i class="mj-busy"></i> Čitam historiju zalihe…</p>' : lc && lc.err ? `<p class="att-from">Provjera nije uspjela (${esc(lc.err)}).</p>` : lc && lc.res ? '<p class="att-from">Kretanja zadnje 2 sedmice za šifre ispod. Ovo nije dokaz: StoreFront ne pokazuje komentar ni razlog.</p>' : ''}
      <button class="btn btn-block" type="button" data-legacy-check ${lc && lc.busy ? 'disabled' : ''}>Provjeri u StoreFrontu (samo čitanje)</button>
      <button class="btn btn-block" type="button" data-legacy-ok="notdone">Provjerio sam: Regulacija nije prošla</button>
      <button class="btn btn-block" type="button" data-legacy-ok="done">Provjerio sam: prošla je, ukloni</button>` : '';
  const pend = pending.length ? `<div class="mp-step mp-pending"><div class="mp-head"><b>Čeka Regulaciju</b><small>${pending.length}</small></div>
      <p class="att-from">Ovi artikli su na Minus listi već vraćeni na 0, ali Regulacija zalihe nije prošla:</p>
      ${pending.map(legacyRow).join('')}
      ${legacyBox}
      <button class="btn btn-primary btn-block mp-apply" type="button" data-mp-apply-adjust ${busy || legacy.length ? 'disabled' : ''}>${S.minusApplying ? 'Šaljem…' : 'Pošalji samo Regulaciju'}</button>
      <button class="text-btn" type="button" data-mp-pending-clear>Uradio sam to u StoreFrontu, ukloni</button></div>` : '';
  if (!one.length) return `<section class="mj-sec mp"><div class="sec-head"><h2>Plan za smjenu</h2></div>${pend}</section>`;
  return `<section class="mj-sec mp"><div class="sec-head"><h2>Plan za smjenu</h2><small>${one.length} ${plural(one.length, 'zamjena', 'zamjene', 'zamjena')}</small></div>
    ${pend}
    <p class="att-from">Prije potvrde provjeri na polici da je pod zamjenskom šifrom stvarno ostalo koliko piše „poslije ostaje“.</p>
    <button class="btn btn-primary btn-block mp-apply" type="button" data-mp-apply ${busy}>${S.minusApplying ? 'Šaljem u StoreFront…' : `Potvrdi ${one.length} ${plural(one.length, 'zamjenu', 'zamjene', 'zamjena')} u aplikaciji`}</button>
    <p class="att-from">Potvrda šalje oba koraka odjednom, s komentarima, pod tvojim SAP HR brojem, s lozinkom iz postavki (Postavke → Prijava), pa ništa ne kucaš; „Upiši ručno“ ako želiš drugu. Ili ručno u StoreFrontu: prvo svi na Minus listi pa jedna potvrda, zatim svi na Regulaciji zalihe pa jedna potvrda.</p>
    <div class="mp-step"><div class="mp-head"><b>1. Minus lista</b><small>${left(1)} preostalo</small><button class="text-btn" type="button" data-sf-page="minus">Otvori Minus listu</button></div>
      ${one.map((x) => row(x, 1)).join('')}</div>
    <div class="mp-step"><div class="mp-head"><b>2. Regulacija zalihe</b><small>${left(2)} preostalo</small><button class="text-btn" type="button" data-sf-page="adjust">Otvori Regulaciju</button></div>
      ${one.map((x) => row(x, 2)).join('')}</div>
  </section>`;
}

/** The lines the shift plan would send: number in minus, its replacement with stock, the two comments. */
function minusApplyItems() {
  const m = S.user.minus;
  if (!m || !m.items) return [];
  return m.items.filter((x) => minusTarget(x)).map((x) => {
    const t = minusTarget(x);
    const [c1, c2] = minusComments(x, t);
    return { num: x.num, qty: x.qty, target: t.num, c1, c2 };
  });
}

window.onMinusApplying = () => { S.minusApplying = true; minusOpNow(); if (top().id === 'minus') renderMinus(); };
window.onMinusApplied = (r) => {
  S.minusApplying = false;
  if (r && r.op) S.minusOp = r.op; else minusOpNow();
  const W = { empty: 'Upiši SAP HR broj i lozinku.', auth: 'StoreFront nije prihvatio SAP HR broj ili lozinku. Ništa nije poslano.', nonstore: 'StoreFront kaže da korisnik nije iz prodavnice. Ništa nije poslano: uradi to u StoreFrontu.', wrongstore: 'StoreFront kaže da korisnik nije iz ove prodavnice. Ništa nije poslano: uradi to u StoreFrontu.', login: 'StoreFront traži prijavu. Ništa nije poslano.', nouser: 'StoreFront nije dao tvoj SAP HR broj. Ništa nije poslano: tapni „Upiši ručno“.' };
  if (r && r.kept && r.why === 'auth') W.auth = 'StoreFront nije prihvatio lozinku iz postavki za potvrdu. Ništa nije poslano. Sljedeći put je upiši ručno, ili je promijeni u Postavke → Prijava.';
  const sentItems = S.minusSending || [];
  const adjustOnly = !!S.minusSendingAdjust;
  S.minusSending = null;
  S.minusSendingAdjust = false;
  if (r && r.state === 'locked') {
    toast(r.why === 'busy' ? 'Slanje je već u toku.' : r.why === 'record' ? 'Zapis slanja se nije mogao spremiti. Ništa nije poslano.' : 'Prethodno slanje ima nepoznat ishod. Prvo ga provjeri, pa tek onda šalji ponovo.');
  } else if (r && r.state === 'unknown') {
    // a step was sent and its answer never came: nothing is marked done, nothing is kept for sending again
    toast('Ishod nepoznat – potrebna provjera. Ništa se neće slati dok ne provjeriš.');
  } else if (!r || r.state !== 'ok') {
    const why = r && r.why || '';
    let msg = W[why] || (r && r.step === 'minus' ? 'StoreFront je odbio Minus listu. Ništa nije promijenjeno.' : 'Slanje nije uspjelo. Ništa nije poslano.');
    if (!adjustOnly && (/^adjust/.test(why) || r && r.step === 'adjust')) {
      // Minus lista went through (StoreFront accepted it), Regulacija was refused: keep those lines to send again
      // on their own, when the employee taps it
      const sent = new Set(r && r.sent ? r.sent : sentItems.map((i) => i.num));
      const have = new Set((S.user.minusPending || []).map((p) => p.num));
      S.user.minusPending = [...(S.user.minusPending || []), ...sentItems.filter((i) => sent.has(i.num) && !have.has(i.num))];
      saveUser();
      msg = 'Minus lista je ispravljena, ali StoreFront je odbio Regulaciju zalihe. Tapni „Pošalji samo Regulaciju“ ili je uradi u StoreFrontu.';
    }
    toast(msg);
  } else {
    const n = (r.sent || []).length, k = (r.skipped || []).length;
    toast(`${n ? `Potvrđeno u StoreFrontu: ${n} ${plural(n, adjustOnly ? 'regulacija' : 'zamjena', adjustOnly ? 'regulacije' : 'zamjene', adjustOnly ? 'regulacija' : 'zamjena')}.` : 'Ništa nije poslano.'}${k ? ` Preskočeno ${k} (promijenilo se u međuvremenu).` : ''}`);
    if (adjustOnly) {
      const sent = new Set(r.sent || []);
      S.user.minusPending = (S.user.minusPending || []).filter((p) => !sent.has(p.num));
    } else {
      const d = S.user.minusDone || (S.user.minusDone = {});
      const m = S.user.minus;
      for (const num of r.sent || []) {
        const x = m && m.items.find((i) => i.num === num);
        if (x) { d[`${x.num}|${x.qty}|1`] = Date.now(); d[`${x.num}|${x.qty}|2`] = Date.now(); }
      }
    }
    saveUser();
    setTimeout(loadMinus, 2500);
  }
  if (top().id === 'minus') renderMinus();
  renderMinusBar();
};

function onMinusClick(ev) {
  const t = ev.target.closest('[data-num],[data-mp-done],[data-mp-copy],[data-sf-page],[data-mp-apply],[data-mp-apply-adjust],[data-mp-pick],[data-mp-pending-clear],[data-op-check],[data-op-resolve],[data-legacy-check],[data-legacy-ok]');
  if (!t) return;
  if ('opCheck' in t.dataset) { minusOpCheck(); return; }
  if ('legacyCheck' in t.dataset) { legacyCheck(); return; }
  if (t.dataset.legacyOk) {
    const legacy = (S.user.minusPending || []).filter((p) => p && p.legacy);
    if (t.dataset.legacyOk === 'done') S.user.minusPending = (S.user.minusPending || []).filter((p) => !(p && p.legacy));
    else for (const p of legacy) { delete p.legacy; p.checkedAt = Date.now(); }
    saveUser();
    S.legacyCheck = null;
    toast(t.dataset.legacyOk === 'done' ? `Uklonjeno ${legacy.length}: Regulacija je već bila prošla.` : 'Zapisano. Regulacija se sada može poslati.');
    renderMinus();
    renderMinusBar();
    return;
  }
  if (t.dataset.opResolve) { minusOpResolve(t.dataset.opResolve); return; }
  if (('mpApply' in t.dataset || 'mpApplyAdjust' in t.dataset) && minusop.locks(minusOpNow())) {
    toast('Prethodno slanje ima nepoznat ishod. Prvo ga provjeri.');
    renderMinus();
    return;
  }
  if ('mpApply' in t.dataset) {
    if (S.minusApplying) return;
    if (!S.user.minus || Date.now() - (S.user.minus.at || 0) > 15 * 60 * 1000) { toast('Lista je starija od 15 minuta. Osvježi je pa potvrdi.'); loadMinus(); return; }
    const items = minusApplyItems();
    if (!items.length) return;
    S.minusSending = items;
    try { A.minusApply(JSON.stringify(items)); } catch (e) { S.minusSending = null; toast('Ova verzija aplikacije to ne zna.'); }
    return;
  }
  if ('mpApplyAdjust' in t.dataset) {
    if (S.minusApplying) return;
    const items = (S.user.minusPending || []).filter((p) => p && p.target);
    if (!items.length) return;
    if (items.some((p) => p.legacy)) { toast('Prvo provjeri redove iz 1.57.'); return; }
    if (!A.minusApplyAdjust) { toast('Ova verzija aplikacije to ne zna. Uradi Regulaciju u StoreFrontu.'); return; }
    S.minusSending = items;
    S.minusSendingAdjust = true;
    try { A.minusApplyAdjust(JSON.stringify(items)); } catch (e) { S.minusSending = null; S.minusSendingAdjust = false; toast('Ova verzija aplikacije to ne zna.'); }
    return;
  }
  if ('mpPendingClear' in t.dataset) { S.user.minusPending = []; saveUser(); renderMinus(); return; }
  if (t.dataset.mpPick) {
    const [num, target] = t.dataset.mpPick.split('|');
    const p = S.user.minusPick || (S.user.minusPick = {});
    p[num] = target;
    saveUser();
    renderMinus();
    return;
  }
  if (t.dataset.sfPage) { try { A.storefrontPage(t.dataset.sfPage); } catch (e) { toast('Ova verzija aplikacije to ne zna.'); } return; }
  if (t.dataset.mpCopy) {
    try { A.copyText(t.dataset.mpCopy); toast('Komentar kopiran'); } catch (e) { toast('Kopiranje ne radi u ovoj verziji.'); }
    return;
  }
  if (t.dataset.mpDone) {
    const d = S.user.minusDone || (S.user.minusDone = {});
    if (d[t.dataset.mpDone]) delete d[t.dataset.mpDone]; else d[t.dataset.mpDone] = Date.now();
    saveUser();
    renderMinus();
    return;
  }
  if (t.dataset.num) openItem(t.dataset.num, { via: 'minus' });
}

function renderMinus() {
  const box = $('#minusBody');
  if (!box) return;
  const m = S.user.minus;
  const busy = S.minusBusy ? '<p class="count-line"><i class="mj-busy"></i> Čitam Minus listu iz StoreFronta…</p>' : '';
  if (!m || !m.items) { minusOpNow(); box.innerHTML = (busy || '<p class="empty">Minus lista još nije učitana. Tapni osvježi gore desno.</p>') + minusOpCard(); return; }
  const items = m.items.slice().sort((a, b) => a.qty - b.qty);
  S.minusMap = minusTargets(items);
  minusOpNow();
  const ready = items.filter((x) => minusTarget(x));
  const decide = items.filter((x) => chainOf(x).length && !minusTarget(x));
  const unread = items.filter((x) => !chainOf(x).length && x.subsErr);
  const noSub = items.filter((x) => !chainOf(x).length && !x.subsErr);
  const hidden = (m.other || []).length;
  const cut = m.total > 300 ? m.total - 300 : 0;
  box.innerHTML = `${busy}<p class="count-line">${items.length} ${plural(items.length, 'artikal', 'artikla', 'artikala')} u minusu · stanje ${esc(ageText(m.at))}</p>
    ${sandboxOn() ? `<p class="sandbox-note">TEST verzija: slanje se samo odigra (${esc((SIMS.find((x) => x[0] === simNow()) || SIMS[0])[1])}). Ništa ne ide u StoreFront. Promjena: Postavke → TEST.</p>` : ''}
    ${cut ? `<p class="att-from op-warnline">StoreFront ima ${m.total} redova na Minus listi, ovdje je prvih 300. Ostale pogledaj u StoreFrontu.</p>` : ''}
    ${hidden ? `<p class="att-from">Nije prikazano ${hidden} (šifre koje nisu od 7 cifara, npr. setovi): ${esc(m.other.join(', '))}. Njih uradi u StoreFrontu.</p>` : ''}
    ${minusOpCard()}
    ${minusPlan(items)}
    ${unread.length ? `<section class="mj-sec"><div class="sec-head"><h2>Zamjene nisu pročitane</h2><small>${unread.length}</small></div>
      <p class="att-from op-warnline">StoreFront nije odgovorio za zamjenske šifre ovih artikala. To ne znači da zamjene nema. Osvježi listu.</p>
      <div class="list">${unread.map(minusRow).join('')}</div></section>` : ''}
    ${decide.length ? `<section class="mj-sec"><div class="sec-head"><h2>Treba tvoja odluka</h2><small>${decide.length}</small></div>
      <div class="mp-step">${decide.map(minusDecideRow).join('')}</div></section>` : ''}
    ${ready.length ? `<section class="mj-sec"><div class="sec-head"><h2>Spremno za ispravku</h2><small>${ready.length}</small></div>
      <div class="list">${ready.map(minusRow).join('')}</div></section>` : ''}
    <section class="mj-sec"><div class="sec-head"><h2>Bez zamjene</h2><small>${noSub.length}</small></div>
      <p class="att-from">Pravilo 6.02: provjeri neprihvaćene dostave, pronađi uzrok, prebroji i u komentar upiši šta je provjereno.</p>
      ${noSub.length ? `<div class="list">${noSub.map(minusRow).join('')}</div>` : '<p class="empty">Nema.</p>'}</section>`;
}

// ------------------------------------------------- an Excel attachment of a news article

const ATT_SHOWN = 150;

/** Which columns hold what: the article number (7 digits in most rows), its name, the store, quantity, reason. */
function prepAttachment(a) {
  const rows = a.rows.filter((r) => Array.isArray(r)).map((r) => r.map((c) => String(c == null ? '' : c)));
  const isNum = (c) => /^-?\d+([.,]\d+)?(E-?\d+)?$/i.test(c);
  let h = 0;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    if (rows[i].filter((c) => c && !isNum(c)).length >= 2) { h = i; break; }
  }
  const head = rows[h] || [];
  const data = rows.slice(h + 1);
  const width = Math.max(head.length, ...data.slice(0, 50).map((r) => r.length), 0);
  const find = (re, not = []) => head.findIndex((c, i) => re.test(c) && !not.includes(i));
  let art = -1, best = 0;
  for (let c = 0; c < width; c++) {
    const n = data.filter((r) => /^\d{7}$/.test((r[c] || '').trim())).length;
    const bonus = /artic|artik|material/i.test(head[c] || '') ? 0.5 : 0;
    if (n + bonus > best) { best = n + bonus; art = c; }
  }
  if (best < Math.max(1, data.length * 0.3)) art = -1;
  let name = find(/short text|naziv|opis|descr|^text|^name|article name|artikal naziv/i, [art]);
  if (name < 0 && art >= 0) name = head.findIndex((c, i) => i > art && data.slice(0, 30).filter((r) => r[i] && !isNum(r[i])).length > 15);
  const site = find(/^(site|store|prodavnica|prodavaonica|trgovina|plant|lokacija)$/i);
  const qty = find(/quant|količ|kolic|^qty|pcs|^kom/i);
  const why = find(/reason|razlog/i);
  // the employee's own store: from the customer orders (their numbers start with it: #7X704…)
  const o = S.user.orders && S.user.orders.list && S.user.orders.list[0];
  const m = o && /^#?\d([A-Z]\d{3})/.exec(o.no || '');
  const sites = site >= 0 ? new Set(data.map((r) => (r[site] || '').trim())) : new Set();
  const mine = m && sites.has(m[1]) ? m[1] : '';
  return { ...a, head, data, art, name, site, qty, why, mine };
}

window.onAttachment = () => {
  let a = null;
  try { a = JSON.parse(A.readText('attachment.json') || 'null'); } catch (e) { a = null; }
  if (!a || !Array.isArray(a.rows) || !a.rows.length) { toast('Prilog se ne može prikazati.'); return; }
  S.att = prepAttachment(a);
  S.attF = { site: S.att.mine ? 'mine' : 'all', kind: 'all', q: '', table: false, more: false };
  renderAttach();
  go('attach');
};

function attRows() {
  const A2 = S.att, f = S.attF;
  const q = f.q.trim().toLowerCase();
  return A2.data.filter((r) => {
    if (f.site === 'mine' && A2.site >= 0 && (r[A2.site] || '').trim() !== A2.mine) return false;
    const num = A2.art >= 0 ? (r[A2.art] || '').trim() : '';
    if (f.kind === 'ord' && !(num && ordersOf(num).length)) return false;
    if (f.kind === 'plan' && !(num && S.index.byNum.has(num))) return false;
    return !q || r.some((c) => String(c).toLowerCase().includes(q));
  });
}

function attRow(r) {
  const A2 = S.att;
  const num = A2.art >= 0 ? (r[A2.art] || '').trim() : '';
  const bits = [
    A2.qty >= 0 && r[A2.qty] ? `${esc(A2.head[A2.qty] || 'Količina')}: ${esc(r[A2.qty])}` : '',
    A2.site >= 0 && S.attF.site === 'all' && r[A2.site] ? esc(r[A2.site]) : '',
    A2.why >= 0 && r[A2.why] ? esc(r[A2.why]) : '',
  ].filter(Boolean).join(' · ');
  const line = bits ? `<span class="store-line">${bits}</span>` : '';
  if (/^\d{7}$/.test(num) && S.index.byNum.has(num)) return itemRow(num, { sub: line });
  const nm = A2.name >= 0 ? r[A2.name] : '';
  return `<div class="item item-static">${num ? sfThumb(num) : `<span class="thumb">${icon('box')}</span>`}<span class="item-main">
    <span class="code">${esc(num || r.filter(Boolean).slice(0, 1).join(''))}</span><span class="item-name">${esc(nm) || 'Bez naziva'}</span>
    <span class="pills">${num ? '<span class="pill pill-muted">Nije u tvojim planogramima</span>' : ''}${num && ordersOf(num).length ? '<span class="pill pill-order">Naručio kupac</span>' : ''}</span>${line}</span></div>`;
}

function renderAttach() {
  const A2 = S.att, f = S.attF;
  if (!A2) return;
  $('#attachTitle').textContent = A2.name || 'Prilog';
  const list = attRows();
  const inSite = (r) => !(f.site === 'mine' && A2.site >= 0 && (r[A2.site] || '').trim() !== A2.mine);
  const base = A2.data.filter(inSite);
  const numOf = (r) => (A2.art >= 0 ? (r[A2.art] || '').trim() : '');
  const nOrd = base.filter((r) => numOf(r) && ordersOf(numOf(r)).length).length;
  const nPlan = base.filter((r) => numOf(r) && S.index.byNum.has(numOf(r))).length;
  const siteChips = A2.site >= 0 && A2.mine
    ? `<div class="chips">${[['mine', `Moja prodavnica (${esc(A2.mine)})`], ['all', `Sve prodavnice (${A2.data.length})`]].map(([k, t]) => `<button class="chip" type="button" aria-pressed="${f.site === k}" data-att-site="${k}">${t}</button>`).join('')}</div>` : '';
  const kindChips = A2.art >= 0
    ? `<div class="chips">${[['all', `Sve linije ${base.length}`], ['ord', `Naručio kupac ${nOrd}`], ['plan', `U mojim planogramima ${nPlan}`]].map(([k, t]) => `<button class="chip" type="button" aria-pressed="${f.kind === k}" data-att-kind="${k}">${t}</button>`).join('')}</div>` : '';
  const shown = f.more ? list : list.slice(0, ATT_SHOWN);
  const body = f.table || A2.art < 0
    ? `<div class="att-table"><table><thead><tr>${A2.head.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${shown.map((r) => `<tr>${A2.head.map((_, i) => `<td>${esc(r[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<div class="list">${shown.map(attRow).join('')}</div>`;
  $('#attachBody').innerHTML = `
    ${A2.title ? `<p class="att-from">Iz vijesti: <b>${esc(A2.title)}</b></p>` : ''}
    <div class="att-tools">
      <input class="set-input" id="attQ" type="search" value="${esc(f.q)}" placeholder="Traži broj ili naziv" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Traži u prilogu">
      ${siteChips}${kindChips}
      ${A2.art >= 0 ? `<button class="text-btn" type="button" data-att-table>${f.table ? 'Prikaži kao listu' : 'Prikaži kao tabelu'}</button>` : ''}
    </div>
    ${list.length ? body : '<p class="empty">Nema linija za ovaj izbor.</p>'}
    ${list.length > ATT_SHOWN ? `<button class="mj-more" type="button" data-att-more>${f.more ? 'Prikaži manje' : `Prikaži još ${list.length - ATT_SHOWN}`}</button>` : ''}`;
  const q = $('#attQ');
  q.addEventListener('input', debounce(() => { S.attF.q = q.value; S.attF.more = false; renderAttach(); const n = $('#attQ'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 200));
}

function onAttachClick(ev) {
  const t = ev.target.closest('button, [data-num]');
  if (!t) return;
  if (t.dataset.attSite) { S.attF.site = t.dataset.attSite; S.attF.more = false; renderAttach(); return; }
  if (t.dataset.attKind) { S.attF.kind = t.dataset.attKind; S.attF.more = false; renderAttach(); return; }
  if ('attTable' in t.dataset) { S.attF.table = !S.attF.table; renderAttach(); return; }
  if ('attMore' in t.dataset) { S.attF.more = !S.attF.more; renderAttach(); return; }
  if (t.dataset.num) openItem(t.dataset.num, { via: 'attachment' });
}

function renderNews() {
  const box = $('#newsWrap');
  const st = S.user.mj;
  const busy = S.mj.busy;
  // what the screen shows is always the last good read; the line says how old it is and what is going on now
  const ERR = { offline: 'Nema internet veze', error: 'MYJYSK nije odgovorio', login: 'Sesija je istekla' };
  const err = !busy && S.mj.err && ERR[S.mj.err] ? `<b class="mj-err">${ERR[S.mj.err]}</b> · ` : '';
  const when = st && st.at ? `${busy ? 'Prikazano' : 'Zadnje osvježeno'} ${esc(ageText(st.at))}` : '';
  const stateLine = `<div class="mj-state"><span>${busy ? `<i class="mj-busy"></i>Osvježavam iz MYJYSK…${when ? ` <small>${when}</small>` : ''}` : `${err}${when}${when && cfg().mj && !err ? ' · samo se osvježi u 8:00' : ''}`}</span>${busy ? '' : '<button class="text-btn" type="button" data-mj="refresh">Osvježi</button>'}</div>`;
  const login = st && st.login
    ? `<button class="orders-bar" type="button" data-mj="login">${icon('info')}<span><b>Prijavi se ponovo u MYJYSK</b><small>Prijava je istekla, pa se zadaci i vijesti ne mogu osvježiti.</small></span><span class="go">Prijava</span></button>`
    : '';
  if (!st || !st.at) {
    box.innerHTML = `${stateLine}${login}<div class="mj-intro"><h3>Zadaci i vijesti iz MYJYSK</h3>
      <p>Tvoji zadaci, zadaci prodavnice, vijesti i status sistema na jednom mjestu. Učitavaju se s tvojom prijavom u MYJYSK, svako jutro u 8:00 same od sebe.</p>
      <button class="btn btn-primary btn-block" type="button" data-mj="login">Prijavi se i učitaj</button></div>`;
    return;
  }
  const now = Date.now();
  const mine = news.myTasks(st, mjMe());
  const overMine = mine.filter((t) => t.over).length;
  const loc = st.loc.filter((t) => !t.done);
  const locOpen = loc.filter((t) => !t.over), locOver = loc.filter((t) => t.over);
  const locShown = (S.mj.loc === 'over' ? locOver : S.mj.loc === 'all' ? loc : locOpen).slice().sort(news.byDue);
  const newsShown = S.mj.more ? st.news : st.news.slice(0, NEWS_SHOWN);
  box.innerHTML = `${stateLine}${login}
  ${arBar()}
  ${impSection(st)}
  <section class="mj-sec"><div class="sec-head"><h2>Za mene</h2><small>${mine.length}${overMine ? ` · ${overMine} isteklo` : ''}</small></div>
    ${mine.length ? `<div class="list">${mine.map((t) => taskRow(st, t, { role: true })).join('')}</div>` : '<p class="empty">Nema otvorenih zadataka za tebe.</p>'}</section>
  <section class="mj-sec"><div class="sec-head"><h2>Vijesti</h2><small>${st.newsTotal > st.news.length ? `zadnjih ${st.news.length} od ${st.newsTotal}` : st.news.length}</small></div>
    ${st.news.length ? `<div class="list">${newsShown.map((a) => newsRow(st, a)).join('')}${st.news.length > NEWS_SHOWN ? `<button class="mj-more" type="button" data-mj="more">${S.mj.more ? 'Prikaži manje' : `Prikaži još ${st.news.length - NEWS_SHOWN}`}</button>` : ''}</div>` : '<p class="empty">Nema vijesti.</p>'}</section>
  <section class="mj-sec"><div class="sec-head"><h2>Zadaci lokacije</h2><small>${loc.length}</small></div>
    <div class="chips">${[['open', `Otvoreni ${locOpen.length}`], ['over', `Istekli ${locOver.length}`], ['all', 'Svi']].map(([k, t]) => `<button class="chip" type="button" aria-pressed="${S.mj.loc === k}" data-mj="loc-${k}">${t}</button>`).join('')}</div>
    ${locShown.length ? `<div class="list">${locShown.map((t) => taskRow(st, t, { role: true })).join('')}</div>` : '<p class="empty">Nema zadataka ovdje.</p>'}</section>`;
}

const IMP_SHOWN = 6;
const KIND = { plan: 'Planogram', upd: 'Ažuriranje koncepta', concept: 'Koncept', sys: 'Status sistema' };
const MY_DEPT = '05';

function impItems(st) {
  const log = (S.user.planLog || []).map((x) => ({ ...x, fresh: (x.at || 0) > (st.viewedAt || 0) }));
  const imp = (st.imp || []).map((x) => ({ ...x, fresh: news.isNew(st, x.id) }));
  return [...log, ...imp].sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.fresh - a.fresh));
}

function impRow(x) {
  const open = S.mj.open.has(x.id);
  const mine = news.deptNo(x.dept) === MY_DEPT;
  const meta = [KIND[x.kind] || '', x.kind === 'plan' ? '' : news.deptName(x.dept), news.dayText(x.date)].filter(Boolean).join(' · ');
  const go = x.kind === 'plan' && x.planId && S.plans.some((p) => p.id === x.planId)
    ? `<button class="text-btn" type="button" data-open-plan="${esc(x.planId)}" data-page="0">Otvori planogram</button>${S.user.changes[x.planId] ? ` · <button class="text-btn" type="button" data-changes="${esc(x.planId)}">Šta se promijenilo</button>` : ''}`
    : x.path ? `<button class="text-btn" type="button" data-mj-open="${esc(x.path)}">Otvori u MYJYSK</button>` : '';
  return `<div class="mj-news${x.kind === 'sys' ? ' is-sys' : ''}"><button class="mj-row" type="button" data-mj-x="${esc(x.id)}" aria-expanded="${open}">
    <span class="mj-main"><span class="mj-title">${x.fresh ? '<span class="mj-new">NOVO</span>' : ''}${esc(x.title)}</span><span class="mj-meta">${esc(meta)}${mine ? ' · <b class="mj-mine">tvoj odjel</b>' : ''}</span></span>
  </button>${open ? `<div class="mj-text">${esc(x.text) || esc(impHint(x))}${go ? `<br>${go}` : ''}</div>` : ''}</div>`;
}

/** What to say when an entry has no text of its own. */
function impHint(x) {
  if (x.kind === 'concept') return `Koncept je ažuriran ${news.dayText(x.date)}. Šta je tačno novo, piše u članku.`;
  if (x.kind === 'plan') return 'Planogram je preuzet i zamijenio stari.';
  return 'Više detalja je u članku.';
}

function impSection(st) {
  const all = impItems(st);
  if (!all.length) return '';
  const shown = S.mj.impMore ? all : all.slice(0, IMP_SHOWN);
  const fresh = all.filter((x) => x.fresh).length;
  return `<section class="mj-sec"><div class="sec-head"><h2>Važno</h2><small>${fresh ? `${fresh} novo` : 'koncept, planogrami, sistem'}</small></div>
    <div class="list">${shown.map(impRow).join('')}${all.length > IMP_SHOWN ? `<button class="mj-more" type="button" data-mj="imp-more">${S.mj.impMore ? 'Prikaži manje' : `Prikaži još ${all.length - IMP_SHOWN}`}</button>` : ''}</div>
    ${mjOn() ? '<button class="text-btn" type="button" data-plcheck>Provjeri nove planograme</button>' : ''}</section>`;
}

function onNewsClick(t) {
  if (t.dataset.mjOpen) { try { A.myjyskOpen(t.dataset.mjOpen); } catch (e) { /* older shell */ } return; }
  if (t.dataset.mjX) {
    const id = t.dataset.mjX;
    if (!S.mj.open.delete(id)) S.mj.open.add(id);
    renderNews();
    return;
  }
  const a = t.dataset.mj;
  if (a === 'ar') { openAr(); return; }
  if (a === 'refresh') refreshMyjysk(false);
  else if (a === 'login') refreshMyjysk(true);
  else if (a === 'more') { S.mj.more = !S.mj.more; renderNews(); }
  else if (a === 'imp-more') { S.mj.impMore = !S.mj.impMore; renderNews(); }
  else if (a.startsWith('loc-')) { S.mj.loc = a.slice(4); renderNews(); }
}


// ------------------------------------------------ StoreFront jobs: stock, best sellers, SM/DM (assets/store-task.js)
//
// Each job runs in a hidden StoreFront page with the employee's own sign-in and answers through window.onStoreTask.

/**
 * The employee's own department in StoreFront's terms: the product groups (e.g. 50101 Svijećnjaci) of the articles in
 * his planograms whose title starts with the department number ("05 Homeware"). StoreFront's group 5 also holds
 * cleaning, laundry and storage (other departments); old articles (21/81) that left the planogram are still in these
 * groups, so they are found too. Learned once from StoreFront and kept; the employee can leave groups out.
 */
function deptPlans() {
  const code = String(cfg().dept || '05');
  return S.plans.filter((p) => String(p.title || core.planTitle(p.plan) || '').trim().startsWith(code));
}
const deptKey = () => deptPlans().map((p) => p.key || p.id).sort().join('|');
function deptNums() {
  const nums = new Set();
  for (const p of deptPlans()) for (const [n, it] of Object.entries(p.plan.items)) if (it.oc.length || it.rw.length) nums.add(n);
  return [...nums];
}
/** The kept groups for the planograms now on the phone, or null (not learned yet). */
function deptGroups() {
  const g = S.user.deptGroups;
  return g && g.key === deptKey() && Array.isArray(g.groups) ? g.groups : null;
}
/** Groups that count: seen at least twice in the planogram (one stray article does not make a group his). */
const deptUsed = () => (deptGroups() || []).filter((x) => x.n >= 2 && !(cfg().grpOff || {})[x.id]);
const deptArg = () => { const u = deptUsed(); return u.length ? { cats: u.map((x) => x.id) } : {}; };
const deptName = () => { const p = deptPlans()[0]; return p ? String(p.title || core.planTitle(p.plan)) : `grupa ${cfg().group || '5'}`; };
const deptSig = () => deptUsed().map((x) => x.id).join(',');

/** Learns the department's groups (once per set of planograms), then runs next(). */
S.deptWait = [];
function withDept(next) {
  if (deptGroups() || !deptPlans().length) { next(); return; }
  S.deptWait.push(next);
  if (S.deptBusy) return; // already being learned: run with the others when it is there
  S.deptBusy = true;
  const done = () => { S.deptBusy = false; const w = S.deptWait.splice(0); for (const f of w) f(); };
  const ok = stCall({ mode: 'groups', nums: deptNums() }, (r) => {
    if (r.how === 'ok' && r.res && Array.isArray(r.res.groups)) {
      S.user.deptGroups = { key: deptKey(), at: Date.now(), groups: r.res.groups.slice(0, 80).map((x) => ({ id: String(x.id), title: String(x.title || ''), n: +x.n || 0 })) };
      saveUser();
    }
    done();
  });
  if (!ok) done();
}

/** The department's groups as chips: tap leaves one out (or takes it back). */
function deptChips(screen) {
  const g = deptGroups();
  if (!g) return '';
  const off = cfg().grpOff || {};
  const used = g.filter((x) => x.n >= 2);
  return `<details class="dept-groups"><summary>${esc(deptName())}: ${deptUsed().length} ${plural(deptUsed().length, 'grupa', 'grupe', 'grupa')} proizvoda iz StoreFronta</summary>
    <p>Grupe u kojima su artikli tvog planograma. Gledaju se i stari artikli tih grupa koji više nisu u planogramu. Tapni grupu da je izbaciš ili vratiš.</p>
    <div class="chips">${used.map((x) => `<button class="chip" type="button" aria-pressed="${!off[x.id]}" data-grp="${esc(x.id)}" data-grp-screen="${screen}">${esc(x.title || x.id)} <small>${x.n}</small></button>`).join('')}</div></details>`;
}

const stJobs = new Map();
let stSeq = 0;
function stCall(arg, cb) {
  if (!A.storeTask) return false;
  const job = `j${++stSeq}`;
  stJobs.set(job, cb);
  try { A.storeTask(JSON.stringify({ ...arg, job })); return true; } catch (e) { stJobs.delete(job); return false; }
}
window.onStoreTask = (r) => {
  const cb = r && stJobs.get(r.job);
  if (!cb) return;
  stJobs.delete(r.job);
  if (r.how === 'ok') { S.user.store = { ok: true }; }
  cb(r);
  if (r.res && r.res.dry) setTimeout(() => toast('TEST verzija: ništa nije spremljeno u StoreFront (samo odigrano).'), 1800);
};

/** What a status code means (StoreFront's own list). */
const ST_TEXT = {
  '01': 'novi artikal', '02': 'novi, samo online', '11': 'aktivan', '12': 'aktivan, samo raspodjela', '21': 'ukinut, ide na rasprodaju',
  '31': 'naručivanje privremeno blokirano', '32': 'rezervisan za prodaju', '41': 'nabavni artikal', '42': 'samo online', '51': 'direktna isporuka', '81': 'označen za brisanje',
};
const stText = (st) => ST_TEXT[st] || '';
const stPill = (st) => (st ? `<span class="pill ${st === '21' || st === '81' ? 'pill-warn' : 'pill-muted'}">Status ${esc(st)}${stText(st) ? `: ${esc(stText(st))}` : ''}</span>` : '');

// stock movements: what the store system calls them (SAP movement types)
const MOVE = { '251': 'Prodano', '252': 'Vraćeno', '101': 'Stiglo', '102': 'Storno prijema', '701': 'Inventura', '702': 'Inventura', '711': 'Inventura', '712': 'Inventura', '551': 'Otpis', '552': 'Storno otpisa', '311': 'Prenos', '641': 'Poslano', '643': 'Poslano' };
const moveName = (m) => MOVE[m.type] || (m.q > 0 ? 'Ulaz' : 'Izlaz');
const dm = (t) => { const d = new Date(t); return `${d.getDate()}.${d.getMonth() + 1}.`; };
const signed = (n) => (n > 0 ? `+${whole(n)}` : n < 0 ? `−${whole(-n)}` : '0');

/** One article's stock in the store, kept a few minutes: num -> { at, d, busy, err } */
S.stock = new Map();

function stockLoad(num, force = false) {
  const c = S.stock.get(num);
  if (c && (c.busy || (!force && c.d && Date.now() - c.at < 180000))) { stockPaint(num); return; }
  const ok = stCall({ mode: 'article', num }, (r) => {
    S.stock.set(num, { at: Date.now(), d: r.how === 'ok' ? r.res : (c && c.d) || null, err: r.how === 'ok' ? null : r.how });
    stockPaint(num);
    sfName(num, r.how === 'ok' && r.res && r.res.md ? r.res.md.name : '');
  });
  if (ok) S.stock.set(num, { ...(c || {}), busy: true });
  stockPaint(num);
}

/** An article the planogram names without a name: StoreFront's name, shown where "Bez naziva" stands. */
function sfName(num, name) {
  if (!name) return;
  const h = document.querySelector('#item .head .title');
  const chip = document.querySelector('#item .head [data-copy]');
  if (h && chip && chip.dataset.copy === num && /^Bez naziva$/.test(h.textContent.trim())) h.textContent = name;
}

function stockPaint(num) {
  for (const el of document.querySelectorAll(`[data-stock="${num}"]`)) el.innerHTML = stockHtml(num);
}

/** The stock over the last 30 days as a small line: the stock after each movement. */
function stockSpark(hist, now) {
  const from = now - 30 * 86400000;
  const pts = hist.filter((m) => m.t >= from).slice().reverse();
  if (pts.length < 2) return '';
  const first = hist.find((m) => m.t < from);
  const series = [{ t: from, v: first ? first.after : pts[0].after - pts[0].q }, ...pts.map((m) => ({ t: m.t, v: m.after })), { t: now, v: pts[pts.length - 1].after }];
  const max = Math.max(1, ...series.map((p) => p.v)), min = Math.min(0, ...series.map((p) => p.v));
  const X = (t) => ((t - from) / (now - from)) * 100, Y = (v) => 26 - ((v - min) / (max - min || 1)) * 24;
  let d = '';
  series.forEach((p, i) => { d += i ? ` H${X(p.t).toFixed(1)} V${Y(p.v).toFixed(1)}` : `M${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`; });
  return `<div class="stk-spark"><svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg><span>zaliha zadnjih 30 dana · najviše ${whole(max)}</span></div>`;
}

function stockHtml(num) {
  const open = `<button class="text-btn stk-open" type="button" data-store="${esc(num)}">${icon('link')}Otvori u StoreFrontu</button>`;
  if (!A.storeTask) return `<button class="btn btn-soft btn-block btn-small store-btn" type="button" data-store="${esc(num)}">${icon('link')}Cijena i zaliha u StoreFrontu</button>`;
  const c = S.stock.get(num) || {};
  const d = c.d;
  if (!d) {
    if (c.busy) return '<div class="stk stk-wait"><i class="mj-busy"></i>Učitavam zalihu iz StoreFronta…</div>';
    const why = c.err === 'login' ? 'StoreFront traži prijavu. Otvori ga jednom i prijavi se.' : c.err ? 'StoreFront nije odgovorio.' : '';
    return `<div class="stk stk-wait">${why ? `${esc(why)} <button class="text-btn" type="button" data-stock-retry="${esc(num)}">Pokušaj ponovo</button>` : ''}${open}</div>`;
  }
  const a = d.sd || {}, md = d.md || {};
  const unit = (a.unit || md.unit || '').toLowerCase();
  const st = md.st || a.st;
  const now = Date.now();
  // the history grouped by day and kind: "4.11. Prodano −3 → 6"
  const rows = [];
  for (const m of d.hist || []) {
    const key = `${dm(m.t)}|${moveName(m)}`;
    const last = rows[rows.length - 1];
    if (last && last.key === key) { last.q += m.q; continue; }
    if (rows.length >= 7) break;
    rows.push({ key, day: dm(m.t), name: moveName(m), q: m.q, after: m.after });
  }
  const sold30 = a.sold30 != null && a.sold30 !== 0 ? a.sold30 : d.sold30h;
  const facts = [
    a.sm != null ? `SM ${whole(a.sm)}` : '', a.dm ? `DM ${whole(a.dm)}` : '', a.cap ? `polica ${whole(a.cap)}` : '',
    md.price ? `${money(md.price)} ${esc(md.cur === 'BAM' ? 'KM' : md.cur || '')}` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="stk">
    <div class="stk-top">
      <div class="${(a.stock ?? 0) <= 0 ? 'is-bad' : ''}"><b>${whole(a.stock ?? 0)}</b><span>na stanju${unit ? ` (${esc(unit)})` : ''}</span></div>
      <div><b>${whole(a.free ?? a.stock ?? 0)}</b><span>slobodno</span></div>
      <div><b>${whole(d.sold7 || 0)}</b><span>prodano 7 dana</span></div>
      <div><b>${whole(sold30 || 0)}</b><span>prodano 30 dana</span></div>
    </div>
    ${facts || st ? `<p class="stk-facts">${st ? stPill(st) : ''}${facts ? `<span>${facts}</span>` : ''}</p>` : ''}
    ${d.recv ? `<p class="stk-line">Zadnja isporuka ${dm(d.recv.t)} (${signed(d.recv.q)})</p>` : ''}
    ${stockSpark(d.hist || [], now)}
    ${rows.length ? `<div class="stk-hist">${rows.map((x) => `<div><span>${esc(x.day)}</span><span>${esc(x.name)}</span><b class="${x.q < 0 ? 'is-out' : 'is-in'}">${signed(x.q)}</b><span>→ ${whole(x.after)}</span></div>`).join('')}</div>` : '<p class="stk-line">Nema promjena zalihe.</p>'}
    <div class="stk-foot"><small>${esc(ageText(c.at))}</small>${open}</div>
  </div>`;
}

// ------------------------------------------------ Najprodavanije: the department's best sellers

S.topDays = 7;
S.topBusy = false;

function renderTopBar() {
  const b = $('#topBar');
  if (!b) return;
  b.hidden = !S.plans.length || !A.storeTask;
  if (b.hidden) return;
  const t = S.user.top;
  b.innerHTML = `${icon('chart')}<span><b>Najprodavanije u odjelu</b><small>${t && t.list ? `${t.list.length} artikala · ${esc(ageText(t.at))}` : 'Zadnjih 7 i 30 dana, iz StoreFronta'}</small></span><span class="go">${t && t.list ? 'Otvori' : 'Učitaj'}</span>`;
}

function openTop() {
  go('top');
  renderTop();
  const t = S.user.top;
  if (!t || !t.list || t.dept !== deptSig() || !deptGroups() || Date.now() - t.at > 6 * 3600000) loadTop();
}

function loadTop() {
  if (S.topBusy) return;
  S.topBusy = true;
  renderTop();
  withDept(() => loadTop2());
}

function loadTop2() {
  const ok = stCall({ mode: 'top', cat: cfg().group || '5', deep: 40, ...deptArg() }, (r) => {
    S.topBusy = false;
    if (r.how === 'ok' && r.res && Array.isArray(r.res.list)) {
      S.user.top = { dept: deptSig(), at: Date.now(), list: r.res.list.slice(0, 80).map((x) => ({ num: x.num, name: x.name, st: x.st, unit: x.unit, stock: x.stock, sm: x.sm, sold30: x.sold30, sold7: x.sold7 })) };
      saveUser();
    } else {
      toast(r.how === 'login' ? 'StoreFront traži prijavu. Otvori artikal u StoreFrontu i prijavi se.' : 'Najprodavanije se nije moglo učitati. Pokušaj ponovo.');
    }
    renderTopBar();
    if (top().id === 'top') renderTop();
  });
  if (!ok) { S.topBusy = false; toast('Ova verzija aplikacije to ne zna. Ažuriraj je.'); renderTop(); }
}

function renderTop() {
  const box = $('#topBody');
  if (!box) return;
  const t = S.user.top;
  const days = S.topDays;
  const seg = `<div class="seg" role="tablist">${[7, 30].map((n) => `<button class="seg-btn" type="button" role="tab" aria-selected="${days === n}" data-top-days="${n}">${n} dana</button>`).join('')}</div>`;
  const head = `<div class="top-head">${seg}<button class="text-btn" type="button" data-top="refresh" ${S.topBusy ? 'disabled' : ''}>${icon('refresh')}Osvježi</button></div>`;
  const busy = S.deptBusy ? '<p class="count-line"><i class="mj-busy"></i> Prvi put: tražim u StoreFrontu grupe proizvoda tvog odjela (iz planograma)…</p>' : S.topBusy ? '<p class="count-line"><i class="mj-busy"></i> Čitam prodaju iz StoreFronta…</p>' : '';
  if (!t || !t.list) { box.innerHTML = `${head}${deptChips('top')}${busy}${S.topBusy ? '' : '<p class="empty">Još nije učitano.</p>'}`; return; }
  const key = days === 7 ? 'sold7' : 'sold30';
  const list = t.list.filter((x) => typeof x[key] === 'number' && x[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, 40);
  const rows = list.map((x, i) => {
    const sub = `<span class="top-sold"><b>${whole(x[key])}</b> prodano · na stanju ${whole(x.stock)}${x.st !== '11' ? ` · status ${esc(x.st)}` : ''}</span>`;
    const rank = `<span class="top-rank">${i + 1}</span>`;
    if (S.index.byNum.has(x.num)) return `<div class="top-row">${rank}${itemRow(x.num, { sub })}</div>`;
    return `<div class="top-row">${rank}<div class="item item-static">${sfThumb(x.num)}<span class="item-main"><span class="code">${esc(x.num)}</span><span class="item-name">${esc(x.name)}</span><span class="pills"><span class="pill pill-muted">Nije u tvojim planogramima</span></span>${sub}</span></div></div>`;
  });
  box.innerHTML = `${head}${deptChips('top')}${busy}
    <p class="count-line">${esc(deptName())} · ${days === 7 ? 'zadnjih 7 dana (iz povijesti zalihe najprodavanijih)' : 'zadnjih 30 dana (StoreFront)'} · ${esc(ageText(t.at))}</p>
    ${rows.length ? `<div class="list">${rows.join('')}</div>` : '<p class="empty">Ništa prodano u tom periodu.</p>'}`;
}

// ------------------------------------------------ Uskoro 21: articles StoreFront already says will be discontinued

// StoreFront keeps the coming status of an article and the date it is valid from (futurestatusCode). This screen
// reads it: first for the employee's own planogram (his department, the priority), or for any other product group
// he picks (e.g. Namještaj > Kancelarija). Sorted by the date, the soonest first, so the SM can go to 0 in time.
S.soon = { scope: 'dept', grp: '', grpTitle: '', busy: '', onlySm: false, pick: false };
const soonToday = () => Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const soonDays = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - soonToday()) / 86400000);
const soonDmy = (iso) => { const [y, m, d] = String(iso).split('-'); return `${d}.${m}.${y}`; };
const soonHas = (x) => x.sm > 0 || x.dm > 0;
/** The read that is shown: the department's or the chosen group's. */
function soonSrc() {
  const u = S.user.soon || {};
  return S.soon.scope === 'dept' ? u.dept : (u.grp || {})[S.soon.grp];
}

function renderSoonBar() {
  const b = $('#soonBar');
  if (!b) return;
  b.hidden = !S.plans.length || !A.storeTask;
  if (b.hidden) return;
  const d = (S.user.soon || {}).dept;
  let small = 'Šta StoreFront najavljuje za status 21, po datumu';
  if (d && d.list) {
    const near = d.list.filter((x) => soonDays(x.from) <= 60);
    const sm = near.filter(soonHas).length;
    small = d.list.length ? `${near.length} u narednih 60 dana${sm ? ` · ${sm} još ima SM/DM` : ''} · ${esc(ageText(d.at))}` : `Ništa najavljeno · ${esc(ageText(d.at))}`;
  }
  b.innerHTML = `${icon('info')}<span><b>Uskoro status 21</b><small>${small}</small></span><span class="go">${d && d.list ? 'Otvori' : 'Učitaj'}</span>`;
}

function openSoon() {
  go('soon');
  renderSoon();
  const s = soonSrc();
  if (S.soon.scope === 'dept' && (!s || !s.list || Date.now() - s.at > 6 * 3600000)) loadSoon();
}

function loadHier() {
  if (S.soon.busy) return;
  S.soon.busy = 'hier';
  renderSoon();
  const ok = stCall({ mode: 'hier' }, (r) => {
    S.soon.busy = '';
    if (r.how === 'ok' && r.res && Array.isArray(r.res.groups)) {
      S.user.hier = { at: Date.now(), groups: r.res.groups.slice(0, 40).map((g) => ({ id: String(g.id), title: String(g.title || ''), subs: (g.subs || []).slice(0, 60).map((x) => ({ id: String(x.id), title: String(x.title || '') })) })) };
      saveUser();
    } else toast(r.how === 'login' ? 'StoreFront traži prijavu.' : 'Grupe se nisu mogle učitati. Pokušaj ponovo.');
    if (top().id === 'soon') renderSoon();
  });
  if (!ok) { S.soon.busy = ''; toast('Ova verzija aplikacije to ne zna. Ažuriraj je.'); renderSoon(); }
}

function loadSoon() {
  if (S.soon.busy) return;
  const dept = S.soon.scope === 'dept';
  const nums = dept ? deptNums() : [];
  if (dept && !nums.length) { toast('Prvo dodaj planogram svog odjela.'); return; }
  if (!dept && !S.soon.grp) return;
  const grp = S.soon.grp, title = S.soon.grpTitle;
  S.soon.busy = 'load';
  renderSoon();
  const ok = stCall(dept ? { mode: 'soon', nums } : { mode: 'soon', cats: [grp] }, (r) => {
    S.soon.busy = '';
    if (r.how === 'ok' && r.res && Array.isArray(r.res.list)) {
      const list = r.res.list.slice(0, 1500).filter((x) => /^\d{7}$/.test(x.num) && /^\d{4}-\d{2}-\d{2}$/.test(x.from)).map((x) => ({
        num: x.num, name: String(x.name || ''), st: String(x.st || ''), fut: String(x.fut || ''), from: x.from, sm: +x.sm || 0, dm: +x.dm || 0,
        stock: +x.stock || 0, sold30: +x.sold30 || 0, cap: +x.cap || 0, price: +x.price || 0, unit: String(x.unit || 'KOM'), groupName: String(x.groupName || ''),
      }));
      const rec = { at: Date.now(), asked: +r.res.asked || 0, list };
      const u = S.user.soon || {};
      S.user.soon = dept ? { ...u, dept: { ...rec, key: deptKey() } } : { ...u, grp: { ...(u.grp || {}), [grp]: { ...rec, title } } };
      saveUser();
    } else {
      toast(r.how === 'login' ? 'StoreFront traži prijavu.' : r.err === 'timeout' ? 'StoreFront je predugo odgovarao. Izaberi manju grupu ili pokušaj ponovo.' : 'Lista se nije mogla učitati. Pokušaj ponovo.');
    }
    renderSoonBar();
    if (top().id === 'soon') renderSoon();
  });
  if (!ok) { S.soon.busy = ''; toast('Ova verzija aplikacije to ne zna. Ažuriraj je.'); renderSoon(); }
}

/** Puts SM (and, if asked, DM) to 0 for these articles, after the employee confirmed. */
async function soonZero(nums) {
  const s = soonSrc();
  const xs = ((s && s.list) || []).filter((x) => nums.includes(x.num) && soonHas(x));
  if (!xs.length || S.soon.busy) return;
  const one = xs.length === 1 ? xs[0] : null;
  const sm = xs.filter((x) => x.sm > 0).length, dm = xs.filter((x) => x.dm > 0).length;
  const how = await ask(one ? `${one.num}: SM na 0?` : `${xs.length} artikala: SM na 0?`,
    `${one ? `<p>${esc(one.name)}</p><p>Prelazi u status ${esc(one.fut)} ${soonDmy(one.from)}. Sada SM ${whole(one.sm)}, DM ${whole(one.dm)}.</p>` : `<p>SM ima ${sm}, DM ima ${dm} ${plural(dm, 'artikal', 'artikla', 'artikala')}.</p>`}
     <p>SM na 0: SAO ih više ne naručuje za dodatno izlaganje. DM ostavi dok su izloženi; skini ga kad uklonješ izložene komade (vraćaju se u online zalihu).</p><p>Sprema se odmah u StoreFront pod tvojom prijavom.</p>`,
    [{ label: 'SM na 0', kind: 'btn-primary', value: 'sm' }, ...(dm ? [{ label: 'SM i DM na 0', value: 'both' }] : []), { label: 'Odustani', value: '' }]);
  if (!how) return;
  const items = xs.filter((x) => x.sm > 0 || how === 'both').slice(0, 300).map((x) => ({ num: x.num, sm: 0, dm: how === 'both' ? 0 : x.dm }));
  if (!items.length) { toast('Ovi artikli nemaju SM.'); return; }
  const ok = stCall({ mode: 'smset', items }, (r) => {
    S.soon.busy = '';
    if (r.how === 'ok' && r.res) {
      const done = new Set(r.res.done || []);
      for (const x of s.list) if (done.has(x.num)) { const it = items.find((y) => y.num === x.num); x.sm = 0; x.dm = it.dm; }
      saveUser();
      const bad = (r.res.failed || []).length;
      toast(`Spremljeno: ${done.size} ${plural(done.size, 'artikal', 'artikla', 'artikala')}${bad ? `, nije prošlo ${bad}` : ''}.`);
    } else toast(r.how === 'login' ? 'StoreFront traži prijavu.' : 'StoreFront nije odgovorio do kraja. Osvježi listu da vidiš šta je spremljeno.');
    renderSoonBar();
    if (top().id === 'soon') renderSoon();
  });
  if (!ok) { toast('Ova verzija aplikacije to ne zna. Ažuriraj je.'); return; }
  S.soon.busy = 'send';
  renderSoon();
}

function soonPicker() {
  const h = S.user.hier;
  if (!h || !h.groups) {
    return S.soon.busy === 'hier' ? '<p class="count-line"><i class="mj-busy"></i> Čitam grupe proizvoda iz StoreFronta…</p>'
      : `<p class="empty">Izaberi odjel iz grupa proizvoda StoreFronta (npr. Namještaj › Kancelarija).</p><button class="btn btn-primary btn-block" type="button" data-soon="hier">${icon('list')}Učitaj grupe</button>`;
  }
  const done = (S.user.soon || {}).grp || {};
  const chip = (id, title, label) => `<button class="chip${done[id] ? ' is-read' : ''}" type="button" data-soon-grp="${esc(id)}" data-soon-title="${esc(title)}">${esc(label)}</button>`;
  return `<p class="count-line">Izaberi grupu. Manja grupa se čita brže (velika, kao cijeli Namještaj, i do 5 minuta).</p>
    ${h.groups.map((g) => `<details class="soon-grp"${String(S.soon.grp).startsWith(g.id) ? ' open' : ''}><summary>${esc(g.title)}</summary>
      <div class="chips">${chip(g.id, g.title, `Sve: ${g.title}`)}${g.subs.map((x) => chip(x.id, `${g.title} › ${x.title}`, x.title)).join('')}</div></details>`).join('')}`;
}

function soonRow(x, other) {
  const days = soonDays(x.from);
  const has = soonHas(x);
  const dis = S.soon.busy ? 'disabled' : '';
  return `<div class="soon-row${has && days <= 60 ? ' is-due' : ''}">
    <button class="soon-main" type="button" data-store="${esc(x.num)}">
      <span class="code">${esc(x.num)}<span class="pill pill-muted">Status ${esc(x.st)} → ${esc(x.fut)}</span>${x.sm > 0 ? `<span class="pill pill-warn">SM ${whole(x.sm)}</span>` : ''}${x.dm > 0 ? `<span class="pill pill-warn">DM ${whole(x.dm)}</span>` : ''}</span>
      <span class="item-name">${esc(x.name) || 'Bez naziva'}</span>
      <span class="sm-facts">Na stanju ${whole(x.stock)} · prodano 30 dana ${whole(x.sold30)}${x.price ? ` · ${money(x.price)} KM` : ''}${other && x.groupName ? ` · ${esc(x.groupName)}` : ''}</span>
    </button>
    ${has ? `<button class="chip soon-zero" type="button" data-soon-zero="${esc(x.num)}" ${dis} aria-label="${x.sm > 0 ? 'SM' : 'DM'} na 0">${x.sm > 0 ? 'SM' : 'DM'} 0</button>` : ''}
  </div>`;
}

function renderSoon() {
  const box = $('#soonBody');
  if (!box) return;
  const dept = S.soon.scope === 'dept';
  const dis = S.soon.busy ? 'disabled' : '';
  const seg = `<div class="seg" role="tablist">${[['dept', 'Moj odjel'], ['grp', 'Drugi odjel']].map(([v, t]) => `<button class="seg-btn" type="button" role="tab" aria-selected="${S.soon.scope === v}" data-soon-scope="${v}" ${dis}>${t}</button>`).join('')}</div>`;
  const intro = `<details class="sm-intro"><summary>Odakle je ovo?</summary>
    <p>StoreFront za svaki artikal unaprijed čuva budući status i datum od kada vrijedi. Ovdje su artikli kojima je najavljen status <b>21</b> (ukinut) ili <b>81</b>, poredani po datumu.</p>
    <p>SAO naručuje samo statuse 11, 12 i 41, pa nakon prelaska u 21 artikal više ne stiže. Prije toga SAO i dalje dopunjava policu i SM: spusti SM na 0 nekoliko sedmica prije datuma da ne ostane višak za rasprodaju. Smjernica: kad artikal pređe u 21, ukloni SM i DM.</p></details>`;
  if (!dept && (S.soon.pick || !S.soon.grp)) {
    box.innerHTML = `${seg}${intro}${soonPicker()}`;
    return;
  }
  const s = soonSrc();
  const busy = S.soon.busy === 'load' ? `<p class="count-line"><i class="mj-busy"></i> Čitam iz StoreFronta budući status svakog artikla… ${dept ? '(oko minutu)' : '(veća grupa i do 5 minuta)'}</p>`
    : S.soon.busy === 'send' ? '<p class="count-line"><i class="mj-busy"></i> Spremam u StoreFront…</p>' : '';
  const which = dept ? `${esc(deptName())} · artikli iz tvog planograma` : `<button class="text-btn" type="button" data-soon="pick" ${dis}>${esc(S.soon.grpTitle)} · Promijeni</button>`;
  if (!s || !s.list) {
    box.innerHTML = `${seg}${intro}<p class="count-line">${which}</p>${busy || `<button class="btn btn-primary btn-block" type="button" data-soon="load">${icon('refresh')}Učitaj iz StoreFronta</button>`}`;
    return;
  }
  const all = s.list.filter((x) => soonDays(x.from) >= -1);
  const list = S.soon.onlySm ? all.filter(soonHas) : all;
  const withSm = all.filter(soonHas);
  const near = withSm.filter((x) => soonDays(x.from) <= 60);
  const days = [];
  for (const x of list) { const d = days[days.length - 1]; if (d && d.from === x.from) d.xs.push(x); else days.push({ from: x.from, xs: [x] }); }
  const when = (n) => (n <= 0 ? 'danas' : n === 1 ? 'sutra' : `za ${n} ${plural(n, 'dan', 'dana', 'dana')}`);
  box.innerHTML = `${seg}${intro}
    <div class="top-head"><p class="count-line">${which}</p><button class="text-btn" type="button" data-soon="load" ${dis}>${icon('refresh')}Osvježi</button></div>
    ${busy}
    <p class="count-line">${all.length ? `${all.length} ${plural(all.length, 'artikal najavljen', 'artikla najavljena', 'artikala najavljeno')} · ${withSm.length} sa SM/DM` : 'Nijedan artikal nema najavljen status 21 ni 81.'} · pregledano ${whole(s.asked)} · ${esc(ageText(s.at))}</p>
    ${all.length ? `<div class="chips soon-filter"><button class="chip" type="button" data-soon="only" aria-pressed="${S.soon.onlySm}" ${dis}>Samo sa SM/DM</button></div>` : ''}
    ${near.length ? `<button class="btn btn-primary btn-block" type="button" data-soon="zero-near" ${dis}>SM/DM na 0 · narednih 60 dana (${near.length})</button>` : ''}
    ${days.map((d) => { const n = soonDays(d.from); return `<h3 class="soon-date${n <= 60 ? ' is-near' : ''}">${soonDmy(d.from)} <small>${when(n)} · ${d.xs.length}</small></h3><div class="soon-list">${d.xs.map((x) => soonRow(x, !dept)).join('')}</div>`; }).join('')}`;
}

function onSoonClick(t) {
  if (t.dataset.soonScope) { if (S.soon.busy) return; S.soon.scope = t.dataset.soonScope === 'grp' ? 'grp' : 'dept'; renderSoon(); const s = soonSrc(); if (S.soon.scope === 'dept' && !(s && s.list)) loadSoon(); return; }
  if (t.dataset.soonGrp) {
    if (S.soon.busy) return;
    S.soon.grp = t.dataset.soonGrp; S.soon.grpTitle = t.dataset.soonTitle || t.dataset.soonGrp; S.soon.pick = false;
    renderSoon();
    if (!(soonSrc() && soonSrc().list)) loadSoon();
    return;
  }
  if (t.dataset.soonZero) { soonZero([t.dataset.soonZero]); return; }
  const a = t.dataset.soon;
  if (a === 'hier') loadHier();
  else if (a === 'pick') { S.soon.pick = true; renderSoon(); }
  else if (a === 'load') loadSoon();
  else if (a === 'only') { S.soon.onlySm = !S.soon.onlySm; renderSoon(); }
  else if (a === 'zero-near') { const s = soonSrc(); soonZero(((s && s.list) || []).filter((x) => soonHas(x) && soonDays(x.from) <= 60 && soonDays(x.from) >= -1).map((x) => x.num)); }
}

// ------------------------------------------------ SM i DM: values of the department's articles that go out (21, 81)

S.sm = { busy: '', edit: {}, move: {}, st: ['21', '81'], scope: 'dept' };
// "Vrt": the whole garden assortment of StoreFront (category 9: garden furniture, garden cushions, parasols, ...),
// every status, every article with an SM or a DM value; for putting the season's values to 0 at once
const GARDEN_CAT = '9';
const GARDEN_ST = ['01', '02', '11', '12', '21', '31', '32', '41', '42', '51', '81'];
const smGarden = () => S.sm.scope === 'garden';
/** The list the SM screen works on: the department's 21/81 or the garden's. */
const smData = () => (smGarden() ? S.user.smGarden : S.user.smdm);
function setSmData(v) { if (smGarden()) S.user.smGarden = v; else S.user.smdm = v; }

/** What moving an old number's SM/DM to its replacement sends: the old one to 0, the new one at least as much. */
function smMoveItems(x) {
  return [{ num: x.num, sm: 0, dm: 0 }, { num: x.succ.num, sm: Math.max(x.succ.sm, x.sm), dm: Math.max(x.succ.dm, x.dm) }];
}
/** A replacement that would be left without the old number's SM/DM. */
const smNeedsMove = (x) => !!x.succ && (x.succ.sm < x.sm || x.succ.dm < x.dm);

function renderSmBar() {
  const b = $('#smBar');
  if (!b) return;
  b.hidden = !S.plans.length || !A.storeTask;
  if (b.hidden) return;
  const m = S.user.smdm;
  b.innerHTML = `${icon('list')}<span><b>SM i DM · odjel (21 i 81) i vrt</b><small>${m && m.list ? `${m.list.length} ${plural(m.list.length, 'artikal', 'artikla', 'artikala')} još ima SM ili DM · ${esc(ageText(m.at))}` : 'Smjernica: kad je artikal ukinut, ukloni SM i DM'}</small></span><span class="go">${m && m.list ? 'Otvori' : 'Učitaj'}</span>`;
}

function openSm() {
  S.sm.edit = {};
  S.sm.move = {};
  S.sm.result = null;
  go('smdm');
  renderSm();
  smLoadIfOld();
}

function smLoadIfOld() {
  const m = smData();
  if (smGarden()) { if (!m || !m.list || Date.now() - m.at > 10 * 60000) loadSm(); return; }
  if (!m || !m.list || m.dept !== deptSig() || !deptGroups() || Date.now() - m.at > 10 * 60000) loadSm(); // the last read is shown at once
}

function loadSm() {
  if (S.sm.busy) return;
  S.sm.busy = 'load';
  renderSm();
  if (smGarden()) loadSm2(); else withDept(() => loadSm2());
}

function loadSm2() {
  const garden = smGarden();
  const arg = garden ? { mode: 'smdm', cat: GARDEN_CAT, cats: [GARDEN_CAT], st: GARDEN_ST, nosucc: true } : { mode: 'smdm', cat: cfg().group || '5', st: S.sm.st, ...deptArg() };
  const ok = stCall(arg, (r) => {
    S.sm.busy = '';
    if (r.how === 'ok' && r.res && Array.isArray(r.res.list)) {
      const d = { v: 3, dept: garden ? 'vrt' : deptSig(), at: Date.now(), list: r.res.list.map((x) => ({ num: x.num, name: x.name, st: x.st, unit: x.unit, stock: x.stock, sm: x.sm, dm: x.dm, cap: x.cap, sold30: x.sold30, succ: x.succ && /^\d{7}$/.test(x.succ.num) ? { num: x.succ.num, st: String(x.succ.st || ''), sm: +x.succ.sm || 0, dm: +x.succ.dm || 0, stock: +x.succ.stock || 0 } : null })) };
      if (garden) S.user.smGarden = d; else S.user.smdm = d;
      saveUser();
    } else {
      toast(r.how === 'login' ? 'StoreFront traži prijavu.' : 'SM vrijednosti se nisu mogle učitati. Pokušaj ponovo.');
    }
    renderSmBar();
    if (top().id === 'smdm') renderSm();
  });
  if (!ok) { S.sm.busy = ''; toast('Ova verzija aplikacije to ne zna. Ažuriraj je.'); renderSm(); }
}

function smSend(items) {
  if (!items.length || S.sm.busy) return;
  const garden = smGarden();
  const ok = stCall({ mode: 'smset', items }, (r) => {
    S.sm.busy = '';
    const m = garden ? S.user.smGarden : S.user.smdm;
    const want = new Map(items.map((x) => [x.num, x]));
    if (r.how === 'ok' && r.res) {
      const done = new Set(r.res.done || []);
      if (m && m.list) {
        m.list = m.list.map((x) => (done.has(x.num) ? { ...x, sm: want.get(x.num).sm, dm: want.get(x.num).dm } : x)).filter((x) => x.sm > 0 || x.dm > 0);
        m.at = Date.now();
      }
      for (const n of done) { delete S.sm.edit[n]; delete S.sm.move[n]; }
      S.sm.result = { done: done.size, failed: r.res.failed || [] };
      saveUser();
    } else {
      S.sm.result = { done: 0, failed: [], err: r.how === 'bad' ? 'Ova verzija aplikacije ne zna spremiti te artikle. Ažuriraj je.' : r.how === 'login' ? 'StoreFront traži prijavu. Ništa nije promijenjeno ili samo dio; učitaj listu ponovo.' : 'StoreFront nije odgovorio do kraja. Učitaj listu ponovo da vidiš šta je promijenjeno.' };
    }
    renderSmBar();
    if (top().id === 'smdm') renderSm();
  });
  if (!ok) { toast('Ova verzija aplikacije to ne zna. Ažuriraj je.'); return; }
  S.sm.busy = 'send';
  renderSm();
}

function renderSm() {
  const box = $('#smBody');
  if (!box) return;
  const m = smData();
  const garden = smGarden();
  const list = (m && m.list) || [];
  const busy = S.deptBusy ? '<p class="count-line"><i class="mj-busy"></i> Prvi put: tražim u StoreFrontu grupe proizvoda tvog odjela (iz planograma)…</p>' : S.sm.busy === 'load' ? '<p class="count-line"><i class="mj-busy"></i> Čitam SM vrijednosti iz StoreFronta…</p>'
    : S.sm.busy === 'send' ? '<p class="count-line"><i class="mj-busy"></i> Spremam u StoreFront…</p>' : '';
  const res = S.sm.result;
  const resLine = res ? (res.err ? `<p class="ar-err">${esc(res.err)}</p>`
    : `<p class="sm-ok">Spremljeno u StoreFront: ${res.done} ${plural(res.done, 'artikal', 'artikla', 'artikala')}.${res.failed.length ? ` Nije prošlo: ${res.failed.map((f) => esc(f.num)).join(', ')}.` : ''}</p>`) : '';
  const intro = `<details class="sm-intro"><summary>Šta su SM i DM i šta kaže smjernica?</summary>
    <p><b>SM</b> (Sales Machine): artikli izloženi dugoročno izvan planograma (Powerline, endframe i slično). SM ulazi u SAO prijedlog narudžbe, da ta ekspozicija bude puna.</p>
    <p><b>DM</b> (Display Model): koliko komada je izloženo. Izloženi komadi se skidaju sa online zalihe trgovine (na JYSK.ba piše „Pogledajte proizvod u prodavnici“).</p>
    <p>Smjernica „Smjernice za vrijednosti SM/DM“ (MYJYSK → Attractive Store): <b>kad artikal pređe na status 21 (ukinut), uklonite SM i DM vrijednosti</b>. Svaki dan: u StoreFrontu filtrirajte ukinute artikle sa SM/DM i uklonite vrijednosti starih artikala. Vrijednosti unesene prije 22:00 ulaze u prijedlog narudžbe sljedećeg dana. Isto važi i za 81 (označen za brisanje).</p></details>`;
  const edits = [...Object.entries(S.sm.edit).filter(([n, e]) => { const x = list.find((y) => y.num === n); return x && !S.sm.move[n] && ((e.sm ?? x.sm) !== x.sm || (e.dm ?? x.dm) !== x.dm); }), ...Object.keys(S.sm.move).filter((n) => list.some((y) => y.num === n && y.succ))];
  const dis = S.sm.busy ? 'disabled' : '';
  const rows = list.map((x) => {
    const mv = !!(S.sm.move[x.num] && x.succ);
    const e = mv ? { sm: 0, dm: 0 } : S.sm.edit[x.num] || {};
    const v = e.sm ?? x.sm, w = e.dm ?? x.dm;
    const changed = mv || +v !== x.sm || +w !== x.dm;
    const to = mv ? smMoveItems(x)[1] : null;
    const succ = x.succ ? `<div class="sm-succ"><span>Zamjena: <b>${esc(x.succ.num)}</b> (status ${esc(x.succ.st)}${stText(x.succ.st) ? `, ${esc(stText(x.succ.st))}` : ''}) · SM ${whole(x.succ.sm)} · DM ${whole(x.succ.dm)} · na stanju ${whole(x.succ.stock)}</span>
        ${mv ? `<span class="sm-move-on">Prebacuje se: zamjena dobija SM ${whole(to.sm)}, DM ${whole(to.dm)}; stari broj na 0</span>` : ''}
        ${smNeedsMove(x) || mv ? `<button class="text-btn" type="button" data-sm-move="${esc(x.num)}" ${S.sm.busy ? 'disabled' : ''}>${mv ? 'Ne prebacuj' : 'Prebaci SM/DM na zamjenu'}</button>` : ''}</div>` : '';
    return `<div class="sm-row${changed ? ' is-changed' : ''}">
      <div class="sm-main"><span class="code">${esc(x.num)}</span><span class="item-name">${esc(x.name)}</span>
        <span class="pills">${stPill(x.st)}${S.index.byNum.has(x.num) ? '<span class="pill">U planogramu</span>' : ''}</span>
        <span class="sm-facts">Na stanju ${whole(x.stock)} · prodano 30 dana ${whole(x.sold30)}</span></div>
      <label class="sm-edit"><span>SM</span><input type="number" inputmode="numeric" min="0" max="9999" value="${esc(v)}" data-sm-in="${esc(x.num)}" data-k="sm" ${dis}></label>
      <label class="sm-edit"><span>DM</span><input type="number" inputmode="numeric" min="0" max="9999" value="${esc(w)}" data-sm-in="${esc(x.num)}" data-k="dm" ${dis}></label>
      <button class="chip" type="button" data-sm-zero="${esc(x.num)}" ${dis} aria-label="SM i DM na 0">0</button>
      ${succ}
    </div>`;
  }).join('');
  const tabs = `<div class="chips sm-scope"><button class="chip" type="button" data-sm="scope" data-scope="dept" aria-pressed="${!garden}" ${dis}>Moj odjel · 21 i 81</button><button class="chip" type="button" data-sm="scope" data-scope="garden" aria-pressed="${garden}" ${dis}>Vrt · sve</button></div>`;
  const head = garden
    ? `${tabs}${busy}${resLine}`
    : `<button class="orders-bar au-master" type="button" data-au-master>${icon('chart')}<span><b>Master provjera</b><small>Sve SM i DM vrijednosti odjela: ukinuti sa SM/DM i zamjene, SM bez prodaje, najprodavaniji bez SM</small></span><span class="go">Pokreni</span></button>${tabs}${intro}${deptChips('smdm')}${busy}${resLine}`;
  const what = garden ? `Vrt (vrtni namještaj, vrtni jastuci, suncobrani…) · svi statusi` : `${esc(deptName())} · status ${S.sm.st.join(' i ')}`;
  const none = garden ? '<p class="empty">Nijedan vrtni artikal nema SM ni DM.</p>' : '<p class="empty">Nijedan artikal sa statusom 21 ili 81 nema SM ni DM. Sve je po smjernici.</p>';
  box.innerHTML = `${head}
    <div class="top-head"><p class="count-line">${m ? `${what} · ${list.length} sa SM ili DM · ${esc(ageText(m.at))}` : ''}</p>
      <button class="text-btn" type="button" data-sm="reload" ${dis}>${icon('refresh')}Osvježi</button></div>
    ${list.length ? `<button class="btn btn-primary btn-block" type="button" data-sm="all0" ${dis}>${garden ? `Sve vrtne SM i DM na 0 (${list.length})` : `Ukloni SM i DM za sve (${list.length})`}</button>` : m && !S.sm.busy ? none : ''}
    ${rows ? `<div class="sm-list">${rows}</div>` : ''}
    ${edits.length ? `<div class="sm-save"><button class="btn btn-primary btn-block" type="button" data-sm="save" ${dis}>Spremi promjene (${edits.length})</button></div>` : ''}`;
}

async function onSmClick(t) {
  if (t.dataset.smZero) { S.sm.edit[t.dataset.smZero] = { sm: 0, dm: 0 }; delete S.sm.move[t.dataset.smZero]; S.sm.result = null; renderSm(); return; }
  if (t.dataset.smMove) { const n = t.dataset.smMove; if (S.sm.move[n]) delete S.sm.move[n]; else { S.sm.move[n] = true; delete S.sm.edit[n]; } S.sm.result = null; renderSm(); return; }
  const a = t.dataset.sm;
  const list = (smData() && smData().list) || [];
  if (a === 'scope') { if (S.sm.busy) return; S.sm.scope = t.dataset.scope === 'garden' ? 'garden' : 'dept'; S.sm.edit = {}; S.sm.move = {}; S.sm.result = null; renderSm(); smLoadIfOld(); return; }
  if (a === 'reload') { S.sm.result = null; loadSm(); return; }
  let items = [];
  let moves = 0;
  if (a === 'all0') {
    const need = list.filter(smNeedsMove);
    let how = 'zero';
    if (need.length) {
      how = await ask(`${need.length} ${plural(need.length, 'artikal ima', 'artikla imaju', 'artikala ima')} zamjenu bez SM/DM`,
        `<p>Stari broj (21/81) ima SM ili DM, a njegov novi broj (zamjena, npr. status 11 ili 12) nema. Ako samo ukloniš sa starog, ekspozicija novog broja se više neće dopunjavati.</p><p>Prebacivanje: novi broj dobija SM/DM starog (ako već ima više, ostaje njegov), stari ide na 0.</p>`,
        [{ label: `Prebaci na zamjene (${need.length}) i ukloni sa starih`, kind: 'btn-primary', value: 'move' }, { label: 'Samo ukloni sa starih', value: 'zero' }, { label: 'Odustani', value: '' }]);
      if (!how) return;
    }
    for (const x of list) {
      if (how === 'move' && smNeedsMove(x)) { items.push(...smMoveItems(x)); moves++; } else items.push({ num: x.num, sm: 0, dm: 0 });
    }
  }
  if (a === 'save') {
    for (const x of list) {
      if (S.sm.move[x.num] && x.succ) { items.push(...smMoveItems(x)); moves++; continue; }
      const e = S.sm.edit[x.num];
      if (e && ((e.sm ?? x.sm) !== x.sm || (e.dm ?? x.dm) !== x.dm)) items.push({ num: x.num, sm: e.sm ?? x.sm, dm: e.dm ?? x.dm });
    }
  }
  if (!items.length) return;
  const olds = items.length - moves;
  const zero = items.filter((x) => x.sm === 0 && x.dm === 0).length;
  const go2 = a === 'all0' && list.some(smNeedsMove) ? true : await ask(`Promijeniti SM/DM za ${olds} ${plural(olds, 'artikal', 'artikla', 'artikala')}?`,
    `<p>Promjena se odmah sprema u StoreFront pod tvojom prijavom.${zero ? smGarden() ? ` Za ${zero} vrtnih artikala SM i DM idu na 0: više ne ulaze u prijedlog narudžbe, a izloženi komadi se vraćaju u online zalihu.` : ` Za ${zero} se uklanjaju SM i DM, kako kaže smjernica za status 21: više ne ulaze u prijedlog narudžbe, a izloženi komadi se vraćaju u online zalihu.` : ''}${moves ? ` ${moves} ${plural(moves, 'zamjena dobija', 'zamjene dobijaju', 'zamjena dobija')} SM/DM starog broja.` : ''}</p>`,
    [{ label: 'Spremi u StoreFront', kind: 'btn-primary', value: true }, { label: 'Odustani', value: false }]);
  if (go2) smSend(items);
}

// ------------------------------------------------ Master provjera: every SM/DM value of the department checked

S.au = { busy: '', edit: {}, move: {}, result: null, open: new Set(['out']) };

function openAudit() {
  S.au.edit = {};
  S.au.move = {};
  S.au.result = null;
  go('audit');
  renderAudit();
  const a = S.user.audit;
  if (!a || !a.list || a.dept !== deptSig() || !deptGroups() || Date.now() - a.at > 30 * 60000) loadAudit();
}

const auKeep = (x) => ({ num: x.num, name: x.name, st: x.st, unit: x.unit, stock: +x.stock || 0, sm: +x.sm || 0, dm: +x.dm || 0, cap: +x.cap || 0, sold30: +x.sold30 || 0,
  succ: x.succ && /^\d{7}$/.test(x.succ.num) ? { num: x.succ.num, st: String(x.succ.st || ''), sm: +x.succ.sm || 0, dm: +x.succ.dm || 0, stock: +x.succ.stock || 0 } : null });

function loadAudit() {
  if (S.au.busy) return;
  S.au.busy = 'load';
  renderAudit();
  withDept(() => loadAudit2());
}

function loadAudit2() {
  const ok = stCall({ mode: 'audit', cat: cfg().group || '5', ...deptArg() }, (r) => {
    S.au.busy = '';
    if (r.how === 'ok' && r.res && Array.isArray(r.res.list)) {
      S.user.audit = { dept: deptSig(), at: Date.now(), list: r.res.list.slice(0, 800).map(auKeep), top: (r.res.top || []).slice(0, 40).map(auKeep) };
      saveUser();
    } else {
      toast(r.how === 'login' ? 'StoreFront traži prijavu.' : 'Provjera se nije mogla učitati. Pokušaj ponovo.');
    }
    if (top().id === 'audit') renderAudit();
  });
  if (!ok) { S.au.busy = ''; toast('Ova verzija aplikacije to ne zna. Ažuriraj je.'); renderAudit(); }
}

function auGroups() {
  const a = S.user.audit;
  return a && a.list ? smcheck.check(a.list, a.top, (n) => S.index.byNum.has(n)) : null;
}

function auRow(x, gid) {
  const dis = S.au.busy ? 'disabled' : '';
  const mv = !!(S.au.move[x.num] && x.succ);
  const e = mv ? { sm: 0, dm: 0 } : S.au.edit[x.num] || {};
  const v = e.sm ?? x.sm, w = e.dm ?? x.dm;
  const changed = mv || +v !== x.sm || +w !== x.dm;
  const to = mv ? smMoveItems(x)[1] : null;
  const facts = [`na stanju ${whole(x.stock)}`, `prodano 30 dana ${whole(x.sold30)}`, x.cap ? `polica ${whole(x.cap)}` : ''].filter(Boolean).join(' · ');
  const succ = gid === 'out' && x.succ ? `<div class="sm-succ"><span>Zamjena: <b>${esc(x.succ.num)}</b> (status ${esc(x.succ.st)}) · SM ${whole(x.succ.sm)} · DM ${whole(x.succ.dm)}</span>
      ${mv ? `<span class="sm-move-on">Prebacuje se: zamjena dobija SM ${whole(to.sm)}, DM ${whole(to.dm)}; stari broj na 0</span>` : ''}
      ${smNeedsMove(x) || mv ? `<button class="text-btn" type="button" data-au-move="${esc(x.num)}" ${dis}>${mv ? 'Ne prebacuj' : 'Prebaci SM/DM na zamjenu'}</button>` : ''}</div>` : '';
  return `<div class="sm-row${changed ? ' is-changed' : ''}">
    <div class="sm-main"><span class="code">${esc(x.num)}</span><span class="item-name">${esc(x.name)}</span>
      <span class="pills">${stPill(x.st)}${S.index.byNum.has(x.num) ? '<span class="pill">U planogramu</span>' : ''}</span>
      <span class="sm-facts">${facts}</span></div>
    <label class="sm-edit"><span>SM</span><input type="number" inputmode="numeric" min="0" max="9999" value="${esc(v)}" data-au-in="${esc(x.num)}" data-k="sm" ${dis}></label>
    <label class="sm-edit"><span>DM</span><input type="number" inputmode="numeric" min="0" max="9999" value="${esc(w)}" data-au-in="${esc(x.num)}" data-k="dm" ${dis}></label>
    <button class="chip" type="button" data-au-zero="${esc(x.num)}" ${dis} aria-label="SM i DM na 0">0</button>
    ${succ}
  </div>`;
}

/** Everything changed on the screen, as StoreFront takes it. */
function auItems() {
  const a = S.user.audit;
  if (!a) return [];
  const by = new Map([...a.list, ...(a.top || [])].map((x) => [x.num, x]));
  const items = [];
  for (const [n, x] of by) {
    if (S.au.move[n] && x.succ) { items.push(...smMoveItems(x)); continue; }
    const e = S.au.edit[n];
    if (e && ((e.sm ?? x.sm) !== x.sm || (e.dm ?? x.dm) !== x.dm)) items.push({ num: n, sm: e.sm ?? x.sm, dm: e.dm ?? x.dm });
  }
  return items;
}

function auSend(items) {
  if (!items.length || S.au.busy) return;
  const ok = stCall({ mode: 'smset', items }, (r) => {
    S.au.busy = '';
    if (r.how === 'ok' && r.res) {
      const done = new Set(r.res.done || []);
      const want = new Map(items.map((x) => [x.num, x]));
      const a = S.user.audit;
      if (a) {
        const upd = (x) => {
          let y = done.has(x.num) ? { ...x, sm: want.get(x.num).sm, dm: want.get(x.num).dm } : x;
          if (y.succ && done.has(y.succ.num)) y = { ...y, succ: { ...y.succ, sm: want.get(y.succ.num).sm, dm: want.get(y.succ.num).dm } };
          return y;
        };
        a.list = a.list.map(upd).filter((x) => x.sm > 0 || x.dm > 0);
        a.top = (a.top || []).map(upd);
        saveUser();
      }
      for (const n of done) { delete S.au.edit[n]; delete S.au.move[n]; }
      S.au.result = { done: done.size, failed: r.res.failed || [] };
    } else {
      S.au.result = { done: 0, failed: [], err: r.how === 'login' ? 'StoreFront traži prijavu. Učitaj provjeru ponovo da vidiš šta je promijenjeno.' : 'StoreFront nije odgovorio do kraja. Učitaj provjeru ponovo.' };
    }
    S.user.smdm = null; // the SM screen reads again
    renderSmBar();
    if (top().id === 'audit') renderAudit();
  });
  if (!ok) { toast('Ova verzija aplikacije to ne zna. Ažuriraj je.'); return; }
  S.au.busy = 'send';
  renderAudit();
}

function renderAudit() {
  const box = $('#auditBody');
  if (!box) return;
  const a = S.user.audit;
  const busy = S.deptBusy ? '<p class="count-line"><i class="mj-busy"></i> Prvi put: tražim u StoreFrontu grupe proizvoda tvog odjela (iz planograma)…</p>' : S.au.busy === 'load' ? '<p class="count-line"><i class="mj-busy"></i> Provjeravam sve SM i DM vrijednosti odjela u StoreFrontu… (do jedne minute)</p>'
    : S.au.busy === 'send' ? '<p class="count-line"><i class="mj-busy"></i> Spremam u StoreFront…</p>' : '';
  const res = S.au.result;
  const resLine = res ? (res.err ? `<p class="ar-err">${esc(res.err)}</p>`
    : `<p class="sm-ok">Spremljeno u StoreFront: ${res.done} ${plural(res.done, 'artikal', 'artikla', 'artikala')}.${res.failed.length ? ` Nije prošlo: ${res.failed.map((f) => esc(f.num)).join(', ')}.` : ''}</p>`) : '';
  const head = `<div class="top-head"><p class="count-line">${a ? `${esc(deptName())} · ${a.list.length} ${plural(a.list.length, 'artikal', 'artikla', 'artikala')} sa SM ili DM · ${esc(ageText(a.at))}` : ''}</p>
    <button class="text-btn" type="button" data-au="reload" ${S.au.busy ? 'disabled' : ''}>${icon('refresh')}Provjeri ponovo</button></div>`;
  const g = auGroups();
  if (!g) { box.innerHTML = `${busy}${resLine}${head}${deptChips('audit')}`; return; }
  const n = smcheck.total(g);
  const sum = n ? `<div class="au-sum">${smcheck.GROUPS.filter((x) => g[x.id].length).map((x) => `<button class="au-chip${x.fix ? ' is-fix' : ''}" type="button" data-au-go="${x.id}"><b>${g[x.id].length}</b>${esc(x.title)}</button>`).join('')}</div>`
    : '<div class="mj-intro"><h3>Sve je u redu ✓</h3><p>Nema ukinutih artikala sa SM/DM, ni drugih sumnjivih vrijednosti u odjelu.</p></div>';
  const groups = smcheck.GROUPS.filter((x) => g[x.id].length).map((x) => {
    const open = S.au.open.has(x.id);
    const fixAll = x.fix ? `<button class="btn btn-primary btn-block btn-small" type="button" data-au="fixout" ${S.au.busy ? 'disabled' : ''}>Riješi sve po smjernici (${g.out.length})</button>` : '';
    return `<section class="au-group" id="au-${x.id}">
      <button class="au-head" type="button" data-au-open="${x.id}" aria-expanded="${open}"><span><b>${esc(x.title)}</b><small>${g[x.id].length} ${plural(g[x.id].length, 'artikal', 'artikla', 'artikala')}</small></span>${icon('chev', 'chev')}</button>
      ${open ? `<p class="au-why">${esc(x.why)}</p>${fixAll}<div class="sm-list">${g[x.id].map((y) => auRow(y, x.id)).join('')}</div>` : ''}
    </section>`;
  }).join('');
  const items = auItems();
  box.innerHTML = `${busy}${resLine}${head}${deptChips('audit')}${sum}${groups}
    ${items.length ? `<div class="sm-save"><button class="btn btn-primary btn-block" type="button" data-au="save" ${S.au.busy ? 'disabled' : ''}>Spremi promjene (${items.length})</button></div>` : ''}`;
}

async function onAuClick(t) {
  const d = t.dataset;
  if (d.auOpen) { if (S.au.open.has(d.auOpen)) S.au.open.delete(d.auOpen); else S.au.open.add(d.auOpen); renderAudit(); return; }
  if (d.auGo) { S.au.open.add(d.auGo); renderAudit(); const el = $(`#au-${d.auGo}`); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  if (d.auZero) { S.au.edit[d.auZero] = { sm: 0, dm: 0 }; delete S.au.move[d.auZero]; S.au.result = null; renderAudit(); return; }
  if (d.auMove) { if (S.au.move[d.auMove]) delete S.au.move[d.auMove]; else { S.au.move[d.auMove] = true; delete S.au.edit[d.auMove]; } S.au.result = null; renderAudit(); return; }
  if (d.au === 'reload') { S.au.result = null; loadAudit(); return; }
  let items = [];
  if (d.au === 'fixout') {
    const g = auGroups();
    for (const x of g.out) items.push(...(smNeedsMove(x) ? smMoveItems(x) : [{ num: x.num, sm: 0, dm: 0 }]));
    const moves = g.out.filter(smNeedsMove).length;
    const yes = await ask(`Riješiti ${g.out.length} ${plural(g.out.length, 'ukinut artikal', 'ukinuta artikla', 'ukinutih artikala')}?`,
      `<p>Po smjernici: SM i DM idu na 0.${moves ? ` ${moves} ${plural(moves, 'ima zamjenu', 'imaju zamjenu', 'ima zamjenu')} bez SM/DM: ${plural(moves, 'njoj se', 'njima se', 'njima se')} prebacuje SM/DM starog broja.` : ''} Sprema se odmah u StoreFront pod tvojom prijavom.</p>`,
      [{ label: 'Spremi u StoreFront', kind: 'btn-primary', value: true }, { label: 'Odustani', value: false }]);
    if (yes) auSend(items);
    return;
  }
  if (d.au === 'save') {
    items = auItems();
    if (!items.length) return;
    const yes = await ask(`Spremiti promjene za ${items.length} ${plural(items.length, 'artikal', 'artikla', 'artikala')}?`,
      `<p>${items.map((x) => `${esc(x.num)}: SM ${whole(x.sm)}, DM ${whole(x.dm)}`).slice(0, 12).join('<br>')}${items.length > 12 ? '<br>…' : ''}</p><p>Sprema se odmah u StoreFront pod tvojom prijavom.</p>`,
      [{ label: 'Spremi u StoreFront', kind: 'btn-primary', value: true }, { label: 'Odustani', value: false }]);
    if (yes) auSend(items);
  }
}

// ------------------------------------------------ Prijedlozi danas: what is worth doing today

S.tips = { busy: false, timer: 0 };

/** Everything the tips are made from, as the app has it now. */
function tipsSrc() {
  const a = S.user.audit;
  const c = S.user.clr2 || {};
  const st = S.user.mj;
  let tasks = [];
  if (st && st.at) {
    const now = Date.now();
    tasks = news.myTasks(st, mjMe()).map((t) => {
      const d = news.due(t.end, now);
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t.end || '');
      const days = m ? Math.round((new Date(+m[1], +m[2] - 1, +m[3]) - new Date(new Date(now).setHours(0, 0, 0, 0))) / 86400000) : null;
      return { title: t.title, days, left: d.left };
    });
  }
  return {
    audit: a && a.list ? { at: a.at, groups: smcheck.check(a.list, a.top, (n) => S.index.byNum.has(n)) } : null,
    top: S.user.top && S.user.top.list ? S.user.top : null,
    home: c.home || null,
    furn: c.furn || null,
    ar: { enabled: mjOn(), done: ar.doneThisWeek(arKept().last, Date.now()) },
    tasks,
  };
}

function renderTipsBar() {
  const b = $('#tipsBar');
  if (!b) return;
  b.hidden = !S.plans.length || !A.storeTask;
  if (b.hidden) return;
  const t = tips.build(tipsSrc());
  const now1 = t.filter((x) => x.level === 1).length;
  b.innerHTML = `${icon('star')}<span><b>Prijedlozi danas${t.length ? `: ${t.length}` : ''}</b><small>${t.length ? `${now1 ? `${now1} hitno · ` : ''}${esc(t[0].title)}` : 'Šta se isplati uraditi danas u odjelu'}</small></span><span class="go">Otvori</span>`;
}

function openTips() {
  go('tips');
  renderTips();
  if (tips.stale(tipsSrc()).length) tipsRefresh();
}

/** Reads again what is old or missing (best sellers, SM/DM check, lists to sell out), the screen follows. */
function tipsRefresh(all = false) {
  const src = tipsSrc();
  const want = all ? ['audit', 'top', 'home', 'furn'] : tips.stale(src);
  if (want.includes('audit') && !S.au.busy) loadAudit();
  if (want.includes('top') && !S.topBusy) loadTop();
  const home = want.includes('home'), furn = want.includes('furn');
  if (home) loadClr2('home');
  S.tips.busy = true;
  clearInterval(S.tips.timer);
  let furnDone = !furn;
  S.tips.timer = setInterval(() => {
    // the two lists to sell out are read one after the other (one list at a time)
    if (!furnDone && !S.clr.busy) { furnDone = true; loadClr2('furn'); }
    const busy = S.au.busy || S.topBusy || S.clr.busy || S.deptBusy || !furnDone;
    if (top().id === 'tips') renderTips();
    renderTipsBar();
    if (!busy) { clearInterval(S.tips.timer); S.tips.busy = false; if (top().id === 'tips') renderTips(); }
  }, 1200);
  renderTips();
}

function renderTips() {
  const box = $('#tipsBody');
  if (!box) return;
  const t = tips.build(tipsSrc());
  const lv = { 1: 'Hitno', 2: 'Danas', 3: 'Kad stigneš' };
  const busy = S.tips.busy ? `<p class="count-line"><i class="mj-busy"></i> Čitam iz StoreFronta: ${[S.au.busy && 'SM/DM provjera', S.topBusy && 'najprodavanije', S.clr.busy && 'lista za rasprodaju', S.deptBusy && 'grupe odjela'].filter(Boolean).join(', ') || 'još malo'}…</p>` : '';
  const cards = t.map((x) => `<section class="tipc tip-l${x.level}">
    <div class="tip-head"><span class="tip-lv">${lv[x.level]}</span><b>${esc(x.title)}</b></div>
    <p>${esc(x.text)}</p>
    ${x.items.length ? `<ul class="tip-items">${x.items.map((i) => `<li>${i.num ? `<span class="code">${esc(i.num)}</span> ` : ''}${esc(i.name)}${i.sub ? ` <small>· ${esc(i.sub)}</small>` : ''}</li>`).join('')}</ul>` : ''}
    <button class="btn btn-soft btn-small" type="button" data-tip-go="${esc(x.go)}">Otvori i riješi</button>
  </section>`).join('');
  box.innerHTML = `<div class="top-head"><p class="count-line">${esc(deptName())} · iz StoreFronta i MYJYSK</p>
      <button class="text-btn" type="button" data-tip="refresh" ${S.tips.busy ? 'disabled' : ''}>${icon('refresh')}Osvježi sve</button></div>
    ${busy}
    ${cards || (S.tips.busy ? '' : '<div class="mj-intro"><h3>Nema ništa hitno ✓</h3><p>Ukinuti artikli nemaju SM/DM, namještaj na izlogu je u redu, najprodavaniji imaju zalihe. Osvježi sutra.</p></div>')}`;
}

function onTipClick(t) {
  if (t.dataset.tip === 'refresh') { tipsRefresh(true); return; }
  const g = t.dataset.tipGo;
  if (g === 'audit') openAudit();
  else if (g === 'top') openTop();
  else if (g === 'ar') openAr();
  else if (g === 'news') { go('home'); setMode('news'); }
  else if (g === 'clear-home' || g === 'clear-furn') { S.clr.dept = g === 'clear-furn' ? 'furn' : 'home'; S.clr.st = 'all'; openClearance(); }
}

// ------------------------------------------------ AR artikli: the weekly rating of the department in MYJYSK
//
// The employee rates his department 1-5 per question; everything starts at 5. Under 5 MYJYSK wants a comment: he
// picks a ready-made sentence or writes his own. One button then makes the visit in MYJYSK, fills in his answers
// and completes it (assets/myjysk-ar.js, with his own sign-in).

const arKept = () => S.user.ar || (S.user.ar = { form: null, last: null, used: {} });
// own comments per question and score (older versions kept one list per question: those count as 4s)
const arUsed = (k, id) => { const u = k.used[id]; return Array.isArray(u) ? { 4: u } : { ...(u || {}) }; };
const arFormName = () => cfg().arForm || ar.DEFAULT_FORM;
const AR_STEP = { create: 'pravljenje posjete', start: 'otvaranje posjete', answers: 'upisivanje odgovora', complete: 'završavanje posjete' };

function arBar() {
  if (!mjOn()) return '';
  const k = arKept();
  const done = ar.doneThisWeek(k.last, Date.now());
  const sub = done ? `Urađeno ove sedmice${k.last.score ? `, rezultat ${Math.round(k.last.score)}%` : ''}` : 'Nije urađeno ove sedmice';
  return `<button class="orders-bar ar-bar${done ? ' is-done' : ''}" type="button" data-mj="ar">${icon('list')}<span><b>AR artikli</b><small>${esc(sub)}</small></span><span class="go">${done ? 'Otvori' : 'Ocijeni'}</span></button>`;
}

function openAr() {
  S.ar.err = null;
  S.ar.done = null;
  if (!S.ar.busy) { S.ar.scores = {}; S.ar.notes = {}; }
  go('ar');
  renderAr();
  if (!S.ar.busy) arLoad();
}

function arCall(arg) {
  try { A.myjyskAr(JSON.stringify(arg)); return true; } catch (e) { return false; }
}

function arLoad() {
  if (!arCall({ mode: 'form', form: arFormName() })) { S.ar.err = { kind: 'old' }; renderAr(); return; }
  S.ar.busy = 'form';
  renderAr();
}

function arSend() {
  const k = arKept();
  const qs = ar.questions(k.form);
  const miss = ar.missing(qs, S.ar.scores, S.ar.notes);
  if (miss.length) {
    toast('Za ocjenu ispod 5 treba komentar.');
    const el = document.querySelector(`[data-ar-note="${miss[0].id}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
    return;
  }
  let answers;
  try { answers = ar.answers(qs, S.ar.scores, S.ar.notes); } catch (e) { toast('Obrazac se promijenio. Osvježi ga pa pokušaj ponovo.'); return; }
  if (!navigator.onLine) { toast('Nema internet veze.'); return; }
  if (!arCall({ mode: 'send', guid: k.form.guid, answers })) { toast('Ova verzija aplikacije to ne može. Ažuriraj je.'); return; }
  S.ar.busy = 'send';
  S.ar.sent = { scores: { ...S.ar.scores }, notes: { ...S.ar.notes } };
  renderAr();
}

window.onMjAr = (r) => {
  if (r && r.res && r.res.dry) setTimeout(() => toast('TEST verzija: ništa nije poslano u MYJYSK (samo odigrano).'), 1800);
  const was = S.ar.busy;
  S.ar.busy = '';
  const k = arKept();
  if (r && r.how === 'ok' && was === 'form') {
    const res = r.res || {};
    k.forms = res.forms || k.forms || [];
    if (res.form) { k.form = res.form; S.ar.err = null; } else S.ar.err = { kind: 'noform' };
    saveUser();
  } else if (r && r.how === 'ok' && was === 'send') {
    const res = r.res || {};
    const qs = ar.questions(k.form);
    for (const q of qs) {
      const n = String((S.ar.sent.notes || {})[q.id] || '').trim();
      const sc = +((S.ar.sent.scores || {})[q.id] || 5);
      if (n && sc < 5) { const u = arUsed(k, q.id); u[sc] = [n, ...(u[sc] || []).filter((x) => x !== n)].slice(0, 3); k.used[q.id] = u; }
    }
    const mine = ar.score(qs, S.ar.sent.scores || {});
    k.last = { at: Date.now(), id: res.id || 0, score: res.score ? res.score : mine, form: k.form.name, status: res.status || '' };
    saveUser();
    S.ar.done = k.last;
    S.ar.err = null;
  } else {
    S.ar.err = { kind: r && r.how === 'login' ? 'login' : 'error', was, step: r && r.step, id: r && r.id, err: r && r.err };
  }
  if (top().id === 'ar') renderAr();
  if (S.mode === 'news') renderNews();
};

function arQuestion(q, i) {
  const sc = +(S.ar.scores[q.id] || 5);
  const k = arKept();
  const note = String(S.ar.notes[q.id] || '');
  const sugg = sc < 5 && q.note ? ar.suggestions(q, sc, arUsed(k, q.id)) : [];
  return `<div class="ar-q${sc < 5 ? ' is-low' : ''}">
    <p class="ar-name"><span>${i + 1}.</span> ${esc(q.name)}</p>
    <div class="ar-scores" role="radiogroup" aria-label="Ocjena">${[1, 2, 3, 4, 5].map((n) => `<button class="ar-sc" type="button" role="radio" aria-checked="${sc === n}" data-ar-sc="${q.id}:${n}" ${S.ar.busy ? 'disabled' : ''}>${n}</button>`).join('')}</div>
    ${sc < 5 && q.note ? `<div class="ar-sugg">${sugg.map((t) => `<button class="chip" type="button" aria-pressed="${note === t}" data-ar-pick="${q.id}" data-text="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <textarea class="ar-note" rows="2" maxlength="1000" placeholder="Zašto ${sc}? Izaberi gore ili napiši svoje." data-ar-note="${q.id}" ${S.ar.busy ? 'disabled' : ''}>${esc(note)}</textarea>` : ''}
  </div>`;
}

function renderAr() {
  const box = $('#arBody');
  if (!box) return;
  const k = arKept();
  const qs = ar.questions(k.form);
  const e = S.ar.err;
  let msg = '';
  if (S.ar.busy === 'form' && !qs.length) msg = '<div class="mj-state"><span><i class="mj-busy"></i>Učitavam obrazac iz MYJYSK…</span></div>';
  else if (S.ar.busy === 'form') msg = '<div class="mj-state"><span><i class="mj-busy"></i>Provjeravam obrazac u MYJYSK…</span></div>';
  if (e && e.kind === 'login') msg = `<button class="orders-bar" type="button" data-ar="login">${icon('info')}<span><b>Prijavi se ponovo u MYJYSK</b><small>Prijava je istekla.${e.was === 'send' ? ' Ništa nije poslano.' : ''}</small></span><span class="go">Prijava</span></button>`;
  else if (e && e.kind === 'noform') msg = `<p class="ar-err">U MYJYSK nema obrasca „${esc(arFormName())}". Izaberi svoj obrazac dolje.</p>`;
  else if (e && e.kind === 'old') msg = '<p class="ar-err">Ova verzija aplikacije to ne može. Ažuriraj je.</p>';
  else if (e && e.was === 'send') {
    msg = e.id
      ? `<div class="ar-err"><b>Nije završeno do kraja</b> (zapelo kod: ${esc(AR_STEP[e.step] || e.step || 'nepoznato')}). Posjeta je napravljena u MYJYSK, otvori je i završi tamo, da ne bude dvije.<br><button class="text-btn" type="button" data-mj-open="/ui/store-visits/${+e.id}">Otvori u MYJYSK</button></div>`
      : `<div class="ar-err"><b>Nije poslano.</b> ${e.err === 'lost' || e.err === 'timeout' ? 'MYJYSK nije odgovorio na vrijeme. Prije ponovnog slanja pogledaj u MYJYSK (Store Visit) da li je posjeta ipak napravljena.' : 'MYJYSK je vratio grešku. Pokušaj ponovo za koji minut.'}</div>`;
  } else if (e) msg = '<p class="ar-err">MYJYSK nije odgovorio. Prikazan je zadnji učitani obrazac.</p>';
  const d = S.ar.done;
  if (d) {
    box.innerHTML = `<div class="mj-intro ar-ok"><h3>AR artikli završeni ✓</h3>
      <p>Posjeta „${esc(d.form)}" je napravljena i završena u MYJYSK${d.score ? `, rezultat ${Math.round(d.score)}%` : ''}.</p>
      ${d.id ? `<button class="btn btn-quiet btn-block" type="button" data-mj-open="/ui/store-visits/${+d.id}">Pogledaj u MYJYSK</button>` : ''}</div>`;
    return;
  }
  const last = k.last && ar.doneThisWeek(k.last, Date.now()) ? `<p class="ar-note-top">Ove sedmice je već urađeno (${new Date(k.last.at).getDate()}.${new Date(k.last.at).getMonth() + 1}.). Ponovno slanje pravi novu posjetu.</p>` : '';
  const forms = (k.forms || []).length ? `<label class="ar-form">Obrazac <select data-ar="form" ${S.ar.busy ? 'disabled' : ''}>${k.forms.map((f) => `<option ${f.name === arFormName() ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>` : '';
  if (!qs.length) {
    box.innerHTML = `${msg}${forms}${S.ar.busy ? '' : '<button class="btn btn-quiet btn-block" type="button" data-ar="reload">Učitaj ponovo</button>'}`;
    return;
  }
  const low = qs.filter((q) => +(S.ar.scores[q.id] || 5) < 5).length;
  box.innerHTML = `${msg}${last}${forms}
    <p class="ar-hint">Sve je na 5. Promijeni samo ono što nije za 5 i izaberi zašto.</p>
    ${qs.map(arQuestion).join('')}
    <button class="btn btn-primary btn-block ar-send" type="button" data-ar="send" ${S.ar.busy ? 'disabled' : ''}>${S.ar.busy === 'send' ? '<i class="mj-busy"></i>Šaljem u MYJYSK…' : `Završi AR artikle${low ? ` (${low} ispod 5)` : ''}`}</button>`;
}

function onArClick(t) {
  if (t.dataset.arSc) {
    const [id, n] = t.dataset.arSc.split(':');
    const q = ar.questions(arKept().form).find((x) => String(x.id) === id);
    const was = +(S.ar.scores[id] || 5);
    // a ready-made sentence picked for the old score does not fit the new one
    if (q && was < 5 && ar.suggestions(q, was, arUsed(arKept(), q.id)).includes(S.ar.notes[id])) delete S.ar.notes[id];
    S.ar.scores[id] = +n;
    renderAr();
    if (+n < 5) { const el = document.querySelector(`[data-ar-note="${id}"]`); if (el && !el.value) el.closest('.ar-q').scrollIntoView({ block: 'nearest' }); }
    return;
  }
  if (t.dataset.arPick) {
    S.ar.notes[t.dataset.arPick] = t.dataset.text;
    renderAr();
    return;
  }
  const a = t.dataset.ar;
  if (a === 'send') arSend();
  else if (a === 'reload') arLoad();
  else if (a === 'login') { S.ar.err = null; S.ar.after = true; refreshMyjysk(true); }
}

// ------------------------------------------------ planograms from MYJYSK

const sideName = () => `${cfg().plSide === 'right' ? 'desna' : 'lijeva'}${cfg().plCompact ? ' Compact' : ''} trgovina`;
const planOff = () => cfg().plOff || {};
function planList() {
  const st = S.user.mj;
  const all = news.planLinks(st && st.kb, { org: cfg().plOrg, side: cfg().plSide, compact: !!cfg().plCompact });
  // the Christmas planogram for stores with a wall is left out until the employee turns it on
  const off = cfg().plOff || Object.fromEntries(all.filter((p) => /zid|wall/i.test(`${p.text} ${p.key}`)).map((p) => [p.key, true]));
  return all.map((p) => ({ ...p, off: !!off[p.key] }));
}
function planCheckLine() {
  const last = S.user.planCheck;
  return `${sideName()[0].toUpperCase()}${sideName().slice(1)} · ${last ? `zadnja provjera ${ageText(last)}` : 'još nije provjereno'}`;
}
function planChips() {
  const list = planList();
  if (!list.length) return '<div class="set-row"><div class="set-txt"><b>Koji planogrami</b><small>Spisak se pojavi poslije prve provjere.</small></div></div>';
  if (!cfg().plOff) setCfg({ plOff: Object.fromEntries(list.filter((p) => p.off).map((p) => [p.key, true])) });
  return `<div class="set-row set-col"><div class="set-txt"><b>Koji planogrami</b><small>Isključeni se ne preuzimaju.</small></div>
    <div class="chips">${list.map((p) => `<button class="chip" type="button" role="checkbox" aria-checked="${!p.off}" data-ploff="${esc(p.key)}">${esc(news.deptName(p.dept))}${/zid|wall/i.test(`${p.text} ${p.key}`) ? ' sa zidom' : ''}</button>`).join('')}</div></div>`;
}

function checkPlans() {
  if (!mjOn()) return;
  if (S.busy) { toast('Sačekaj da se završi uvoz planograma.'); return; }
  const st = S.user.mj;
  if (st && st.kb && Date.now() - st.at < 20 * 60 * 1000) { startPlanDownload(); return; }
  S.mj.after = 'plans';
  progress('Provjeravam planograme', 0.03, 'Čitam koncept trgovine u MYJYSK…');
  refreshMyjysk(false);
}

let planDl = null; // the running download: { list }
function startPlanDownload() {
  const list = planList().filter((p) => !p.off);
  if (!list.length) {
    openSheet({ title: 'Nema planograma', body: `<p>U MYJYSK nisam našao planograme za ${esc(sideName())}. Provjeri u postavkama stranu trgovine.</p>`, actions: [{ label: 'U redu', kind: 'btn-primary', onClick: closeSheet }] });
    return;
  }
  const src = S.user.planSrc || {};
  planDl = { list };
  progress('Preuzimam planograme', 0.05, `${list.length} ${plural(list.length, 'planogram', 'planograma', 'planograma')} za ${sideName()}`);
  try {
    A.downloadPlans(JSON.stringify(list.map((p) => ({ url: p.url, name: p.name, sha: (src[p.key] || {}).sha || '', etag: (src[p.key] || {}).etag || '', lm: (src[p.key] || {}).lm || '' }))));
  } catch (e) { planDl = null; closeSheet(); toast('Ova verzija aplikacije ne zna preuzimati planograme.'); }
}

window.onPlanDl = (r) => {
  if (!planDl) return;
  if (!r.done) { progress('Preuzimam planograme', 0.05 + (0.9 * r.i) / Math.max(1, r.n), `${r.i + 1}. od ${r.n}: ${r.name}`); return; }
  const { list } = planDl;
  planDl = null;
  if (r.login) { planLogin(r, list); return; }
  S.user.planCheck = Date.now();
  const src = S.user.planSrc || (S.user.planSrc = {});
  const byUrl = new Map(list.map((p) => [p.url, p]));
  const fresh = [], pending = {}, info = [];
  let same = 0;
  for (const f of r.files || []) {
    const p = byUrl.get(f.url);
    if (!p) continue;
    if (f.status === 'same') { same++; src[p.key] = { ...(src[p.key] || {}), sha: f.sha, etag: f.etag, lm: f.lm, at: Date.now() }; continue; }
    if (f.status === 'new') { fresh.push({ name: p.name, file: f.file, size: f.size }); pending[p.name] = { key: p.key, sha: f.sha, etag: f.etag, lm: f.lm, first: !src[p.key] }; continue; }
    info.push({ kind: 'dlerror', name: p.text, why: f.why });
  }
  saveUser();
  const head = { kind: 'checked', n: list.length, same, fresh: fresh.length, side: sideName() };
  if (!fresh.length) { showResults([head, ...info]); if (top().id === 'plans') renderPlans(); return; }
  queue.push({ list: fresh, target: null, auto: { pending, head, info } });
  drainImports();
};

/** The planogram server wants its own sign-in: a user and password once (kept on the phone), or its web page. */
function planLogin(r, list) {
  const d = String(r.detail || '');
  if (r.login === 'auth' && /ntlm|negotiate/i.test(d) && !/basic/i.test(d)) {
    openSheet({ title: 'Prijava za planograme', body: '<p>Server za planograme traži Windows prijavu, a nju ova verzija aplikacije još ne zna poslati. Javi to, pa ću je dodati.</p>', actions: [{ label: 'U redu', kind: 'btn-primary', onClick: closeSheet }] });
    return;
  }
  if (r.login === 'auth') {
    closeSheet();
    S.plWait = true;
    A.plansLogin(r.kept ? 'Korisničko ime ili lozinka nisu prihvaćeni. Upiši ih ponovo.' : 'Server za planograme traži prijavu (samo prvi put).');
    return;
  }
  openSheet({
    title: 'Prijava za planograme',
    body: '<p>Server za planograme traži prijavu, istu kao za MYJYSK. Prijavi se, ekran se sam zatvori i provjera ide dalje.</p>',
    actions: [{ label: 'Prijavi se', kind: 'btn-primary', onClick: () => { closeSheet(); S.plWait = true; A.plansWeb(list[0].url); } }, { label: 'Odustani', kind: 'btn-quiet', onClick: closeSheet }],
  });
}

window.onPlansLogin = (ok) => {
  if (S.loginWait) {
    S.loginWait = false;
    if (ok) toast('Sačuvano. Aplikacija se sama prijavljuje kad te sistem odjavi.');
    if (top().id === 'settings') renderSettings();
    return;
  }
  if (!S.plWait) return;
  S.plWait = false;
  if (ok) startPlanDownload();
  else toast('Bez prijave se planogrami ne mogu preuzeti.');
};

/** After the downloaded planograms were read: remember which file each one was, and note the new ones under "Važno". */
function afterAutoImport(auto, results, from) {
  const src = S.user.planSrc || (S.user.planSrc = {});
  const mine = results.slice(from);
  for (const r of mine) {
    const p = auto.pending[r.name];
    if (!p || !['added', 'replaced', 'skipped'].includes(r.kind)) continue;
    src[p.key] = { sha: p.sha, etag: p.etag, lm: p.lm, at: Date.now() };
    if (p.first || !r.meta) continue; // the first download of a planogram is not news
    const c = r.ch;
    const n = c ? c.added.length + c.moved.length + c.removed.length : 0;
    (S.user.planLog || (S.user.planLog = [])).unshift({
      id: `p:${r.meta.id}`, kind: 'plan', at: Date.now(), dept: r.meta.title, date: new Date().toISOString().slice(0, 10), planId: r.meta.id,
      title: `Novi planogram: ${r.meta.title}`,
      text: `${r.meta.deadline ? `Rok za postavku ${core.deadlineLabel(r.meta.deadline)}. ` : ''}${n ? `${c.added.length} novih, ${c.moved.length} premještenih, ${c.removed.length} izbačenih artikala.` : ''}`,
    });
  }
  if (S.user.planLog) S.user.planLog = S.user.planLog.slice(0, 30);
  results.splice(from, 0, auto.head, ...auto.info);
  saveUser();
}

// --------------------------------------------------------------------- home

function renderHome() {
  const has = S.plans.length > 0;
  $('#planCount').textContent = String(S.plans.length);
  $('#planCount').hidden = !has;
  const count = S.index.names.length;
  const ol = S.user.orders && S.user.orders.list;
  $('#homeStats').textContent = S.mode === 'orders'
    ? (ol ? `${ol.length} ${plural(ol.length, 'narudžba', 'narudžbe', 'narudžbi')} kupaca` : 'Narudžbe još nisu učitane')
    : has
      ? `${artikala(count)} u ${S.plans.length} ${plural(S.plans.length, 'planogramu', 'planograma', 'planograma')}`
      : 'Tvoji planogrami, uvijek pri ruci';
  const nw = S.mode === 'news' && mjOn();
  $('#newsTab').hidden = !mjOn();
  $('#newsDot').hidden = nw || !newsWaiting();
  $('#newsWrap').hidden = !nw;
  if (nw) {
    $('#homeStats').textContent = 'Zadaci i vijesti iz MYJYSK';
    for (const id of ['#welcome', '#searchForm', '#homeDock', '#results', '#recentWrap', '#ordersBar', '#clearBar', '#minusBar', '#tipsBar', '#topBar', '#smBar', '#soonBar']) $(id).hidden = true;
    for (const b of $$('#modeSeg [data-mode]')) b.setAttribute('aria-selected', String(b.dataset.mode === S.mode));
    renderNews();
    return;
  }
  const ord = S.mode === 'orders';
  $('#welcome').hidden = has || ord;
  $('#searchForm').hidden = !(has || ord);
  $('#homeDock').hidden = !(has || ord);
  const q = $('#q').value.trim();
  $('#results').hidden = !(has || ord) || !q;
  $('#recentWrap').hidden = !(has || ord) || !!q;
  const favs = (S.user.favs || []).filter((n) => S.index.byNum.has(n));
  const recent = S.user.recent.filter((r) => S.index.byNum.has(r.num) && !favs.includes(r.num));
  $('#favWrap').hidden = !favs.length;
  $('#favs').innerHTML = favs.length ? `<div class="list">${favs.map((n) => itemRow(n)).join('')}</div>` : '';
  $('#recent').innerHTML = recent.length ? `<div class="list">${recent.map((r) => itemRow(r.num)).join('')}</div>` : '';
  renderOrdersBar();
  renderClearBar();
  renderMinusBar();
  renderStoreBars();
  $('#recentEmpty').hidden = recent.length > 0 || favs.length > 0;
  $('#recentHead').hidden = recent.length === 0;
  for (const b of $$('#modeSeg [data-mode]')) b.setAttribute('aria-selected', String(b.dataset.mode === S.mode));
  $('#q').placeholder = S.mode === 'orders' ? 'Šifra artikla, ime kupca ili telefon' : 'Šifra ili naziv artikla';
  if (S.mode === 'orders') { runOrdersSearch(); return; }
  if (q) runSearch();
}

function runSearch() {
  if (S.mode === 'orders') { runOrdersSearch(); return; }
  const q = $('#q').value.trim();
  $('#clearQ').hidden = !q;
  const box = $('#results');
  if (!q || !S.plans.length) {
    box.hidden = true;
    $('#recentWrap').hidden = !S.plans.length;
    return;
  }
  box.hidden = false;
  $('#recentWrap').hidden = true;
  const nums = core.search(S.index, q, 60);
  if (!nums.length) {
    const d = q.replace(/\s/g, '');
    box.innerHTML = `<p class="empty">${/^\d+$/.test(d) && d.length < 3
      ? 'Upiši bar tri cifre šifre.'
      : `Nema artikla „${esc(q)}“ u planogramima.`}</p>${/^\d{7}$/.test(d) ? ordersBlock(d, { label: d }) + ordersBlock(d, { after: true }) : ''}`;
    return;
  }
  box.innerHTML = `<p class="count-line">${artikala(nums.length)}${nums.length >= 60 ? ' i više' : ''}</p><div class="list">${nums.map((n) => itemRow(n)).join('')}</div>`;
}

// ------------------------------------------------------------------ article

function sideView(plan, oc, place) {
  const shelves = core.moduleShelves(plan, oc);
  if (!shelves.length) return '';
  const maxN = Math.max(...shelves.map((s) => s.n), 10) + 6;
  const y = (n) => 6 + (1 - n / maxN) * 80;
  const here = plan.pages[oc.p].segs[oc.g];
  let svg = '<svg class="side" viewBox="0 0 58 92" role="img" aria-label="Položaj na modulu">';
  svg += '<rect class="up" x="1" y="1" width="4" height="90" rx="2"/><rect class="up" x="53" y="1" width="4" height="90" rx="2"/>';
  for (const s of shelves) {
    const yy = y(s.n);
    const cur = s.sh === here.sh && s.n === here.n;
    if (isBar(s.d)) svg += `<line class="rod${cur ? ' is-here' : ''}" x1="7" x2="51" y1="${yy}" y2="${yy}"/>`;
    else svg += `<rect class="shelf${cur ? ' is-here' : ''}" x="5" y="${yy - 2}" width="48" height="4" rx="2"/>`;
  }
  const yy = y(here.n);
  const frac = place.cnt > 0 ? (place.pos - 0.5) / place.cnt : 0.5;
  const px = 7 + frac * 44 - 4.5;
  svg += isBar(here.d)
    ? `<rect class="prod" x="${px}" y="${yy + 2}" width="9" height="11" rx="2"/>`
    : `<rect class="prod" x="${px}" y="${yy - 14}" width="9" height="11" rx="2"/>`;
  return svg + '</svg>';
}

function whereText(place) {
  const parts = [];
  if (place.shelf) {
    const word = isBar(place.fixture) ? 'šipka' : 'polica';
    let s = `<strong>${place.shelf}. ${word} odozgo</strong>`;
    const fx = fixtureText(place.fixture).replace(/^šipka za vješanje(, )?/, '').replace(/^polica (\d+ cm)/, 'dubina $1');
    if (fx) s += `, ${esc(fx)}`;
    parts.push(s + '.');
  }
  if (place.cnt > 1) parts.push(`<strong>${place.pos}. artikal s lijeva</strong> od ${place.cnt}.`);
  return parts.join(' ');
}

function linkNums(text, self) {
  return esc(text).replace(/(?<!\d)(\d{7})(?!\d)/g, (m) => (m !== self && S.index.byNum.has(m)
    ? `<button class="link" type="button" data-num="${m}">${m}</button>` : m));
}

/** Everything on the same shelf, left to right. */
function shelfMates(plan, oc) {
  const out = [];
  for (const [num, it] of Object.entries(plan.items)) {
    for (const o of it.oc) if (o.p === oc.p && o.g === oc.g) out.push({ num, o });
  }
  out.sort((a, b) => (a.o.k || a.o.b)[0] - (b.o.k || b.o.b)[0]);
  return out;
}

function renderItem() {
  const { num, info } = S.item;
  const locs = locationsOf(num);
  const li = Math.min(S.item.loc || 0, Math.max(0, locs.length - 1));
  S.item.loc = li;
  const L = locs[li];
  const body = $('#itemBody');
  if (!L) {
    body.innerHTML = '<p class="empty">Ovaj artikal više nije u planogramima.</p>';
    return;
  }
  const plan = L.e.plan;
  const it = L.e.it;
  $('#itemPlan').textContent = core.planTitle(plan);
  let section = L.place ? L.place.section : null;
  if (!section && L.row) {
    const pg = plan.pages[L.row.p];
    const sec = pg && pg.sec >= 0 ? plan.meta.sections[pg.sec] : null;
    section = sec ? `${sec.code} ${sec.name}` : null;
  }
  let h = `<div class="head">
      ${thumb(num, 'thumb-lg', true)}
      <div class="head-text">
        <span class="head-acts"><button class="code-chip" type="button" data-copy="${esc(num)}" aria-label="Kopiraj šifru ${esc(num)}">${esc(num)} ${icon('copy', 'ico-sm')}</button>
          <button class="fav-btn" type="button" data-fav="${esc(num)}" aria-pressed="${isFav(num)}" aria-label="${isFav(num) ? 'Ukloni iz favorita' : 'Dodaj u favorite'}">${isFav(num) ? '★' : '☆'}</button></span>
        <h2 class="title">${esc(it.nm) || 'Bez naziva'}</h2>
        ${section ? `<p class="sub">${esc(section)}</p>` : ''}
      </div>
    </div>`;
  if (info && info.via === 'substitute') {
    h += `<p class="notice">${icon('info')}<span>Skenirana šifra ${esc(info.from)} je zamjena za ovaj artikal.</span></p>`;
  } else if (info && info.via === 'learned') {
    h += `<p class="notice">${icon('link')}<span>Barkod ${esc(info.code)} je povezan s ovim artiklom. <button class="link" type="button" data-unlink="${esc(info.code)}">Promijeni</button></span></p>`;
  }
  if (locs.length > 1) {
    const many = locs.some((y) => y.e.id !== L.e.id);
    h += `<div class="tabs" role="tablist">${locs.map((x, i) => `<button class="tab" type="button" role="tab" aria-selected="${i === li}" data-loc="${i}">Mjesto ${i + 1}${many ? `, ${esc(core.planTitle(x.e.plan))}` : ''}</button>`).join('')}</div>`;
  }
  h += ordersBlock(num);
  if (L.place && L.place.segment) {
    const p = L.place;
    const long = String(p.module).length > 3;
    h += `<div class="loc">
      <div class="loc-grid">
        <div><span>Modul</span><b class="${long ? 'is-long' : ''}">${esc(p.module)}</b></div>
        <div><span>${isBar(p.fixture) ? 'Šipka' : 'Polica'}</span><b>${esc(p.shelf)}</b></div>
        <div><span>Notch</span><b>${esc(p.notch)}</b></div>
      </div>
      <div class="loc-foot"><p>${whereText(p)}${L.oc.whole ? ` <span id="locNote">Mjesto je iz liste artikala (${esc(L.row && L.row.fx ? L.row.fx : `segment ${p.segment}`)}); tražim ga na crtežu…</span>` : ''}</p>${sideView(plan, L.oc, p)}</div>
    </div>`;
  } else if (L.row) {
    h += `<div class="loc loc-off">
      <div class="loc-grid"><div style="grid-column: span 3"><span>Na listi artikala</span><b class="is-long">${esc(L.row.fx || 'Bez mjesta')}</b></div></div>
      <div class="loc-foot"><p>Ovaj artikal je samo na listi, nije nacrtan na polici.</p></div>
    </div>`;
  } else {
    h += '<div class="loc loc-off"><div class="loc-foot" style="margin:0;padding:0;border:0"><p>Ovaj artikal se spominje u planogramu, ali nema svoje mjesto na crtežu.</p></div></div>';
  }
  h += `<div class="stock-box" data-stock="${esc(num)}">${stockHtml(num)}</div>`;
  h += ordersBlock(num, { after: true });
  const page = L.oc ? L.oc.p : L.row ? L.row.p : null;
  if (page != null) {
    h += `<section class="block">
      <div class="sec-head"><h3>Na planogramu</h3><button class="text-btn" type="button" id="openViewer">Otvori</button></div>
      <button class="plano" type="button" id="crop" aria-label="Otvori planogram na ovom mjestu">
        <canvas></canvas><svg preserveAspectRatio="none"></svg><span class="wait">Crtam planogram</span>
      </button>
      <p class="plano-cap">Stranica ${page + 1} od ${plan.pages.length}${L.place && L.place.segment ? `, segment ${esc(L.place.segment)}` : ''}</p>
    </section>`;
  }
  if (L.oc && L.oc.g >= 0) {
    const mates = shelfMates(plan, L.oc);
    if (mates.length > 1) {
      h += `<section class="block"><div class="sec-head"><h3>Na istoj polici</h3></div><div class="shelf" id="shelf">${mates.map(({ num: n, o }) => {
        const here = n === num && o === L.oc;
        return `<button class="mate${here ? ' is-here' : ''}" type="button" ${here ? 'aria-current="true"' : `data-num="${esc(n)}"`}>
          ${thumb(n)}<span class="code">${esc(n)}</span><span class="mate-name">${esc(plan.items[n] ? plan.items[n].nm : '')}</span></button>`;
      }).join('')}</div><p class="shelf-cap">Redom s lijeva na desno</p></section>`;
    }
  }
  // the same note written at several labels ("Display in 4911295 ARE") is shown once
  const notes = new Map(); // text -> other articles it is written at
  for (const k of it.nt) {
    const n = plan.notes[k];
    if (!n) continue;
    if (!notes.has(n.t)) notes.set(n.t, []);
    const owners = notes.get(n.t);
    for (const o of n.o || []) if (o !== num && !owners.includes(o)) owners.push(o);
  }
  if (notes.size) {
    const numLink = (o) => (S.index.byNum.has(o) ? `<button class="link" type="button" data-num="${o}">${o}</button>` : o);
    const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} i ${xs[xs.length - 1]}` : xs[0]);
    h += `<section class="block"><div class="sec-head"><h3>${notes.size > 1 ? 'Napomene' : 'Napomena'} u planogramu</h3></div>${[...notes].map(([t, owners]) => `<p class="note">${linkNums(t, num)}${owners.length
      ? `<small>${owners.length > 1 ? 'Uz artikle' : 'Uz artikal'} ${list(owners.map(numLink))}</small>` : ''}</p>`).join('')}</section>`;
  }
  body.innerHTML = h;
  // centre this article in the shelf strip (sideways only: the page itself stays at the top)
  const strip = $('#shelf'), here = $('#shelf .is-here');
  if (strip && here) {
    const d = here.getBoundingClientRect().left - strip.getBoundingClientRect().left;
    strip.scrollLeft += d - (strip.clientWidth - here.offsetWidth) / 2;
  }
  stockLoad(num);
  if (page != null) paintCrop(L).catch((e) => {
    console.warn('crop', e);
    const w = $('#crop .wait');
    if (w) w.textContent = 'Planogram se ne može prikazati';
  });
}

const blockCache = new Map(); // "planId:page:x,y" -> box
let cropToken = 0;

/** The planogram around the product, with everything else dimmed. */
async function paintCrop(L) {
  const token = ++cropToken;
  const box = $('#crop');
  if (!box) return;
  const cw = box.clientWidth, ch = box.clientHeight;
  if (!cw || !ch) return;
  const plan = L.e.plan;
  const pageIdx = L.oc ? L.oc.p : L.row.p;
  const pg = plan.pages[pageIdx];
  const whole = !!(L.oc && L.oc.whole);
  const key = L.oc ? `${L.e.id}:${L.oc.p}:${L.oc.b.join(',')}${whole ? `:${S.item.num}` : ''}` : null;
  let blk = L.oc ? (whole ? blockCache.get(key) || null : L.oc.k || blockCache.get(key) || null) : null;
  let target = L.oc ? L.oc.b : L.row.b;
  const doc = await docs.openPlan(L.e.id);
  if (token !== cropToken) return;
  // only on the product list: its number is written on the drawing all the same (under its photo); mark that,
  // never the whole shelf. Not there: the shelf is shown with nothing marked.
  let label = null;
  if (whole) {
    try { label = await docs.findNumber(doc, pageIdx + 1, S.item.num); } catch (e) { label = null; }
    if (token !== cropToken) return;
    if (label) target = label;
    const note = $('#locNote');
    if (note) note.textContent = label ? '' : `Na crtežu nema njegove šifre (na listi piše ${L.row && L.row.fx ? L.row.fx : 'ovaj segment'}): pokazana je samo polica.`;
  }
  const region = (focus) => {
    const fw = focus[2] - focus[0], fh = focus[3] - focus[1];
    let w = Math.max(fw * 2.8, fh * 2.8 * (cw / ch), 200);
    w = Math.min(w, pg.w);
    let h = (w * ch) / cw;
    if (h > pg.h) { h = pg.h; w = (h * cw) / ch; }
    let x0 = (focus[0] + focus[2]) / 2 - w / 2;
    let y0 = (focus[1] + focus[3]) / 2 - h / 2;
    x0 = Math.max(Math.min(x0, pg.w - w), Math.min(0, pg.w - w));
    y0 = Math.max(Math.min(y0, pg.h - h), Math.min(0, pg.h - h));
    return [x0, y0, x0 + w, y0 + h];
  };
  const guess = blk || (whole && !label ? L.oc.b : [target[0] - 10, target[1] - 50, target[2] + 10, target[3] + 30]);
  let reg = region(guess);
  const canvas = $('#crop canvas');
  const r = await docs.renderRegion(doc, pageIdx + 1, reg, canvas, cw, ch, { maxDpr: 2.5 });
  if (token !== cropToken) return;
  if (whole && !label) {
    // nothing to mark: the shelf without a highlight
    svgClear($('#crop svg'), reg);
    $('#crop').classList.add('is-ready');
    const w0 = $('#crop .wait');
    if (w0) w0.remove();
    S.item.focus = null;
    return;
  }
  if (L.oc && !blk) {
    const extra = whole ? { b: label, nums: [S.item.num] } : undefined;
    // the photos of the whole page, not only of the part drawn here: facings outside the crop count too
    try { blk = docs.blockFor(plan, L.oc, await docs.photosOf(doc, pageIdx + 1), extra); } catch (e) { blk = null; }
    if (!blk) blk = docs.blockFor(plan, L.oc, r.photos, extra);
    if (blk) blockCache.set(key, blk);
    const inside = blk && blk[0] >= reg[0] && blk[2] <= reg[2] && blk[1] >= reg[1] && blk[3] <= reg[3];
    if (blk && !inside) {
      reg = region(blk);
      await docs.renderRegion(doc, pageIdx + 1, reg, canvas, cw, ch, { maxDpr: 2.5 });
      if (token !== cropToken) return;
    }
  }
  const spot = blk ? [Math.min(blk[0], target[0]), Math.min(blk[1], target[1]), Math.max(blk[2], target[2]), Math.max(blk[3], target[3])] : target;
  drawSpot($('#crop svg'), reg, spot);
  $('#crop').classList.add('is-ready');
  const w = $('#crop .wait');
  if (w) w.remove();
  S.item.focus = { id: L.e.id, page: pageIdx, box: spot };
}

function svgClear(svg, reg) {
  svg.setAttribute('viewBox', `${reg[0]} ${reg[1]} ${reg[2] - reg[0]} ${reg[3] - reg[1]}`);
  svg.innerHTML = '';
}

function drawSpot(svg, reg, b) {
  const pad = 2.5;
  const x0 = b[0] - pad, y0 = b[1] - pad, x1 = b[2] + pad, y1 = b[3] + pad;
  const r = Math.min(6, (x1 - x0) / 6, (y1 - y0) / 6);
  svg.setAttribute('viewBox', `${reg[0]} ${reg[1]} ${reg[2] - reg[0]} ${reg[3] - reg[1]}`);
  svg.innerHTML = `<path class="spot-dim" fill-rule="evenodd" d="M${reg[0] - 5} ${reg[1] - 5}H${reg[2] + 5}V${reg[3] + 5}H${reg[0] - 5}Z M${x0 + r} ${y0}H${x1 - r}Q${x1} ${y0} ${x1} ${y0 + r}V${y1 - r}Q${x1} ${y1} ${x1 - r} ${y1}H${x0 + r}Q${x0} ${y1} ${x0} ${y1 - r}V${y0 + r}Q${x0} ${y0} ${x0 + r} ${y0}Z"/>
    <rect class="spot-glow" x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="${r}" vector-effect="non-scaling-stroke"/>
    <rect class="spot-edge" x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="${r}" vector-effect="non-scaling-stroke"/>`;
}

function openItem(num, info = {}, opts = {}) {
  rememberRecent(num);
  S.item = { num, info, loc: 0, focus: null };
  go('item', S.item, { replace: !!opts.replace });
  renderItem();
}

function openViewerForItem() {
  if (!S.item) return;
  const L = locationsOf(S.item.num)[S.item.loc];
  if (!L) return;
  const page = L.oc ? L.oc.p : L.row ? L.row.p : 0;
  // a list-only article whose number is not on the drawing: the page without a highlight (never the whole shelf)
  const focus = S.item.focus && S.item.focus.page === page ? S.item.focus.box : L.oc ? (L.oc.whole ? null : L.oc.b) : L.row ? L.row.b : null;
  viewer.open(L.e.id, page, focus);
}

// ------------------------------------------------------ barcode not known yet

function renderMissing(code) {
  // a code that is itself an article number is simply not in the planograms on the phone
  if (/^\d{7}$/.test(code)) {
    $('#missing .top-title').textContent = 'Nije pronađeno';
    $('#missingBody').innerHTML = `<div class="missing">
      <div class="missing-ico">${icon('search')}</div>
      <h2>Artikal nije u planogramima</h2>
      <p>Šifre ${esc(code)} nema ni u jednom planogramu na telefonu. Možda je u planogramu koji još nisi dodao.</p>
      <span class="code-big">${esc(code)}</span>
      ${ordersBlock(code)}${ordersBlock(code, { after: true })}
      <button class="btn btn-soft btn-block" type="button" data-add>${icon('plus')}Dodaj planograme</button>
    </div>`;
    $('#missingBody').onclick = null;
    return;
  }
  $('#missing .top-title').textContent = 'Novi barkod';
  $('#missingBody').innerHTML = `<div class="missing">
    <div class="missing-ico">${icon('link')}</div>
    <h2>Poveži ovaj barkod</h2>
    <p>Barkod na proizvodu ne sadrži šifru artikla. Poveži ga jednom i od tada ga @APP@ odmah prepozna.</p>
    <span class="code-big">${esc(code)}</span>
  </div>
  <section class="block">
    <button class="btn btn-primary btn-block" type="button" id="storeGo">${icon('search')}Nađi u StoreFrontu</button>
    <p class="hint store-hint">StoreFront zna ovaj barkod. Prvi put se prijaviš na njihovoj stranici, poslije ide samo.</p>
    <div id="storeBox"></div>
  </section>
  <section class="block">
    <div class="sec-head"><h3>Ili upiši šifru s naljepnice</h3></div>
    <p class="empty" style="margin-bottom:10px">Na naljepnici je to „Product no.“, prvih 7 cifara (npr. 4912611).</p>
    <form class="link-form" id="linkForm" autocomplete="off">
      <input id="linkNum" inputmode="numeric" pattern="[0-9]*" maxlength="7" placeholder="4912611" aria-label="Šifra artikla">
      <button class="btn btn-primary" type="submit">Poveži</button>
    </form>
    <p class="form-msg" id="linkMsg" role="alert"></p>
    <div id="linkPreview"></div>
  </section>
  <section class="block">
    <div class="sec-head"><h3>Ili ga nađi po nazivu</h3></div>
    <form class="search" id="linkSearch" role="search" autocomplete="off">
      ${icon('search', 'search-ico')}
      <input id="linkQ" type="search" enterkeyhint="search" placeholder="Npr. ingar, okvir, korpa" aria-label="Naziv artikla" spellcheck="false" autocapitalize="off" autocorrect="off">
    </form>
    <div id="linkResults"></div>
  </section>`;
  const link = (num) => {
    S.user.learned[code] = num;
    saveUser();
    openItem(num, { via: 'learned', code }, { replace: true });
    toast('Zapamćeno. Sljedeći put ovaj barkod radi odmah.');
  };
  const preview = () => {
    const n = $('#linkNum').value.replace(/\D/g, '');
    const res = n.length === 7 ? core.resolveCode(S.index, n, {}) : null;
    $('#linkMsg').textContent = n.length === 7 && (!res || res.via === 'inside') ? `Šifra ${n} nije u planogramima.` : '';
    $('#linkPreview').innerHTML = res && res.via !== 'inside' ? `<div class="list">${itemRow(res.num, { attr: 'data-link' })}</div>` : '';
  };
  $('#linkNum').addEventListener('input', preview);
  $('#linkForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const n = $('#linkNum').value.replace(/\D/g, '');
    const res = n.length === 7 ? core.resolveCode(S.index, n, {}) : null;
    if (!res || res.via === 'inside') {
      $('#linkMsg').textContent = n.length !== 7 ? 'Šifra artikla ima 7 cifara.' : `Šifra ${n} nije u planogramima.`;
      return;
    }
    link(res.num);
  });
  $('#linkSearch').addEventListener('submit', (ev) => { ev.preventDefault(); $('#linkQ').blur(); });
  $('#linkQ').addEventListener('input', debounce(() => {
    const q = $('#linkQ').value.trim();
    const nums = q ? core.search(S.index, q, 30) : [];
    $('#linkResults').innerHTML = nums.length
      ? `<div class="list">${nums.map((n) => itemRow(n, { attr: 'data-link' })).join('')}</div>`
      : q ? `<p class="empty">Nema artikla „${esc(q)}“.</p>` : '';
  }, 90));
  $('#missingBody').onclick = (ev) => {
    const t = ev.target.closest('[data-link]');
    if (t) link(t.dataset.link);
  };

  // StoreFront: the same barcode, asked where the store system itself knows it
  const box = $('#storeBox');
  const say = (t, cls = '') => { box.innerHTML = `<p class="store-msg ${cls}">${t}</p>`; };
  const storeLine = (x) => {
    const bits = [x.stock ? `Zaliha u prodavnici: ${esc(x.stock)}` : '', x.price ? esc(x.price) : ''].filter(Boolean);
    return `${x.st ? `<span class="pills">${stPill(x.st)}</span>` : ''}${bits.length ? `<span class="store-line">${bits.join(' · ')}</span>` : ''}`;
  };
  S.storeCb = (r) => {
    $('.store-hint').hidden = r.how === 'ok' && (r.results || []).length > 0;
    if (r.how === 'cancelled' || r.how === 'bad') { box.innerHTML = ''; return; }
    if (r.how === 'timeout') { say('StoreFront nije odgovorio na vrijeme. Provjeri vezu i pokušaj ponovo.', 'is-bad'); return; }
    const res = (r.results || []).slice(0, 3);
    if (!res.length) { say(`StoreFront ne nalazi barkod ${esc(code)}.`, 'is-bad'); return; }
    // StoreFront names exactly one article and it is in a planogram: link it and show its place, no extra tap
    if (res.length === 1 && S.index.byNum.has(res[0].num) && top().id === 'missing') { link(res[0].num); return; }
    S.user.store = { ok: true };
    saveUser();
    const rows = res.map((x, i) => {
      const lead = i === 0 && res.length > 1 ? '<span class="pill">Najbolji pogodak</span>' : '';
      if (S.index.byNum.has(x.num)) return itemRow(x.num, { attr: 'data-link', sub: `${lead ? `<span class="pills">${lead}</span>` : ''}${storeLine(x)}` });
      return `<div class="item item-static">${sfThumb(x.num)}<span class="item-main"><span class="code">${esc(x.num)}</span><span class="item-name">${esc(x.name) || 'Bez naziva'}</span><span class="pills"><span class="pill pill-muted">Nije u tvojim planogramima</span>${ordersOf(x.num).length ? '<span class="pill pill-order">Naručio kupac</span>' : ''}</span>${storeLine(x)}</span></div>`;
    });
    const ord = res.map((x, i) => (ordersOf(x.num).length
      ? ordersBlock(x.num, { label: `${x.num} ${x.name || ''}`.trim() })
      : i === 0 ? ordersBlock(x.num, { after: true }) : '')).join('');
    box.innerHTML = `${ord}<p class="store-msg">Dodirni pravi artikal i barkod ${esc(code)} se povezuje s njim.</p><div class="list">${rows.join('')}</div>`;
    if (r.via === 'task') {
      box.insertAdjacentHTML('beforeend', `<div class="stock-box" data-stock="${esc(res[0].num)}">${stockHtml(res[0].num)}</div>`);
      stockLoad(res[0].num);
    }
  };
  // asked in the background with every status code (StoreFront's own search page leaves 81 out); its page only
  // when it wants a sign-in, or on an older version of the app
  const askStore = () => {
    say('Tražim u StoreFrontu…');
    const ok = stCall({ mode: 'find', code }, (r) => {
      const t = top();
      if (t.id !== 'missing' || t.state !== code) return;
      if (r.how === 'login') { A.storefront(code, 'lookup'); return; }
      if (r.how !== 'ok') { say('StoreFront nije odgovorio. Provjeri vezu i pokušaj ponovo.', 'is-bad'); return; }
      const list = (r.res && r.res.list) || [];
      S.storeCb({ how: 'ok', via: 'task', results: list.map((x) => ({ num: x.num, name: x.name, st: x.st, stock: `${whole(x.stock)} ${(x.unit || '').toLowerCase()}`.trim(), price: x.price ? `${money(x.price)} KM` : '' })) });
    });
    if (!ok) A.storefront(code, 'lookup');
  };
  $('#storeGo').addEventListener("click", askStore);
  // after the first successful answer every unknown barcode is asked there without a tap
  if (cfg().auto && ((S.user.store && S.user.store.ok) || A.storeTask) && !S.tried.has(code)) { S.tried.add(code); askStore(); }
}

function openMissing(code, opts = {}) {
  renderMissing(code);
  go('missing', code, opts);
}

// ------------------------------------------------------------------- scanning

function startScan() {
  if (!S.plans.length) {
    toast('Prvo dodaj planograme.');
    return;
  }
  if (A.scanWith) A.scanWith(cfg().vib); else A.scan();
}

function handleCode(code) {
  const c = String(code || '').trim();
  if (!c) return;
  let res = core.resolveCode(S.index, c, S.user.learned);
  if (!res && eanOf(c)) res = core.resolveCode(S.index, c, { [c.replace(/\s+/g, '')]: eanOf(c) });
  const replace = ['item', 'missing'].includes(top().id);
  if (res) openItem(res.num, { via: res.via, code: c, from: res.from }, { replace });
  else openMissing(c, { replace });
}

window.onStorefront = (r) => {
  checkOnline();
  const t = top();
  if (r && t.id === 'missing' && r.query === t.state && S.storeCb) S.storeCb(r);
};

window.onOrders = (r) => {
  checkOnline();
  if (!r || r.how === 'cancelled' || !Array.isArray(r.orders)) return;
  const prevList = (S.user.orders && S.user.orders.list) || [];
  const prev = new Map(prevList.map((x) => [x.no, x]));
  const fresh = r.orders.map((x) => ({ ...x, items: x.items || (prev.get(x.no) || {}).items || null }));
  if (r.how === 'ok') {
    S.user.orders = { at: r.at || Date.now(), list: fresh };
    const withItems = fresh.filter((x) => x.items).length;
    toast(`Narudžbe osvježene: ${fresh.length} (${withItems} s artiklima)`);
    S.site = null;
    setTimeout(syncWatch, 0);
  } else if (fresh.length) {
    const seen = new Set(fresh.map((x) => x.no));
    S.user.orders = { at: (S.user.orders && S.user.orders.at) || r.at || Date.now(), list: [...fresh, ...prevList.filter((x) => !seen.has(x.no))] };
    toast('Pročitano je samo dio narudžbi. Pokušaj opet osvježiti.');
  } else {
    toast('Nisam uspio pročitati narudžbe. Provjeri prijavu u StoreFront.');
  }
  saveUser();
  const t = top();
  if (t.id === 'home') renderHome();
  else if (t.id === 'item' && S.item) renderItem();
};

window.onScan = (r) => {
  if (!r) return;
  if (r.manual) {
    while (S.stack.length > 1) back();
    const q = $('#q');
    q.value = '';
    runSearch();
    setTimeout(() => q.focus(), 60);
    return;
  }
  handleCode(r.code);
};

// ------------------------------------------------------------------- sheet

const sheet = { dismissible: true, resolve: null };

function openSheet({ title, body = '', actions = [], dismissible = true }) {
  sheet.dismissible = dismissible;
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = body;
  const box = $('#sheetActions');
  box.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-block ${a.kind || ''}`;
    b.textContent = a.label;
    b.addEventListener('click', () => a.onClick && a.onClick());
    box.appendChild(b);
  }
  $('#scrim').hidden = false;
  $('#sheet').hidden = false;
}

function closeSheet() {
  $('#scrim').hidden = true;
  $('#sheet').hidden = true;
  if (sheet.resolve) { const r = sheet.resolve; sheet.resolve = null; r(null); }
}

function ask(title, body, choices) {
  return new Promise((resolve) => {
    openSheet({
      title,
      body,
      dismissible: false,
      actions: choices.map((c) => ({
        label: c.label,
        kind: c.kind,
        onClick: () => { sheet.resolve = null; closeSheet(); resolve(c.value); },
      })),
    });
    sheet.resolve = resolve;
  });
}

function progress(title, frac, line) {
  const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
  if ($('#sheet').hidden || !$('#sheetBody .progress')) {
    openSheet({ title, body: '<div class="progress"><i></i></div><p class="prog-line" id="progLine"></p>', dismissible: false });
  }
  $('#sheetTitle').textContent = title;
  $('#sheetBody .progress i').style.width = pct + '%';
  $('#progLine').textContent = line || '';
}

// ------------------------------------------------------------------- import

function addPlanograms(targetId = null) {
  S.importTarget = targetId;
  A.pickPdfs();
}

window.onPicking = (n) => {
  if (S.busy && !S.refreshing) return; // the running import shows its own progress
  progress(n > 1 ? `Uvozim ${n} ${plural(n, 'fajl', 'fajla', 'fajlova')}` : 'Uvozim fajl', 0, 'Kopiram u aplikaciju…');
};

const newId = () => 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

function compactPlace(plan, it) {
  return it.oc.map((o) => {
    const p = core.placeOf(plan, o);
    return { module: p.module, shelf: p.shelf, notch: p.notch, segment: p.segment, fixture: p.fixture };
  });
}

function changesOf(oldPlan, newPlan, codes = null) {
  const d = core.diffPlans(oldPlan, newPlan, codes);
  return {
    added: d.added.map((n) => ({ num: n, nm: newPlan.items[n].nm, to: compactPlace(newPlan, newPlan.items[n]) })),
    removed: d.removed.map((n) => ({ num: n, nm: oldPlan.items[n].nm, from: compactPlace(oldPlan, oldPlan.items[n]) })),
    moved: d.moved.map((m) => ({ num: m.num, nm: newPlan.items[m.num].nm, from: compactPlace(oldPlan, oldPlan.items[m.num]), to: compactPlace(newPlan, newPlan.items[m.num]) })),
  };
}

function metaOf(id, f, plan) {
  const count = Object.values(plan.items).filter((it) => it.oc.length || it.rw.length).length;
  return {
    id,
    name: f.name,
    size: f.size,
    imported: Date.now(),
    key: plan.key,
    title: core.planTitle(plan),
    concept: plan.meta.concept || '',
    deadline: plan.meta.deadline || '',
    sections: [...new Map(plan.meta.sections.map((s) => [s.code + s.name, s])).values()],
    pages: plan.meta.pages,
    count,
    pictures: Object.values(plan.items).filter((it) => it.im).length,
  };
}

/** Saves the article pictures of a planogram; onStep(done, total). */
async function savePictures(id, thumbs, onStep) {
  const list = [...thumbs.entries()];
  const encoded = new Map(); // the same photo is shared by several numbers
  // the pictures are turned into text 16 at a time (in the background), then written in order
  const uniq = [...new Set(list.map(([, b]) => b))];
  for (let i = 0; i < uniq.length; i += 16) {
    const part = uniq.slice(i, i + 16);
    const txt = await Promise.all(part.map((b) => blobToBase64(b)));
    part.forEach((b, j) => encoded.set(b, txt[j]));
  }
  let done = 0;
  for (const [num, blob] of list) {
    A.writeThumb(id, `${num}.webp`, encoded.get(blob));
    done++;
    if (onStep && done % 10 === 0) { onStep(done, list.length); await new Promise((r) => setTimeout(r, 0)); }
  }
}

const queue = []; // { list, target } picked or shared PDFs waiting to be read

window.onPicked = (list) => {
  if (list === null) {
    if (!S.busy) closeSheet();
    toast('Na telefonu nema aplikacije za izbor fajlova.');
    return;
  }
  if (!list || !list.length) { if (!S.busy) closeSheet(); return; }
  queue.push({ list, target: S.importTarget });
  S.importTarget = null;
  if (S.busy) {
    if (S.refreshing) progress('Uvoz čeka', 0, '@APP@ završava slike za stari planogram i odmah nastavlja.');
    else toast('PDF čeka na red, @APP@ ga čita odmah poslije ovog.');
    return;
  }
  drainImports();
};

async function drainImports() {
  if (S.busy || !queue.length) return;
  S.busy = true;
  A.keepScreenOn(true);
  const results = [];
  try {
    while (queue.length) {
      const { list, target, auto } = queue.shift();
      const from = results.length;
      await importList(list, target, results);
      if (auto) afterAutoImport(auto, results, from);
    }
  } finally {
    A.clearInbox(); // only now: files of a queued import are in the inbox too
    A.keepScreenOn(false);
    S.busy = false;
  }
  renderHome();
  if (top().id === 'plans') renderPlans();
  showResults(results);
  pageCache.start(); // the new planograms' pages
}

async function importList(list, forced, results) {
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const title = list.length > 1 ? `Čitam ${i + 1}. od ${list.length}` : 'Čitam planogram';
    if (f.error || !f.file) { results.push({ kind: 'error', name: f.name }); continue; }
    progress(title, 0, f.name);
    let plan, thumbs;
    try {
      ({ plan, thumbs } = await docs.readPlanogram(`/files/inbox/${f.file}`, (frac, p, n, phase) => progress(title, frac * 0.92,
        phase === 'pictures' ? `Slike artikala, stranica ${p} od ${n}` : `${f.name}, stranica ${p} od ${n}`)));
    } catch (e) {
      console.warn('read', f.name, e);
      results.push({ kind: e.message === 'locked' ? 'locked' : 'bad', name: f.name });
      continue;
    }
    const meta0 = metaOf('', f, plan);
    if (!meta0.count) { results.push({ kind: 'notplan', name: f.name }); continue; }
    let target = forced ? S.plans.find((p) => p.id === forced) : S.plans.find((p) => core.samePlanogram(p.plan, plan));
    if (forced && target && !core.samePlanogram(target.plan, plan)) {
      const ok = await ask('Drugi odjel?',
        `<p><b>${esc(f.name)}</b> je planogram za <b>${esc(meta0.title)}</b>, a mijenjaš <b>${esc(target.title)}</b>.</p>`,
        [{ label: `Zamijeni ${target.title}`, value: 'replace', kind: 'btn-primary' }, { label: 'Dodaj kao novi', value: 'add', kind: 'btn-soft' }, { label: 'Preskoči', value: 'skip', kind: 'btn-quiet' }]);
      if (ok === 'skip' || !ok) { results.push({ kind: 'skipped', name: f.name }); continue; }
      if (ok === 'add') target = null;
    }
    if (target && core.deadlineValue(target.deadline) > core.deadlineValue(plan.meta.deadline) && core.deadlineValue(plan.meta.deadline)) {
      const ok = await ask('Ovaj planogram je stariji',
        `<p><b>${esc(f.name)}</b> ima rok ${esc(core.deadlineLabel(plan.meta.deadline))}, a planogram koji već imaš ima rok ${esc(core.deadlineLabel(target.deadline))}.</p>`,
        [{ label: 'Ipak zamijeni', value: 'replace', kind: 'btn-primary' }, { label: 'Zadrži postojeći', value: 'skip', kind: 'btn-soft' }]);
      if (ok !== 'replace') { results.push({ kind: 'skipped', name: f.name }); continue; }
    }
    // a PDF with only some sections of a planogram takes over just those sections
    const partOf = target ? [] : S.plans
      .map((p) => ({ p, codes: core.sharedSections(p.plan, plan) }))
      .filter((x) => x.codes.size);
    const id = newId();
    if (!A.keepPdf(f.file, `${id}.pdf`) || !store.write(`plan-${id}.json`, plan)) {
      dropFiles(id);
      results.push({ kind: 'error', name: f.name });
      continue;
    }
    await savePictures(id, thumbs, (d, n) => progress(title, 0.92 + (0.08 * d) / n, `Spremam slike artikala, ${d} od ${n}`));
    const meta = metaOf(id, f, plan);
    if (target) {
      const ch = changesOf(target.plan, plan);
      S.user.changes[id] = { ...ch, from: target.deadline, to: meta.deadline, at: Date.now(), title: meta.title };
      delete S.user.changes[target.id];
      S.plans = S.plans.map((p) => (p.id === target.id ? { ...meta, plan } : p));
      dropFiles(target.id);
      results.push({ kind: 'replaced', name: f.name, meta, old: target, ch });
    } else {
      let ch = null;
      for (const { p, codes } of partOf) {
        const c = changesOf(p.plan, plan, codes);
        ch = ch ? { added: ch.added.concat(c.added), removed: ch.removed.concat(c.removed), moved: ch.moved.concat(c.moved) } : c;
      }
      if (ch) S.user.changes[id] = { ...ch, from: partOf[0].p.deadline, to: meta.deadline, at: Date.now(), title: meta.title };
      S.plans.push({ ...meta, plan });
      results.push({ kind: 'added', name: f.name, meta, partOf, ch });
    }
    rebuildIndex();
    for (const g of pruneSuperseded()) results.push({ kind: 'pruned', name: g.name, meta: g });
    savePlansList();
    saveUser();
  }
}

function showResults(results) {
  const line = (r) => {
    switch (r.kind) {
      case 'added': {
        let extra = '';
        if (r.partOf && r.partOf.length) {
          const secs = r.meta.sections.map((x) => `${x.code} ${x.name}`).join(', ');
          const n = r.ch ? r.ch.added.length + r.ch.moved.length + r.ch.removed.length : 0;
          extra = `<p>Za ${esc(secs)} sada vrijedi ovaj PDF umjesto ${esc(r.partOf.map((x) => x.p.title).join(', '))}.</p>${n
            ? `<button class="btn btn-small btn-soft" type="button" data-changes="${r.meta.id}">${icon('list')}Pogledaj promjene (${n})</button>` : ''}`;
        }
        return `<div class="result"><b>Dodan: ${esc(r.meta.title)}</b><p>${artikala(r.meta.count)}, ${r.meta.pictures} sa slikom${r.meta.deadline ? `, rok ${esc(core.deadlineLabel(r.meta.deadline))}` : ''}.</p>${extra}</div>`;
      }
      case 'pruned':
        return `<div class="result"><b>Uklonjen stari: ${esc(r.meta.title)}</b><p>Sve iz njega sada pokrivaju noviji planogrami.</p></div>`;
      case 'replaced': {
        const c = r.ch;
        const parts = [];
        if (c.added.length) parts.push(`${c.added.length} ${plural(c.added.length, 'novi', 'nova', 'novih')}`);
        if (c.moved.length) parts.push(`${c.moved.length} ${plural(c.moved.length, 'premješten', 'premještena', 'premještenih')}`);
        if (c.removed.length) parts.push(`${c.removed.length} ${plural(c.removed.length, 'izbačen', 'izbačena', 'izbačenih')}`);
        const dl = r.old.deadline && r.meta.deadline && r.old.deadline !== r.meta.deadline
          ? ` (${esc(core.deadlineLabel(r.old.deadline))} → ${esc(core.deadlineLabel(r.meta.deadline))})` : '';
        return `<div class="result"><b>Zamijenjen: ${esc(r.meta.title)}${dl}</b><p>${parts.length ? parts.join(', ') + '.' : 'Nema promjena u rasporedu.'}</p>${parts.length
          ? `<button class="btn btn-small btn-soft" type="button" data-changes="${r.meta.id}">${icon('list')}Pogledaj promjene</button>` : ''}</div>`;
      }
      case 'checked':
        return `<div class="result"><b>Provjereno ${r.n} ${plural(r.n, 'planogram', 'planograma', 'planograma')} (${esc(r.side)})</b><p>${r.same ? `${r.same} bez promjene. ` : ''}${r.fresh ? `${r.fresh} ${plural(r.fresh, 'novi ili promijenjen', 'nova ili promijenjena', 'novih ili promijenjenih')}.` : 'Nema novih planograma.'}</p></div>`;
      case 'dlerror':
        return `<div class="result"><b>${esc(r.name)}</b><p>Nije preuzet: ${esc(r.why || 'greška')}.</p></div>`;
      case 'notplan':
        return `<div class="result"><b>${esc(r.name)}</b><p>Ne izgleda kao planogram: u njemu nema šifara artikala.</p></div>`;
      case 'locked':
        return `<div class="result"><b>${esc(r.name)}</b><p>PDF je zaključan šifrom.</p></div>`;
      case 'skipped':
        return `<div class="result"><b>${esc(r.name)}</b><p>Preskočen.</p></div>`;
      default:
        return `<div class="result"><b>${esc(r.name)}</b><p>Ovaj PDF se ne može pročitati.</p></div>`;
    }
  };
  const ok = results.filter((r) => r.kind === 'added' || r.kind === 'replaced').length;
  const checked = results.some((r) => r.kind === 'checked');
  openSheet({
    title: checked ? (ok ? 'Novi planogrami su tu' : 'Planogrami su najnoviji') : ok ? (results.length === 1 ? 'Planogram je spreman' : 'Uvoz je gotov') : 'Ništa nije uvezeno',
    body: results.map(line).join(''),
    actions: [{ label: 'U redu', kind: 'btn-primary', onClick: closeSheet }],
  });
}

// ----------------------------------------- planograms read by an older version

/** Reads planograms imported by an older version again from their PDFs, to add the article pictures. */
async function refreshOld() {
  const old = S.plans.filter((p) => (p.plan.v || 1) < docs.PLAN_VERSION);
  if (!old.length || S.busy) return;
  S.busy = true;
  S.refreshing = true;
  const line = $('#workLine');
  const say = (t) => { line.querySelector('span').textContent = t; line.hidden = false; };
  const still = (id) => S.plans.some((x) => x.id === id); // deleted meanwhile?
  try {
    for (const p of old) {
      if (!still(p.id)) continue;
      say(`Pripremam slike artikala, ${p.title}`);
      try {
        const { plan, thumbs } = await docs.readPlanogram(`/files/plans/${p.id}.pdf`, (frac) => {
          say(`Pripremam slike artikala, ${p.title}, ${Math.round(frac * 100)}%`);
        });
        if (!still(p.id)) continue;
        A.removeThumbs(p.id);
        await savePictures(p.id, thumbs);
        if (!still(p.id)) { A.removeThumbs(p.id); continue; }
        if (!store.write(`plan-${p.id}.json`, plan)) continue;
        const cur = S.plans.find((x) => x.id === p.id);
        const meta = { ...metaOf(p.id, cur, plan), imported: cur.imported };
        S.plans = S.plans.map((x) => (x.id === p.id ? { ...meta, plan } : x));
        savePlansList();
        rebuildIndex();
        const t = top();
        if (t.id === 'home') renderHome();
        else if (t.id === 'item') renderItem();
        else if (t.id === 'plans') renderPlans();
      } catch (e) {
        console.warn('refresh', p.id, e);
      }
    }
  } finally {
    line.hidden = true;
    S.busy = false;
    S.refreshing = false;
  }
  drainImports();
}

// -------------------------------------------------------------- planograms

/** Article numbers written out on one card for a status before "+N još". */
const PLAN_CODES = 24;

/** The first page of the planogram that belongs to a section (the chip's section), or the first page. */
function sectionPage(p, s) {
  const secs = (p.plan && p.plan.meta && p.plan.meta.sections) || [];
  const pages = (p.plan && p.plan.pages) || [];
  const i = pages.findIndex((pg) => pg.sec >= 0 && secs[pg.sec] && secs[pg.sec].code === s.code && secs[pg.sec].name === s.name);
  return i < 0 ? 0 : i;
}

/**
 * The list of articles to sell out as the small print of a planogram card: how many have status 21 / 81 (and are in
 * stock), and which. It is the department's list, the same numbers as on the list screen: such an article is often
 * not on the planogram at all (it comes off the shelf when a new planogram arrives), so the planogram's own articles
 * would be the wrong count. `view` is clrView(false): Christmas / New Year articles stay hidden here as everywhere.
 * null = no list for this planogram: it is read for one product group only, the department's own.
 */
function planClear(p, view) {
  const c = clrSrc('home');
  const dept = p.plan && p.plan.meta && p.plan.meta.dept ? parseInt(p.plan.meta.dept.code, 10) : NaN;
  if (dept !== parseInt((c && c.group) || cfg().group, 10)) return null;
  if (!c || !c.list) return { wait: true };
  return { c, by: c.st.map((st) => ({ st, rows: view.list.filter((x) => x.st === st).sort((a, b) => a.num.localeCompare(b.num)) })) };
}

/** The small print under a planogram's name: "5 artikala sa statusom 21 na zalihi", then their numbers. */
function planClearHtml(p, view) {
  const r = planClear(p, view);
  if (!r) return '';
  if (r.wait) {
    return `<div class="plan-st"><p class="plan-st-src">Artikli sa statusom ${clrStatuses().join(' i ')} još nisu učitani · <button class="code-more" type="button" data-open-clear="1">Učitaj</button></p></div>`;
  }
  const lines = r.by.filter((g) => g.rows.length).map((g) => {
    const key = `${p.id}|${g.st}`;
    const open = S.planMore.has(key);
    const shown = open ? g.rows : g.rows.slice(0, PLAN_CODES);
    const rest = g.rows.length - shown.length;
    const more = rest > 0 ? `+${rest} još` : open && g.rows.length > PLAN_CODES ? 'Manje' : '';
    return `<div class="plan-st-line is-st${esc(g.st)}">
      <p class="plan-st-n"><b>${g.rows.length}</b> ${plural(g.rows.length, 'artikal', 'artikla', 'artikala')} sa statusom ${esc(g.st)} na zalihi</p>
      <div class="plan-codes">${shown.map((x) => `<button class="code-link" type="button" data-store="${esc(x.num)}">${esc(x.num)}</button>`).join('')}${more ? `<button class="code-more" type="button" data-codes-more="${esc(key)}">${more}</button>` : ''}</div>
    </div>`;
  });
  const none = lines.length ? '' : `<p class="plan-st-none">Nema artikala sa statusom ${esc(r.c.st.join(' ni '))} na zalihi</p>`;
  const partial = (r.c.limited || []).length || (r.c.short || []).length ? ' · lista nije cijela' : '';
  return `<div class="plan-st">${lines.join('')}${none}<p class="plan-st-src">Iz liste za rasprodaju · ${esc(ageText(r.c.at))}${partial} · <button class="code-more" type="button" data-open-clear="1">Otvori listu</button></p></div>`;
}

function renderPlans() {
  const body = $('#plansBody');
  let h = `<div class="plans-top">
    ${mjOn() ? `<button class="orders-bar" type="button" data-plcheck>${icon('refresh')}<span><b>Provjeri nove planograme</b><small>${esc(planCheckLine())}</small></span><span class="go">Provjeri</span></button>` : ''}
    <button class="btn btn-primary btn-block" type="button" data-add>${icon('plus')}Dodaj planograme</button>
    <p class="hint">Kad stigne novi planogram, samo ga dodaj. @APP@ prepozna isti odjel, zamijeni stari i pokaže šta se promijenilo.</p>
  </div>`;
  if (!S.plans.length) h += '<p class="empty">Još nema planograma.</p>';
  const sorted = S.plans.slice().sort((a, b) => a.title.localeCompare(b.title, 'bs'));
  const view = clrView(false, clrSrc('home'));
  for (const p of sorted) {
    const ch = S.user.changes[p.id];
    const chN = ch ? ch.added.length + ch.removed.length + ch.moved.length : 0;
    const code = /^(\d{2})\b/.exec(p.title);
    const name = p.title.replace(/^\d{2}\s+/, '');
    h += `<article class="plan">
      <h3 class="plan-h"><button class="plan-head" type="button" data-open-plan="${esc(p.id)}" data-page="0" aria-label="Otvori planogram ${esc(name)}">
        <span class="plan-tile">${esc(code ? code[1] : p.title.slice(0, 2))}</span>
        <span class="plan-ttl"><span class="plan-name">${esc(name)}</span>${p.deadline ? `<span class="plan-due">Rok za postavku: ${esc(core.deadlineLabel(p.deadline))}</span>` : ''}</span>
        ${icon('chev', 'chev')}
      </button></h3>
      ${planClearHtml(p, view)}
      <div class="secs">${p.sections.map((s) => `<button class="sec" type="button" data-open-plan="${esc(p.id)}" data-page="${sectionPage(p, s)}"><b>${esc(s.code)}</b>${esc(s.name)}</button>`).join('')}</div>
      <div class="stats">
        <div class="stat"><b>${p.count}</b><span>${plural(p.count, 'artikal', 'artikla', 'artikala')}</span></div>
        <div class="stat"><b>${p.pictures || 0}</b><span>sa slikom</span></div>
        <div class="stat"><b>${p.pages}</b><span>${plural(p.pages, 'stranica', 'stranice', 'stranica')}</span></div>
      </div>
      <p class="plan-foot">${p.concept ? `${esc(p.concept)}, ` : ''}uvezeno ${esc(dateBs(p.imported))}</p>
      <div class="plan-actions">
        <button class="btn btn-small btn-soft" type="button" data-replace="${p.id}">${icon('swap')}Zamijeni novijim</button>
        ${chN ? `<button class="btn btn-small btn-soft" type="button" data-changes="${p.id}">${icon('list')}Promjene (${chN})</button>` : ''}
        <button class="btn btn-small btn-danger" type="button" data-delete="${p.id}">${icon('trash')}Obriši</button>
      </div>
    </article>`;
  }
  const learned = Object.keys(S.user.learned).length;
  if (learned) h += `<p class="hint" style="margin:6px 4px 0">Povezanih barkodova: ${learned}. Pamte se i kad zamijeniš planogram.</p>`;
  body.innerHTML = h;
}

async function deletePlan(id) {
  const p = S.plans.find((x) => x.id === id);
  if (!p) return;
  const ok = await ask(`Obrisati ${p.title}?`, '<p>Artikli iz ovog planograma više se neće pronalaziti. PDF ostaje tamo odakle si ga uvezao.</p>',
    [{ label: 'Obriši', value: true, kind: 'btn-danger' }, { label: 'Odustani', value: false, kind: 'btn-quiet' }]);
  if (!ok) return;
  S.plans = S.plans.filter((x) => x.id !== id);
  delete S.user.changes[id];
  dropFiles(id);
  savePlansList();
  saveUser();
  rebuildIndex();
  renderPlans();
  renderHome();
  toast(`${p.title} je obrisan.`);
}

// ------------------------------------------------------------------ changes

function renderChanges(id) {
  const ch = S.user.changes[id];
  const p = S.plans.find((x) => x.id === id);
  $('#changesTitle').textContent = p ? `Promjene: ${p.title}` : 'Promjene';
  if (!ch) { $('#changesBody').innerHTML = '<p class="empty">Nema zapisanih promjena.</p>'; return; }
  const pl = (x, old = false) => pills(x && x[0] ? x[0] : null).replace('class="pills"', `class="pills${old ? ' is-old' : ''}"`);
  const row = (x, kind) => {
    const known = S.index.byNum.has(x.num);
    const where = kind === 'moved'
      ? `<span class="move">${pl(x.from, true)}${icon('arrow')}${pl(x.to)}</span>`
      : pl(kind === 'added' ? x.to : x.from, kind === 'removed');
    return `<button class="item" type="button" ${known ? `data-num="${esc(x.num)}"` : 'disabled'}>
      ${thumb(x.num)}
      <span class="item-main"><span class="code">${esc(x.num)}</span><span class="item-name">${esc(x.nm) || 'Bez naziva'}</span>${where}</span>
    </button>`;
  };
  const group = (title, list, kind) => (list.length ? `<section class="chg-group"><div class="sec-head"><h3>${title}</h3><span class="count-line" style="margin:0">${list.length}</span></div><div class="list">${list.map((x) => row(x, kind)).join('')}</div></section>` : '');
  const when = ch.from && ch.to && ch.from !== ch.to
    ? `Rok ${esc(core.deadlineLabel(ch.from))} → ${esc(core.deadlineLabel(ch.to))}, zamijenjeno ${esc(dateBs(ch.at))}`
    : `Zamijenjeno ${esc(dateBs(ch.at))}`;
  $('#changesBody').innerHTML = `<p class="chg-when">${when}</p>${group('Premješteni', ch.moved, 'moved')}${group('Novi', ch.added, 'added')}${group('Izbačeni', ch.removed, 'removed')}`;
}

// ------------------------------------------------------------------- viewer

// ------------------------------------------- pictures of whole planogram pages
//
// Drawing a planogram page from its PDF takes a second or more on a phone. Every page is drawn once, kept as a
// picture next to the article pictures (thumbs/<id>-p/) and shown from there afterwards; pages not kept yet are
// drawn quietly in the background while the app is open and nothing else is being read.
const pageCache = (() => {
  const FILE = 'pagecache.json';
  let man = null; // plan id -> { tag, have: { pageIndex: 'webp' | 'jpg' } }
  let full = false; // the phone refused to keep more
  let running = false;
  let hold = 0; // the viewer is drawing a page from the PDF
  const near = []; // [id, page] pages next to the one on screen: drawn first
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = () => man || (man = store.read(FILE, {}) || {});
  const save = debounce(() => store.write(FILE, get()), 1000);
  const dir = (id) => `${id}-p`;
  const dpr = () => Math.min(window.devicePixelRatio || 1, 3);
  /** Width the page is drawn at, in CSS px: sharp enough for a first zoom, the same for every page on this phone. */
  const cssW = () => Math.min(Math.min(screen.width || 400, screen.height || 400) * 2.2, 3600 / dpr());
  const tagOf = (p) => `${Number(p.imported || 0).toString(36)}-${Math.round(cssW() * dpr())}`;

  function entry(p) {
    const m = get();
    const tag = tagOf(p);
    if (!m[p.id] || m[p.id].tag !== tag) {
      if (m[p.id]) A.removeThumbs(dir(p.id)); // drawn for another screen size: draw again
      m[p.id] = { tag, have: {} };
    }
    return m[p.id];
  }
  const plan = (id) => S.plans.find((x) => x.id === id);
  const has = (id, i) => { const p = plan(id); return !!p && !!entry(p).have[i]; };
  const url = (id, i) => { const p = plan(id); const e = entry(p); return `/files/thumbs/${dir(id)}/pg${i}-${e.tag}.${e.have[i]}`; };

  /** The kept picture of a page, decoded, or null. */
  async function load(id, i) {
    if (!has(id, i)) return null;
    const img = new Image();
    img.src = url(id, i);
    try {
      await img.decode();
      return img;
    } catch (e) {
      const p = plan(id);
      if (p) { delete entry(p).have[i]; save(); } // gone from the phone: drawn again
      return null;
    }
  }

  const toBlob = (c, type, q) => new Promise((r) => c.toBlob(r, type, q));

  /** Keeps a page drawn at cssW() (the viewer's base canvas or a background one). */
  async function keep(id, i, canvas) {
    const p = plan(id);
    if (!p || full || entry(p).have[i]) return;
    try {
      let blob = await toBlob(canvas, 'image/webp', 0.8);
      let ext = 'webp';
      if (!blob || blob.type !== 'image/webp') { blob = await toBlob(canvas, 'image/jpeg', 0.85); ext = 'jpg'; }
      if (!blob) return;
      const e = entry(p);
      const b64 = await blobToBase64(blob);
      if (!plan(id) || entry(p) !== e) return; // deleted or replaced meanwhile
      if (!A.writeThumb(dir(id), `pg${i}-${e.tag}.${ext}`, b64)) { full = true; return; }
      e.have[i] = ext;
      save();
    } catch (err) {
      console.warn('pageCache', err);
    }
  }

  async function draw(id, i) {
    const p = plan(id);
    const pg = p && p.plan.pages[i];
    if (!pg) return;
    const doc = await docs.openPlan(id);
    const c = document.createElement('canvas');
    const w = cssW();
    await docs.renderRegion(doc, i + 1, [0, 0, pg.w, pg.h], c, w, (w * pg.h) / pg.w);
    await keep(id, i, c);
    c.width = 1;
    c.height = 1;
  }

  /** What to draw next: pages next to the one on screen, then (only away from articles and the viewer) all others. */
  function next() {
    while (near.length) {
      const [id, i] = near.shift();
      const p = plan(id);
      if (p && i >= 0 && i < p.plan.pages.length && !entry(p).have[i]) return [id, i];
    }
    const t = top().id;
    if (t === 'item' || t === 'viewer') return null; // they read the PDFs themselves; not taken from them
    for (const p of S.plans) {
      const e = entry(p);
      for (let i = 0; i < p.plan.pages.length; i++) if (!e.have[i]) return [p.id, i];
    }
    return null;
  }

  async function loop() {
    if (running) return;
    running = true;
    try {
      for (let idle = 0; idle < 40 && !full; ) {
        if (S.busy || hold || document.hidden) { await sleep(1500); continue; }
        const job = next();
        if (!job) {
          if (top().id !== 'item' && top().id !== 'viewer') break; // all done
          idle++;
          await sleep(1500); // waiting for the employee to leave the article or the viewer
          continue;
        }
        idle = 0;
        try {
          await draw(job[0], job[1]);
        } catch (e) {
          // the PDF was closed by another screen or the page cannot be drawn: tried again next time
          await sleep(1000);
        }
        await sleep(near.length ? 30 : 250);
      }
    } finally {
      running = false;
    }
  }

  return {
    cssW, has, load, keep,
    start() { if (!full) setTimeout(loop, 0); },
    /** The viewer shows page i: the pages before and after it are drawn first. */
    around(id, i) {
      near.length = 0;
      near.push([id, i + 1], [id, i - 1], [id, i + 2]);
      if (!full) loop();
    },
    holdOn() { hold++; },
    holdOff() { hold = Math.max(0, hold - 1); },
    drop(id) {
      const m = get();
      if (m[id]) { delete m[id]; save(); }
      A.removeThumbs(dir(id));
    },
    /** Warms the browser's picture cache, so the next page appears at once. */
    warm(id, i) { if (has(id, i)) { const img = new Image(); img.src = url(id, i); } },
  };
})();

const viewer = (() => {
  const st = { id: null, plan: null, page: 0, focus: null, z: 1, x: 0, y: 0, fitZ: 1, renderTask: null, detailTask: null, token: 0, pointers: new Map(), gesture: null, lastTap: 0 };
  const stage = () => $('#stage');
  const base = () => $('#stageBase');
  const detail = () => $('#stageDetail');
  const mark = () => $('#stageMark');

  function apply() {
    const t = `translate(${st.x}px, ${st.y}px) scale(${st.z})`;
    base().style.transform = t;
    mark().style.transform = t;
    // keep the highlight lines the same thickness on screen at every zoom
    mark().style.setProperty('--k', String(1 / st.z));
  }

  function clamp() {
    const pg = st.plan.pages[st.page];
    const W = stage().clientWidth, H = stage().clientHeight;
    st.z = Math.min(Math.max(st.z, st.fitZ * 0.9), st.fitZ * 14);
    const cw = pg.w * st.z, ch = pg.h * st.z;
    st.x = cw <= W ? (W - cw) / 2 : Math.min(0, Math.max(W - cw, st.x));
    st.y = ch <= H ? (H - ch) / 2 : Math.min(0, Math.max(H - ch, st.y));
  }

  function fit() {
    const pg = st.plan.pages[st.page];
    const W = stage().clientWidth, H = stage().clientHeight;
    st.fitZ = Math.min(W / pg.w, H / pg.h);
    st.z = st.fitZ;
    clamp();
    apply();
  }

  function focusOn(b) {
    const W = stage().clientWidth, H = stage().clientHeight;
    const bw = b[2] - b[0], bh = b[3] - b[1];
    st.z = Math.min(W / (bw * 3.2), H / (bh * 3.2), st.fitZ * 6);
    st.z = Math.max(st.z, st.fitZ * 1.5);
    st.x = W / 2 - ((b[0] + b[2]) / 2) * st.z;
    st.y = H / 2 - ((b[1] + b[3]) / 2) * st.z;
    clamp();
    apply();
  }

  async function drawPage() {
    const token = ++st.token;
    const pg = st.plan.pages[st.page];
    $('#viewerTitle').textContent = `${core.planTitle(st.plan)}${pg.sec >= 0 ? `, ${st.plan.meta.sections[pg.sec].code}` : ''}`;
    $('#pageNo').textContent = `${st.page + 1} / ${st.plan.pages.length}`;
    $('#pagePrev').disabled = st.page === 0;
    $('#pageNext').disabled = st.page >= st.plan.pages.length - 1;
    detail().hidden = true;
    const b = base();
    b.style.width = pg.w + 'px';
    b.style.height = pg.h + 'px';
    const m = mark();
    m.setAttribute('width', pg.w);
    m.setAttribute('height', pg.h);
    m.setAttribute('viewBox', `0 0 ${pg.w} ${pg.h}`);
    m.style.width = pg.w + 'px';
    m.style.height = pg.h + 'px';
    const f = st.focus && st.focus.page === st.page ? st.focus.box : null;
    m.innerHTML = f ? `<rect class="mk-glow" x="${f[0] - 3}" y="${f[1] - 3}" width="${f[2] - f[0] + 6}" height="${f[3] - f[1] + 6}" rx="4"/><rect class="mk-in" x="${f[0] - 3}" y="${f[1] - 3}" width="${f[2] - f[0] + 6}" height="${f[3] - f[1] + 6}" rx="4"/>` : '';
    fit();
    if (f) focusOn(f);
    const id = st.id, page = st.page;
    if (st.renderTask) st.renderTask.cancel();
    // a page drawn before: its kept picture, at once
    const img = pageCache.has(id, page) ? await pageCache.load(id, page) : null;
    if (token !== st.token) return;
    if (img) {
      b.width = img.naturalWidth;
      b.height = img.naturalHeight;
      const ctx = b.getContext('2d', { alpha: false });
      ctx.drawImage(img, 0, 0);
      b.style.width = pg.w + 'px';
      b.style.height = pg.h + 'px';
      $('#stageMsg').hidden = true;
      scheduleDetail();
      afterPage(id, page);
      return;
    }
    $('#stageMsg').hidden = false;
    $('#stageMsg').textContent = 'Crtam stranicu…';
    pageCache.holdOn();
    try {
      const doc = await docs.openPlan(id);
      if (token !== st.token) return;
      // the whole page, sharp enough for a first zoom; detail is drawn on top when zoomed further
      const cssW = pageCache.cssW();
      const cssH = (cssW * pg.h) / pg.w;
      await docs.renderRegion(doc, page + 1, [0, 0, pg.w, pg.h], b, cssW, cssH, { onTask: (t) => { st.renderTask = t; } });
      b.style.width = pg.w + 'px';
      b.style.height = pg.h + 'px';
      if (token !== st.token) return;
      $('#stageMsg').hidden = true;
      pageCache.keep(id, page, b); // the picture is taken now, written while the employee looks
      scheduleDetail();
      afterPage(id, page);
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.warn('viewer', e);
      if (token === st.token) $('#stageMsg').textContent = 'Stranica se ne može prikazati.';
    } finally {
      pageCache.holdOff();
    }
  }

  /** The pages around this one are made ready while the employee looks at it. */
  function afterPage(id, page) {
    pageCache.warm(id, page + 1);
    pageCache.warm(id, page - 1);
    pageCache.around(id, page);
  }

  const scheduleDetail = debounce(async () => {
    if (!st.plan) return;
    const pg = st.plan.pages[st.page];
    const W = stage().clientWidth, H = stage().clientHeight;
    const baseCss = base().width / Math.min(window.devicePixelRatio || 1, 3); // css px of the base render across pg.w
    if (st.z * pg.w <= baseCss * 1.05) { detail().hidden = true; return; }
    const reg = [-st.x / st.z, -st.y / st.z, (W - st.x) / st.z, (H - st.y) / st.z];
    const token = st.token;
    try {
      const doc = await docs.openPlan(st.id);
      if (st.detailTask) st.detailTask.cancel();
      const d = detail();
      const tmp = document.createElement('canvas');
      await docs.renderRegion(doc, st.page + 1, reg, tmp, W, H, { transparent: true, onTask: (t) => { st.detailTask = t; } });
      if (token !== st.token) return;
      d.width = tmp.width;
      d.height = tmp.height;
      const ctx = d.getContext('2d');
      ctx.clearRect(0, 0, d.width, d.height);
      // white page under the drawing, only where the page is
      const s = d.width / (reg[2] - reg[0]);
      ctx.fillStyle = '#fff';
      ctx.fillRect((0 - reg[0]) * s, (0 - reg[1]) * s, pg.w * s, pg.h * s);
      ctx.drawImage(tmp, 0, 0);
      d.hidden = false;
      d.style.zIndex = 1;
      mark().style.zIndex = 2;
    } catch (e) {
      // a newer gesture cancelled this drawing
    }
  }, 160);

  function onDown(e) {
    stage().setPointerCapture(e.pointerId);
    st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    detail().hidden = true;
    if (st.pointers.size === 1) {
      const now = Date.now();
      if (now - st.lastTap < 300) {
        // double tap: zoom in around the finger, or back out
        const r = stage().getBoundingClientRect();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        const nz = st.z > st.fitZ * 1.8 ? st.fitZ : st.z * 2.5;
        st.x = px - ((px - st.x) / st.z) * nz;
        st.y = py - ((py - st.y) / st.z) * nz;
        st.z = nz;
        clamp();
        apply();
        st.lastTap = 0;
        scheduleDetail();
        return;
      }
      st.lastTap = now;
      st.gesture = { kind: 'pan', x: st.x, y: st.y, px: e.clientX, py: e.clientY };
    } else if (st.pointers.size === 2) {
      const [a, b] = [...st.pointers.values()];
      const r = stage().getBoundingClientRect();
      st.gesture = {
        kind: 'pinch', z: st.z, x: st.x, y: st.y,
        d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top,
      };
    }
  }

  function onMove(e) {
    if (!st.pointers.has(e.pointerId)) return;
    st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = st.gesture;
    if (!g) return;
    if (g.kind === 'pan' && st.pointers.size === 1) {
      st.x = g.x + (e.clientX - g.px);
      st.y = g.y + (e.clientY - g.py);
    } else if (g.kind === 'pinch' && st.pointers.size >= 2) {
      const [a, b] = [...st.pointers.values()];
      const r = stage().getBoundingClientRect();
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      const nz = Math.min(Math.max(g.z * (d / g.d), st.fitZ * 0.9), st.fitZ * 14);
      st.x = mx - ((g.mx - g.x) / g.z) * nz;
      st.y = my - ((g.my - g.y) / g.z) * nz;
      st.z = nz;
    }
    clamp();
    apply();
  }

  function onUp(e) {
    st.pointers.delete(e.pointerId);
    if (st.pointers.size === 1 && st.gesture && st.gesture.kind === 'pinch') {
      const [p] = [...st.pointers.values()];
      st.gesture = { kind: 'pan', x: st.x, y: st.y, px: p.x, py: p.y };
    } else if (!st.pointers.size) {
      st.gesture = null;
      scheduleDetail();
    }
  }

  function bind() {
    const s = stage();
    s.addEventListener('pointerdown', onDown);
    s.addEventListener('pointermove', onMove);
    s.addEventListener('pointerup', onUp);
    s.addEventListener('pointercancel', onUp);
    $('#viewerFit').addEventListener('click', () => { fit(); scheduleDetail(); });
    $('#pagePrev').addEventListener('click', () => { if (st.page > 0) { st.page--; drawPage(); } });
    $('#pageNext').addEventListener('click', () => { if (st.page < st.plan.pages.length - 1) { st.page++; drawPage(); } });
    window.addEventListener('resize', debounce(() => { if (st.plan) { clamp(); apply(); scheduleDetail(); } }, 150));
  }

  return {
    bind,
    open(id, page, focus) {
      const p = S.plans.find((x) => x.id === id);
      if (!p) return;
      st.id = id;
      st.plan = p.plan;
      st.page = page;
      st.focus = focus ? { page, box: focus } : null;
      go('viewer', { id, page });
      requestAnimationFrame(() => drawPage());
    },
    close() {
      st.token++;
      if (st.renderTask) st.renderTask.cancel();
      if (st.detailTask) st.detailTask.cancel();
      st.plan = null;
      const b = base();
      b.width = 1;
      b.height = 1;
    },
  };
})();

// ------------------------------------------------------------------- events

function bind() {
  $('#openPlans').addEventListener('click', () => { renderPlans(); go('plans'); });
  $('#clearRefresh').addEventListener('click', () => refreshClearance());
  $('#openSettings').addEventListener('click', () => { renderSettings(); go('settings'); });
  $('#welcomeAdd').addEventListener('click', () => addPlanograms());
  $('#scanBtn').addEventListener('click', startScan);
  for (const b of $$('[data-scan]')) b.addEventListener('click', startScan);
  for (const b of $$('[data-back]')) b.addEventListener('click', () => back());
  $('#attachBody').addEventListener('click', onAttachClick);
  $('#minusRefresh').addEventListener('click', () => loadMinus());
  $('#minusBody').addEventListener('click', onMinusClick);
  $('#attachBack').addEventListener('click', () => { if (S.att && S.att.path) { try { A.myjyskOpen(S.att.path); } catch (e) { /* older shell */ } } else back(); });
  $('#scrim').addEventListener('click', () => { if (sheet.dismissible) closeSheet(); });
  $('#itemViewer').addEventListener('click', openViewerForItem);
  $('#clearRecent').addEventListener('click', () => { S.user.recent = []; saveUser(); renderHome(); });

  const q = $('#q');
  q.addEventListener('input', debounce(runSearch, 90));
  $('#searchForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (S.mode === 'orders') { q.blur(); return; }
    const v = q.value.trim();
    const d = v.replace(/\s/g, '');
    if (/^\d{7,14}$/.test(d)) {
      const res = core.resolveCode(S.index, d, S.user.learned);
      if (res) { q.blur(); openItem(res.num, { via: res.via, code: d, from: res.from }); return; }
      if (d.length >= 8) { q.blur(); openMissing(d); return; }
    }
    const nums = core.search(S.index, v, 2);
    if (nums.length === 1) { q.blur(); openItem(nums[0]); return; }
    q.blur();
  });
  $('#clearQ').addEventListener('click', () => { q.value = ''; runSearch(); q.focus(); });

  // the words that hide Christmas / New Year articles: saved when the field is left; nothing typed brings back the usual ones
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t && t.id === 'mjMe') {
      setCfg({ mjMe: String(t.value || '').replace(/\s+/g, ' ').trim().slice(0, 120) });
      toast('Spremljeno.');
      return;
    }
    if (!t || t.id !== 'xmasWords') return;
    const words = String(t.value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    setCfg({ xmas: words || core.XMAS_WORDS });
    renderSettings();
    renderHome();
    toast(words ? 'Riječi su spremljene.' : 'Vraćene su zadane riječi.');
  });

  $('#auditBody').addEventListener('change', (ev) => {
    const n = ev.target.dataset.auIn;
    if (!n) return;
    S.au.edit[n] = { ...(S.au.edit[n] || {}), [ev.target.dataset.k === 'dm' ? 'dm' : 'sm']: Math.max(0, Math.min(9999, Math.round(+ev.target.value || 0))) };
    delete S.au.move[n];
    S.au.result = null;
    renderAudit();
  });

  // SM screen: a typed value is kept until saved (the list is drawn again only to show the save button)
  $('#smBody').addEventListener('change', (ev) => {
    const n = ev.target.dataset.smIn;
    if (!n) return;
    S.sm.edit[n] = { ...(S.sm.edit[n] || {}), [ev.target.dataset.k === 'dm' ? 'dm' : 'sm']: Math.max(0, Math.min(9999, Math.round(+ev.target.value || 0))) };
    S.sm.result = null;
    renderSm();
  });

  // AR screen: the comments are kept as they are typed, the form can be changed
  $('#arBody').addEventListener('input', (ev) => { const n = ev.target.dataset.arNote; if (n) S.ar.notes[n] = ev.target.value; });
  $('#arBody').addEventListener('change', (ev) => {
    if (ev.target.dataset.ar !== 'form') return;
    setCfg({ arForm: ev.target.value });
    arKept().form = null;
    S.ar.scores = {};
    S.ar.notes = {};
    saveUser();
    arLoad();
  });

  // one listener for every list, button and link that carries data
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-copy],[data-fav],[data-ovw],[data-num],[data-loc],[data-add],[data-replace],[data-delete],[data-changes],[data-unlink],[data-store],[data-orders],[data-oq],[data-mode],[data-set],[data-choice],[data-act],[data-tab],[data-cst],[data-sim],[data-clr-st],[data-clr-sort],[data-clr-dept],[data-clr-dm],[data-clr-xmas],[data-open-plan],[data-open-clear],[data-codes-more],[data-mj],[data-mj-open],[data-mj-x],[data-ar],[data-ar-sc],[data-ar-pick],[data-top],[data-top-days],[data-sm],[data-sm-zero],[data-sm-move],[data-au],[data-au-open],[data-au-go],[data-au-zero],[data-au-move],[data-au-master],[data-grp],[data-stock-retry],[data-plcheck],[data-ploff],[data-big],[data-soon],[data-soon-scope],[data-soon-grp],[data-soon-zero],#ordersBar,#clearBar,#minusBar,#tipsBar,#topBar,#smBar,#soonBar,[data-tip],[data-tip-go],#updateBar,#crop,#openViewer');
    if (!t) return;
    if (t.dataset.big) { sfBig(t.dataset.big, t); return; }
    if (t.dataset.copy) { copyCode(t.dataset.copy); return; }
    if (t.dataset.fav) {
      toggleFav(t.dataset.fav);
      t.setAttribute('aria-pressed', String(isFav(t.dataset.fav)));
      t.textContent = isFav(t.dataset.fav) ? '★' : '☆';
      return;
    }
    if (t.dataset.ovw) { setCfg({ ordCompact: t.dataset.ovw === 'compact' }); runOrdersSearch(); return; }
    if (t.dataset.num) { closeSheet(); openItem(t.dataset.num); return; }
    if (t.dataset.openPlan) { viewer.open(t.dataset.openPlan, +t.dataset.page || 0); return; }
    if (t.dataset.openClear) { openClearance(); return; }
    if (t.dataset.mj || t.dataset.mjOpen || t.dataset.mjX) { onNewsClick(t); return; }
    if (t.dataset.ar || t.dataset.arSc || t.dataset.arPick) { if (t.tagName !== 'SELECT') onArClick(t); return; }
    if (t.hasAttribute('data-plcheck')) { checkPlans(); return; }
    if (t.dataset.ploff) { const off = { ...planOff(), [t.dataset.ploff]: !planOff()[t.dataset.ploff] }; setCfg({ plOff: off }); renderSettings(); return; }
    if (t.dataset.codesMore) {
      if (!S.planMore.delete(t.dataset.codesMore)) S.planMore.add(t.dataset.codesMore);
      renderPlans();
      return;
    }
    if (t.dataset.set || t.dataset.choice || t.dataset.act || t.dataset.tab || t.dataset.cst || t.dataset.sim) { onSettingsClick(t); return; }
    if (t.id === 'clearBar') { openClearance(); return; }
    if (t.id === 'minusBar') { openMinus(); return; }
    if (t.id === 'tipsBar') { openTips(); return; }
    if (t.dataset.tip || t.dataset.tipGo) { onTipClick(t); return; }
    if (t.id === 'topBar') { openTop(); return; }
    if (t.id === 'smBar') { openSm(); return; }
    if (t.id === 'soonBar') { openSoon(); return; }
    if (t.dataset.soon || t.dataset.soonScope || t.dataset.soonGrp || t.dataset.soonZero) { onSoonClick(t); return; }
    if (t.dataset.topDays) { S.topDays = +t.dataset.topDays; renderTop(); return; }
    if (t.dataset.top === 'refresh') { loadTop(); return; }
    if (t.dataset.sm || t.dataset.smZero || t.dataset.smMove) { onSmClick(t); return; }
    if (t.hasAttribute('data-au-master')) { openAudit(); return; }
    if (t.dataset.grp) {
      const off = { ...(cfg().grpOff || {}) };
      if (off[t.dataset.grp]) delete off[t.dataset.grp]; else off[t.dataset.grp] = true;
      setCfg({ grpOff: off });
      const sc = t.dataset.grpScreen;
      if (sc === 'top') loadTop(); else if (sc === 'audit') loadAudit(); else loadSm();
      return;
    }
    if (t.dataset.au || t.dataset.auOpen || t.dataset.auGo || t.dataset.auZero || t.dataset.auMove) { onAuClick(t); return; }
    if (t.dataset.stockRetry) { stockLoad(t.dataset.stockRetry, true); return; }
    if (t.dataset.clrDept) { S.clr.dept = t.dataset.clrDept; S.clr.st = 'all'; S.clr.q = ''; renderClearance(); if (!(clrSrc() && clrSrc().list)) loadClr2(S.clr.dept); return; }
    if (t.dataset.clrDm) { clrDmOff(t.dataset.clrDm); return; }
    if (t.dataset.clrSt) { S.clr.st = t.dataset.clrSt; renderClearance(); return; }
    if (t.dataset.clrSort) { S.clr.sort = t.dataset.clrSort; renderClearance(); return; }
    if (t.dataset.clrXmas) { S.clr.peek = !S.clr.peek; renderClearance(); return; }
    if (t.id === 'updateBar') { installUpdate(); return; }
    if (t.dataset.mode) { setMode(t.dataset.mode); return; }
    if (t.dataset.oq) { $('#q').value = t.dataset.oq; runOrdersSearch(); return; }
    if (t.dataset.orders || t.id === 'ordersBar') { refreshOrders(); return; }
    if (t.dataset.store) { A.storefront(t.dataset.store, 'view'); return; }
    if (t.dataset.unlink) {
      delete S.user.learned[t.dataset.unlink];
      saveUser();
      openMissing(t.dataset.unlink, { replace: true });
      return;
    }
    if (t.dataset.loc !== undefined) { S.item.loc = +t.dataset.loc; renderItem(); return; }
    if (t.hasAttribute('data-add')) { addPlanograms(); return; }
    if (t.dataset.replace) { addPlanograms(t.dataset.replace); return; }
    if (t.dataset.delete) { deletePlan(t.dataset.delete); return; }
    if (t.dataset.changes) { closeSheet(); renderChanges(t.dataset.changes); go('changes', t.dataset.changes); return; }
    if (t.id === 'crop' || t.id === 'openViewer') openViewerForItem();
  });

  viewer.bind();
}

window.appResume = () => {
  // back from another app (e.g. the install permission screen) or after a while: look for updates, at most every 3 h
  if (S.update && S.update.state === 'permission') { renderUpdate(); return; }
  checkOnline();
  if (!S.updChecked || Date.now() - S.updChecked > 3 * 3600 * 1000) checkUpdate(false);
  pickupMyjysk();
  if (S.mode === 'news') freshenMyjysk();
  else renderHome();
};
const applyTheme = () => {
  const t = cfg().theme;
  try { A.setTheme(t); } catch (e) { /* older shell */ }
  document.documentElement.dataset.theme = t === 'dark' ? 'dark' : t === 'light' ? 'light' : (A.isDark() ? 'dark' : 'light');
};
window.themeChanged = () => applyTheme();

function boot() {
  load();
  applyTheme();
  S.mode = cfg().mode === 'orders' ? 'orders' : cfg().mode === 'news' && mjOn() ? 'news' : 'plan';
  pickupMyjysk();
  bind();
  checkOnline();
  // the app stopped working last time: write down which crash it was, switch the background look off once, and show the cause in the settings
  try { S.crash = (A.lastCrash && A.lastCrash()) || ''; } catch (e) { S.crash = ''; }
  if (S.crash) {
    const stamp = S.crash.split('\n')[0];
    if (S.user.crashSeen !== stamp) {
      S.user.crashSeen = stamp;
      if (cfg().watch) setCfg({ watch: false }); else saveUser();
      setTimeout(() => toast('Aplikacija je prošli put prestala raditi. Pozadinska provjera je isključena.'), 1200);
    }
  }
  syncWatch();
  syncMyjysk(false);
  minusOpNow();
  if (sandboxOn()) document.body.classList.add('is-sandbox');
  renderHome();
  if (gateNeeded()) showGate();
  else { try { if (A.loginState && A.loginState() === 'refused') setTimeout(() => toast('StoreFront nije prihvatio sačuvanu lozinku. Upiši je ponovo u Postavke → Prijava.'), 1500); } catch (e) { /* older shell */ } }
  if (S.mode === 'news') freshenMyjysk();
  setTimeout(() => checkUpdate(false), 1500);
  setTimeout(refreshOld, 400);
  setTimeout(() => pageCache.start(), 6000); // pages of all planograms, after the start has settled
  setTimeout(fillMe, 4000);
}

/**
 * Who the employee is in MYJYSK (name, number), for the tasks that name him. It is never built into the app any more:
 * when the settings have nothing yet (a new install, or the update from a build that carried it), it is asked once
 * from StoreFront's own user details and kept on the phone. What the employee typed in Postavke is never replaced.
 */
function fillMe() {
  if (cfg().mjMe != null || !mjOn() || S.meAsked) return;
  S.meAsked = true;
  stCall({ mode: 'me' }, (r) => {
    if (r.how !== 'ok' || !r.res || cfg().mjMe != null) return;
    const v = [r.res.name, r.res.num].map((x) => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ').slice(0, 120);
    if (!v) return;
    setCfg({ mjMe: v });
    if ($('#settings').classList.contains('is-active')) renderSettings();
    renderHome();
  });
}

boot();
