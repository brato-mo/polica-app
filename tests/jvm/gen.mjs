// Runs the REAL assets/minus-apply.js against a fake StoreFront for every ending and writes, for the Java harness,
// the steps the page went through and its final window.__mx, plus what the preview mock would record for it.
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
const ROOT = new URL('../../', import.meta.url);
const SRC = readFileSync(new URL('assets/minus-apply.js', ROOT), 'utf8');
// the preview mock's rule for the record's state (scratch prev/mock.js), kept here word for word: the Java record must agree
const mapLine = "r.state === 'ok' ? 'confirmed' : r.state === 'unknown' ? 'unknown' : kind !== 'adjust' && r.step === 'adjust' ? 'partial' : 'failed'";
const mockState = new Function('r', 'kind', 'return ' + mapLine);
const ITEMS = [{ num: '1000001', qty: -2, target: '1000002', c1: 'a', c2: 'b' }, { num: '1000003', qty: -1, target: '1000004', c1: 'c', c2: 'd' }];
async function run(plan, mode) {
  const steps = [];
  const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) });
  let win;
  const fetch = async (url, o = {}) => {
    steps.push(win.__mx && win.__mx.step);
    const body = o.body ? JSON.parse(o.body) : null;
    if (url.startsWith('/api/v1/websapapi/user-details')) return resp(200, { userDetails: { username: '100001', storeInfo: { storeId: 'T001', catalogId: 'CAT-1' } } });
    if (url.startsWith('/api/v1/minus-list/')) return resp(200, ITEMS.map((x) => ({ articleId: x.num, totalStock: x.qty })));
    if (url.startsWith('/api/v1/article/masterdata')) { const n = /article=(\d+)/.exec(url)[1]; const it = ITEMS.find((x) => x.num === n); return resp(200, [{ substitutionChain: [{ articleNumber: it.target, smDmData: { stock: 10 } }] }]); }
    if (url.startsWith('/api/v1/validate-sap-user')) return resp(url.endsWith('validate-sap-user') ? plan.auth || 200 : 200, {});
    if (url === '/api/v1/stock-adjustments') { const w = body.module === 'MINUS_LIST' ? plan.minus ?? 200 : plan.adjust ?? 200; if (w === 'drop') throw new TypeError('Failed to fetch'); return resp(w, {}); }
  };
  win = { __mxIn: { user: '', pass: 'pw-secret', items: ITEMS, mode } }; win.window = win;
  vm.runInNewContext(SRC, { window: win, fetch, Promise, JSON, Error, TypeError, String, Math, Object, Array, encodeURIComponent, setTimeout });
  for (let i = 0; i < 300 && (!win.__mx || win.__mx.state === 'busy'); i++) await new Promise((r) => setImmediate(r));
  const fin = JSON.parse(JSON.stringify(win.__mx));
  return { steps: [...new Set(steps.filter(Boolean))], final: fin, mock: mockState(fin, mode === 'adjust' ? 'adjust' : 'both') };
}
const S = {
  ok: [{}, 'both'], 'drop-minus': [{ minus: 'drop' }, 'both'], '500-minus': [{ minus: 500 }, 'both'], '400-minus': [{ minus: 400 }, 'both'],
  'drop-adjust': [{ adjust: 'drop' }, 'both'], '422-adjust': [{ adjust: 422 }, 'both'], '503-adjust': [{ adjust: 503 }, 'both'], auth: [{ auth: 401 }, 'both'],
  'adjust-ok': [{}, 'adjust'], 'adjust-drop': [{ adjust: 'drop' }, 'adjust'], 'adjust-422': [{ adjust: 422 }, 'adjust'],
};
const out = {};
for (const [k, [plan, mode]] of Object.entries(S)) out[k] = { mode, ...(await run(plan, mode)) };
writeFileSync(process.argv[2] || 'scenarios.json', JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(12), v.final.state.padEnd(8), (v.final.step || '').padEnd(7), 'mock→', v.mock);
