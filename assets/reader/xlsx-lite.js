// Reads the first sheet of an .xlsx file (a zip of XML files) into rows of cell texts, in the browser, without
// libraries: the zip's central directory, DecompressionStream('deflate-raw'), DOMParser. Only what a table shows:
// shared strings, inline strings, numbers as written. At most `maxRows` rows and 40 columns.
async function readXlsx(buf, maxRows) {
  maxRows = maxRows || 3000;
  var dv = new DataView(buf);
  var u8 = new Uint8Array(buf);
  var eocd = -1;
  for (var i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  var n = dv.getUint16(eocd + 10, true), off = dv.getUint32(eocd + 16, true);
  var files = {};
  var dec = new TextDecoder();
  for (var k = 0; k < n; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('zip directory');
    var method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
    var nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true);
    var lho = dv.getUint32(off + 42, true);
    var name = dec.decode(u8.subarray(off + 46, off + 46 + nl));
    files[name] = { method: method, csize: csize, lho: lho };
    off += 46 + nl + el + cl;
  }
  async function text(name) {
    var f = files[name];
    if (!f) return null;
    var lh = f.lho, start = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
    var data = u8.subarray(start, start + f.csize);
    if (f.method === 0) return dec.decode(data);
    if (f.method !== 8) throw new Error('zip method');
    var s = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(s).text();
  }
  function xml(t) { return new DOMParser().parseFromString(t, 'application/xml'); }
  function kids(el, tag) { return Array.prototype.filter.call(el.getElementsByTagName('*'), function (e) { return e.localName === tag; }); }
  // the first sheet in the workbook's order
  var sheet = 'xl/worksheets/sheet1.xml';
  try {
    var wb = xml(await text('xl/workbook.xml'));
    var first = kids(wb, 'sheet')[0];
    var rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    var rels = xml(await text('xl/_rels/workbook.xml.rels'));
    kids(rels, 'Relationship').forEach(function (r) {
      if (r.getAttribute('Id') === rid) {
        var t = r.getAttribute('Target');
        sheet = t.charAt(0) === '/' ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
      }
    });
  } catch (e) { /* keep sheet1 */ }
  var shared = [];
  var sst = await text('xl/sharedStrings.xml');
  if (sst) kids(xml(sst), 'si').forEach(function (si) { shared.push(kids(si, 't').map(function (t) { return t.textContent; }).join('')); });
  var st = await text(sheet);
  if (!st) throw new Error('no sheet');
  function col(ref) {
    var m = /^([A-Z]+)/.exec(ref || ''), c = 0;
    if (!m) return -1;
    for (var j = 0; j < m[1].length; j++) c = c * 26 + (m[1].charCodeAt(j) - 64);
    return c - 1;
  }
  var rows = [];
  kids(xml(st), 'row').some(function (r) {
    var row = [];
    kids(r, 'c').forEach(function (c, idx) {
      var ci = col(c.getAttribute('r'));
      if (ci < 0) ci = idx;
      if (ci >= 40) return;
      var t = c.getAttribute('t'), v = kids(c, 'v')[0], val = '';
      if (t === 's') val = v ? shared[+v.textContent] || '' : '';
      else if (t === 'inlineStr') val = kids(c, 't').map(function (x) { return x.textContent; }).join('');
      else val = v ? v.textContent : '';
      while (row.length < ci) row.push('');
      row[ci] = String(val).trim().slice(0, 200);
    });
    while (row.length && !row[row.length - 1]) row.pop();
    if (row.length) rows.push(row);
    return rows.length >= maxRows;
  });
  return rows;
}
