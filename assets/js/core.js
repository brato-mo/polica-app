// Planogram reading and lookup. Pure functions: no DOM, no pdf.js calls, so the
// same code runs in the app and in the Node tests.
//
// Input to parsePlanogram() is what pdf.js gives per page: the viewport size and
// the text items, already transformed into viewport space (scale 1, y grows down).
//
// The planograms come from Nielsen Spaceman and have three kinds of pages:
//  - drawings: product photos with white labels ("4912529", or "5098501 / CUR
//    ALAJAURE / 1x110x175 / white"), a shelf strip under every shelf
//    ("Segment 4/1 Shelf 40cm W/Light Notch: 44") and module numbers along the
//    bottom ("4 3 2 1", "B A");
//  - product lists: ProductID | Name | Substitution, grouped by Fixel_ID
//    ("Segment 3/3");
//  - tables: Nordic Article | Nordic Substitution | display model | Description.

export const ITEM_RX = /(?<![0-9])[0-9]{7}(?![0-9])/g;
const SEG_RX = /Segment\s+([0-9]+(?:-[0-9]+)?)\s*\/\s*([0-9]+)\s*(.*?)\s*Notch\s*:?\s*([0-9]+)/gi;
const MARKER_RX = /^(?:[0-9]{1,3}|[A-Z]{1,2}|[0-9]{1,3}\s*\/\s*[A-Z0-9]{1,3}(?:\s*\(\s*[0-9]+\s*\))?)$/;
const BAR_RX = /hanging|bar\b|hook|peg|rail/i;

const MONTHS = {
  january: 'januar', february: 'februar', march: 'mart', april: 'april', may: 'maj', june: 'juni',
  july: 'juli', august: 'august', september: 'septembar', october: 'oktobar', november: 'novembar',
  december: 'decembar',
};
const MONTH_NO = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9,
  october: 10, november: 11, december: 12,
};

// ---------------------------------------------------------------------------
// Geometry

/** One pdf.js text item -> run geometry. t is [a,b,c,d,e,f] in viewport space. */
function glyphRun(str, t, width, height) {
  const [a, b, c, d, e, f] = t;
  const along = Math.hypot(a, b) || 1;
  const up = Math.hypot(c, d) || along;
  const h = height > 0 ? Math.min(height, up * 1.05) || up : up;
  const ang = Math.atan2(b, a);
  const dir = ((Math.round(ang / (Math.PI / 2)) % 4) + 4) % 4;
  const ux = Math.round(Math.cos(dir * Math.PI / 2)), uy = Math.round(Math.sin(dir * Math.PI / 2));
  // glyph "up" direction: perpendicular to the baseline, the side the glyphs grow to
  let vx = c / up, vy = d / up;
  // snap to the axis perpendicular to u
  if (Math.abs(ux) > 0) { vx = 0; vy = vy >= 0 ? 1 : -1; } else { vy = 0; vx = vx >= 0 ? 1 : -1; }
  const w = Math.max(0, width);
  const xs = [], ys = [];
  for (const s of [0, w]) for (const k of [-0.22 * h, 0.92 * h]) {
    xs.push(e + ux * s + vx * k);
    ys.push(f + uy * s + vy * k);
  }
  return {
    str, dir, h, w,
    ux, uy, vx, vy,
    p: e * vx + f * vy, // position across the baseline (bigger = "higher" line)
    s0: e * ux + f * uy, // position along the baseline
    s1: e * ux + f * uy + w,
    b: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  };
}

function union(a, b) {
  if (!a) return b.slice();
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
const cx = (b) => (b[0] + b[2]) / 2;
const cy = (b) => (b[1] + b[3]) / 2;
const round1 = (v) => Math.round(v * 10) / 10;
const rb = (b) => b.map(round1);

/** Groups runs that sit on one baseline and touch into lines of text. */
export function buildLines(runs, gapFactor = 0.9) {
  const sorted = runs.slice().sort((r, q) => r.dir - q.dir || q.p - r.p || r.s0 - q.s0);
  const clusters = [];
  for (const r of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && c.dir === r.dir && Math.abs(c.p - r.p) <= 0.35 * Math.min(c.h, r.h)) {
      c.runs.push(r);
      c.h = Math.max(c.h, r.h);
    } else {
      clusters.push({ dir: r.dir, p: r.p, h: r.h, runs: [r] });
    }
  }
  const lines = [];
  for (const c of clusters) {
    c.runs.sort((r, q) => r.s0 - q.s0);
    let cur = null;
    for (const r of c.runs) {
      const gap = cur ? r.s0 - cur.s1 : Infinity;
      if (cur && gap <= gapFactor * Math.max(cur.h, r.h) && gap > -2 * Math.max(cur.h, r.h)) {
        const sep = gap > 0.15 * r.h && !/\s$/.test(cur.text) && !/^\s/.test(r.str) ? ' ' : '';
        const c0 = cur.text.length + sep.length;
        cur.text += sep + r.str;
        cur.parts.push({ r, c0, c1: cur.text.length });
        cur.s1 = Math.max(cur.s1, r.s1);
        cur.h = Math.max(cur.h, r.h);
        cur.b = union(cur.b, r.b);
      } else {
        cur = {
          dir: r.dir, p: r.p, h: r.h, s0: r.s0, s1: r.s1, b: r.b.slice(),
          text: r.str, parts: [{ r, c0: 0, c1: r.str.length }],
        };
        lines.push(cur);
      }
    }
  }
  for (const l of lines) l.t = l.text.replace(/\s+/g, ' ').trim();
  return lines.filter((l) => l.t);
}

/** Bounding box of the characters [c0, c1) of a line. */
function spanBox(line, c0, c1) {
  let b = null;
  for (const pt of line.parts) {
    if (pt.c1 <= c0 || pt.c0 >= c1) continue;
    const r = pt.r;
    const len = Math.max(1, pt.c1 - pt.c0);
    const s0 = r.w * Math.max(0, (c0 - pt.c0) / len);
    const s1 = r.w * Math.min(1, (c1 - pt.c0) / len);
    let box;
    if (r.ux !== 0) {
      const ox = r.ux > 0 ? r.b[0] : r.b[2]; // where the run starts
      const x0 = ox + r.ux * s0, x1 = ox + r.ux * s1;
      box = [Math.min(x0, x1), r.b[1], Math.max(x0, x1), r.b[3]];
    } else {
      const oy = r.uy > 0 ? r.b[1] : r.b[3];
      const y0 = oy + r.uy * s0, y1 = oy + r.uy * s1;
      box = [r.b[0], Math.min(y0, y1), r.b[2], Math.max(y0, y1)];
    }
    b = union(b, box);
  }
  return b || line.b.slice();
}

// ---------------------------------------------------------------------------
// Page analysis

