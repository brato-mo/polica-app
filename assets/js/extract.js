// Reads the text of every page with pdf.js, in viewport space (scale 1, y down).
// Works with the pdf.js document object in the app and in Node.

/** m × n for pdf.js style matrices [a, b, c, d, e, f]: applies n first. */
export function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export async function readPages(doc, onPage) {
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string' || !it.str.trim()) continue;
      items.push({ str: it.str, t: mul(vp.transform, it.transform), w: it.width, h: it.height });
    }
    out.push({ w: vp.width, h: vp.height, items });
    page.cleanup();
    if (onPage) await onPage(i, doc.numPages);
  }
  return out;
}

function unitBox(m) {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * What is drawn on a page, in viewport space (scale 1), from its operator list:
 * photos (product pictures) and tall rectangles (module back panels and uprights).
 * Each photo carries the clip paths in effect when it was drawn ({ path, m, rule }, path in
 * pdf.js drawing format, m to viewport space): product photos are often cut out by a path.
 */
export async function pageGraphics(page, OPS) {
  const vp = page.getViewport({ scale: 1 });
  const ol = await page.getOperatorList();
  let ctm = vp.transform.slice();
  let clips = []; // replaced, never changed in place: photos keep the array they saw
  let pendingClip = null;
  const stack = [];
  const photos = [];
  const rules = [];
  const tall = vp.height * 0.3;
  const pop = () => { const s = stack.pop(); if (s) [ctm, clips] = s; };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    const a = ol.argsArray[i];
    if (fn === OPS.save) stack.push([ctm, clips]);
    else if (fn === OPS.restore) pop();
    else if (fn === OPS.transform) ctm = mul(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push([ctm, clips]); if (a && a[0]) ctm = mul(ctm, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) pop();
    else if (fn === OPS.clip || fn === OPS.eoClip) pendingClip = fn === OPS.eoClip ? 'evenodd' : 'nonzero';
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      photos.push({ b: unitBox(ctm), m: ctm, id: typeof a[0] === 'string' ? a[0] : null, inline: typeof a[0] === 'object' ? a[0] : null, clips });
    } else if (fn === OPS.paintImageMaskXObject) {
      photos.push({ b: unitBox(ctm), m: ctm, id: null, inline: null, clips });
    } else if (fn === OPS.paintImageXObjectRepeat) {
      const [id, sx, sy, pos] = a;
      for (let j = 0; j < pos.length; j += 2) {
        const m = mul(ctm, [sx, 0, 0, sy, pos[j], pos[j + 1]]);
        photos.push({ b: unitBox(m), m, id: typeof id === 'string' ? id : null, inline: null, clips });
      }
    } else if (fn === OPS.constructPath && a) {
      if (pendingClip && a[1] && a[1][0]) clips = clips.concat([{ path: a[1][0], m: ctm, rule: pendingClip }]);
      pendingClip = null;
      if (a[2]) {
        const mm = a[2];
        const m = mul(ctm, [mm[2] - mm[0], 0, 0, mm[3] - mm[1], mm[0], mm[1]]);
        const b = unitBox(m);
        if (b[3] - b[1] > tall) rules.push({ b });
      }
    }
  }
  return { photos, rules };
}

/** The decoded picture of a photo found by pageGraphics ({ width, height, bitmap } or { width, height, kind, data }). */
export function photoImage(page, photo, waitMs = 4000) {
  if (photo.inline) return Promise.resolve(photo.inline);
  if (!photo.id) return Promise.resolve(null);
  const store = photo.id.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), waitMs);
    try {
      store.get(photo.id, (img) => { clearTimeout(timer); resolve(img || null); });
    } catch (e) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}
