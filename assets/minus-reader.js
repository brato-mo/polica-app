// Runs inside the store system's own page (the employee's sign-in), driven by MinusReader. Reads the store's
// minus list through the same call the Minus lista page makes, and for each article its replacement number
// (substitutionsFuture). Only READS; leaves a trimmed result in window.__ml for the app.
(function () {
  if (window.__ml && window.__ml.state === 'busy') return;
  window.__ml = { state: 'busy' };
  function s(v, n) { v = v == null ? '' : String(v).trim(); return v.length > n ? v.slice(0, n) : v; }
  function get(u) {
    return fetch(u, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw 'login';
      if (!r.ok) throw 'http ' + r.status;
      if ((r.headers.get('content-type') || '').indexOf('json') < 0) throw 'login';
      return r.json();
    });
  }
  var store = '', catalog = '';
  // the article's substitution chain with the store's stock of each number: what the Minus lista page shows as
  // "Zaliha zamjenskih artikala"
  function chain(num) {
    if (!catalog) return Promise.resolve([]);
    return get('/api/v1/article/masterdata?article=' + num + '&catalog=' + encodeURIComponent(catalog) + '&store=' + encodeURIComponent(store) + '&include=SubstitutionChainSmDm')
      .then(function (j) {
        var a = Array.isArray(j) ? j[0] : j;
        return ((a && a.substitutionChain) || []).map(function (c) {
          var stock = c.smDmData && typeof c.smDmData.stock === 'number' ? c.smDmData.stock : c.atp && typeof c.atp.quantity === 'number' ? c.atp.quantity : 0;
          return { num: s(c.articleNumber, 10), st: s(c.statusCode, 3), stock: stock };
        }).filter(function (c) { return /^\d{7}$/.test(c.num) && c.num !== num; }).slice(0, 12);
      }).catch(function (e) { if (e === 'login') throw e; return []; });
  }
  get('/api/v1/websapapi/user-details').then(function (u) {
    var si = u && u.userDetails && u.userDetails.storeInfo;
    store = si && s(si.storeId, 10);
    catalog = si && s(si.catalogId, 30);
    if (!/^[0-9A-Za-z]{1,10}$/.test(store || '')) throw 'store';
    if (!/^[0-9A-Za-z-]{1,30}$/.test(catalog || '')) catalog = '';
    return get('/api/v1/minus-list/' + encodeURIComponent(store) + '?include=Article');
  }).then(function (list) {
    if (!Array.isArray(list)) throw 'shape';
    var items = list.slice(0, 300).map(function (x) {
      var a = x.article || {};
      return {
        num: s(x.articleId || a.articleNumber, 10),
        name: s(a.title, 120),
        st: s(a.statusCode, 3),
        qty: +x.totalStock || 0,
        blocked: +x.blockedStock || 0,
        unit: s(a.unit, 6),
        group: s(a.groupTitle, 60),
        subs: [],
      };
    }).filter(function (x) { return /^\d{7}$/.test(x.num); });
    return Promise.all(items.map(function (x) {
      return chain(x.num).then(function (c) { x.subs = c; return x; });
    }));
  }).then(function (items) {
    window.__ml = { state: 'ok', items: items };
  }).catch(function (e) {
    window.__ml = { state: e === 'login' ? 'login' : 'error', why: s(e, 60) };
  });
})();
