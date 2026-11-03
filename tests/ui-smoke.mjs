// Opens the interface in Chromium with a fake phone bridge and a small planogram, clicks through the new parts and
// fails on any page error. node tests/ui-smoke.mjs  (needs playwright)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../assets/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  r.end(fs.readFileSync(f));
}).listen(0);
const port = srv.address().port;

const plan = { v: 1, meta: { sections: [], dept: { code: '05', name: 'Kućanstvo' } }, pages: [{ sec: -1, segs: [] }],
  items: { '3700123': { nm: 'Svijeća mirisna vanilija velika dugačkog naziva koji se lomi', oc: [], nt: [], rw: [{ p: 0, fx: 'Gondola 4' }] }, '3700456': { nm: 'Korpa pletena', oc: [], nt: [], rw: [{ p: 0, fx: 'Gondola 5' }] } } };
const orders = { at: Date.now() - 600000, list: Array.from({ length: 30 }, (_, i) => ({ no: `90000${100 + i}`, name: `KUPAC ${i}`, tab: 'Aktivan', status: 'Aktivan', items: [{ num: '3700123', name: 'Svijeća', qty: 1, st: i % 2 ? 'Otvoreno' : 'Popunjeno' }] })) };
const files = {
  'plans.json': JSON.stringify([{ id: 'p1', name: 'test.pdf', imported: 1 }]),
  'plan-p1.json': JSON.stringify(plan),
  'user.json': JSON.stringify({ recent: [{ num: '3700456', t: 1 }], favs: ['3700123'], learned: {}, changes: {}, orders, mj: { at: Date.now() - 3600e3, my: [], loc: [], news: [{ id: 'n1', title: 'Vijest' }], sys: [], seen: { n1: 0 }, viewedAt: 1 } }),
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.addInitScript((files) => {
  const F = { ...files };
  window.__copied = [];
  window.Android = new Proxy({
    readText: (n) => F[n] || '', writeText: (n, s) => { F[n] = s; return true; }, deleteText: (n) => { delete F[n]; },
    copyText: (t) => window.__copied.push(t), myjyskOn: () => true, myjyskMe: () => 'Test Prodavac, 100200',
    myjysk: () => setTimeout(() => window.onMyjysk({ how: 'error' }), 50), loginState: () => 'ok', loginLast: () => '',
    version: () => '1.40-test', device: () => 'test', isDark: () => false,
  }, { get: (t, k) => (k in t ? t[k] : () => '') });
}, files);
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForTimeout(500);

const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { errors.push(`${name}: ${e.message}`); console.log('FAIL', name, e.message); } };
await step('favorites shown on home', async () => { if (!(await page.isVisible('#favWrap'))) throw new Error('no favorites'); });
await step('open favorite article', async () => { await page.click('#favs [data-num="3700123"]'); await page.waitForSelector('#item.is-active [data-copy]', { timeout: 3000 }); });
await step('copy code with one tap', async () => { await page.click('#item [data-copy]'); const c = await page.evaluate(() => window.__copied); if (c[0] !== '3700123') throw new Error(String(c)); });
await step('toggle favorite', async () => { await page.click('#item [data-fav]'); if (await page.getAttribute('#item [data-fav]', 'aria-pressed') !== 'false') throw new Error('still fav'); });
await page.screenshot({ path: 'out/smoke-item.png' });
await step('back to home', async () => { await page.evaluate(() => window.handleBack()); await page.waitForSelector('#home.is-active'); });
await step('orders compact view', async () => {
  await page.click('[data-mode="orders"]');
  await page.fill('#q', 'kupac'); await page.dispatchEvent('#q', 'input'); await page.waitForTimeout(300);
  await page.click('[data-ovw="compact"]');
  const n = await page.locator('.ocard-c').count(); if (n < 20) throw new Error(`compact rows ${n}`);
});
await page.screenshot({ path: 'out/smoke-orders.png' });
await step('news shows error but keeps the old items', async () => {
  await page.click('[data-mode="news"]'); await page.waitForTimeout(200); await page.click('[data-mj="refresh"]'); await page.waitForTimeout(300);
  const t = await page.textContent('#newsWrap'); if (!/MYJYSK nije odgovorio|Nema internet/.test(t) || !/Vijest/.test(t)) throw new Error(t.slice(0, 200));
});
await page.screenshot({ path: 'out/smoke-news.png' });
await browser.close();
srv.close();
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('UI smoke: all fine');
