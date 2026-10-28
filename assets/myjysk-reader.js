// Injected into the MYJYSK page (the employee's own sign-in, inside the app). Reads the employee's tasks, the
// store's tasks and the news through the same calls the MYJYSK start page makes, and leaves a small, trimmed
// result in window.__mjr for the app to pick up. Changes nothing on MYJYSK.
(function () {
  if (window.__mjr && window.__mjr.state === 'busy') return;
  window.__mjr = { state: 'busy' };
  var JSON_H = { Accept: 'application/json' };
  function chk(r) {
    if (r.status === 401 || r.status === 403) throw 'login';
    if (!r.ok) throw 'http ' + r.status;
    if ((r.headers.get('content-type') || '').indexOf('json') < 0) throw 'login'; // a sign-in page instead of data
    return r.json();
  }
  function get(u) { return fetch(u, { credentials: 'include', headers: JSON_H }).then(chk); }
  function post(u, b) {
    return fetch(u, { method: 'POST', credentials: 'include', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(chk);
  }
  function s(v, n) { v = v == null ? '' : String(v); return v.length > n ? v.slice(0, n) : v; }
  function task(t) {
    return {
      id: s(t.objectId || t.id, 14), title: s(t.title, 200), start: s(t.startDate, 10), end: s(t.endDate, 10), time: s(t.endTime, 5),
      done: !!(t.isComplete || t.isClosed), over: !!t.isOverdue, role: s(t.roleName, 40), who: s(t.assignedUserName, 60),
      st: s(t.taskStatus, 30), eff: +t.estEffort || 0, crit: !!t.isCritical,
      path: /^\/ui\/tasks\/[a-z]+\/\d+$/.test(t.url || '') ? t.url : '',
    };
  }
  function art(a) {
    return {
      id: s(a.objectId || a.id, 14), title: s(a.title, 200), kb: s(a.articleKbaseName, 40), by: s(a.creator, 60),
      at: s(a.datePublished || a.updatedAt, 19), text: s(String(a.content || '').replace(/\s+/g, ' ').trim(), 700),
      crit: !!a.isCritical, att: +a.articleAttachmentsCount || 0,
      path: /^\/ui\/news\/articles\/\d+$/.test(a.url || '') ? a.url : '',
    };
  }
  var news = function (ids, sort, n) { return post('/searchapi/kb/recent', { types: ['news'], limit: n, start: 0, kbasesIds: ids, sorting: sort, featureOnWidget: false }); };
  function text(html) {
    var d = new DOMParser().parseFromString(html || '', 'text/html');
    d.querySelectorAll('br,p,div,li,h1,h2,h3,h4,tr').forEach(function (e) { e.append('\n'); });
    return (d.body.textContent || '').replace(/[ \t ​]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  }
  // Store concept knowledge base: the planogram links ("3)" articles), the dated updates ("2)") and when each
  // concept ("1)") was changed. Each article read is one call; about twenty of them.
  var KB = 81;
  function concept() {
    return get('/searchapi/search?type=kbarticle&topicfacets=auto&kbaseid=' + KB + '&limit=200&start=0&q=').then(function (r) {
      var list = (r.results || []).map(function (a) {
        return { id: s(a.objectId || a.id, 14), title: s(a.title, 160), dept: s(a.articleTopicName, 60), upd: s(a.dateUpdated || a.lastPublishedDate, 19), path: /^\/ui\/knowledge-bases\/\d+\/topics\/\d+\/articles\/\d+$/.test(a.url || '') ? a.url : '' };
      });
      var want = list.filter(function (a) { return /^\s*[23]\)/.test(a.title); });
      return Promise.all(want.map(function (a) {
        return get('/learnapi/v1/articles/' + encodeURIComponent(a.id) + '/view').then(function (j) {
          var secs = (j.sections || []).filter(function (x) { return x.isActive !== false; }).sort(function (x, y) { return x.order - y.order; });
          var links = [];
          secs.forEach(function (x) {
            var d = new DOMParser().parseFromString(x.content || '', 'text/html');
            d.querySelectorAll('a[href*="viewCollected"]').forEach(function (l) {
              try {
                var u = new URL(l.getAttribute('href'));
                u.protocol = 'https:';
                links.push({ text: s(l.textContent.replace(/\s+/g, ' ').trim(), 120), url: s(u.href, 400), org: s(u.searchParams.get('sorg'), 20), sis: s(u.searchParams.get('sis'), 80), sub: s(u.searchParams.get('sub'), 80) });
              } catch (e) { /* not a link */ }
            });
          });
          return { a: a, upd: s(j.lastUpdated, 19) || a.upd, first: secs.length ? s(text(secs[0].content), 6000) : '', links: links };
        }).catch(function (e) { if (e === 'login') throw e; return { a: a, upd: a.upd, first: '', links: [] }; });
      })).then(function (read) {
        var plans = [], upds = [];
        read.forEach(function (x) {
          x.links.forEach(function (l) { l.dept = x.a.dept; l.art = x.a.id; l.upd = x.upd; plans.push(l); });
          if (/^\s*2\)/.test(x.a.title)) upds.push({ id: x.a.id, dept: x.a.dept, title: x.a.title, upd: x.upd, path: x.a.path, text: x.first });
        });
        var concepts = list.filter(function (a) { return /^\s*1\)/.test(a.title); });
        return { plans: plans, upds: upds, concepts: concepts };
      });
    });
  }
  Promise.all([
    get('/searchapi/widgets/tasklist/8/0/100/0?sortasc=endDate'), // My Tasks (all types)
    get('/searchapi/widgets/tasklist/11/0/200/0?sortasc=endDate'), // My Location Tasks
    news([181, 189, 180, 182], 'MostRecentlyUpdated', 40), // Store News
    news([183, 184, 185], 'MostRecentlyCreated', 10), // System status
    concept().catch(function (e) { if (e === 'login') throw e; return null; }), // a broken concept read does not stop the rest
  ]).then(function (r) {
    window.__mjr = {
      state: 'ok',
      my: (r[0].results || []).map(task),
      loc: (r[1].results || []).map(task), locTotal: +r[1].total || 0,
      news: (r[2].articles || []).map(art), newsTotal: +r[2].total || 0,
      sys: (r[3].articles || []).map(art),
      kb: r[4],
    };
  }).catch(function (e) {
    window.__mjr = { state: e === 'login' ? 'login' : 'error', why: s(e, 80) };
  });
})();
