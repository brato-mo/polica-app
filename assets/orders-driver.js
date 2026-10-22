// Runs inside the store system's own page (Customer Orders), driven by OrdersActivity. It only READS what the
// signed-in employee can already see: for the tabs "Ispunjen" and "Stigao" it goes through the list pages, opens
// each order that is not known yet, and notes the article numbers and quantities. Nothing is sent anywhere:
// the app polls window.__pol for progress and the final list.
(function () {
  if (window.__pol && window.__pol.run) return;
  var known = window.__polKnown || [];
  var P = window.__pol = { q: 0, tap: null, tapDone: 0, run: true, done: false, err: null, msg: '', read: 0, seen: 0, orders: [], tabs: [] };
  // the more specific tabs first: an order that is in several keeps the first tab it was seen in
  var TABS = window.__polTabs && window.__polTabs.length ? window.__polTabs : ['Ispunjen', 'Stigao', 'Zakasnio', 'Aktivan'];

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function lines(el) {
    return (el.innerText || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function visible(e) { var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  // the innermost visible elements whose own text passes the test
  function leaves(test) {
    var all = document.querySelectorAll('button,a,div,span,li,p,h1,h2,h3,td,[role=tab]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      var t = (e.innerText || '').trim();
      if (!t || t.length > 60 || !test(t)) continue;
      var deeper = false;
      for (var c = e.firstElementChild; c; c = c.nextElementSibling) {
        if (test((c.innerText || '').trim())) { deeper = true; break; }
      }
      if (!deeper && visible(e)) out.push(e);
    }
    return out;
  }
  function readList() {
    var l = lines(document.body);
    var cards = [];
    var tail = -1;
    for (var i = 2; i < l.length; i++) {
      if (!/^#[0-9A-Za-z]{8,30}$/.test(l[i])) continue;
      var n = /^(\d+) Artikli$/.exec(l[i + 2] || '');
      var d = /^Očekivana dostava:\s*(\S+)/.exec(l[i + 3] || '');
      cards.push({ no: l[i], name: l[i - 2] || '', status: l[i - 1] || '', n: n ? +n[1] : 0, date: d ? d[1] : '' });
      tail = i + 3;
    }
    var pages = [];
    for (var j = tail + 1; j < l.length; j++) if (/^\d{1,3}$/.test(l[j])) pages.push(+l[j]);
    var all = document.body.innerText;
    var tot = /(\d+)\s+narud\S*\s+prona/i.exec(all);
    var tabCount = {};
    for (var k = 0; k < l.length; k++) {
      var m = /^(Ispunjen|Stigao|Zakasnio|Aktivan) \((\d+)\)$/.exec(l[k]);
      if (m && tabCount[m[1]] == null) tabCount[m[1]] = +m[2];
    }
    return { cards: cards, pages: pages, total: tot ? +tot[1] : -1, tabCount: tabCount };
  }
  async function until(test, ms, what) {
    var t0 = Date.now();
    for (;;) {
      var v = test();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('timeout: ' + what);
      await sleep(250);
    }
  }
  function parseItems(l) {
    var out = [];
    for (var i = 0; i < l.length; i++) {
      var m = /^(\d{7}) \((\d+)\)$/.exec(l[i]);
      if (!m) continue;
      var qty = 0, st = '';
      for (var j = i + 1; j <= i + 6 && j < l.length && !/^\d{7} \(/.test(l[j]); j++) {
        var q = /^(\d+)\s*[A-Za-z]{1,5}$/.exec(l[j]);
        var split = !q && /^\d+$/.test(l[j]) && /^[A-Za-z]{1,5}$/.test(l[j + 1] || '');
        if (q || split) {
          qty = +(q ? q[1] : l[j]);
          var nx = j + (split ? 2 : 1);
          st = l[nx] && !/^\d{7} \(/.test(l[nx]) && /^[^\d]{3,30}$/.test(l[nx]) && l[nx] !== 'Ukupno' ? l[nx] : '';
          break;
        }
      }
      out.push({ num: m[1], qty: qty, name: i > 0 ? l[i - 1] : '', st: st });
    }
    return out;
  }
  function dialog() { return document.querySelector('[role=dialog]'); }

  // A real touch, injected by the app at the element's position (the page may ignore scripted clicks).
  async function nativeTap(el) {
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    await sleep(250);
    var r = el.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var q = ++P.q;
    P.tap = { x: (r.left + r.width / 2) * dpr, y: (r.top + r.height / 2) * dpr, q: q };
    var t0 = Date.now();
    while (P.tapDone !== q && Date.now() - t0 < 4000) await sleep(80);
    P.tap = null;
  }
  function eventClick(el) {
    var r = el.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0 };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
      el.dispatchEvent(new (t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent)(t, o));
    });
  }
  // tries the ways of pressing a button in turn; remembers the one that worked
  var way = 0;
  async function press(el, done) {
    for (var w = way; w < 3; w++) {
      if (w === 0) el.click();
      else if (w === 1) eventClick(el);
      else await nativeTap(el);
      for (var k = 0; k < 8; k++) {
        await sleep(250);
        if (done()) { way = w; return true; }
      }
    }
    return false;
  }
  async function closeDialog() {
    var d = dialog();
    if (!d) return;
    var b = d.querySelector('button');
    var gone = function () { return !dialog(); };
    if (b) {
      if (b.click(), await until2(gone, 1500)) return;
      eventClick(b);
      if (await until2(gone, 1500)) return;
      await nativeTap(b);
      if (await until2(gone, 2000)) return;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    if (await until2(gone, 1500)) return;
    throw new Error('dialog stays open');
  }
  async function until2(test, ms) {
    var t0 = Date.now();
    while (Date.now() - t0 < ms) { if (test()) return true; await sleep(150); }
    return test();
  }
  async function readOrder(card) {
    var els = leaves(function (t) { return t === card.no; });
    if (!els.length) return null;
    var btn = els[0].closest('button') || els[0];
    var ok = await press(btn, function () { return !!dialog(); });
    if (!ok) return null;
    var items = null;
    var ph = '';
    var last = null, stable = 0;
    for (var k = 0; k < 28; k++) {
      var d = dialog();
      if (d) {
        var l = lines(d);
        if (l.indexOf(card.no) >= 0) {
          var pi = l.indexOf('Broj telefona');
          if (pi >= 0 && /^[+\d][\d\s\/+()-]{5,24}$/.test(l[pi + 1] || '')) ph = l[pi + 1];
          var it = parseItems(l);
          if (it.length) {
            items = it;
            // the quantity and state of a line are drawn after its number: wait until they are all there
            var full = it.length >= card.n && it.every(function (x) { return x.qty > 0 && x.st; });
            var key = JSON.stringify(it);
            stable = key === last ? stable + 1 : 0;
            last = key;
            if (full && stable >= 1) break;
            if (stable >= 6) break; // nothing changes any more: take what there is
          }
        }
      }
      await sleep(250);
    }
    P.lastPh = ph;
    await closeDialog();
    return items;
  }

  (async function () {
    try {
      var seenNo = {};
      var fails = 0;
      for (var ti = 0; ti < TABS.length; ti++) {
        var tab = TABS[ti];
        P.msg = tab;
        try {
        var list;
        try {
          list = await until(function () { var r = readList(); return r.tabCount[tab] != null ? r : null; }, ti === 0 ? 30000 : 6000, 'list');
        } catch (e) {
          if (ti === 0) throw e;
          continue; // a tab this page version does not have
        }
        var want = list.tabCount[tab];
        var tabEls = leaves(function (t) { return t === tab + ' (' + want + ')'; });
        if (!tabEls.length) throw new Error('tab ' + tab);
        var tabOk = function () {
          var r = readList();
          return r.total === want && (r.cards.length > 0 || want === 0);
        };
        await press(tabEls[0].closest('button') || tabEls[0], tabOk);
        await until(tabOk, 20000, 'tab ' + tab);
        P.tabs.push(tab + ':' + want);
        P.expect = (P.expect || 0) + want;
        var page = 1;
        for (;;) {
          var cur = readList();
          for (var ci = 0; ci < cur.cards.length; ci++) {
            var c = cur.cards[ci];
            if (seenNo[c.no]) continue;
            seenNo[c.no] = 1;
            P.seen++;
            var o = { no: c.no, name: c.name, status: c.status, date: c.date, n: c.n, tab: tab, items: null };
            if (known.indexOf(c.no) < 0) {
              P.msg = tab + ' ' + c.no.slice(-6);
              o.items = await readOrder(c);
              o.ph = P.lastPh || '';
              if (o.items) { P.read++; fails = 0; }
              else if (++fails >= 4 && P.read === 0) throw new Error('orders do not open');
            }
            P.orders.push(o);
          }
          var next = page + 1;
          if (cur.pages.indexOf(next) < 0) break;
          var firstNo = cur.cards.length ? cur.cards[0].no : '';
          var pe = leaves(function (t) { return t === String(next); });
          if (!pe.length) throw new Error('page ' + next);
          var pageOk = function () {
            var r = readList();
            return r.cards.length > 0 && r.cards[0].no !== firstNo;
          };
          var pb = pe[pe.length - 1];
          await press(pb.closest('button') || pb, pageOk);
          await until(pageOk, 20000, 'page ' + next);
          page = next;
        }
        } catch (e) {
          if (ti === 0) throw e;
          P.warn = String(e && e.message ? e.message : e); // a later tab failed: keep what was read
        }
      }
      P.done = true;
    } catch (e) {
      P.err = String(e && e.message ? e.message : e);
      P.done = true;
    }
  })();
})();