function headerOf(lines, W, H) {
  const out = { dept: null, concept: null, section: null, deadline: null };
  for (const l of lines) {
    const m = /store\s+deadline\s*:?\s*(.+)$/i.exec(l.t);
    if (m && !out.deadline) out.deadline = m[1].trim();
  }
  const top = lines
    .filter((l) => l.dir === 0 && l.b[3] < H * 0.17 && l.h >= 8 && Math.abs(cx(l.b) - W / 2) < W * 0.25)
    .sort((a, b) => a.b[1] - b.b[1]);
  for (const l of top) {
    let t = l.t;
    if (!out.dept) {
      const d = /^([0-9]{2})\s+(.+)$/.exec(t);
      if (d && !/^[0-9]{4}/.test(t)) {
        let name = d[2];
        const sc = /\s+(SC\s+[0-9].*)$/i.exec(name);
        if (sc) { name = name.slice(0, sc.index); out.concept = out.concept || sc[1]; }
        out.dept = { code: d[1], name: name.trim() };
        continue;
      }
    }
    if (!out.concept && /^SC\s+[0-9]/i.test(t)) { out.concept = t; continue; }
    if (!out.section) {
      const s = /^([0-9]{4,6})\s+(.+)$/.exec(t);
      if (s) out.section = { code: s[1], name: s[2].trim() };
    }
  }
  return out;
}

function findSegments(lines) {
  const segs = [];
  for (const l of lines) {
    if (!/Segment/i.test(l.t) || !/Notch/i.test(l.t)) continue;
    // match against the raw text so character offsets line up with the parts
    SEG_RX.lastIndex = 0;
    let m;
    while ((m = SEG_RX.exec(l.text))) {
      const b = spanBox(l, m.index, m.index + m[0].length);
      segs.push({
        s: m[1], sh: m[2], d: m[3].replace(/\s+/g, ' ').trim(), n: +m[4], b, line: l,
      });
    }
  }
  return segs;
}

function findMarkers(lines, segs, labelH, H) {
  if (!segs.length) return [];
  const minH = Math.max(7, labelH * 1.3);
  return lines
    .filter((l) => {
      if (l.dir !== 0 || l.h < minH || !MARKER_RX.test(l.t) || l.b[1] < H * 0.55) return false;
      // below every shelf strip around it (an endframe can end higher than the gondola next to it)
      const x = cx(l.b);
      const near = segs.filter((s) => s.b[2] > x - 90 && s.b[0] < x + 90);
      const lowest = Math.max(...(near.length ? near : segs).map((s) => s.b[3]));
      return l.b[1] > lowest - 2;
    })
    .map((l) => ({ t: l.t.replace(/\s+/g, ' '), x: cx(l.b), b: l.b }))
    .sort((a, b) => a.x - b.x);
}

/** Splits the page into module columns from the module markers along the bottom. */
function columnsOf(markers, W) {
  if (!markers.length) return [];
  const cols = markers.map((m) => ({ t: m.t, x: m.x, x0: 0, x1: W }));
  const gaps = [];
  for (let i = 1; i < cols.length; i++) gaps.push(cols[i].x - cols[i - 1].x);
  const typical = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : W;
  for (let i = 0; i < cols.length; i++) {
    cols[i].x0 = i ? (cols[i - 1].x + cols[i].x) / 2 : Math.max(0, cols[i].x - typical / 2);
    cols[i].x1 = i < cols.length - 1 ? (cols[i].x + cols[i + 1].x) / 2 : Math.min(W, cols[i].x + typical / 2);
  }
  return cols;
}

function colIndex(cols, x) {
  if (!cols.length) return -1;
  for (let i = 0; i < cols.length; i++) if (x >= cols[i].x0 && x < cols[i].x1) return i;
  let best = 0;
  for (let i = 1; i < cols.length; i++) if (Math.abs(cols[i].x - x) < Math.abs(cols[best].x - x)) best = i;
  return best;
}

/** Stacks lines into paragraphs: labels, notes, headings. */
function buildBlocks(lines) {
  const order = lines.slice().sort((a, b) => a.dir - b.dir || b.p - a.p || a.s0 - b.s0);
  const blocks = [];
  for (const l of order) {
    let best = null, bestGap = Infinity;
    for (const bl of blocks) {
      const last = bl.lines[bl.lines.length - 1];
      if (last.dir !== l.dir) continue;
      const step = last.p - l.p;
      const h = Math.max(last.h, l.h);
      if (step < 0.5 * Math.min(last.h, l.h) || step > 1.75 * h) continue;
      if (l.h / last.h > 1.34 || last.h / l.h > 1.34) continue;
      const overlap = Math.min(last.s1, l.s1) - Math.max(last.s0, l.s0);
      if (overlap < -0.3 * h) continue;
      if (step < bestGap) { best = bl; bestGap = step; }
    }
    if (best) {
      best.lines.push(l);
      best.b = union(best.b, l.b);
    } else {
      blocks.push({ lines: [l], b: l.b.slice() });
    }
  }
  return blocks;
}

const digits = (s) => /^[0-9]+$/.test(s);

/** Reads a label block: leading item numbers (possibly wrapped) and the name under them. */
function readLabel(block) {
  const T = block.lines.map((l) => l.t);
  const nums = [];
  const name = [];
  let i = 0;
  while (i < T.length) {
    const t = T[i].replace(/\s+/g, '');
    if (/^[0-9]{7}$/.test(t)) { nums.push(t); i++; continue; }
    if (digits(t) && t.length < 7) {
      // a number wrapped over two or more narrow lines: "491261" + "3", "508" + "700" + "1"
      let acc = t, j = i + 1;
      while (acc.length < 7 && j < T.length && digits(T[j].replace(/\s+/g, ''))) acc += T[j++].replace(/\s+/g, '');
      if (acc.length === 7) { nums.push(acc); i = j; continue; }
    }
    const m = /^([0-9]{7})\s*[,;:\-–]?\s*(\D.*)$/.exec(T[i]);
    if (m) { nums.push(m[1]); name.push(m[2]); i++; }
    break;
  }
  if (!nums.length) return null;
  for (; i < T.length; i++) name.push(T[i]);
  const nm = name.join(' ').replace(/^[\s,;:–-]+/, '').replace(/\s+/g, ' ').trim();
  // text with other item numbers under a label is an instruction, not the name:
  // 4912709 / "Display in 4912804 ROY"
  if (numsIn(nm).length) return { nums, name: '', extra: nm.replace(/^"|"$/g, '') };
  return { nums, name: nm };
}

function numsIn(text) {
  ITEM_RX.lastIndex = 0;
  return [...text.matchAll(ITEM_RX)].map((m) => m[0]);
}

// ---------------------------------------------------------------------------
// Tables

const HEAD = {
  id: /^(ProductID|Product ID|Article|Item no\.?|Varenr\.?)$/i,
  name: /^(Name|Description|Product name)$/i,
  sub: /^Substitut/i,
  disp: /^display model$/i,
};
const GROUP_RX = /^(Fixel_ID|Segment_Number|Segment\s+[0-9])/i;

