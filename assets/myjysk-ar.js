// Injected into the MYJYSK page (the employee's own sign-in, inside the app) for the weekly AR rating of his
// department ("AR Time - ..." store visit). window.__mjArg says what to do:
//   { mode: 'form', form: 'AR Time - MALI ARTIKLI' }  -> the questions of that form (nothing is changed)
//   { mode: 'send', guid, answers: [{ fieldId, fieldGuid, fieldType, value }] }
//      -> creates a visit to himself in his store, fills in his answers and completes it, the same calls the
//         MYJYSK pages make. Only what the employee chose in the app is sent.
// The result is left in window.__mjt for the app to pick up.
(function () {
  if (window.__mjt && window.__mjt.state === 'busy') return;
  var arg = window.__mjArg || {};
  window.__mjt = { state: 'busy', step: 'start' };
  function chk(r) {
    if (r.status === 401 || r.status === 403) throw 'login';
    if (!r.ok) throw 'http ' + r.status;
    var ct = r.headers.get('content-type') || '';
    if (ct.indexOf('html') >= 0) throw 'login'; // a sign-in page instead of data
    return r.text().then(function (t) { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } });
  }
  function req(method, u, b) {
    var o = { method: method, credentials: 'include', headers: { Accept: 'application/json' } };
    if (b !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(b); }
    return fetch(u, o).then(chk);
  }
  var get = function (u) { return req('GET', u); };
  var post = function (u, b) { return req('POST', u, b === undefined ? {} : b); };
  var data = function (r) { return r && r.data !== undefined ? r.data : r; };
  function s(v, n) { v = v == null ? '' : String(v); return v.length > n ? v.slice(0, n) : v; }
  function step(t) { window.__mjt.step = t; }

  function me() {
    return get('/api/BackendContext/information').then(function (r) {
      var u = (data(r) || {}).user || {};
      if (!u.id || !u.primaryLocation || !u.primaryLocation.id) throw 'no user';
      return { user: u.id, loc: u.primaryLocation.id };
    });
  }

  function form() {
    var want = String(arg.form || '').toLowerCase().trim();
    return get('/api/storevisits/visittypes').then(function (r) {
      var list = data(r);
      if (!Array.isArray(list)) list = (list && list.items) || [];
      var ar = list.filter(function (x) { return /^ar (time|vrijeme)/i.test(x.name || ''); })
        .map(function (x) { return { guid: s(x.guid, 40), name: s(x.name, 80) }; });
      var hit = ar.filter(function (x) { return x.name.toLowerCase().trim() === want; })[0];
      if (!hit) return { forms: ar, form: null };
      return get('/api/customforms/' + encodeURIComponent(hit.guid)).then(function (c) {
        var d = data(c) || {};
        var secs = d.fieldSections || [];
        var fields = [];
        secs.forEach(function (sec) { (sec.fields || []).forEach(function (f) { fields.push(f); }); });
        if (!fields.length) fields = d.fields || [];
        var qs = fields.filter(function (f) { return !f.isHidden; }).map(function (f) {
          var opts = [];
          try { opts = JSON.parse(f.values || '[]').map(function (v) { return { id: s(v.id, 20), text: s(v.text, 40), value: +v.value || 0 }; }); } catch (e) { opts = []; }
          return { id: f.formFieldId, guid: s(f.guid, 40), type: f.fieldType, req: !!f.isRequired, name: s(f.name, 200), opts: opts };
        });
        return { forms: ar, form: { guid: hit.guid, name: hit.name, qs: qs } };
      });
    });
  }

  function mdy(d) { return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear(); }

  function send(who) {
    var guid = String(arg.guid || '');
    var answers = Array.isArray(arg.answers) ? arg.answers : [];
    if (!/^[0-9a-f-]{36}$/i.test(guid) || !answers.length) throw 'bad input';
    var id = 0;
    step('create');
    return post('/api/storevisits?stickToActiveVersion=true', {
      id: 0, customFormGuid: guid, locationId: who.loc,
      conductorId: who.user, conductorRoles: [], receiverId: who.user, receiverRoles: [],
      isSelfVisit: true, isPrivateVisit: false, scheduleDate: null, startVisitToday: true,
    }).then(function (r) {
      var d = data(r) || {};
      id = +(d.id || (d.data && d.data.id) || 0);
      if (!id) throw 'no visit id';
      window.__mjt.id = id;
      step('start');
      return post('/api/v2/storevisits/' + id + '/startconduct');
    }).then(function (r) {
      var d = data(r) || {};
      var g = d.guid || d.responseGuid || (d.conductMeta && d.conductMeta.guid) || '';
      if (g) return g;
      return get('/api/v2/storevisits/' + id + '/conduct').then(function (c) {
        var x = data(c) || {};
        return x.guid || x.responseGuid || (x.conductMeta && x.conductMeta.guid) || '';
      }, function () { return ''; });
    }).then(function (responseGuid) {
      step('answers');
      var i = 0;
      function next() {
        if (i >= answers.length) return Promise.resolve();
        var a = answers[i++];
        var body = { fieldGuid: String(a.fieldGuid || ''), fieldId: +a.fieldId, fieldType: +a.fieldType, value: s(a.value, 1000) };
        if (responseGuid) body.responseGuid = responseGuid;
        window.__mjt.done = i - 1;
        return post('/api/v2/storevisits/' + id + '/conduct/fieldvalue', body).then(next);
      }
      return next();
    }).then(function () {
      window.__mjt.done = answers.length;
      step('complete');
      return get('/api/storevisits/' + id + '/complete?conductedOn=' + encodeURIComponent(mdy(new Date())));
    }).then(function () {
      return get('/api/storevisits/' + id).then(function (r) {
        var d = data(r) || {};
        return { id: id, status: s(d.statusStr, 30), score: d.hasAverageScore ? +d.averageScore : null };
      }, function () { return { id: id }; });
    });
  }

  me().then(function (who) {
    if (arg.mode === 'form') return form();
    if (arg.mode === 'send') return send(who);
    throw 'bad mode';
  }).then(function (res) {
    window.__mjt = { state: 'ok', res: res };
  }, function (e) {
    var m = String(e && e.message ? e.message : e);
    var cur = window.__mjt || {};
    window.__mjt = { state: m === 'login' ? 'login' : 'error', err: s(m, 120), step: cur.step, id: cur.id || 0, done: cur.done || 0 };
  });
})();
