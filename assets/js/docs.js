// Everything that touches pdf.js: reading a planogram at import, keeping documents open,
// and drawing a part of a page (with the product photos recorded for the highlight).
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { readPages, pageGraphics, photoImage, mul } from './extract.js';
import { analyzePage, placeLabels, buildPlan, productBlock, labelPicture, rowPhoto } from './core.js';

/** Version of what the reader stores; older planograms are read again after an update. */
export const PLAN_VERSION = 2;

const VENDOR = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';

function load(data) {
  return pdfjs.getDocument({
    data,
    standardFontDataUrl: VENDOR + 'standard_fonts/',
    wasmUrl: VENDOR + 'wasm/',
    iccUrl: VENDOR + 'iccs/',
    useWorkerFetch: false,
    enableXfa: false,
    verbosity: 0,
  });
}

async function bytes(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('missing');
  return new Uint8Array(await r.arrayBuffer());
}

// ------------------------------------------------------------------ pictures

const THUMB = 240; // longest side of an article picture, in pixels

function dataCanvas(img) {
  const { width: w, height: h, kind, data } = img;
  if (!data || (kind !== 2 && kind !== 3)) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  const o = id.data;
  if (kind === 3) {
    o.set(data.subarray(0, o.length));
  } else {
    for (let i = 0, j = 0, k = 0; i < w * h; i++, j += 3, k += 4) {
      o[k] = data[j]; o[k + 1] = data[j + 1]; o[k + 2] = data[j + 2]; o[k + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

/** A clip path from pageGraphics as a Path2D (pdf.js drawing format), or null if unknown. */
function pathOf(data) {
  if (data instanceof Path2D) return data;
  if (!data || typeof data.length !== 'number') return null;
  const p = new Path2D();
  for (let i = 0; i < data.length;) {
    switch (data[i++]) {
      case 0: p.moveTo(data[i++], data[i++]); break;
      case 1: p.lineTo(data[i++], data[i++]); break;
      case 2: p.bezierCurveTo(data[i++], data[i++], data[i++], data[i++], data[i++], data[i++]); break;
      case 3: p.quadraticCurveTo(data[i++], data[i++], data[i++], data[i++]); break;
      case 4: p.closePath(); break;
      default: return null; // a wrong cut-out is worse than none
    }
  }
  return p;
}

/**
 * An article's picture as a small WebP: its photos (usually one) drawn the way they stand
 * on the page, each cut out by its own clip paths.
 */
async function thumbOf(page, parts) {
  const loaded = [];
  for (const photo of parts) {
    const img = await photoImage(page, photo);
    if (!img || !img.width || !img.height) continue;
    const src = img.bitmap || dataCanvas(img);
    if (src) loaded.push({ photo, img, src });
  }
  if (!loaded.length) return null;
  const b = loaded.slice(1).reduce((u, { photo: { b: p } }) => [Math.min(u[0], p[0]), Math.min(u[1], p[1]), Math.max(u[2], p[2]), Math.max(u[3], p[3])], loaded[0].photo.b);
  const k = THUMB / Math.max(b[2] - b[0], b[3] - b[1]);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((b[2] - b[0]) * k));
  c.height = Math.max(1, Math.round((b[3] - b[1]) * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const toPic = [k, 0, 0, k, -k * b[0], -k * b[1]];
  for (const { photo, img, src } of loaded) {
    ctx.save();
    // the photo's own cut-out: clip paths, from their space to the picture
    for (const clip of photo.clips || []) {
      const p = pathOf(clip.path);
      if (!p) continue;
      const M = mul(toPic, clip.m);
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      ctx.clip(p, clip.rule);
    }
    // image pixels -> page (the unit square under the photo's transform) -> picture
    const [m0, m1, m2, m3, m4, m5] = photo.m;
    const w = img.width, h = img.height;
    const M = mul(toPic, [m0 / w, m1 / w, -m2 / h, -m3 / h, m2 + m4, m3 + m5]);
    ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    ctx.drawImage(src, 0, 0, w, h);
    ctx.restore();
  }
  return new Promise((resolve) => c.toBlob((blob) => resolve(blob), 'image/webp', 0.82));
}

/**
 * Reads a planogram PDF. onStep(fraction 0..1, pageNo, pages, phase) reports progress.
 * With pictures: true, also returns a small photo of every article (Map number -> Blob).
 * Throws Error('locked') for password protected files and Error('bad') for broken ones.
 */
export async function readPlanogram(url, onStep, { pictures = true } = {}) {
  const task = load(await bytes(url));
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy();
    throw new Error(e && e.name === 'PasswordException' ? 'locked' : 'bad');
  }
  try {
    const n = doc.numPages;
    const raw = await readPages(doc, (i) => onStep && onStep((0.3 * i) / n, i, n, 'text'));
    const ctx = {};
    const pages = raw.map((r) => analyzePage(r, ctx));
    const thumbs = new Map();
    const work = pages.map((p, i) => (p.kind === 'drawing' || p.kind === 'table' ? i : -1)).filter((i) => i >= 0);
    for (let k = 0; k < work.length; k++) {
      const i = work[k];
      const pg = pages[i];
      const page = await doc.getPage(i + 1);
      try {
        const gfx = await pageGraphics(page, pdfjs.OPS);
        if (pg.kind === 'drawing') placeLabels(pg, gfx);
        if (pictures && gfx.photos.length) {
          const made = new Map(); // one picture per photo, even when facings repeat it
          const want = [];
          if (pg.kind === 'drawing') {
            for (const lab of pg.labels) want.push({ nums: lab.nums, parts: labelPicture(pg, lab, gfx.photos) });
          } else {
            for (const row of pg.rows) { const ph = rowPhoto(row, gfx.photos); want.push({ nums: [row.num, ...row.variants], parts: ph ? [ph] : [] }); }
          }
          for (const { nums, parts } of want) {
            if (!parts.length || nums.every((x) => thumbs.has(x))) continue;
            const key = parts.map((ph) => ph.id || ph.b.join(',')).join('|');
            if (!made.has(key)) made.set(key, await thumbOf(page, parts).catch(() => null));
            const blob = made.get(key);
            if (blob) for (const x of nums) if (!thumbs.has(x)) thumbs.set(x, blob);
          }
        }
      } catch (e) {
        console.warn('page ' + (i + 1), e);
      }
      page.cleanup();
      if (onStep) onStep(0.3 + (0.7 * (k + 1)) / work.length, i + 1, n, 'pictures');
    }
    const plan = buildPlan(pages);
    plan.v = PLAN_VERSION;
    for (const num of thumbs.keys()) if (plan.items[num]) plan.items[num].im = 1;
    return { plan, thumbs };
  } finally {
    await task.destroy();
  }
}

// ------------------------------------------------------------- open documents

const open = new Map(); // plan id -> { task, promise }

export function openPlan(id) {
  if (open.has(id)) {
    const hit = open.get(id);
    open.delete(id);
    open.set(id, hit); // most recent last
    return hit.promise;
  }
  const entry = {};
  entry.promise = bytes(`/files/plans/${id}.pdf`).then((data) => {
    entry.task = load(data);
    return entry.task.promise;
  });
  entry.promise.catch(() => open.delete(id));
  open.set(id, entry);
  while (open.size > 2) {
    const [oldId, old] = open.entries().next().value;
    open.delete(oldId);
    if (old.task) old.task.destroy();
  }
  return entry.promise;
}

export function forget(id) {
  const e = open.get(id);
  if (!e) return;
  open.delete(id);
  if (e.task) e.task.destroy();
}

// ------------------------------------------------------------------ drawing

/**
 * Draws region [x0, y0, x1, y1] (page units, scale 1, y down) of a page into canvas,
 * filling cssW x cssH CSS pixels. Records where photos were drawn, in page units.
 */
export async function renderRegion(doc, pageNo, region, canvas, cssW, cssH, opts = {}) {
  const page = await doc.getPage(pageNo);
  const dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr || 3);
  const pw = Math.max(1, Math.round(cssW * dpr));
  const ph = Math.max(1, Math.round(cssH * dpr));
  const s = pw / (region[2] - region[0]);
  const viewport = page.getViewport({ scale: s, offsetX: -region[0] * s, offsetY: -region[1] * s });
  canvas.width = pw;
  canvas.height = ph;
  const ctx = canvas.getContext('2d', { alpha: !!opts.transparent });
  if (!opts.transparent) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pw, ph);
  }
  const photos = [];
  const orig = ctx.drawImage;
  ctx.drawImage = function (img, ...a) {
    try {
      let dx, dy, dw, dh;
      if (a.length >= 8) [, , , , dx, dy, dw, dh] = a;
      else if (a.length >= 4) [dx, dy, dw, dh] = a;
      else { [dx, dy] = a; dw = img.width; dh = img.height; }
      const m = this.getTransform();
      const xs = [], ys = [];
      for (const [x, y] of [[dx, dy], [dx + dw, dy], [dx, dy + dh], [dx + dw, dy + dh]]) {
        xs.push((m.a * x + m.c * y + m.e) / s + region[0]);
        ys.push((m.b * x + m.d * y + m.f) / s + region[1]);
      }
      photos.push({ b: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    } catch (e) {
      // recording is best effort
    }
    return orig.call(this, img, ...a);
  };
  const task = page.render({
    canvasContext: ctx,
    viewport,
    background: opts.transparent ? 'rgba(0,0,0,0)' : '#ffffff',
  });
  if (opts.onTask) opts.onTask(task);
  try {
    await task.promise;
  } finally {
    ctx.drawImage = orig;
  }
  return { scale: s, photos, page };
}

/** Photos on a page without drawing it (when the drawing could not record them). */
export async function photosOf(doc, pageNo) {
  const page = await doc.getPage(pageNo);
  return (await pageGraphics(page, pdfjs.OPS)).photos;
}

/**
 * The product's box on the page: stored at import, or found from the photos now.
 * plan: stored planogram, oc: the occurrence, photos: from renderRegion/photosOf.
 */
export function blockFor(plan, oc, photos) {
  if (oc.k) return oc.k;
  if (!photos || !photos.length) return null;
  const pg = plan.pages[oc.p];
  const seen = new Set();
  const labels = [];
  for (const [num, it] of Object.entries(plan.items)) {
    for (const o of it.oc) {
      if (o.p !== oc.p) continue;
      const key = o.b.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push({ b: o.b, nums: [num] });
    }
  }
  const lab = labels.find((l) => l.b.join(',') === oc.b.join(','));
  if (!lab) return null;
  return productBlock({ w: pg.w, h: pg.h, labels }, lab, photos);
}