function findTable(lines) {
  const heads = [];
  for (const l of lines) {
    if (l.dir !== 0) continue;
    for (const k of Object.keys(HEAD)) if (HEAD[k].test(l.t)) heads.push({ k, x: l.b[0], y: l.b[3], top: l.b[1] });
  }
  if (!heads.some((h) => h.k === 'id') || !heads.some((h) => h.k === 'name')) return null;
  // the header row: the topmost header cell and the cells stacked with it
  const top = Math.min(...heads.map((h) => h.top));
  const row = heads.filter((h) => h.top < top + 40);
  if (!row.some((h) => h.k === 'id') || !row.some((h) => h.k === 'name')) return null;
  const headerBottom = Math.max(...row.map((h) => h.y));
  const merged = [];
  for (const h of row.slice().sort((a, b) => a.x - b.x)) {
    const m = merged.find((q) => Math.abs(q.x - h.x) < 4);
    if (!m) merged.push({ k: h.k, x: h.x });
    else if (m.k !== 'id' && h.k === 'id') m.k = 'id';
  }
  merged.sort((a, b) => a.x - b.x);
  for (let i = 0; i < merged.length; i++) {
    merged[i].x0 = merged[i].x - 6;
    merged[i].x1 = i + 1 < merged.length ? merged[i + 1].x - 6 : Infinity;
  }
  const multiline = lines.some((l) => /^Nordic$/i.test(l.t));
  return { cols: merged, headerBottom, multiline };
}

/** A page without a header can continue the table of the page before it. */
function continuesTable(lines, prev) {
  if (!prev) return null;
  const idCols = prev.cols.filter((c) => c.k === 'id');
  const hits = lines.filter((l) => l.dir === 0 && /^[0-9]{7}$/.test(l.t) && idCols.some((c) => Math.abs(l.b[0] - c.x) < 4));
  if (hits.length < 2) return null;
  return { ...prev, headerBottom: 0 };
}

function readTable(lines, table, ctx) {
  const rows = [];
  const body = lines.filter((l) => l.dir === 0 && l.b[1] > table.headerBottom - 1 && l.h >= 2);
  const inCol = (l, c) => !!c && l.b[0] >= c.x0 && l.b[0] < c.x1;
  // group headers of product lists: "Segment_Number  Fixel_ID  Segment 3/3"
  const groups = body.filter((l) => GROUP_RX.test(l.t) && !/Notch/i.test(l.t));
  const fixels = groups
    .filter((l) => /^Segment\s+[0-9]/i.test(l.t))
    .map((l) => ({ y: l.b[1], t: l.t.replace(/\s+/g, ' ') }))
    .sort((a, b) => a.y - b.y);
  const breaks = groups.map((l) => l.b[1]).sort((a, b) => a - b);
  const text = body.filter((l) => !GROUP_RX.test(l.t));
  const idCols = table.cols.filter((c) => c.k === 'id');
  for (const ic of idCols) {
    const nextId = idCols.find((c) => c.x > ic.x);
    const right = table.cols.filter((c) => c.x > ic.x && (!nextId || c.x < nextId.x));
    const nameCol = right.find((c) => c.k === 'name');
    const subCol = right.find((c) => c.k === 'sub');
    const dispCol = right.find((c) => c.k === 'disp');
    const idLines = text.filter((l) => inCol(l, ic)).sort((a, b) => a.b[1] - b.b[1]);
    const anchors = idLines.filter((l) => /^[0-9]{7}$/.test(l.t.replace(/\s+/g, '')));
    if (!anchors.length) continue;
    // every number in the id column starts a row, except a country variant under its
    // main article: 4912691 / UK / 4912696
    const starts = [];
    anchors.forEach((a, i) => {
      const prev = anchors[i - 1];
      if (prev) {
        const between = idLines.filter((l) => l.b[1] > prev.b[1] + 0.5 && l.b[1] < a.b[1] - 0.5);
        if (between.length && between.every((l) => /^[A-Z]{2,3}$/.test(l.t)) && a.b[1] - prev.b[3] < 3 * a.h) return;
      }
      starts.push(a);
    });
    const bands = starts.map((a, i) => {
      let y1 = i + 1 < starts.length ? starts[i + 1].b[1] - 0.3 * a.h : Infinity;
      const br = breaks.find((y) => y > a.b[1] + 1);
      if (br !== undefined && br < y1) y1 = br - 0.5;
      if (y1 === Infinity) y1 = table.multiline ? a.b[3] + 6 * a.h : a.b[3] + 0.6 * a.h;
      return { y0: a.b[1] - 0.3 * a.h, y1, desc: null };
    });
    for (const bd of bands) {
      const ids = anchors.filter((a) => a.b[1] >= bd.y0 - 0.5 && a.b[1] < bd.y1);
      if (!ids.length) continue;
      const main = ids[0];
      const inBand = (l) => l.b[1] >= bd.y0 - 0.5 && l.b[1] < bd.y1;
      const nameLines = (bd.desc || text.filter((l) => inCol(l, nameCol) && inBand(l)))
        .slice().sort((a, b) => a.b[1] - b.b[1] || a.b[0] - b.b[0]);
      const name = nameLines.map((l) => l.t).join(' ').replace(/\s+/g, ' ').trim();
      const subs = text.filter((l) => inCol(l, subCol) && inBand(l)).flatMap((l) => numsIn(l.t));
      const disp = text.filter((l) => inCol(l, dispCol) && inBand(l)).flatMap((l) => numsIn(l.t));
      const variants = ids.slice(1).map((l) => l.t.replace(/\s+/g, ''));
      let fixel = ctx.lastFixel || null;
      for (const f of fixels) if (f.y <= main.b[1] + 1) fixel = f.t;
      let b = main.b.slice();
      for (const l of nameLines) b = union(b, l.b);
      rows.push({ num: main.t.replace(/\s+/g, ''), name, subs, disp, variants, fixel, b });
    }
  }
  if (fixels.length) ctx.lastFixel = fixels[fixels.length - 1].t;
  return rows;
}

// ---------------------------------------------------------------------------
// Pages

/**
 * Reads one page. raw = { w, h, items: [{ str, t: [a,b,c,d,e,f] (viewport space), w, h }] }
 * ctx carries table state from one page to the next.
 */
