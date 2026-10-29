// The reader of the in-app browser (BrowserActivity). Injected into a MYJYSK news page, inside the app's own WebView
// that carries the employee's sign-in (no bridge to the app): reads the article and its attachments through the same
// calls the page makes and shows them over the page in the app's own look. Changes nothing on MYJYSK.
// window.__jr: { state: 'busy'|'ok'|'error'|'login', open: {name, rows, ...} when an Excel attachment was read,
// show(), hide() }. The app polls it. window.__jrDark is set by the app before this runs.
(function () {
  var m = /^\/ui\/news\/articles\/(\d+)/.exec(location.pathname);
  if (!m) return;
  var ID = m[1];
  if (window.__jr && window.__jr.id === ID) { window.__jr.show(); return; }
  if (window.__jr) window.__jr.remove();
  var R = window.__jr = { id: ID, state: 'busy', open: null, opening: '' };
  var dark = !!window.__jrDark;

  function chk(r) {
    if (r.status === 401 || r.status === 403) throw 'login';
    if (!r.ok) throw 'http ' + r.status;
    if ((r.headers.get('content-type') || '').indexOf('json') < 0) throw 'login';
    return r.json();
  }
  function get(u) { return fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } }).then(chk); }
  function post(u, b) {
    return fetch(u, { method: 'POST', credentials: 'include', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(chk);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  var MON = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  function day(s) {
    var d = new Date(s);
    if (isNaN(d)) return '';
    return d.getDate() + '. ' + MON[d.getMonth()] + ' ' + d.getFullYear() + '. u ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function size(b) {
    b = +b || 0;
    return b > 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' kB';
  }
  function kind(name, type) {
    var e = (/\.([a-z0-9]{1,5})$/i.exec(name || '') || [])[1] || '';
    e = e.toLowerCase();
    if (e === 'xlsx' || /spreadsheetml/.test(type)) return 'xlsx';
    if (e === 'pdf' || /pdf/.test(type)) return 'pdf';
    if (/^(png|jpe?g|gif|webp)$/.test(e) || /^image\//.test(type)) return 'img';
    if (/^(docx?|odt)$/.test(e)) return 'doc';
    if (/^(xls|csv)$/.test(e)) return 'xls';
    return 'file';
  }
  // the article's own HTML, cleaned: no scripts, styles, event handlers or frames; links and pictures kept
  function clean(html) {
    var d = new DOMParser().parseFromString('<div>' + (html || '') + '</div>', 'text/html');
    d.querySelectorAll('script,style,iframe,object,embed,form,input,button,link,meta').forEach(function (e) { e.remove(); });
    d.querySelectorAll('*').forEach(function (e) {
      [].slice.call(e.attributes).forEach(function (a) {
        var n = a.name.toLowerCase();
        if (n === 'href' || n === 'src') {
          if (!/^(https:|\/(?!\/)|#)/i.test(a.value.trim())) e.removeAttribute(a.name);
        } else if (!(n === 'colspan' || n === 'rowspan' || n === 'alt')) e.removeAttribute(a.name);
      });
    });
    // empty paragraphs the editor leaves behind
    d.querySelectorAll('p,div,span').forEach(function (e) { if (!e.textContent.trim() && !e.querySelector('img,br,table')) e.remove(); });
    return d.body.firstChild.innerHTML;
  }

  var C = dark
    ? { bg: '#0e1014', card: '#171a21', soft: '#1f232c', ink: '#eef1f7', ink2: '#a8afbe', line: '#262b35', blue: '#6d8bff', chip: '#1f2750', chipInk: '#bccaff', green: '#173a28', greenInk: '#7fd7a2' }
    : { bg: '#f3f4f7', card: '#ffffff', soft: '#f1f3f7', ink: '#131620', ink2: '#596072', line: '#e5e7ee', blue: '#2b50e6', chip: '#eaeeff', chipInk: '#2340c4', green: '#e3f4ea', greenInk: '#1b7a45' };
  var CSS = ':host{all:initial}*{box-sizing:border-box}'
    + '.wrap{position:fixed;inset:0;z-index:2147483647;background:' + C.bg + ';overflow-y:auto;-webkit-overflow-scrolling:touch;font-family:Inter,Roboto,system-ui,sans-serif;color:' + C.ink + ';padding:8px 14px 28px}'
    + '.card{background:' + C.card + ';border-radius:22px;padding:20px 18px 22px;box-shadow:0 1px 2px rgba(20,24,40,.05),0 6px 18px rgba(20,24,40,.06)}'
    + '.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.chip{font-size:12px;font-weight:600;padding:5px 10px;border-radius:999px;background:' + C.chip + ';color:' + C.chipInk + '}'
    + 'h1{margin:0 0 14px;font-size:23px;line-height:1.25;font-weight:800;letter-spacing:-.01em}'
    + '.by{display:flex;align-items:center;gap:10px;margin-bottom:16px}.av{width:36px;height:36px;border-radius:18px;background:' + C.soft + ';display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:' + C.ink2 + ';flex-shrink:0}'
    + '.by b{display:block;font-size:14px}.by small{display:block;font-size:12px;color:' + C.ink2 + ';margin-top:2px}'
    + '.body{font-size:16px;line-height:1.6;overflow-wrap:anywhere}.body p{margin:0 0 12px}.body img{max-width:100%;height:auto;border-radius:12px}'
    + '.body a{color:' + C.blue + '}.body table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%;font-size:14px}.body td,.body th{border:1px solid ' + C.line + ';padding:6px 8px}'
    + '.body ul,.body ol{padding-left:22px;margin:0 0 12px}'
    + 'h2{font-size:15px;margin:22px 4px 10px}'
    + '.att{display:flex;align-items:center;gap:12px;width:100%;padding:12px;margin-bottom:10px;border:0;border-radius:16px;background:' + C.card + ';color:' + C.ink + ';text-align:left;font:inherit;box-shadow:0 1px 2px rgba(20,24,40,.05),0 6px 18px rgba(20,24,40,.06)}'
    + '.ic{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:12px;font-weight:800;background:' + C.soft + ';color:' + C.ink2 + '}.ic.xlsx{background:' + C.green + ';color:' + C.greenInk + '}'
    + '.att span.t{flex-grow:1;min-width:0}.att b{display:block;font-size:14px;overflow-wrap:anywhere}.att small{display:block;font-size:12px;color:' + C.ink2 + ';margin-top:2px}.go{color:' + C.blue + ';font-size:20px;font-weight:700}'
    + '.msg{padding:40px 20px;text-align:center;color:' + C.ink2 + ';font-size:15px}.spin{width:28px;height:28px;margin:0 auto 14px;border-radius:50%;border:3px solid ' + C.line + ';border-top-color:' + C.blue + ';animation:r 0.8s linear infinite}@keyframes r{to{transform:rotate(360deg)}}';

  var host = document.createElement('div');
  host.id = '__jr_host';
  var root = host.attachShadow({ mode: 'open' });
  var wrap = document.createElement('div');
  wrap.className = 'wrap';
  var st = document.createElement('style');
  st.textContent = CSS;
  root.appendChild(st);
  root.appendChild(wrap);
  wrap.innerHTML = '<div class="msg"><div class="spin"></div>Učitavam vijest…</div>';
  document.documentElement.appendChild(host);

  R.show = function () { host.style.display = ''; };
  R.hide = function () { host.style.display = 'none'; };
  R.remove = function () { host.remove(); };
  R.textZoom = function (pct) { wrap.style.fontSize = pct + '%'; };

  var atts = [];
  function attRow(a, i) {
    var k = kind(a.fileName, a.contentType);
    var label = { xlsx: 'XLS', xls: 'XLS', pdf: 'PDF', img: 'SLIKA', doc: 'DOC', file: 'FAJL' }[k];
    var sub = k === 'xlsx' ? 'Excel · otvara se u aplikaciji, kao lista artikala' : size(a.bytes) + ' · sačuva se na telefon';
    if (R.opening === String(i)) sub = 'Čitam prilog…';
    return '<button class="att" type="button" data-i="' + i + '"><span class="ic ' + k + '">' + label + '</span><span class="t"><b>' + esc(a.fileName) + '</b><small>' + esc(sub) + '</small></span><span class="go">›</span></button>';
  }
  function draw(a) {
    var who = (a.creator && (a.creator.fullName || a.creator.name)) || '';
    var ini = who.split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
    var secs = (a.sections || []).slice().sort(function (x, y) { return x.order - y.order; });
    var act = secs.filter(function (x) { return x.isActive !== false; });
    var body = (act.length ? act : secs).map(function (x) { return (x.title ? '<h3>' + esc(x.title) + '</h3>' : '') + clean(x.content); }).join('');
    var chips = [a.knowledgeBaseName, a.topicName].filter(Boolean).map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('');
    wrap.innerHTML = '<article class="card">' + (chips ? '<div class="chips">' + chips + '</div>' : '')
      + '<h1>' + esc(a.title) + '</h1>'
      + '<div class="by"><span class="av">' + esc(ini || '·') + '</span><span><b>' + esc(who || 'MYJYSK') + '</b><small>' + esc([day(a.updatedAt || a.createdAt), a.views ? a.views + ' pregleda' : ''].filter(Boolean).join(' · ')) + '</small></span></div>'
      + '<div class="body">' + (body || '<p>Vijest nema teksta.</p>') + '</div></article>'
      + (atts.length ? '<h2>Prilozi (' + atts.length + ')</h2>' + atts.map(attRow).join('') : '');
  }
  var article = null;
  function redraw() { if (article) draw(article); }

  wrap.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('.att');
    if (b) {
      ev.preventDefault();
      var i = +b.getAttribute('data-i'), a = atts[i];
      if (!a || R.opening) return;
      var url = '/core/services/media/asset/redirect?key=' + encodeURIComponent(a.key) + '&download=true';
      if (kind(a.fileName, a.contentType) !== 'xlsx') { location.href = url; return; } // the app saves it
      R.opening = String(i);
      redraw();
      // the default credentials: the sign-in goes to MYJYSK only, not to the file store it redirects to
      fetch(url).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) { return readXlsx(buf, 3000); }).then(function (rows) {
        R.open = { name: String(a.fileName || '').slice(0, 120), rows: rows, id: ID, title: String(article && article.title || '').slice(0, 200) };
        R.opening = '';
        redraw();
      }).catch(function () {
        R.opening = '';
        redraw();
        location.href = url; // could not read it here: save it on the phone instead
      });
      return;
    }
    var l = ev.target.closest && ev.target.closest('a[href]');
    if (l) {
      var h = l.getAttribute('href') || '';
      if (h.charAt(0) === '#') return;
      ev.preventDefault();
      location.href = l.href; // stays in the app's browser; a news link opens in the reader again
    }
  });

  get('/api/newsarticles/' + ID + '?translate=true&manage=false').then(function (j) {
    article = j && j.data;
    if (!article) throw 'shape';
    R.state = 'ok';
    draw(article);
    var loc = 'bs-Latn-BA-jysk';
    performance.getEntriesByType('resource').some(function (e) {
      var x = /\/api\/resources\/static\/([A-Za-z-]{2,30})\//.exec(e.name);
      if (x) loc = x[1];
      return !!x;
    });
    if (!article.uniqueGuid) return;
    return post('/core/v1/services/media/Asset/ListAssetsMainIsoOrAssetsFallbackIso', {
      fileMainIsoOrFallbackIsoCollection: [{ entityId: article.uniqueGuid, entityType: 'kb-articles', mainLocaleIsoCode: loc, fallBackLocaleIsoCode: article.primaryLanguageIsoCode || loc }],
    }).then(function (r) {
      atts = (r && r.result || []).filter(function (x) { return x && x.key && x.fileName && !x.isDeleted; });
      redraw();
    }).catch(function () { /* the article without its attachments */ });
  }).catch(function (e) {
    R.state = e === 'login' ? 'login' : 'error';
    wrap.innerHTML = '<div class="msg">' + (e === 'login' ? 'Prijava je istekla. Pokušavam se ponovo prijaviti…' : 'Vijest se ne može učitati u čitaču. Otvori originalnu stranicu.') + '</div>';
  });
})();
