// @APP@: scan or type an article, see its picture and where it stands on the shelf.
import * as core from './core.js';
import * as store from './store.js';
import * as docs from './docs.js';
import * as news from './news.js';

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
}

function dropFiles(id) {
  A.removePdf(`${id}.pdf`);
  A.removeThumbs(id);
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
  const list = store.read('plans.json', []);
  S.plans = [];
  for (const meta of list) {
    const plan = store.read(`plan-${meta.id}.json`, null);
    if (plan && plan.items) S.plans.push({ ...meta, plan });
  }
  rebuildIndex();
}

/** Every place an article is shown, across all planograms. */
function locationsOf(num) {
  const out = [];
  for (const e of S.index.byNum.get(num) || []) {
    const meta = S.plans.find((p) => p.id === e.id);
    for (const oc of e.it.oc) out.push({ e, meta, oc, place: core.placeOf(e.plan, oc) });
    if (!e.it.oc.length) {
      for (const r of e.it.rw) out.push({ e, meta, row: r, place: null });
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

function thumb(num, cls = '') {
  const src = pictureOf(num);
  return `<span class="thumb ${cls}">${src ? `<img src="${src}" alt="" loading="lazy" decoding="async">` : icon('box')}</span>`;
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
  if (t.id === 'plans') renderPlans();
  if (t.id === 'home') renderHome();
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
        <div><b>${esc(custName(ord))}</b>${ord.ph && cfg().phone ? `<a class="ord-tel" href="tel:${esc(String(ord.ph).replace(/[^\d+]/g, ''))}">${esc(ord.ph)}</a>` : ''}<small>${esc(ord.no.slice(-6))}${ord.date ? ` · dostava ${esc(ord.date)}` : ''}</small>${st === 'Otvoreno' ? '<small class="ord-wait">Nije zaprimljeno: roba još nije stigla ili čeka prijem</small>' : st === 'Popunjeno' ? '<small class="ord-ok">Roba zaprimljena</small>' : st ? `<small>${esc(st)}</small>` : ''}</div>
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
    // different numbers than at the last read: read the new orders now (only if nothing is being typed)
    if (cfg().autoref && siteDiff().length && top().id === 'home' && !$('#q').value.trim() && (!S.autoAt || Date.now() - S.autoAt > 10 * 60 * 1000)) {
      S.autoAt = Date.now();
      refreshOrders();
    }
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
    if (S.updManual) toast('Provjera nije uspjela. Provjeri vezu.');
  } else S.update = r;
  if (r.state !== 'downloading') S.updManual = false;
  renderUpdate();
  if (top().id === 'settings') renderSettings();
};

// ----------------------------------------------- articles to sell out (status 21 / 81)

const CLR_ST = ['21', '81'];
S.clr = { st: 'all', sort: 'stock', q: '', peek: false }; // peek: show the Christmas / New Year articles for now
const clrStatuses = () => CLR_ST.filter((k) => cfg().clr[k]);
const whole = (n) => { try { return Math.round(n).toLocaleString('de-DE'); } catch (e) { return String(Math.round(n)); } };
const money = (n) => { try { return Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch (e) { return Number(n).toFixed(2); } };
const dmy = (s) => String(s || '').replace(/-/g, '.');

function refreshClearance() {
  const st = clrStatuses();
  if (!st.length) { toast('Uključi bar jedan status u postavkama.'); return; }
  if (!A.clearance) { toast('Ova verzija ne zna čitati listu.'); return; }
  A.clearance(JSON.stringify(st), cfg().group);
}

function openClearance() {
  renderClearance();
  go('clearance');
  if (!(S.user.clear && S.user.clear.list)) refreshClearance();
}

/**
 * The stored list as it is shown. What matters is selling the articles off, so an article with nothing in stock never
 * shows (StoreFront is asked for articles in stock, but this does not depend on it). Christmas and New Year articles
 * (a name with one of the words in the settings) are left out too, unless the setting is off or the screen was asked
 * to show them for now (`peek`; the list screen's own switch, other screens pass false). `xmas` counts them, `flag`
 * says which ones they are.
 */
function clrView(peek = S.clr.peek) {
  const c = S.user.clear;
  const all = (c && c.list ? c.list : []).filter(core.inStock);
  const test = cfg().noxmas ? core.wordMatcher(cfg().xmas) : null;
  if (!test) return { list: all, xs: [], xmas: 0, flag: () => false };
  const xs = all.filter((x) => test(x.name));
  const hit = new Set(xs.map((x) => x.num));
  return { list: peek ? all : all.filter((x) => !hit.has(x.num)), xs, xmas: xs.length, flag: (x) => hit.has(x.num) };
}

function renderClearBar() {
  const b = $('#clearBar');
  if (!b) return;
  const has = S.plans.length > 0;
  b.hidden = !has;
  if (!has) return;
  const c = S.user.clear;
  const ic = icon('box');
  if (!c || !c.list) {
    b.innerHTML = `${ic}<span><b>Artikli za rasprodaju</b><small>Status ${clrStatuses().join(' i ')} sa zalihom, iz StoreFronta</small></span><span class="go">Učitaj</span>`;
    return;
  }
  const v = clrView();
  const n = (s) => v.list.filter((x) => x.st === s).length;
  b.innerHTML = `${ic}<span><b>Za rasprodaju: ${v.list.length}</b><small>${c.st.map((k) => `Status ${k}: ${n(k)}`).join(' · ')} · ${esc(ageText(c.at))}</small></span><span class="go">Otvori</span>`;
}

function clrFiltered() {
  const c = S.user.clear;
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
  list.sort((a, b) => (by === 'value' ? val(b) - val(a) : by === 'new' ? core.dateKey(b.chg) - core.dateKey(a.chg) : b.stock - a.stock) || a.name.localeCompare(b.name, 'bs'));
  return list;
}

function clrRow(x, xm) {
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
  const c = S.user.clear;
  if (!c || !$('#clrList')) return;
  const v = clrView();
  const list = clrFiltered();
  const value = list.reduce((s, x) => s + (x.price || 0) * x.stock, 0);
  const usual = cfg().xmas === core.XMAS_WORDS; // with the words of the settings changed the name "Christmas" would not be true
  const here = v.xs.filter((x) => S.clr.st === 'all' || x.st === S.clr.st).length; // in the status that is open
  const xm = here || (S.clr.peek && v.xmas) ? `<button class="clr-xmas" type="button" data-clr-xmas="1">${S.clr.peek
    ? `Prikazani su i ${usual ? 'božićni i novogodišnji' : 'sakriveni po riječima iz postavki'}${here ? `: ${here}` : ''} · Sakrij`
    : `Sakriveno ${usual ? 'božićnih i novogodišnjih' : 'po riječima iz postavki'}: ${here} · Prikaži`}</button>` : '';
  $('#clrSum').innerHTML = `<b>${list.length} ${plural(list.length, 'artikal', 'artikla', 'artikala')}</b><small>Vrijednost zalihe ${whole(value)} KM · ${esc(ageText(c.at))}</small>${xm}`;
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
  const c = S.user.clear;
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
  const sorts = [['stock', 'Zaliha'], ['value', 'Vrijednost'], ['new', 'Novi status']];
  body.innerHTML = `<div class="clr-sum" id="clrSum"></div>
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
  const shown = clrView(false).list.length; // what the list will show: only the ones in stock, without Christmas
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
  autoref: true, // when StoreFront shows different order numbers, read the new orders by itself
  watch: false, // look at the order numbers in the background and send a notification
  clr: { 21: true, 81: true }, // statuses on the list of articles to sell
  group: '5', // product group of that list (5 = the department's own)
  noxmas: true, // leave Christmas and New Year articles out of that list
  xmas: core.XMAS_WORDS, // the words that make a name a Christmas / New Year one
  upd: true, // look for a new version of the app when it is opened
  mj: true, // read MYJYSK every morning at 8:00 and send a notification when there is something new
  mjMe: null, // who the employee is in MYJYSK (names, numbers, comma between); null = what the build says
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
    ${sw('autoref', 'Sam učitaj nove narudžbe', 'Kad se otvori @APP@ i StoreFront pokaže drugačije brojeve, nove narudžbe se same pročitaju (bez dodira)', c.autoref)}
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
    ${act('clear-refresh', 'Učitaj listu sada', S.user.clear && S.user.clear.list ? `${clrView().list.length} artikala, ${esc(ageText(S.user.clear.at))}` : 'Još nije učitana')}
    ${act('clear-clear', 'Obriši listu s telefona', '', true)}
  </div></section>

  ${mjOn() ? `<section class="set-block"><h3>Vijesti (MYJYSK)</h3><div class="set-card">
    ${sw('mj', 'Svako jutro u 8:00', 'Zadaci i vijesti iz MYJYSK se sami učitaju, a obavijest dođe kad ima nešto novo. Android može pomjeriti za koju minutu. Radi dok si prijavljen u MYJYSK.', c.mj)}
    <div class="set-row set-col"><div class="set-txt"><b>Ja u MYJYSK</b><small>Ime i prezime ili broj, odvojeno zarezom. Zadaci na kojima piše ovo idu pod „Za mene“, kao i zadaci za Store Staff i sve uloge.</small></div>
      <input class="set-input" id="mjMe" type="text" value="${esc(mjMe())}" autocapitalize="words" autocorrect="off" spellcheck="false" aria-label="Ja u MYJYSK"></div>
    ${act('mj-refresh', 'Osvježi sada', S.user.mj && S.user.mj.at ? `Stanje ${esc(ageText(S.user.mj.at))}` : 'Još nije učitano')}
  </div></section>

  <section class="set-block"><h3>Planogrami iz MYJYSK</h3><div class="set-card">
    ${choice('plSide', 'Strana trgovine', [['left', 'Lijeva'], ['right', 'Desna']], c.plSide)}
    ${sw('plCompact', 'SC 3.0 Compact trgovina', 'Uključi samo ako je trgovina Compact', c.plCompact)}
    ${planChips()}
    ${act('pl-check', 'Provjeri nove planograme', planCheckLine())}
    ${(() => { try { return A.plansLoginKept && A.plansLoginKept(); } catch (e) { return false; } })() ? act('pl-logout', 'Zaboravi prijavu za planograme', 'Korisničko ime i lozinka se brišu s telefona', true) : ''}
    ${act('mj-clear', 'Obriši vijesti i zadatke s telefona', '', true)}
  </div></section>` : ''}

  <section class="set-block"><h3>Podaci</h3><div class="set-card">
    ${act('plans', 'Planogrami', `${S.plans.length} na telefonu`)}
    ${act('recent', 'Obriši zadnje traženo', `${S.user.recent.length} artikala`, true)}
    ${act('learned', 'Zaboravi povezane barkodove', `${learned} povezanih`, true)}
    ${act('signout', 'Odjavi se iz StoreFronta', 'Sljedeći put se ponovo prijaviš na njihovoj stranici', true)}
  </div></section>

  <section class="set-block"><h3>O aplikaciji</h3><div class="set-card">
    <div class="set-row"><div class="set-txt"><b>@APP@</b><small>Verzija ${esc(A.version())} · ${esc(A.device())}</small></div></div>
    ${S.crash ? `<div class="set-row set-col"><div class="set-txt"><b>Zadnja greška</b><small class="crash">${esc(S.crash.slice(0, 700))}</small></div></div>${act('crash-clear', 'Obriši zapis o grešci', '')}` : ''}
    ${sw('upd', 'Provjeri nove verzije pri otvaranju', 'Nova verzija se sama preuzme, a ti samo potvrdiš instalaciju', c.upd)}
    ${S.update && S.update.state === 'ready' ? act('upd-install', `Instaliraj verziju ${esc(S.update.name || '')}`, 'Spremna je za instalaciju')
      : S.update && S.update.state === 'downloading' ? `<div class="set-row"><div class="set-txt"><b>Preuzimam ${esc(S.update.name || '')}</b><small>${S.update.pct || 0}%</small></div></div>`
      : act('upd-check', 'Provjeri nove verzije sada', '')}
  </div></section>`;
}

function onSettingsClick(t) {
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
    if (a === 'pl-logout') { try { A.plansLogout(); } catch (e) { /* older shell */ } toast('Prijava za planograme je obrisana.'); }
    if (a === 'mj-clear') { S.user.mj = null; saveUser(); store.remove(MJ_FILE); toast('Vijesti i zadaci su obrisani s telefona.'); }
    if (a === 'clear-clear') { S.user.clear = null; saveUser(); toast('Lista je obrisana s telefona.'); }
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
  : st === 'Popunjeno' ? '<span class="ol-st is-ok">zaprimljeno</span>' : st ? `<span class="ol-st">${esc(st)}</span>` : '');

function orderCard(ord, hit) {
  const lines = (ord.items || []).map((it) => `<li class="${hit && hit(it) ? 'is-hit' : ''}"><span class="code">${esc(it.num)}</span><span class="ol-name">${esc(it.name)}</span><span class="ol-q">${it.qty > 0 ? `${it.qty} kom` : ''}</span>${stBadge(it.st)}</li>`).join('');
  return `<article class="ocard">
    <div class="ocard-top"><b>${esc(custName(ord))}</b><span class="ord-chip">${esc(ord.status || ord.tab)}</span></div>
    ${ord.ph && cfg().phone ? `<a class="ord-tel" href="tel:${esc(telOf(ord.ph))}">${esc(ord.ph)}</a>` : ''}
    <small class="ocard-meta">${esc(ord.no.slice(-6))} · ${esc(ord.tab)}${ord.date ? ` · dostava ${esc(ord.date)}` : ''}</small>
    ${lines ? `<ul class="olines">${lines}</ul>` : ''}
  </article>`;
}

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
      const hay = norm(`${ord.name} ${ord.no} ${(ord.items || []).map((it) => it.name).join(' ')}`);
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
  box.innerHTML = `<p class="count-line">${head}${found.length > 40 ? ' (prikazano prvih 40)' : ''} · stanje ${esc(ageText(o.at))}</p>${found.slice(0, 40).map((ord) => orderCard(ord, hit)).join('')}`;
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
// numbers of the last full read, for the enabled tabs: "Aktivan:92,Stigao:45"
const baseCounts = () => {
  const o = S.user.orders;
  if (!o) return '';
  const t = cfg().tabs;
  return TABS_ALL.filter((k) => t[k]).map((k) => `${k}:${o.list.filter((x) => x.tab === k).length}`).join(',');
};
const syncWatch = (ask) => { try { if (A.watch) A.watch(!!cfg().watch, baseCounts(), !!ask); } catch (e) { /* ignore */ } };
// what StoreFront shows now against what was read: [['Aktivan', +3], ...]
function siteDiff() {
  const o = S.user.orders;
  if (!o || !S.site) return [];
  const t = cfg().tabs;
  return TABS_ALL.filter((k) => t[k] && S.site[k] != null)
    .map((k) => [k, S.site[k] - o.list.filter((x) => x.tab === k).length]).filter((x) => x[1] !== 0);
}

function renderOrdersBar() {
  const b = $('#ordersBar');
  const has = S.plans.length > 0;
  b.hidden = !has;
  if (!has) return;
  const o = S.user.orders;
  const ic = icon('info');
  if (!o) {
    b.innerHTML = `${ic}<span><b>Narudžbe kupaca</b><small>Učitaj iz StoreFronta, pa @APP@ javi kad je artikal naručen</small></span><span class="go">Učitaj</span>`;
  } else {
    const c = (t) => o.list.filter((x) => x.tab === t).length;
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
  S.mj.busy = !visible;
  try { A.myjysk(!!visible); } catch (e) { S.mj.busy = false; toast('Ova verzija aplikacije ne zna čitati MYJYSK.'); }
  if (S.mode === 'news') renderNews();
}

window.onMyjysk = (r) => {
  S.mj.busy = false;
  const after = S.mj.after;
  if (after === 'plans' && r && r.how !== 'login') S.mj.after = null;
  if (r && r.how === 'ok') {
    takeMyjysk(r);
    store.write(MJ_FILE, { how: 'ok', at: +r.at || Date.now(), data: r.data });
  } else if (r && r.how === 'login') {
    if (!S.user.mj) S.user.mj = { at: 0, my: [], loc: [], news: [], sys: [], seen: {} };
    S.user.mj.login = true;
    saveUser();
  } else if (r && r.how === 'error') {
    toast('MYJYSK nije odgovorio. Pokušaj malo kasnije.');
  }
  renderHome();
  if ($('#settings').classList.contains('is-active')) renderSettings();
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
  </button>${open ? `<div class="mj-text">${esc(a.text) || 'Bez teksta u pregledu.'}${a.path ? `<br><button class="text-btn" type="button" data-mj-open="${esc(a.path)}">Otvori cijelu vijest u MYJYSK</button>` : ''}</div>` : ''}</div>`;
}

function renderNews() {
  const box = $('#newsWrap');
  const st = S.user.mj;
  const busy = S.mj.busy;
  const stateLine = `<div class="mj-state"><span>${busy ? '<i class="mj-busy"></i>Učitavam iz MYJYSK…' : st && st.at ? `Stanje ${esc(ageText(st.at))}${cfg().mj ? ' · samo se osvježi u 8:00' : ''}` : ''}</span>${busy ? '' : '<button class="text-btn" type="button" data-mj="refresh">Osvježi</button>'}</div>`;
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
  </button>${open ? `<div class="mj-text">${esc(x.text) || ''}${go ? `${x.text ? '<br>' : ''}${go}` : ''}</div>` : ''}</div>`;
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
  if (a === 'refresh') refreshMyjysk(false);
  else if (a === 'login') refreshMyjysk(true);
  else if (a === 'more') { S.mj.more = !S.mj.more; renderNews(); }
  else if (a === 'imp-more') { S.mj.impMore = !S.mj.impMore; renderNews(); }
  else if (a.startsWith('loc-')) { S.mj.loc = a.slice(4); renderNews(); }
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
  $('#homeStats').textContent = has && S.mode === 'orders'
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
    for (const id of ['#welcome', '#searchForm', '#homeDock', '#results', '#recentWrap', '#ordersBar', '#clearBar']) $(id).hidden = true;
    for (const b of $$('#modeSeg [data-mode]')) b.setAttribute('aria-selected', String(b.dataset.mode === S.mode));
    renderNews();
    return;
  }
  $('#welcome').hidden = has;
  $('#searchForm').hidden = !has;
  $('#homeDock').hidden = !has;
  const q = $('#q').value.trim();
  $('#results').hidden = !has || !q;
  $('#recentWrap').hidden = !has || !!q;
  const recent = S.user.recent.filter((r) => S.index.byNum.has(r.num));
  $('#recent').innerHTML = recent.length ? `<div class="list">${recent.map((r) => itemRow(r.num)).join('')}</div>` : '';
  renderOrdersBar();
  renderClearBar();
  $('#recentEmpty').hidden = recent.length > 0;
  $('#recentHead').hidden = recent.length === 0;
  for (const b of $$('#modeSeg [data-mode]')) b.setAttribute('aria-selected', String(b.dataset.mode === S.mode));
  $('#q').placeholder = S.mode === 'orders' ? 'Šifra artikla, ime kupca ili telefon' : 'Šifra ili naziv artikla';
  if (S.mode === 'orders' && has) { runOrdersSearch(); return; }
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
      ${thumb(num, 'thumb-lg')}
      <div class="head-text">
        <span class="code-chip">${esc(num)}</span>
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
      <div class="loc-foot"><p>${whereText(p)}</p>${sideView(plan, L.oc, p)}</div>
    </div>`;
  } else if (L.row) {
    h += `<div class="loc loc-off">
      <div class="loc-grid"><div style="grid-column: span 3"><span>Na listi artikala</span><b class="is-long">${esc(L.row.fx || 'Bez mjesta')}</b></div></div>
      <div class="loc-foot"><p>Ovaj artikal je samo na listi, nije nacrtan na polici.</p></div>
    </div>`;
  } else {
    h += '<div class="loc loc-off"><div class="loc-foot" style="margin:0;padding:0;border:0"><p>Ovaj artikal se spominje u planogramu, ali nema svoje mjesto na crtežu.</p></div></div>';
  }
  h += `<button class="btn btn-soft btn-block btn-small store-btn" type="button" data-store="${esc(num)}">${icon('link')}Cijena i zaliha u StoreFrontu</button>`;
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
  const key = L.oc ? `${L.e.id}:${L.oc.p}:${L.oc.b.join(',')}` : null;
  let blk = L.oc ? (L.oc.k || blockCache.get(key) || null) : null;
  const target = L.oc ? L.oc.b : L.row.b;
  const doc = await docs.openPlan(L.e.id);
  if (token !== cropToken) return;
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
  const guess = blk || [target[0] - 10, target[1] - 50, target[2] + 10, target[3] + 30];
  let reg = region(guess);
  const canvas = $('#crop canvas');
  const r = await docs.renderRegion(doc, pageIdx + 1, reg, canvas, cw, ch, { maxDpr: 2.5 });
  if (token !== cropToken) return;
  if (L.oc && !blk) {
    blk = docs.blockFor(plan, L.oc, r.photos);
    if (!blk) {
      try { blk = docs.blockFor(plan, L.oc, await docs.photosOf(doc, pageIdx + 1)); } catch (e) { blk = null; }
    }
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
  const focus = S.item.focus && S.item.focus.page === page ? S.item.focus.box : L.oc ? L.oc.b : L.row ? L.row.b : null;
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
    return bits.length ? `<span class="store-line">${bits.join(' · ')}</span>` : '';
  };
  S.storeCb = (r) => {
    $('.store-hint').hidden = r.how === 'ok' && (r.results || []).length > 0;
    if (r.how === 'cancelled' || r.how === 'bad') { box.innerHTML = ''; return; }
    if (r.how === 'timeout') { say('StoreFront nije odgovorio na vrijeme. Provjeri vezu i pokušaj ponovo.', 'is-bad'); return; }
    const res = (r.results || []).slice(0, 3);
    if (!res.length) { say(`StoreFront ne nalazi barkod ${esc(code)}.`, 'is-bad'); return; }
    S.user.store = { ok: true };
    saveUser();
    const rows = res.map((x, i) => {
      const lead = i === 0 && res.length > 1 ? '<span class="pill">Najbolji pogodak</span>' : '';
      if (S.index.byNum.has(x.num)) return itemRow(x.num, { attr: 'data-link', sub: `${lead ? `<span class="pills">${lead}</span>` : ''}${storeLine(x)}` });
      return `<div class="item item-static"><span class="thumb">${icon('box')}</span><span class="item-main"><span class="code">${esc(x.num)}</span><span class="item-name">${esc(x.name) || 'Bez naziva'}</span><span class="pills"><span class="pill pill-muted">Nije u tvojim planogramima</span>${ordersOf(x.num).length ? '<span class="pill pill-order">Naručio kupac</span>' : ''}</span>${storeLine(x)}</span></div>`;
    });
    const ord = res.map((x, i) => (ordersOf(x.num).length
      ? ordersBlock(x.num, { label: `${x.num} ${x.name || ''}`.trim() })
      : i === 0 ? ordersBlock(x.num, { after: true }) : '')).join('');
    box.innerHTML = `${ord}<p class="store-msg">Dodirni pravi artikal i barkod ${esc(code)} se povezuje s njim.</p><div class="list">${rows.join('')}</div>`;
  };
  const askStore = () => { say('Tražim u StoreFrontu…'); A.storefront(code, 'lookup'); };
  $('#storeGo').addEventListener("click", askStore);
  // after the first successful answer every unknown barcode is asked there without a tap
  if (cfg().auto && S.user.store && S.user.store.ok && !S.tried.has(code)) { S.tried.add(code); askStore(); }
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
  const res = core.resolveCode(S.index, c, S.user.learned);
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
  let done = 0;
  for (const [num, blob] of list) {
    if (!encoded.has(blob)) encoded.set(blob, await blobToBase64(blob));
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
  const c = S.user.clear;
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
  const view = clrView(false);
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
    $('#stageMsg').hidden = false;
    $('#stageMsg').textContent = 'Crtam stranicu…';
    try {
      const doc = await docs.openPlan(st.id);
      if (token !== st.token) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      // the whole page, sharp enough for a first zoom; detail is drawn on top when zoomed further
      const cssW = Math.min(stage().clientWidth * 2.2, 3600 / dpr);
      const cssH = (cssW * pg.h) / pg.w;
      if (st.renderTask) st.renderTask.cancel();
      await docs.renderRegion(doc, st.page + 1, [0, 0, pg.w, pg.h], b, cssW, cssH, { onTask: (t) => { st.renderTask = t; } });
      b.style.width = pg.w + 'px';
      b.style.height = pg.h + 'px';
      if (token !== st.token) return;
      $('#stageMsg').hidden = true;
      scheduleDetail();
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.warn('viewer', e);
      $('#stageMsg').textContent = 'Stranica se ne može prikazati.';
    }
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

  // one listener for every list, button and link that carries data
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-num],[data-loc],[data-add],[data-replace],[data-delete],[data-changes],[data-unlink],[data-store],[data-orders],[data-oq],[data-mode],[data-set],[data-choice],[data-act],[data-tab],[data-cst],[data-clr-st],[data-clr-sort],[data-clr-xmas],[data-open-plan],[data-open-clear],[data-codes-more],[data-mj],[data-mj-open],[data-mj-x],[data-plcheck],[data-ploff],#ordersBar,#clearBar,#updateBar,#crop,#openViewer');
    if (!t) return;
    if (t.dataset.num) { closeSheet(); openItem(t.dataset.num); return; }
    if (t.dataset.openPlan) { viewer.open(t.dataset.openPlan, +t.dataset.page || 0); return; }
    if (t.dataset.openClear) { openClearance(); return; }
    if (t.dataset.mj || t.dataset.mjOpen || t.dataset.mjX) { onNewsClick(t); return; }
    if (t.hasAttribute('data-plcheck')) { checkPlans(); return; }
    if (t.dataset.ploff) { const off = { ...planOff(), [t.dataset.ploff]: !planOff()[t.dataset.ploff] }; setCfg({ plOff: off }); renderSettings(); return; }
    if (t.dataset.codesMore) {
      if (!S.planMore.delete(t.dataset.codesMore)) S.planMore.add(t.dataset.codesMore);
      renderPlans();
      return;
    }
    if (t.dataset.set || t.dataset.choice || t.dataset.act || t.dataset.tab || t.dataset.cst) { onSettingsClick(t); return; }
    if (t.id === 'clearBar') { openClearance(); return; }
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
  renderHome();
  if (S.mode === 'news') freshenMyjysk();
  setTimeout(() => checkUpdate(false), 1500);
  setTimeout(refreshOld, 400);
}

boot();