export function analyzePage(raw, ctx = {}) {
  const runs = raw.items
    .filter((it) => it.str && it.str.trim())
    .map((it) => glyphRun(it.str, it.t, it.w, it.h))
    .filter((r) => r.h >= 2); // hidden 1pt helper text in the lists
  const lines = buildLines(runs);
  const head = headerOf(lines, raw.w, raw.h);
  const page = { w: raw.w, h: raw.h, head, kind: 'other', segs: [], cols: [], labels: [], notes: [], rows: [] };
  const segs = findSegments(lines);
  if (!segs.length) {
    // tables: cells sit close together, so split lines at every real gap
    const cells = buildLines(runs, 0.3);
    const table = findTable(cells) || continuesTable(cells, ctx.table);
    if (table) {
      page.kind = 'table';
      ctx.table = table;
      page.rows = readTable(cells, table, ctx);
      return page;
    }
  }
  ctx.table = null;
  ctx.lastFixel = null;
  page.kind = segs.length ? 'drawing' : 'other';
  const segLines = new Set(segs.map((s) => s.line));
  const labelHs = lines.filter((l) => /^[0-9]{7}$/.test(l.t)).map((l) => l.h).sort((a, b) => a - b);
  const labelH = labelHs.length ? labelHs[Math.floor(labelHs.length / 2)] : 6;
  page.labelH = labelH;
  const markers = findMarkers(lines, segs, labelH, raw.h);
  const markerBoxes = new Set(markers.map((m) => m.b));
  const cols = columnsOf(markers, raw.w);
  page.cols = cols.map((c) => ({ t: c.t, x: round1(c.x), x0: round1(c.x0), x1: round1(c.x1) }));
  page.segs = segs.map((s) => {
    const col = colIndex(page.cols, cx(s.b));
    return { s: s.s, sh: s.sh, d: s.d, n: s.n, m: col >= 0 ? page.cols[col].t : null, b: rb(s.b), col };
  });
  const topY = raw.h * 0.15;
  const blocks = buildBlocks(lines.filter((l) => !segLines.has(l) && !markerBoxes.has(l.b)));
  for (const bl of blocks) {
    const lab = readLabel(bl);
    if (lab) {
      const nl = lab.extra ? bl.lines.filter((l, k) => k < lab.nums.length) : bl.lines;
      const lb = nl.reduce((acc, l) => union(acc, l.b), null);
      const label = { nums: lab.nums, name: lab.name, b: rb(lb), h: bl.lines[0].h };
      page.labels.push(label);
      if (lab.extra) page.notes.push({ t: lab.extra, nums: numsIn(lab.extra), b: rb(bl.b), h: label.h, own: label });
      continue;
    }
    const text = bl.lines.map((l) => l.t).join(' ').replace(/\s+/g, ' ').trim();
    if (bl.b[3] < topY && !numsIn(text).length) continue; // page title
    if (/store\s+deadline/i.test(text)) continue;
    const note = { t: text, nums: numsIn(text), b: rb(bl.b), h: Math.max(...bl.lines.map((l) => l.h)) };
    // under the module numbers: a note for the whole module
    if (markers.length && !note.nums.length && bl.b[1] > Math.min(...markers.map((m) => m.b[1])) - 1) note.module = true;
    page.notes.push(note);
  }
  placeLabels(page, null);
  return page;
}

const inside = (b, x, y) => x >= b[0] - 0.01 && x <= b[2] + 0.01 && y >= b[1] - 0.01 && y <= b[3] + 0.01;
const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/**
 * The product photo(s) a label belongs to. Spaceman centres a label under the
 * product (all facings), or puts it in the top left corner (curtains).
 * imgs: [{ b }] photo boxes on the page in viewport space.
 */
function productPhotos(page, imgs) {
  const pageArea = page.w * page.h;
  return imgs.filter((im) => area(im.b) < 0.12 * pageArea && im.b[2] - im.b[0] < 0.3 * page.w && im.b[3] - im.b[1] < 0.45 * page.h
    && im.b[2] - im.b[0] > 2 && im.b[3] - im.b[1] > 2);
}

/** The photo a label belongs to: the one under it, or the facing right next to it. */
export function labelPhoto(page, lab, imgs) {
  const photos = productPhotos(page, imgs);
  const lx = cx(lab.b), ly = cy(lab.b);
  let i0 = photos.filter((im) => inside(im.b, lx, ly)).sort((a, b) => area(a.b) - area(b.b))[0];
  if (!i0) {
    // the label sits between two facings, or just below / above the photo
    i0 = photos
      .filter((im) => im.b[0] < lab.b[2] && im.b[2] > lab.b[0])
      .map((im) => ({
        im,
        dy: Math.max(0, lab.b[1] - im.b[3], im.b[1] - lab.b[3]),
        dx: Math.max(0, im.b[0] - lx, lx - im.b[2]),
      }))
      .filter((x) => x.dy < 4)
      .sort((a, b) => a.dy - b.dy || a.dx - b.dx || area(a.im.b) - area(b.im.b))
      .map((x) => x.im)[0];
  }
  return i0 || null;
}

/**
 * The photos that make an article's picture, in drawing order. Usually one: the biggest photo
 * in the column of the label's product (lab.blk from placeLabels), so the thin rim of a stacked
 * basket does not stand for the basket. When even that is a thin slice (plates in a stack),
 * the whole stack. [] when the label has no photo.
 */
export function labelPicture(page, lab, imgs) {
  const i0 = labelPhoto(page, lab, imgs);
  if (!i0) return [];
  const k = lab.blk;
  if (!k) return [i0];
  const W = (im) => im.b[2] - im.b[0], H = (im) => im.b[3] - im.b[1];
  const column = (a, im) => Math.min(im.b[2], a.b[2]) - Math.max(im.b[0], a.b[0]) > 0.6 * Math.min(W(a), W(im)) && W(im) < 1.3 * W(a);
  const within = productPhotos(page, imgs).filter((im) => im.b[0] >= k[0] - 1 && im.b[2] <= k[2] + 1
    && im.b[1] >= k[1] - 1 && im.b[3] <= k[3] + 1 && column(i0, im));
  let best = i0;
  for (const im of within) if (area(im.b) > area(best.b)) best = im;
  if (area(best.b) < 1.5 * area(i0.b)) best = i0;
  if (H(best) < 0.35 * W(best)) {
    const stack = within.filter((im) => column(best, im));
    if (stack.length > 1) return imgs.filter((im) => stack.includes(im));
  }
  return [best];
}

/** The photo in the same row of a table (lamp lists), left of the article number. */
export function rowPhoto(row, imgs) {
  let best = null, bestO = 0;
  for (const im of imgs) {
    if (cx(im.b) >= row.b[0]) continue;
    const o = Math.min(im.b[3], row.b[3] + 24) - Math.max(im.b[1], row.b[1] - 24);
    if (o > bestO && row.b[0] - im.b[2] < 120) { best = im; bestO = o; }
  }
  return best;
}

