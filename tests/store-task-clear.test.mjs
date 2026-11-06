// assets/store-task.js 'clear' against a fake StoreFront: the search split by status code gives the same list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../assets/store-task.js', import.meta.url), 'utf8');
const ROWS = [
  { id: '3600001', statusCode: '21', storeStock: 2, smDmData: { dmQuantity: 0 } },
  { id: '3600002', statusCode: '81', storeStock: 0, smDmData: { dmQuantity: 1 } },
  { id: '3600003', statusCode: '21', storeStock: 0, smDmData: { dmQuantity: 0 } },
  { id: '3600004', statusCode: '81', storeStock: -1, smDmData: { dmQuantity: 1 } },
  { id: '3600005', statusCode: '81', storeStock: 5, smDmData: { dmQuantity: 0 } },
];

test('furniture: two searches by status code + the DM search, same articles as one search', async () => {
  const searches = [];
  const ok = (b) => ({ status: 200, ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(b) });
  const fetch = async (url, o = {}) => {
    if (url.startsWith('/api/v1/websapapi/user-details')) return ok({ userDetails: { username: '1', storeInfo: { storeId: 'T001', catalogId: 'CAT-1' } } });
    if (url.startsWith('/api/v1/article/search')) {
      const b = JSON.parse(o.body);
      searches.push(b.statusCodes.join('+') + (b.smDmQuantityParameters ? ' DM' : ''));
      const rows = ROWS.filter((r) => b.statusCodes.includes(r.statusCode) && (!b.smDmQuantityParameters || r.smDmData.dmQuantity > 0));
      return ok({ articleResults: rows, pagingInfo: { total: rows.length } });
    }
    if (url.startsWith('/api/v1/article/masterdata')) return ok([{ activeSalesPrice: 10, normalSalesPrice: 20, groupId: '40201', groupTitle: 'Komode', substitutionChain: [] }]);
    throw new Error(url);
  };
  const win = { __stArg: { mode: 'clear', cats: ['4'], job: 'j1' } };
  win.window = win;
  vm.runInNewContext(SRC, { window: win, fetch, Promise, JSON, Error, String, Math, Object, Array, isFinite, encodeURIComponent, setTimeout });
  for (let i = 0; i < 200 && (!win.__st || win.__st.state === 'busy'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(win.__st.state, 'ok');
  assert.deepEqual(searches.sort(), ['21', '21+81 DM', '81']);
  assert.deepEqual(Array.from(win.__st.res.list, (x) => x.num).sort(), ['3600001', '3600002', '3600004', '3600005'], 'stock > 0 or on display, each once');
});
