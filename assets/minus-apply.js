// Runs inside the store system's own page (StoreFront), driven by MinusApply, after the employee typed their own
// SAP HR number and password in the app and confirmed the list of corrections. It does what StoreFront's own
// Minus lista and Regulacija zalihe pages do on "approve": checks the user, then sends the corrections.
// Before sending it reads the minus list again and sends only the lines that still stand exactly as the employee
// saw them (nothing is corrected twice). Result in window.__mx; the credentials are dropped from the page at once.
(function () {
  var IN = window.__mxIn;
  window.__mxIn = null;
  if (!IN || window.__mx && window.__mx.state === 'busy') return;
  window.__mx = { state: 'busy', step: 'start' };
  var user = String(IN.user || ''), pass = String(IN.pass || '');
  IN.pass = null;
  function s(v, n) { v = v == null ? '' : String(v).trim(); return v.length > n ? v.slice(0, n) : v; }
  function req(method, u, body) {
    return fetch(u, {
      method: method, credentials: 'same-origin',
      headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json', suppressMessages: 'true' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  function json(r) {
    if (r.status === 401 || r.status === 403) throw 'login';
    if (!r.ok) throw 'http ' + r.status;
    return r.json();
  }
  function done(o) { user = pass = ''; window.__mx = o; }
  var store = '', catalog = '';
  req('GET', '/api/v1/websapapi/user-details').then(json).then(function (u) {
    var si = u && u.userDetails && u.userDetails.storeInfo;
    store = si && s(si.storeId, 10);
    catalog = si && s(si.catalogId, 30);
    if (!/^[0-9A-Za-z]{1,10}$/.test(store || '') || !/^[0-9A-Za-z-]{1,30}$/.test(catalog || '')) throw 'store';
    return req('GET', '/api/v1/minus-list/' + encodeURIComponent(store) + '?include=Article').then(json);
  }).then(function (list) {
    var now = {};
    (list || []).forEach(function (x) { now[s(x.articleId, 10)] = +x.totalStock; });
    // the lines that still stand as the employee saw them: same minus, and the replacement still has the stock
    return Promise.all(IN.items.map(function (it) {
      if (now[it.num] !== it.qty) return Promise.resolve({ it: it, ok: false, why: 'promijenjeno' });
      return req('GET', '/api/v1/article/masterdata?article=' + it.num + '&catalog=' + encodeURIComponent(catalog) + '&store=' + encodeURIComponent(store) + '&include=SubstitutionChainSmDm')
        .then(json).then(function (j) {
          var a = Array.isArray(j) ? j[0] : j;
          var c = ((a && a.substitutionChain) || []).filter(function (z) { return s(z.articleNumber, 10) === it.target; })[0];
          var st = c && c.smDmData && typeof c.smDmData.stock === 'number' ? c.smDmData.stock : c && c.atp ? c.atp.quantity : null;
          return { it: it, ok: typeof st === 'number' && st >= Math.abs(it.qty), why: 'zaliha zamjene se promijenila' };
        });
    }));
  }).then(function (checked) {
    var go = checked.filter(function (x) { return x.ok; }).map(function (x) { return x.it; });
    var skipped = checked.filter(function (x) { return !x.ok; }).map(function (x) { return { num: x.it.num, why: x.why }; });
    if (!go.length) { done({ state: 'ok', sent: [], skipped: skipped }); return; }
    window.__mx.step = 'user';
    // the same checks StoreFront's approve dialog makes, in the same order
    return req('POST', '/api/v1/validate-sap-user/validate-non-store-user', { username: user }).then(function (r) {
      if (r.status === 401) throw 'nonstore';
      if (!r.ok) throw 'http ' + r.status;
      return req('POST', '/api/v1/validate-sap-user/validate-user-in-correct-store', { username: user, currentStore: store });
    }).then(function (r) {
      if (r.status === 401) throw 'wrongstore';
      if (!r.ok) throw 'http ' + r.status;
      return req('POST', '/api/v1/validate-sap-user', { username: user, password: pass });
    }).then(function (r) {
      if (r.status === 401) throw 'auth';
      if (!r.ok) throw 'http ' + r.status;
      window.__mx.step = 'minus';
      // 1. Minus lista: the number in minus counted 0, as the Minus lista page sends it (reason 103, quantity =
      // counted - stock)
      return req('POST', '/api/v1/stock-adjustments', {
        username: user, password: pass, storeId: store, module: 'MINUS_LIST',
        stockAdjustments: go.map(function (it) { return { article: it.num, quantity: 0 - it.qty, reasonCode: '103', comment: s(it.c1, 50) }; }),
      });
    }).then(function (r) {
      if (!r.ok) throw 'minus ' + r.status;
      window.__mx.step = 'adjust';
      // 2. Regulacija zalihe: the replacement number down by the same, reason 53
      return req('POST', '/api/v1/stock-adjustments', {
        username: user, password: pass, storeId: store, module: 'STOCK_ADJUSTMENT',
        stockAdjustments: go.map(function (it) { return { article: it.target, quantity: it.qty, reasonCode: '53', comment: s(it.c2, 50) }; }),
      }).then(function (r2) {
        if (!r2.ok) throw 'adjust ' + r2.status;
        done({ state: 'ok', sent: go.map(function (it) { return it.num; }), skipped: skipped });
      });
    });
  }).catch(function (e) {
    var step = window.__mx && window.__mx.step;
    done({ state: 'error', why: s(e, 40), step: step });
  });
})();