export function productBlock(page, lab, imgs) {
  const photos = productPhotos(page, imgs);
  const lx = cx(lab.b), ly = cy(lab.b);
  const i0 = labelPhoto(page, lab, imgs);
  if (!i0) return null;
  const others = page.labels.filter((o) => o !== lab).map((o) => [cx(o.b), cy(o.b)]);
  const taken = (im) => others.some(([x, y]) => inside(im.b, x, y));
  const h0 = i0.b[3] - i0.b[1], w0 = i0.b[2] - i0.b[0];
  // labels on the same row split the shelf between them
  const mates = page.labels.filter((o) => o !== lab && Math.abs(cy(o.b) - ly) < 0.75 * h0);
  const lim0 = Math.max(-Infinity, ...mates.filter((o) => cx(o.b) < lx).map((o) => cx(o.b)));
  const lim1 = Math.min(Infinity, ...mates.filter((o) => cx(o.b) > lx).map((o) => cx(o.b)));
  const like = (im) => Math.abs(im.b[3] - i0.b[3]) <= 2 && Math.abs((im.b[3] - im.b[1]) - h0) <= 0.1 * h0
    && Math.abs((im.b[2] - im.b[0]) - w0) <= 0.12 * w0 && cx(im.b) > lim0 && cx(im.b) < lim1 && !taken(im);
  const chain = (sideLeft) => {
    const out = [];
    let cur = i0;
    for (;;) {
      const nxt = photos.find((im) => im !== cur && !out.includes(im) && like(im) && (sideLeft
        ? Math.abs(im.b[2] - cur.b[0]) < 2.5 && im.b[0] < cur.b[0]
        : Math.abs(im.b[0] - cur.b[2]) < 2.5 && im.b[2] > cur.b[2]));
      if (!nxt) return out;
      out.push(nxt);
      cur = nxt;
    }
  };
  const L = chain(true), R = chain(false);
  let kL = 0, kR = 0;
  if (Math.abs(lab.b[0] - i0.b[0]) < 3 && lab.b[1] - i0.b[1] < h0 * 0.5) {
    kR = R.length; // label in the top left corner: the facings run to the right
  } else {
    let best = { n: -1, asym: Infinity };
    for (let a = 0; a <= L.length; a++) {
      for (let c = 0; c <= R.length; c++) {
        const x0 = a ? L[a - 1].b[0] : i0.b[0];
        const x1 = c ? R[c - 1].b[2] : i0.b[2];
        const asym = Math.abs((x0 + x1) / 2 - lx);
        if (asym > Math.max(3, 0.2 * w0)) continue;
        if (a + c > best.n || (a + c === best.n && asym < best.asym)) best = { n: a + c, asym, a, c };
      }
    }
    if (best.n >= 0) { kL = best.a; kR = best.c; }
  }
  const set = [i0, ...L.slice(0, kL), ...R.slice(0, kR)];
  let b = set.reduce((acc, im) => union(acc, im.b), null);
  // facings stacked on top of each other
  for (let grew = true; grew;) {
    grew = false;
    for (const im of photos) {
      if (set.includes(im) || taken(im)) continue;
      if (cx(im.b) <= lim0 || cx(im.b) >= lim1) continue;
      const xo = Math.min(im.b[2], b[2]) - Math.max(im.b[0], b[0]);
      const iw = im.b[2] - im.b[0];
      if (xo < 0.6 * iw || iw > (b[2] - b[0]) * 1.15) continue;
      if (im.b[1] - b[3] < 2.5 && b[1] - im.b[3] < 2.5) { set.push(im); b = union(b, im.b); grew = true; }
    }
  }
  return rb(b);
}

/**
 * Module edges from the drawing itself: the gap between two module back panels,
 * or the middle of the double upright between them.
 */
function refineColumns(cols, rules) {
  if (cols.length < 2 || !rules.length) return;
  const spacing = Math.abs(cols[1].x - cols[0].x);
  const panels = rules.filter((r) => r.b[2] - r.b[0] > 40 && r.b[2] - r.b[0] < spacing * 1.6);
  const thin = rules.filter((r) => r.b[2] - r.b[0] < 16);
  const panelAt = (x) => panels.filter((p) => p.b[0] <= x && p.b[2] >= x).sort((a, b) => (a.b[2] - a.b[0]) - (b.b[2] - b.b[0]))[0];
  for (let i = 0; i + 1 < cols.length; i++) {
    const a = cols[i], b = cols[i + 1];
    const mid = (a.x + b.x) / 2;
    let edge = null;
    // the upright between two modules is drawn as two halves; the edge is where they meet
    const ups = thin.filter((r) => cx(r.b) > a.x + 5 && cx(r.b) < b.x - 5);
    if (ups.length) {
      const near = ups.reduce((p, r) => (Math.abs(cx(r.b) - mid) < Math.abs(cx(p.b) - mid) ? r : p));
      const cl = ups.filter((r) => Math.abs(cx(r.b) - cx(near.b)) < 20).sort((p, q) => p.b[0] - q.b[0]);
      const left = cl.filter((r) => cx(r.b) < cx(cl[cl.length - 1].b) - 1);
      if (left.length) {
        const l = left[left.length - 1].b[2];
        const r = Math.min(...cl.filter((q) => !left.includes(q)).map((q) => q.b[0]));
        edge = (l + r) / 2;
      } else {
        edge = (Math.min(...cl.map((r) => r.b[0])) + Math.max(...cl.map((r) => r.b[2]))) / 2;
      }
    } else {
      const pa = panelAt(a.x), pb = panelAt(b.x);
      if (pa && pb && pa !== pb && pa.b[2] <= pb.b[0] + 1 && pb.b[0] - pa.b[2] < 30) edge = (pa.b[2] + pb.b[0]) / 2;
    }
    if (edge !== null && edge > a.x && edge < b.x) { a.x1 = Math.round(edge * 100) / 100; b.x0 = a.x1; }
  }
}

/**
 * Puts every label on a module and a shelf. With the drawing (gfx = { photos, rules })
 * the product's left edge decides the module, as in Spaceman.
 */
export function placeLabels(page, gfx) {
  if (gfx && gfx.rules) {
    refineColumns(page.cols, gfx.rules);
    for (const s of page.segs) { s.col = colIndex(page.cols, cx(s.b)); s.m = s.col >= 0 ? page.cols[s.col].t : null; }
  }
  const imgs = gfx ? gfx.photos : null;
  for (const lab of page.labels) {
    const blk = imgs ? productBlock(page, lab, imgs) : null;
    if (blk) lab.blk = blk;
    const box = lab.blk ? union(lab.blk, lab.b) : lab.b;
    // a product belongs to the module its left edge stands in
    const anchorX = lab.blk ? lab.blk[0] + 0.05 : lab.b[0] + Math.min(4, (lab.b[2] - lab.b[0]) / 2);
    lab.col = colIndex(page.cols, anchorX);
    lab.seg = pickShelf(page.segs, lab.col, anchorX, box);
  }
  const byShelf = new Map();
  for (const lab of page.labels) {
    if (lab.seg < 0) continue;
    if (!byShelf.has(lab.seg)) byShelf.set(lab.seg, []);
    byShelf.get(lab.seg).push(lab);
  }
  for (const list of byShelf.values()) {
    list.sort((a, b) => (a.blk || a.b)[0] - (b.blk || b.b)[0]);
    list.forEach((lab, i) => { lab.pos = i + 1; lab.cnt = list.length; });
  }
  // short notes without numbers ("Display in ROY", "SEAM box 40x20") go with the label next to them
  const lh = page.labelH || 6;
  for (const n of page.notes) {
    n.near = null;
    if (n.module) {
      // every product in the modules the note spans
      n.near = page.labels.filter((lab) => {
        const c = page.cols[lab.col];
        return c && Math.min(c.x1, n.b[2]) - Math.max(c.x0, n.b[0]) > 0.3 * (c.x1 - c.x0);
      });
      continue;
    }
    if (n.nums.length || n.h > lh * 1.25) continue;
    let best = null, bestD = Infinity;
    for (const lab of page.labels) {
      const lb = lab.blk ? union(lab.blk, lab.b) : lab.b;
      const dx = Math.max(0, lb[0] - n.b[2], n.b[0] - lb[2]);
      const dy = Math.max(0, lb[1] - n.b[3], n.b[1] - lb[3]);
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = lab; }
    }
    if (best && bestD < 2.5 * lh) n.near = [best];
  }
}

