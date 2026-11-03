// Customer orders work with no planogram on the phone: the orders bar, the search and the list show up.
// node tests/orders-no-plans.mjs (needs playwright)
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = new URL('../assets/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.mjs': 'text/javascript', '.woff': 'font/woff', '.webp': 'image/webp' };
const srv = http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
}).listen(0);
const orders = { at: Date.now() - 60000, list: Array.from({ length: 3 }, (_, i) => ({ no: `9000${i}`, name: `KUPAC ${i}`, tab: 'Aktivan', status: 'Aktivan', items: [{ num: '3700123', name: 'Svijeća', qty: 1, st: 'Otvoreno' }] })) };
const files = { 'plans.json': '[]', 'user.json': JSON.stringify({ recent: [], learned: {}, changes: {}, orders }) };
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 400, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript((files) => {
  const F = { ...files };
  window.Android = new Proxy({ readText: (n) => F[n] || '', writeText: (n, s) => { F[n] = s; return true; }, deleteText: () => {}, myjysk: () => {}, loginState: () => 'none', loginLast: () => '', version: () => 'x', device: () => 'x', isDark: () => false }, { get: (t, k) => (k in t ? t[k] : () => '') });
}, files);
await page.goto(`http://localhost:${srv.address().port}/index.html`);
await page.click('[data-mode="orders"]');
await page.waitForTimeout(300);
let bad = 0;
const check = (name, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name); };
check('orders bar visible without planograms', await page.isVisible('#ordersBar'));
check('welcome hidden in orders mode', !(await page.isVisible('#welcome')));
check('waiting-for-goods list shown without a search', /Čeka prijem robe/.test(await page.textContent('#results')));
await page.fill('#q', 'KUPAC'); await page.dispatchEvent('#q', 'input'); await page.waitForTimeout(200);
check('orders found by customer name', (await page.locator('#results .ocard').count()) === 3);
check('search visible', await page.isVisible('#searchForm'));
await page.click('[data-mode="plan"]');
await page.waitForTimeout(200);
check('plan mode without planograms shows welcome again', await page.isVisible('#welcome'));
check('orders bar hidden in plan mode without planograms', !(await page.isVisible('#ordersBar')));
await page.screenshot({ path: 'out/orders-no-plans.png' });
await b.close(); srv.close();
if (errors.length) { console.log(errors.join('\n')); bad++; }
process.exit(bad ? 1 : 0);
