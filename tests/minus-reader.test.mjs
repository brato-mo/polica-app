// assets/minus-reader.js: a replacement read that StoreFront drops is tried again, and one that still fails is
// marked as "not read", never shown as "no replacement". Only GETs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../assets/minus-reader.js', import.meta.url), 'utf8');

test('minus list: retries dropped replacement reads, flags the ones still missing, at most 6 at once', async () => {
  const methods = new Set();
  const tries = {};
  let open = 0, most = 0;
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => 'application/json' }, json: async () => body });
  const fetch = async (url, o = {}) => {
    methods.add(o.method || 'GET');
    if (url.startsWith('/api/v1/websapapi/user-details')) return res(200, { userDetails: { storeInfo: { storeId: 'T001', catalogId: 'CAT-1' } } });
    if (url.startsWith('/api/v1/minus-list/')) {
      const l = Array.from({ length: 20 }, (_, i) => ({ articleId: String(1000000 + i), totalStock: -1, article: { title: 'A' } }));
      l.push({ articleId: 'S371203', totalStock: -1, article: {} });
      return res(200, l);
    }
    if (url.startsWith('/api/v1/article/masterdata')) {
      const n = new URL(url, 'https://x').searchParams.get('article');
      tries[n] = (tries[n] || 0) + 1;
      open++; most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 3));
      open--;
      if (n === '1000003' && tries[n] === 1) return res(500, null); // dropped once
      if (n === '1000005') return res(503, null); // never answers
      return res(200, [{ substitutionChain: [{ articleNumber: '2000000', statusCode: '11', smDmData: { stock: 4 } }] }]);
    }
    throw new Error(url);
  };
  const win = {};
  win.window = win;
  vm.runInNewContext(SRC, { window: win, fetch, Promise, JSON, String, Math, Array, isFinite, encodeURIComponent, setTimeout, URL });
  for (let i = 0; i < 400 && (!win.__ml || win.__ml.state === 'busy'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(win.__ml.state, 'ok');
  assert.deepEqual([...methods], ['GET']);
  assert.ok(most <= 6, `at most 6 at once, was ${most}`);
  const by = Object.fromEntries(Array.from(win.__ml.items, (x) => [x.num, x]));
  assert.equal(by['1000003'].subs.length, 1, 'dropped once, read on the second try');
  assert.equal(by['1000005'].subs.length, 0);
  assert.equal(by['1000005'].subsErr, true, 'still not read: marked, not "no replacement"');
  assert.equal(by['1000001'].subsErr, undefined);
  assert.equal(win.__ml.total, 21);
  assert.deepEqual(Array.from(win.__ml.other), ['S371203']);
});
