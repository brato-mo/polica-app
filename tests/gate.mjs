// The first screen: shown when no login is kept, hidden after a good login, shows the refusal, "Kasnije" closes it.
// node tests/gate.mjs (needs playwright)
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = new URL('../assets/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.webp': 'image/webp' };
const srv = http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
}).listen(0);
const b = await chromium.launch();
let bad = 0;
const check = (name, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name); };
async function open(mode) {
  const page = await b.newPage({ viewport: { width: 400, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((mode) => {
    window.__saved = null;
    window.Android = new Proxy({
      readText: () => '', writeText: () => true, deleteText: () => {}, myjysk: () => {}, myjysk_: 0,
      loginState: () => (mode === 'ok' ? 'ok' : 'none'), loginLast: () => '', version: () => 'x', device: () => 'x', isDark: () => false,
      storeStatus: () => {}, copyText: () => {},
      saveLogin: (u, p) => { window.__saved = [u, p]; setTimeout(() => window.onLoginSaved(mode === 'ok-after', mode === 'ok-after' ? 'ok' : 'refused'), 50); },
    }, { get: (t, k) => (k in t ? t[k] : () => '') });
  }, mode);
  await page.goto(`http://localhost:${srv.address().port}/index.html`);
  await page.waitForTimeout(300);
  return { page, errors };
}
{
  const { page, errors } = await open('none');
  check('shown when no login is kept', await page.isVisible('#gate'));
  await page.click('#gateLater'); await page.waitForTimeout(100);
  check('"Kasnije" closes it', !(await page.isVisible('#gate')));
  await page.close();
  if (errors.length) { console.log(errors); bad++; }
}
{
  const { page, errors } = await open('ok-after');
  await page.fill('#gateUser', '294641'); await page.fill('#gatePass', 'tajna');
  await page.click('#gateGo'); await page.waitForTimeout(200);
  check('typed login goes to the app once', await page.evaluate(() => JSON.stringify(window.__saved)) === '["294641","tajna"]');
  check('closed after a good login', !(await page.isVisible('#gate')));
  await page.close();
  if (errors.length) { console.log(errors); bad++; }
}
{
  const { page, errors } = await open('refused-case');
  await page.fill('#gateUser', '294641'); await page.fill('#gatePass', 'krivo');
  await page.click('#gateGo'); await page.waitForTimeout(200);
  check('refused password stays on the first screen with a message', (await page.isVisible('#gate')) && /ne prihvata/.test(await page.textContent('#gateMsg')));
  await page.screenshot({ path: 'out/gate-refused.png' });
  await page.close();
  if (errors.length) { console.log(errors); bad++; }
}
{
  const { page, errors } = await open('ok');
  check('not shown when a login is kept', !(await page.isVisible('#gate')));
  await page.close();
  if (errors.length) { console.log(errors); bad++; }
}
await b.close(); srv.close();
process.exit(bad ? 1 : 0);
