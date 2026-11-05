// Injected into StoreFront's own page (the employee's sign-in, inside the app) by StoreTask. window.__stArg says what
// to do; the same calls StoreFront's pages make:
//   { mode: 'find', code }          an article by number or barcode, whatever its status code (21 and 81 included)
//   { mode: 'article', num }        one article: stock, SM/DM, price, sales and the stock history
//   { mode: 'top', cat, days }      the department's best sellers (StoreFront counts the last 30 days); for the first
//                                   ones also the last 7 days, from their stock history
//   { mode: 'smdm', cat, st }       articles of the department with these status codes and an SM value above 0
//   { mode: 'smset', items: [{ num, sm, dm }] }  saves these SM/DM values (only what the employee confirmed)
// Only 'smset' changes anything. The result is left in window.__st for the app to pick up.
(function () {
  if (window.__st && window.__st.state === 'busy') return;
  var arg = window.__stArg || {};
  var job = String(arg.job || '').slice(0, 40);
  window.__st = { state: 'busy', job: job };
  var ALL = ['01', '02', '11', '12', '21', '31', '32', '41', '42', '51', '81'];
  function s(v, n) { v = v == null ? '' : String(v).trim(); return v.length > n ? v.slice(0, n) : v; }
  function num(v) { v = +v; return isFinite(v) ? v : 0; }
  function req(method, u, body) {
    var h = { Accept: 'application/json' };
    if (body !== undefined) { h['Content-Type'] = 'application/json'; h.suppressMessages = 'true'; }
    return fetch(u, { method: method, credentials: 'same-origin', headers: h, body: body === undefined ? undefined : JSON.stringify(body) }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw 'login';
      if ((r.headers.get('content-type') || '').indexOf('html') >= 0) throw 'login';
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
        if (!r.ok) throw 'http ' + r.status + (j && j.message ? ' ' + s(j.message, 80) : '');
        return j;
      });
    });
  }
  var get = function (u) { return req('GET', u); };
  var store = '', catalog = '';
  function who() {
    return get('/api/v1/websapapi/user-details').then(function (u) {
      var si = u && u.userDetails && u.userDetails.storeInfo;
      store = si && s(si.storeId, 10);
      catalog = si && s(si.catalogId, 30);
      if (!/^[0-9A-Za-z]{1,10}$/.test(store || '') || !/^[0-9A-Za-z-]{1,30}$/.test(catalog || '')) throw 'store';
    });
  }
  function search(body, max) {
    var b = { storeId: store, catalogId: catalog, start: '0', max: String(max || 40) };
    for (var k in body) b[k] = body[k];
    return req('POST', '/api/v1/article/search?include=SmDm', b).then(function (j) {
      return { list: ((j && j.articleResults) || []).map(row), total: j && j.pagingInfo ? num(j.pagingInfo.total) : 0 };
    });
  }
  function row(a) {
    var d = a.smDmData || {};
    return {
      num: s(a.id, 10), name: s(a.title || d.title, 120), st: s(a.statusCode || d.articleStatus, 3), unit: s(a.unit || d.unit, 6),
      stock: num(a.storeStock != null ? a.storeStock : d.stock), free: num(a.sellableStock != null ? a.sellableStock : d.sellableStock),
      sm: num(d.smQuantity), dm: num(d.dmQuantity), cap: num(d.shelfCapacity || a.shelfCapacity), sold30: num(d.quantitySoldInPeriod),
      changed: s(d.lastChangedFmt, 20), ean: s(a.ean, 14), eans: (a.eanHistory || []).slice(0, 10).map(function (x) { return s(x, 14); }),
    };
  }
  // the store's stock movements of an article, newest first: 251 sold, 252 returned, 101 received, others corrections
  function history(n) {
    return get('/api/v1/stockhistory/' + encodeURIComponent(store) + '/' + encodeURIComponent(n)).then(function (h) {
      return (Array.isArray(h) ? h : []).map(function (m) {
        return { t: num(m.entryTime), q: num(m.quantity), type: s(m.movementType, 4), after: num(m.totalStock), by: /^\d{1,3}$/.test(String(m.performedBy || '')) ? 'kasa' : '' };
      }).sort(function (a, b) { return b.t - a.t; });
    });
  }
  function soldSince(h, days) {
    var from = Date.now() - days * 86400000, n = 0;
    h.forEach(function (m) { if (m.t >= from && (m.type === '251' || m.type === '252')) n -= m.q; });
    return n;
  }
  function inBatches(list, size, fn) {
    var i = 0, out = [];
    function next() {
      if (i >= list.length) return Promise.resolve(out);
      var part = list.slice(i, i + size);
      i += size;
      return Promise.all(part.map(function (x) { return fn(x).catch(function (e) { if (e === 'login') throw e; return null; }); })).then(function (r) { out = out.concat(r); window.__st.prog = i + '/' + list.length; return next(); });
    }
    return next();
  }

  function find() {
    var code = s(arg.code, 20);
    if (!/^\d{4,14}$/.test(code)) throw 'bad code';
    // no status codes: StoreFront then looks among all of them (its article search page leaves out 81 by default)
    // the search is loose (best match first) and its rows carry no barcodes: the first few are checked against
    // their master data, which has the barcode
    return search({ query: code, fieldsToSearch: ['id', 'ean', 'eanhistory'] }, 8).then(function (r) {
      var exact = r.list.filter(function (a) { return a.num === code || a.ean === code || a.eans.indexOf(code) >= 0; });
      if (exact.length) return { list: exact.slice(0, 6) };
      return Promise.all(r.list.slice(0, 4).map(function (a) {
        return get('/api/v1/article/masterdata?article=' + a.num + '&catalog=' + encodeURIComponent(catalog) + '&store=' + encodeURIComponent(store)).then(function (j) {
          var m = Array.isArray(j) ? j[0] : j;
          if (!m) return null;
          var eans = [m.ean].concat(m.eanHistory || [], m.eans || []).map(function (x) { return s(x, 14); });
          if (eans.indexOf(code) < 0) return null;
          a.ean = code;
          a.price = num(m.activeSalesPrice);
          return a;
        }).catch(function (e) { if (e === 'login') throw e; return null; });
      })).then(function (l) { return { list: l.filter(Boolean) }; });
    });
  }

  function article() {
    var n = s(arg.num, 10);
    if (!/^\d{7}$/.test(n)) throw 'bad num';
    var md = get('/api/v1/article/masterdata?article=' + n + '&catalog=' + encodeURIComponent(catalog) + '&store=' + encodeURIComponent(store)).then(function (j) {
      var a = Array.isArray(j) ? j[0] : j;
      return a ? { price: num(a.activeSalesPrice), normal: num(a.normalSalesPrice), cur: s(a.activePriceCurrency, 4), st: s(a.statusCode, 3), stDate: s(a.dateStatusChangeFmt, 12), group: s(a.groupTitle, 60), name: s(a.title, 120), unit: s(a.unit, 6) } : {};
    }).catch(function (e) { if (e === 'login') throw e; return {}; });
    var sd = search({ query: n, fieldsToSearch: ['id'] }, 5).then(function (r) { return r.list.filter(function (a) { return a.num === n; })[0] || null; });
    var hs = history(n).catch(function (e) { if (e === 'login') throw e; return []; });
    return Promise.all([md, sd, hs]).then(function (x) {
      var h = x[2];
      var last = h.filter(function (m) { return m.type === '101' && m.q > 0; })[0] || null;
      return { num: n, md: x[0], sd: x[1], sold7: soldSince(h, 7), sold30h: soldSince(h, 30), recv: last, hist: h.slice(0, 60) };
    });
  }

  function top() {
    var cat = s(arg.cat, 10);
    if (!/^[0-9A-Za-z]{1,10}$/.test(cat)) throw 'bad cat';
    var deep = Math.max(0, Math.min(60, +arg.deep || 40));
    return search({ categories: [cat], statusCodes: ALL, orderBy: 'quantitySoldInPeriod', orderByDirection: 'DESC' }, 80).then(function (r) {
      var list = r.list.filter(function (a) { return a.sold30 > 0; });
      // the last 7 days: from the stock history of the first ones
      return inBatches(list.slice(0, deep), 6, function (a) { return history(a.num).then(function (h) { a.sold7 = soldSince(h, 7); }); }).then(function () {
        return { list: list, total: r.total };
      });
    });
  }

  // articles of the department with these status codes that still have an SM or a DM value (two searches, merged)
  function smdm() {
    var cat = s(arg.cat, 10);
    var st = (Array.isArray(arg.st) ? arg.st : ['21', '81']).map(function (x) { return s(x, 3); }).filter(function (x) { return /^\d{2}$/.test(x); });
    if (!/^[0-9A-Za-z]{1,10}$/.test(cat) || !st.length) throw 'bad input';
    function all(field) {
      var out = [];
      function page(start) {
        var b = { storeId: store, catalogId: catalog, categories: [cat], statusCodes: st, smDmQuantityParameters: [{ operator: 'GT', value: 0, field: field }], start: String(start), max: '100' };
        return req('POST', '/api/v1/article/search?include=SmDm', b).then(function (j) {
          var l = ((j && j.articleResults) || []).map(row);
          out = out.concat(l);
          var total = j && j.pagingInfo ? num(j.pagingInfo.total) : 0;
          if (l.length && out.length < total && out.length < 500) return page(start + l.length);
          return out;
        });
      }
      return page(0);
    }
    return all('SM').then(function (a) {
      return all('DM').then(function (b) {
        var seen = {};
        var list = a.concat(b).filter(function (x) { if (seen[x.num]) return false; seen[x.num] = 1; return true; });
        return { list: list, total: list.length };
      });
    });
  }

  function smset() {
    var items = (Array.isArray(arg.items) ? arg.items : []).slice(0, 300).filter(function (x) {
      return x && /^\d{7}$/.test(String(x.num)) && isFinite(+x.sm) && +x.sm >= 0 && +x.sm <= 9999 && isFinite(+x.dm) && +x.dm >= 0 && +x.dm <= 9999;
    });
    if (!items.length) throw 'bad input';
    var done = [], failed = [];
    var i = 0;
    function next() {
      if (i >= items.length) return Promise.resolve({ done: done, failed: failed });
      var x = items[i++];
      window.__st.prog = i + '/' + items.length;
      return req('POST', '/api/v1/article-smdm-data/update', { storeId: store, articleId: String(x.num), module: 'SM_DM', smQuantity: Math.round(+x.sm), dmQuantity: Math.round(+x.dm) })
        .then(function () { done.push(String(x.num)); }, function (e) { if (e === 'login') throw e; failed.push({ num: String(x.num), why: s(e, 100) }); })
        .then(next);
    }
    return next();
  }

  var run = { find: find, article: article, top: top, smdm: smdm, smset: smset }[arg.mode];
  (run ? who().then(run) : Promise.reject('bad mode')).then(function (res) {
    window.__st = { state: 'ok', job: job, res: res };
  }, function (e) {
    var m = String(e && e.message ? e.message : e);
    window.__st = { state: m === 'login' ? 'login' : 'error', job: job, err: s(m, 120), prog: (window.__st || {}).prog || '' };
  });
})();
