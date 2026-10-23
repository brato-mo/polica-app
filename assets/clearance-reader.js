// Runs inside the store system's own article search page, started by ClearanceActivity. It only READS what the
// signed-in employee can already see on the phone: the article cards of the page that is open. Nothing is sent
// anywhere. This file is one function; the activity calls it with the answer it wants:
//   'check'  -> what the page says it found, how many cards are on screen, whether it says "too many results"
//   'grab'   -> the text of every card (name, "<7 digits> (<status>)", labelled values), cards split by an empty line
//   'sample' -> a few lines of the page, for the details box when nothing could be read
function (mode) {
  var all = '';
  try { all = (document.body && document.body.innerText) || ''; } catch (e) { all = ''; }
  var t = [];
  var raw = all.split('\n');
  var i;
  for (i = 0; i < raw.length; i++) {
    var s = raw[i].trim();
    if (s) t.push(s);
  }
  // a card: the name, then "<7 digits> (<status>)", then label / value pairs
  var rx = /^\d{7}\s+\(\d{1,3}\)$/;
  var at = [];
  for (i = 0; i < t.length; i++) if (rx.test(t[i])) at.push(i);

  if (mode === 'grab') {
    var out = [];
    for (var k = 0; k < at.length && out.length < 400; k++) {
      var from = Math.max(0, at[k] - 1);
      var to = k + 1 < at.length ? at[k + 1] : Math.min(t.length, at[k] + 24);
      var c = t.slice(from, Math.min(to, from + 26));
      for (var j = 0; j < c.length; j++) c[j] = c[j].slice(0, 160);
      out.push(c.join('\n'));
    }
    return out.join('\n\n');
  }

  if (mode === 'sample') {
    var h = -1;
    for (i = 0; i < t.length; i++) if (/Prona.eno/.test(t[i])) { h = i; break; }
    var a = h < 0 ? 0 : Math.max(0, h - 1);
    var first = '';
    if (at.length) first = t.slice(Math.max(0, at[0] - 1), Math.min(t.length, at[0] + 16)).join(' | ').slice(0, 500);
    return JSON.stringify({
      lines: t.length,
      cards: at.length,
      head: t.slice(a, a + 14).join(' | ').slice(0, 700),
      first: first,
      tail: t.slice(-6).join(' | ').slice(0, 300)
    });
  }

  var f = /Prona.eno\s+(\d+)/.exec(all);
  return JSON.stringify({
    f: f ? +f[1] : -1,
    r: at.length,
    m: /previ\S*\s+rezultat/i.test(all),
    z: /nema\s+(rezultata|artikala)/i.test(all),
    n: all.length
  });
}