/** The shelf strip under the product in the same module (or the bar it hangs from). */
function pickShelf(segs, col, anchorX, box) {
  let cands = segs.map((s, i) => ({ s, i })).filter(({ s }) => col < 0 || s.col === col);
  if (!cands.length) cands = segs.map((s, i) => ({ s, i }));
  if (col < 0) cands = cands.filter(({ s }) => anchorX >= s.b[0] - 120 && anchorX <= s.b[2] + 120);
  const tol = 1.5;
  let below = null, bar = null, above = null;
  const mid = (box[1] + box[3]) / 2;
  for (const c of cands) {
    const gapBelow = c.s.b[1] - box[3];
    if (gapBelow >= -tol && (!below || gapBelow < below.g)) below = { ...c, g: gapBelow };
    const gapAbove = box[1] - c.s.b[3];
    if (gapAbove >= -tol && (!above || gapAbove < above.g)) above = { ...c, g: gapAbove };
    // products hang under a bar: its strip sits at their top edge
    if (BAR_RX.test(c.s.d) && cy(c.s.b) < mid) {
      const g = Math.abs(box[1] - cy(c.s.b));
      if (!bar || g < bar.g) bar = { ...c, g };
    }
  }
  if (bar && (!below || bar.g < below.g)) return bar.i;
  if (below) return below.i;
  return above ? above.i : -1;
}

// ---------------------------------------------------------------------------
// Whole planogram

const fixelKey = (s, sh) => `${s}/${sh}`;
const FIXEL_RX = /Segment\s+([0-9]+(?:-[0-9]+)?)\s*\/\s*([0-9]+)/i;

function listedShelves(pages) {
  const by = new Map();
  for (const p of pages) {
    for (const r of p.rows) {
      const m = r.fixel && FIXEL_RX.exec(r.fixel);
      if (!m) continue;
      if (!by.has(r.num)) by.set(r.num, new Set());
      by.get(r.num).add(fixelKey(m[1], m[2]));
    }
  }
  return by;
}

/** Drawing pages with products the product lists do not place: these need the photo boxes. */
export function pagesNeedingPhotos(pages) {
  const listed = listedShelves(pages);
  const out = [];
  pages.forEach((p, i) => {
    if (p.kind === 'drawing' && p.labels.some((l) => l.nums.some((n) => !listed.has(n)))) out.push(i);
  });
  return out;
}

/** Text-only convenience: raw pages -> planogram. */
export function parsePlanogram(rawPages) {
  const ctx = {};
  return buildPlan(rawPages.map((r) => analyzePage(r, ctx)));
}

