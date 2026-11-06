// assets/store-task.js 'smset': ordinary articles and set articles (S + 6 digits) go to the SM/DM update; odd ones not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../assets/store-task.js', import.meta.url), 'utf8');

test('SM/DM: set articles are saved like any other, nothing else slips through', async () => {
  const sent = [];
  const ok = (b) => ({ status: 200, ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(b) });
  const fetch = async (url, o = {}) => {
    if (url.startsWith('/api/v1/websapapi/user-details')) return ok({ userDetails: { username: '1', storeInfo: { storeId: 'T001', catalogId: 'CAT-1' } } });
    if (url === '/api/v1/article-smdm-data/update' && o.method === 'POST') { sent.push(JSON.parse(o.body)); return ok({}); }
    throw new Error(url);
  };
  const items = [{ num: '1000001', sm: 0, dm: 0 }, { num: 'S371203', sm: 0, dm: 0 }, { num: 'S12', sm: 0, dm: 0 }, { num: '../x', sm: 0, dm: 0 }];
  const win = { __stArg: { mode: 'smset', items, job: 'j1' } };
  win.window = win;
  vm.runInNewContext(SRC, { window: win, fetch, Promise, JSON, Error, String, Math, Object, Array, isFinite, encodeURIComponent, setTimeout });
  for (let i = 0; i < 200 && (!win.__st || win.__st.state === 'busy'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(win.__st.state, 'ok');
  assert.deepEqual(sent.map((b) => b.articleId).sort(), ['1000001', 'S371203']);
  assert.deepEqual(Array.from(win.__st.res.done).sort(), ['1000001', 'S371203']);
});
