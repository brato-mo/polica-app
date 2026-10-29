// Runs inside the store system's own page (Customer Orders), driven by OrdersActivity. It asks the page's own
// back end for the lists the page itself shows (the same calls, with the employee's own sign-in), so all orders of
// a tab come with their article lines in one answer, without opening each order. Only READS; nothing is sent
// anywhere else: the app polls window.__pol for progress and the final list. If the back end does not answer as
// expected, it hands over to the slower reader that goes through the page (window.__polSlow).
(function () {
  if (window.__pol && window.__pol.run) return;
  var P = window.__pol = { q: 0, tap: null, tapDone: 0, run: true, done: false, err: null, msg: 'API', read: 0, seen: 0, orders: [], tabs: [], fast: true };
  // the more specific tabs first: an order that is in several keeps the first tab it was seen in
  var ORDER = ['Ispunjen', 'Stigao', 'Zakasnio', 'Aktivan'];
  var KEY = { Ispunjen: 'LEGACY_FULFILLED', Stigao: 'LEGACY_ARRIVED_AT_STORE', Zakasnio: 'LEGACY_OVERDUE', Aktivan: 'LEGACY_UNCOMPLETED' };
  var want = window.__polTabs && window.__polTabs.length ? window.__polTabs : ORDER;
  var TABS = ORDER.filter(function (t) { return want.indexOf(t) >= 0; });
  var STATE = {
    CREATED: 'Kreirano',
    IN_TRANSIT: 'U tranzitu',
    ARRIVED_IN_STORE: 'Stiglo u prodavnicu',
    READY_FOR_HANDOUT: 'Spremno za podjelu'
  };
  var PAGE = 500;

  async function get(path) {
    var r = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
  function txt(v) { return v == null ? '' : String(v).trim(); }
  function name(c) {
    if (!c) return '';
    var co = txt(c.companyName);
    if (co) return co;
    return (txt(c.firstName) + ' ' + txt(c.lastName)).trim();
  }
  function date(o) {
    var d = txt(o.expectedPickUpDateFmt);
    return /2099$/.test(d) ? '' : d; // 31.12.2099 is the system's "not known yet"
  }
  function stateText(s) {
    s = txt(s);
    return STATE[s] || s.replace(/_/g, ' ').toLowerCase().replace(/^./, function (c) { return c.toUpperCase(); });
  }
  function toOrder(o, tab) {
    var lines = Array.isArray(o.orderlines) ? o.orderlines : [];
    var items = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i] || {};
      var a = l.article || {};
      var num = txt(a.articleId);
      if (!/^\d{7}$/.test(num)) continue;
      items.push({ num: num, qty: +l.quantity || 0, name: txt(a.title), st: txt(l.orderLineStateText) });
    }
    var c = o.customer || {};
    var ci = c.contactInfo || {};
    return {
      no: '#' + txt(o.orderNumber).replace(/^#/, ''),
      name: name(c),
      status: stateText(o.state),
      date: date(o),
      n: items.length || lines.length,
      tab: tab,
      ph: txt(ci.phone),
      items: items
    };
  }

  (async function () {
    try {
      var u = await get('/api/v1/websapapi/user-details');
      var si = u && u.userDetails && u.userDetails.storeInfo;
      var org = si && txt(si.salesOrganisation);
      var store = si && txt(si.storeId);
      if (!/^[0-9A-Za-z]{1,10}$/.test(org || '') || !/^[0-9A-Za-z]{1,10}$/.test(store || '')) throw new Error('store');
      var base = '/api/v1/customer-order/' + encodeURIComponent(org) + '/' + encodeURIComponent(store) + '/';
      try {
        var tot = await get('/api/v1/customer-order/order-totals/' + encodeURIComponent(org) + '/' + encodeURIComponent(store) + '?source=WSS');
        var ex = 0;
        for (var k = 0; k < (tot || []).length; k++) {
          for (var t in KEY) if (KEY[t] === tot[k].state && TABS.indexOf(t) >= 0) ex += +tot[k].count || 0;
        }
        if (ex > 0) P.expect = ex;
      } catch (e) { /* only for the progress bar */ }
      var seen = {};
      for (var ti = 0; ti < TABS.length; ti++) {
        var tab = TABS[ti];
        P.msg = tab;
        var start = 0, total = -1, got = 0;
        do {
          var j = await get(base + KEY[tab] + '?start=' + start + '&max=' + PAGE + '&orderBy=EXPECTED_PICKUP_DATE&orderByDirection=DESC&source=WSS');
          var list = j && Array.isArray(j.customerOrders) ? j.customerOrders : null;
          if (!list) throw new Error('shape');
          if (j.pagingInfo && typeof j.pagingInfo.total === 'number') total = j.pagingInfo.total;
          for (var i = 0; i < list.length; i++) {
            var o = toOrder(list[i], tab);
            P.seen++;
            if (o.no.length < 9 || seen[o.no]) continue;
            seen[o.no] = 1;
            P.read++;
            P.orders.push(o);
          }
          got += list.length;
          start += PAGE;
        } while (list.length === PAGE && (total < 0 || got < total) && start < 5000);
        P.tabs.push(tab + ':' + got);
      }
      P.done = true;
    } catch (e) {
      // the back end did not answer as expected: read through the page, as before
      if (typeof window.__polSlow === 'function') {
        window.__polFastErr = String(e && e.message ? e.message : e);
        window.__pol = null;
        window.__polSlow();
      } else {
        P.err = String(e && e.message ? e.message : e);
        P.done = true;
      }
    }
  })();
})();
