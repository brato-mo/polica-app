// assets/store-task.js 'eans': read only searches by article number, the barcodes of the exact article only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../assets/store-task.js', import.meta.url), 'utf8');

test('barcodes: exact article only, old barcodes included, nothing but the search', async () => {
  const calls = [];
  const ok = (b) => ({ status: 200, ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(b) });
  const fetch = async (url, o = {}) => {
    calls.push(`${o.method || 'GET'} ${url.split('?')[0]}`);
    if (url.startsWith('/api/v1/websapapi/user-details')) return ok({ userDetails: { username: '1', storeInfo: { storeId: 'T001', catalogId: 'CAT-1' } } });
    if (url.startsWith('/api/v1/article/search')) {
      const q = JSON.parse(o.body).query;
      const rows = { '1000001': [{ id: '1000001', ean: '5700000000017', eanHistory: ['5700000000024', 'x'] }, { id: '1000009', ean: '5700000000999' }],
        '1000002': [{ id: '1000003', ean: '5700000000031' }] }[q] || [];
      return ok({ articleResults: rows, pagingInfo: { total: rows.length } });
    }
    throw new Error(url);
  };
  const win = { __stArg: { mode: 'eans', nums: ['1000001', '1000002', 'zz'], job: 'j1' } };
  win.window = win;
  vm.runInNewContext(SRC, { window: win, fetch, Promise, JSON, Error, String, Math, Object, Array, isFinite, encodeURIComponent, setTimeout });
  for (let i = 0; i < 200 && (!win.__st || win.__st.state === 'busy'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(win.__st.state, 'ok');
  const l = Array.from(win.__st.res.list, (x) => ({ num: x.num, eans: Array.from(x.eans) }));
  assert.deepEqual(l, [{ num: '1000001', eans: ['5700000000017', '5700000000024'] }, { num: '1000002', eans: [] }]);
  assert.ok(calls.every((c) => c === 'GET /api/v1/websapapi/user-details' || c === 'POST /api/v1/article/search'), 'only the search');
});
