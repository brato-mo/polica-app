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
  get('/api/v1/websapapi/user-details').then(function (u) {
    var si = u && u.userDetails && u.userDetails.storeInfo;
    var store = si && s(si.storeId, 10);
    if (!/^[0-9A-Za-z]{1,10}$/.test(store || '')) throw 'store';
    return get('/api/v1/minus-list/' + encodeURIComponent(store) + '?include=Article');
  }).then(function (list) {
    if (!Array.isArray(list)) throw 'shape';
    window.__ml = {
      state: 'ok',
      items: list.slice(0, 500).map(function (x) {
        var a = x.article || {};
        var subs = (Array.isArray(a.substitutionsFuture) ? a.substitutionsFuture : []).map(function (n) { return s(n, 10); }).filter(function (n) { return /^\d{7}$/.test(n); });
        return {
          num: s(x.articleId || a.articleNumber, 10),
          name: s(a.title, 120),
          st: s(a.statusCode, 3),
          qty: +x.totalStock || 0,
          blocked: +x.blockedStock || 0,
          unit: s(a.unit, 6),
          group: s(a.groupTitle, 60),
          subs: subs.slice(0, 3),
        };
      }).filter(function (x) { return /^\d{7}$/.test(x.num); }),
    };
  }).catch(function (e) {
    window.__ml = { state: e === 'login' ? 'login' : 'error', why: s(e, 60) };
  });
})();
