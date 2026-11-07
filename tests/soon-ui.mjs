// "Uskoro status 21" in Chromium with a fake phone bridge: the department list by date, another group, SM to 0.
// node tests/soon-ui.mjs  (needs playwright)
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
const plan = { v: 1, meta: { sections: [], dept: { code: '05', name: 'Homeware' } }, pages: [{ sec: -1, segs: [] }],
  items: { 4912893: { nm: 'Zdjela MALIK', oc: [], nt: [], rw: [{ p: 0, fx: 'S1' }] }, 4912966: { nm: 'Čaša ISAK', oc: [], nt: [], rw: [{ p: 0, fx: 'S2' }] } } };
const files = { 'plans.json': JSON.stringify([{ id: 'p1', name: 'h.pdf', title: '05 Homeware', imported: 1 }]), 'plan-p1.json': JSON.stringify(plan), 'user.json': JSON.stringify({ recent: [], favs: [], learned: {}, changes: {} }) };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(({ files, near, far }) => {
  const F = { ...files };
  window.__jobs = [];
  const answer = (a) => {
    if (a.mode === 'soon' && a.nums) return { list: [
      { num: '4912893', name: 'Zdjela MALIK Ø16xV6 cm pepeljasto grožđe', st: '11', fut: '21', from: near, sm: 12, dm: 0, stock: 34, sold30: 2, price: 11.5 },
      { num: '4912966', name: 'Čaša ISAK 30 cl', st: '11', fut: '21', from: far, sm: 24, dm: 1, stock: 53, sold30: 8, price: 7.5 },
      { num: '4912338', name: 'Čaša FERDINAND 40cl', st: '11', fut: '21', from: far, sm: 0, dm: 0, stock: 0, sold30: 4, price: 4 } ], asked: 437 };
    if (a.mode === 'hier') return { groups: [{ id: '4', title: 'Namještaj', subs: [{ id: '405', title: 'Kancelarija' }, { id: '406', title: 'Trpezarija' }] }] };
    if (a.mode === 'soon' && a.cats) return { list: [{ num: '3000001', name: 'Stolica TRPEZA', st: '12', fut: '21', from: near, sm: 0, dm: 4, stock: 2, sold30: 1, price: 99, groupName: 'Trpezarija' }], asked: 120 };
    if (a.mode === 'smset') return { done: a.items.map((x) => x.num), failed: [] };
    return null;
  };
  window.Android = new Proxy({
    readText: (n) => F[n] || '', writeText: (n, s) => { F[n] = s; return true; }, deleteText: (n) => { delete F[n]; },
    loginState: () => 'ok', loginLast: () => '', version: () => '1.66-test', device: () => 'test', isDark: () => false,
    storeTask: (j) => { const a = JSON.parse(j); window.__jobs.push(a); setTimeout(() => window.onStoreTask({ job: a.job, how: 'ok', res: answer(a) }), 60); },
  }, { get: (t, k) => (k in t ? t[k] : () => '') });
}, { files, near: iso(20), far: iso(200) });
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForTimeout(500);

const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { errors.push(`${name}: ${e.message}`); console.log('FAIL', name, e.message); } };
await step('bar on home', async () => { await page.waitForSelector('#soonBar:not([hidden])', { timeout: 3000 }); });
await step('open: department read by its planogram numbers', async () => {
  await page.click('#soonBar'); await page.waitForSelector('#soon.is-active .soon-row', { timeout: 3000 });
  const j = await page.evaluate(() => window.__jobs.find((x) => x.mode === 'soon'));
  if (!j.nums || !j.nums.includes('4912893')) throw new Error(JSON.stringify(j));
});
await step('sorted by date, near date marked', async () => {
  const codes = await page.$$eval('#soonBody .soon-row .code', (l) => l.map((e) => e.textContent.slice(0, 7)));
  if (codes[0] !== '4912893') throw new Error(codes.join());
  if (!(await page.isVisible('.soon-date.is-near'))) throw new Error('no near date');
});
await page.screenshot({ path: 'out/soon-dept.png', fullPage: true });
await step('only with SM/DM', async () => { await page.click('[data-soon="only"]'); const n = await page.locator('#soonBody .soon-row').count(); if (n !== 2) throw new Error(String(n)); });
await step('SM to 0 for the next 60 days, DM kept', async () => {
  await page.click('[data-soon="zero-near"]'); await page.waitForTimeout(300);
  await page.click('text=SM na 0 >> nth=-1').catch(async () => { await page.getByRole('button', { name: 'SM na 0', exact: true }).click(); });
  await page.waitForTimeout(300);
  const j = await page.evaluate(() => window.__jobs.filter((x) => x.mode === 'smset').pop());
  if (!j || j.items.length !== 1 || j.items[0].num !== '4912893' || j.items[0].sm !== 0) throw new Error(JSON.stringify(j));
});
await step('other department: pick Trpezarija', async () => {
  await page.click('[data-soon-scope="grp"]'); await page.click('[data-soon="hier"]');
  await page.waitForSelector('.soon-grp'); await page.click('.soon-grp summary'); await page.click('[data-soon-grp="406"]');
  await page.waitForSelector('#soonBody .soon-row'); const t = await page.textContent('#soonBody');
  if (!/Stolica TRPEZA/.test(t) || !/Namještaj › Trpezarija/.test(t)) throw new Error(t.slice(0, 300));
  const j = await page.evaluate(() => window.__jobs.filter((x) => x.mode === 'soon').pop()); if (JSON.stringify(j.cats) !== '["406"]') throw new Error(JSON.stringify(j));
});
await page.screenshot({ path: 'out/soon-grp.png', fullPage: true });
await browser.close();
srv.close();
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('Uskoro 21: all fine');