/** Analysed pages -> the planogram the app stores. */
export function buildPlan(pages) {
  const meta = { dept: null, concept: null, sections: [], deadline: null, pages: pages.length };
  const secIndex = new Map();
  for (const p of pages) {
    const h = p.head;
    if (h.dept && !meta.dept) meta.dept = h.dept;
    if (h.concept && !meta.concept) meta.concept = h.concept;
    if (h.deadline && !meta.deadline) meta.deadline = h.deadline;
    if (h.section) {
      const k = `${h.section.code} ${h.section.name}`;
      if (!secIndex.has(k)) { secIndex.set(k, meta.sections.length); meta.sections.push(h.section); }
      p.sec = secIndex.get(k);
    } else {
      p.sec = -1;
    }
  }
  const listed = listedShelves(pages);
  const items = {};
  const alias = {};
  const get = (n) => (items[n] = items[n] || { nm: '', oc: [], nt: [], rw: [] });
  pages.forEach((p, pi) => {
    for (const r of p.rows) {
      const it = get(r.num);
      if (r.name && it.src !== 'table') { it.nm = r.name; it.src = 'table'; }
      it.rw.push({ p: pi, b: rb(r.b), fx: r.fixel || null });
      for (const s of [...r.subs, ...r.variants]) if (s !== r.num && !alias[s]) alias[s] = { to: r.num, k: 'sub' };
      for (const s of r.disp) if (s !== r.num && !alias[s]) alias[s] = { to: r.num, k: 'disp' };
    }
  });
  pages.forEach((p, pi) => {
    for (const lab of p.labels) {
      for (const num of lab.nums) {
        const it = get(num);
        if (lab.name && !it.nm) { it.nm = lab.name; it.src = 'label'; }
        let seg = lab.seg;
        // the product list knows the shelf for sure; trust it over the geometry
        const fx = listed.get(num);
        if (fx && seg >= 0 && !fx.has(fixelKey(p.segs[seg].s, p.segs[seg].sh))) {
          const ref = lab.blk || lab.b;
          let best = -1, bestD = Infinity;
          p.segs.forEach((s, si) => {
            if (!fx.has(fixelKey(s.s, s.sh))) return;
            const d = Math.abs(s.b[1] - ref[3]) + 0.25 * Math.abs(cx(s.b) - cx(ref));
            if (d < bestD) { bestD = d; best = si; }
          });
          if (best >= 0) seg = best;
        }
        const oc = { p: pi, b: lab.b, g: seg };
        if (lab.blk) oc.k = lab.blk;
        it.oc.push(oc);
      }
    }
  });
  const notes = [];
  const noteKey = new Map();
  pages.forEach((p, pi) => {
    for (const n of p.notes) {
      const owners = n.own ? n.own.nums : n.near ? n.near.flatMap((lab) => lab.nums) : [];
      const targets = [...new Set([...owners, ...n.nums])];
      if (!targets.length) continue;
      const k = `${n.t}|${owners.join(',')}`;
      let idx = noteKey.get(k);
      if (idx === undefined) {
        idx = notes.length;
        const note = { p: pi, b: n.b, t: n.t };
        if (owners.length) note.o = [...new Set(owners)];
        notes.push(note);
        noteKey.set(k, idx);
      }
      for (const num of targets) { const it = get(num); if (!it.nt.includes(idx)) it.nt.push(idx); }
    }
  });
  // order on each shelf, after the corrections
  const shelves = new Map();
  for (const [num, it] of Object.entries(items)) {
    for (const o of it.oc) {
      if (o.g < 0) continue;
      const k = `${o.p}:${o.g}`;
      if (!shelves.has(k)) shelves.set(k, []);
      shelves.get(k).push({ num, o });
    }
  }
  for (const list of shelves.values()) {
    list.sort((a, b) => (a.o.k || a.o.b)[0] - (b.o.k || b.o.b)[0]);
    list.forEach(({ o }, i) => {
      o.pos = i + 1;
      o.cnt = list.length;
      o.l = i > 0 ? list[i - 1].num : null;
      o.r = i + 1 < list.length ? list[i + 1].num : null;
    });
  }
  for (const it of Object.values(items)) delete it.src;
  const codes = [...new Set(meta.sections.map((s) => s.code))].sort();
  const key = `${meta.dept ? meta.dept.code : '?'}|${codes.join(',')}`;
  return {
    v: 1,
    meta,
    key,
    pages: pages.map((p) => ({
      w: round1(p.w), h: round1(p.h), kind: p.kind, sec: p.sec,
      segs: p.segs.map(({ col, ...s }) => s), cols: p.cols,
    })),
    items,
    notes,
    alias,
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers

export function deadlineLabel(d) {
  if (!d) return '';
  const m = /([A-Za-z]+)\s+([0-9]{4})/.exec(d);
  if (m && MONTHS[m[1].toLowerCase()]) return `${MONTHS[m[1].toLowerCase()]} ${m[2]}`;
  return d;
}

/** Sortable value for "July 2026" (2026*12+7); 0 when unknown. */
export function deadlineValue(d) {
  if (!d) return 0;
  const m = /([A-Za-z]+)\s+([0-9]{4})/.exec(d);
  if (!m) return 0;
  const mo = MONTH_NO[m[1].toLowerCase()];
  return mo ? +m[2] * 12 + mo : 0;
}

export function planTitle(plan) {
  const m = plan.meta;
  if (m.dept) return `${m.dept.code} ${m.dept.name}`;
  if (m.sections.length) return `${m.sections[0].code} ${m.sections[0].name}`;
  return 'Planogram';
}

/** Where an occurrence is, in words the app shows. */
export function placeOf(plan, oc) {
  const pg = plan.pages[oc.p];
  const seg = oc.g >= 0 ? pg.segs[oc.g] : null;
  const sec = pg.sec >= 0 ? plan.meta.sections[pg.sec] : null;
  return {
    module: seg ? seg.m || seg.s : null,
    segment: seg ? `${seg.s}/${seg.sh}` : null,
    shelf: seg ? +seg.sh : null,
    notch: seg ? seg.n : null,
    fixture: seg ? seg.d : null,
    section: sec ? `${sec.code} ${sec.name}` : null,
    page: oc.p + 1,
    pos: oc.pos || 0,
    cnt: oc.cnt || 0,
  };
}

/** All shelves of the module an occurrence is in, top to bottom (for the side view). */
export function moduleShelves(plan, oc) {
  const pg = plan.pages[oc.p];
  if (oc.g < 0) return [];
  const seg = pg.segs[oc.g];
  return pg.segs
    .map((s, i) => ({ ...s, i }))
    .filter((s) => (seg.m ? s.m === seg.m : s.s === seg.s) && s.s === seg.s)
    .sort((a, b) => b.n - a.n || +a.sh - +b.sh);
}

// ---------------------------------------------------------------------------
// Lookup across all planograms

export function fold(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[øØ]/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Section codes a planogram covers ("0501", "0502", ...). */
export function sectionCodes(plan) {
  return new Set(plan.meta.sections.map((s) => s.code));
}

/** The section code of the page an occurrence or row is on, or null. */
function sectionAt(plan, p) {
  const pg = plan.pages[p];
  return pg && pg.sec >= 0 ? plan.meta.sections[pg.sec].code : null;
}

/**
 * plans: [{ id, plan }] oldest first. The newest planogram for a section wins:
 * places from an older PDF for the same section are left out.
 * Returns an index for resolveCode() and search().
 */
export function buildIndex(plans) {
  const owner = new Map(); // section code -> plan id
  for (const { id, plan } of plans) for (const c of sectionCodes(plan)) owner.set(c, id);
  const byNum = new Map(); // num -> [{ id, plan, it, num }]
  const alias = new Map(); // other num -> { to, k, id }
  const newer = new Map(); // num -> index of the newest plan that has it
  plans.forEach(({ plan }, i) => { for (const num of Object.keys(plan.items)) newer.set(num, i); });
  plans.forEach(({ id, plan }, i) => {
    for (const [num, it] of Object.entries(plan.items)) {
      const live = (p) => { const c = sectionAt(plan, p); return c ? owner.get(c) === id : newer.get(num) === i; };
      const oc = it.oc.filter((o) => live(o.p));
      const rw = it.rw.filter((r) => live(r.p));
      const mentioned = !it.oc.length && !it.rw.length && newer.get(num) === i;
      if (!oc.length && !rw.length && !mentioned) continue;
      const view = oc.length === it.oc.length && rw.length === it.rw.length ? it : { ...it, oc, rw };
      if (!byNum.has(num)) byNum.set(num, []);
      byNum.get(num).push({ id, plan, it: view, num });
    }
  });
  for (let i = plans.length - 1; i >= 0; i--) {
    const { id, plan } = plans[i];
    for (const [num, a] of Object.entries(plan.alias || {})) {
      if (!byNum.has(num) && !alias.has(num) && byNum.has(a.to)) alias.set(num, { ...a, id });
    }
  }
  const names = [];
  for (const [num, list] of byNum) {
    const nm = list.map((x) => x.it.nm).find(Boolean) || '';
    names.push({ num, nm, f: fold(nm) });
  }
  names.sort((a, b) => a.num.localeCompare(b.num));
  return { byNum, alias, names, owner };
}

/**
 * Turns a scanned or typed code into item numbers.
 * learned: { code: num } the user linked earlier.
 * Returns { num, via } or null. via: 'exact' | 'learned' | 'substitute' | 'inside'
 */
export function resolveCode(index, code, learned = {}) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!c) return null;
  if (index.byNum.has(c)) return { num: c, via: 'exact' };
  if (learned[c] && (index.byNum.has(learned[c]) || index.alias.has(learned[c]))) {
    const n = learned[c];
    if (index.byNum.has(n)) return { num: n, via: 'learned' };
    return { num: index.alias.get(n).to, via: 'substitute', from: n };
  }
  if (index.alias.has(c)) return { num: index.alias.get(c).to, via: 'substitute', from: c };
  const d = c.replace(/^0+/, '');
  if (d !== c && index.byNum.has(d)) return { num: d, via: 'exact' };
  // a 7-digit item number inside a longer code (EAN, label codes)
  if (/^[0-9]{8,14}$/.test(c)) {
    const hits = new Set();
    for (let i = 0; i + 7 <= c.length; i++) {
      const s = c.slice(i, i + 7);
      if (index.byNum.has(s)) hits.add(s);
    }
    if (hits.size === 1) return { num: [...hits][0], via: 'inside' };
  }
  return null;
}

// Names in the planograms are English; people search in Bosnian too.
const SYN = [
  [['korp', 'kosar', 'kosar'], ['basket']],
  [['kutij'], ['box', 'storage']],
  [['svijecnj', 'svjecnj', 'svecnj'], ['candlestick', 'candle holder', 'tealight holder', 'holder']],
  [['svijec', 'svjec', 'svec'], ['candle', 'tealight']],
  [['vaz'], ['vase']],
  [['okvir', 'ram'], ['frame']],
  [['lamp', 'svjetilj', 'svjetiljk'], ['lamp', 'pendant']],
  [['sijalic', 'zarulj', 'sijalk'], ['bulb']],
  [['ogledal'], ['mirror']],
  [['jastuk', 'jastuc'], ['cus', 'cushion']],
  [['pled', 'prekrivac', 'deka', 'cebe'], ['thr', 'throw', 'blanket']],
  [['zavjes', 'zavjese', 'zavese', 'zastor'], ['cur', 'curtain']],
  [['rolet', 'roletn'], ['rb', 'roller', 'blind']],
  [['garnis', 'karnis'], ['pole', 'rod', 'track']],
  [['sipk'], ['rod', 'pole']],
  [['tepih', 'tepisi', 'otirac'], ['rug', 'mat']],
  [['sat', 'satov'], ['clock']],
  [['biljk', 'cvijet', 'cvjet'], ['plant', 'flower']],
  [['saksij', 'tegl', 'teglic', 'lonac'], ['pot']],
  [['posluzavnik', 'pladanj', 'tacn', 'tanjir', 'zdjel', 'cinij'], ['tray', 'bowl', 'plate']],
  [['fenjer', 'lantern'], ['lantern']],
  [['figur', 'kip'], ['figurine', 'figure']],
  [['bater'], ['battery', 'batteries']],
  [['lampic'], ['string lights', 'lights']],
  [['drzac'], ['holder']],
  [['kuk', 'vjesalic'], ['hook', 'hanger']],
  [['ubrus', 'salvet'], ['napkin']],
  [['mreza', 'komarnik'], ['insect screen', 'net']],
  [['bijel'], ['white']],
  [['crn'], ['black']],
  [['siv'], ['grey', 'gray']],
  [['smed', 'braon'], ['brown']],
  [['zelen'], ['green']],
  [['plav'], ['blue']],
  [['bez'], ['beige', 'sand']],
];

function synonyms(w) {
  if (w.length < 3) return [];
  const out = [];
  for (const [bs, en] of SYN) if (bs.some((b) => w.startsWith(b) || (b.startsWith(w) && w.length >= 4))) out.push(...en);
  return out;
}

/** Search by number (prefix, 3+ digits) or by words in the name. */
export function search(index, q, limit = 40) {
  const s = String(q || '').trim();
  if (!s) return [];
  const out = [];
  const dq = s.replace(/\s+/g, '');
  if (/^[0-9]+$/.test(dq)) {
    if (dq.length < 3) return [];
    for (const n of index.names) if (n.num.startsWith(dq)) { out.push(n.num); if (out.length >= limit) break; }
    if (out.length < limit) {
      for (const n of index.names) if (!n.num.startsWith(dq) && n.num.includes(dq)) { out.push(n.num); if (out.length >= limit) break; }
    }
    for (const [a, v] of index.alias) if (a.startsWith(dq) && !out.includes(v.to) && out.length < limit) out.push(v.to);
    return out;
  }
  const words = fold(s).split(' ').filter(Boolean).map((w) => [w, ...synonyms(w)]);
  const scored = [];
  for (const n of index.names) {
    if (!n.f) continue;
    let ok = true, score = 0;
    for (const alts of words) {
      let best = 0;
      for (const w of alts) {
        const i = n.f.indexOf(w);
        if (i < 0) continue;
        const sc = (i === 0 || n.f[i - 1] === ' ' ? 2 : 1) * (w === alts[0] ? 1 : 0.9);
        if (sc > best) best = sc;
      }
      if (!best) { ok = false; break; }
      score += best;
    }
    if (ok) scored.push({ num: n.num, score, len: n.f.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len || a.num.localeCompare(b.num));
  return scored.slice(0, limit).map((x) => x.num);
}

/**
 * What changed between two versions of a planogram, optionally only for some sections.
 * Returns { added: [num], removed: [num], moved: [{ num, from, to }] }.
 */
export function diffPlans(oldPlan, newPlan, codes = null) {
  const keep = (plan, o) => !codes || codes.has(sectionAt(plan, o.p));
  const places = (plan, it) => it.oc.filter((o) => keep(plan, o));
  const where = (plan, it) => places(plan, it)
    .map((o) => placeOf(plan, o))
    .map((p) => (p.segment ? `${p.module || ''}|${p.segment}|${p.notch}` : `p${p.page}`))
    .sort()
    .join(';');
  const added = [], removed = [], moved = [];
  const oldNums = new Set(Object.keys(oldPlan.items).filter((n) => places(oldPlan, oldPlan.items[n]).length));
  const newNums = new Set(Object.keys(newPlan.items).filter((n) => places(newPlan, newPlan.items[n]).length));
  for (const n of newNums) if (!oldNums.has(n)) added.push(n);
  for (const n of oldNums) if (!newNums.has(n)) removed.push(n);
  for (const n of newNums) {
    if (!oldNums.has(n)) continue;
    const a = where(oldPlan, oldPlan.items[n]), b = where(newPlan, newPlan.items[n]);
    if (a !== b) {
      moved.push({
        num: n,
        from: places(oldPlan, oldPlan.items[n]).map((o) => placeOf(oldPlan, o)),
        to: places(newPlan, newPlan.items[n]).map((o) => placeOf(newPlan, o)),
      });
    }
  }
  return { added: added.sort(), removed: removed.sort(), moved };
}

const deptOf = (p) => (p.meta.dept ? p.meta.dept.code : null);

/** The new planogram covers every section of the old one: it replaces it. */
export function samePlanogram(oldPlan, newPlan) {
  if (oldPlan.key === newPlan.key) return true;
  const a = deptOf(oldPlan), b = deptOf(newPlan);
  if (a && b && a !== b) return false;
  const nc = sectionCodes(newPlan);
  const oc = sectionCodes(oldPlan);
  return oc.size > 0 && [...oc].every((c) => nc.has(c));
}

/** Sections the new planogram takes over from an older one it does not fully replace. */
export function sharedSections(oldPlan, newPlan) {
  const a = deptOf(oldPlan), b = deptOf(newPlan);
  if (a && b && a !== b) return new Set();
  const nc = sectionCodes(newPlan);
  return new Set([...sectionCodes(oldPlan)].filter((c) => nc.has(c)));
}

/** For tests and debugging. */
export const _internals = { glyphRun, buildLines, findTable, readTable, buildBlocks, readLabel };
