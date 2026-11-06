// assets/minus-apply.js against a fake StoreFront (no real StoreFront is ever called): every way a sending can end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../assets/minus-apply.js', import.meta.url), 'utf8');
const ITEMS = [
  { num: '1000001', qty: -2, target: '1000002', c1: 'Zamjena: 1000001 na 0, roba pod 1000002', c2: 'Zamjena: prodano pod 1000001' },
  { num: '1000003', qty: -1, target: '1000004', c1: 'Zamjena: 1000003 na 0, roba pod 1000004', c2: 'Zamjena: prodano pod 1000003' },
];

/**
 * A fake StoreFront. plan: { minus: 200 | 400 | 500 | 'drop', adjust: ..., list: minus list, stock: replacement stock,
 * auth: 200 | 401 }. Answer: the result the script left in window.__mx, and every request it made.
 */
async function run(plan = {}, mode = 'both', items = ITEMS) {
  const calls = [];
  const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => (body == null ? '' : JSON.stringify(body)) });
  const fetch = async (url, o = {}) => {
    const body = o.body ? JSON.parse(o.body) : null;
    calls.push({ url, method: o.method, body });
    if (url.startsWith('/api/v1/websapapi/user-details')) return resp(200, { userDetails: { username: '100001', storeInfo: { storeId: 'T001', catalogId: 'CAT-1' } } });
    if (url.startsWith('/api/v1/minus-list/')) return resp(200, plan.list || items.map((x) => ({ articleId: x.num, totalStock: x.qty })));
    if (url.startsWith('/api/v1/article/masterdata')) {
      const num = /article=(\d+)/.exec(url)[1];
      const it = items.find((x) => x.num === num);
      return resp(200, [{ substitutionChain: [{ articleNumber: it.target, smDmData: { stock: plan.stock ?? 10 } }] }]);
    }
    if (url.startsWith('/api/v1/validate-sap-user')) return resp(url.endsWith('validate-sap-user') ? plan.auth || 200 : 200, {});
    if (url === '/api/v1/stock-adjustments') {
      const what = body.module === 'MINUS_LIST' ? plan.minus ?? 200 : plan.adjust ?? 200;
      if (what === 'drop') throw new TypeError('Failed to fetch');
      return resp(what, what < 300 ? { ok: true } : { message: 'refused' });
    }
    throw new Error('unexpected ' + url);
  };
  const win = { __mxIn: { user: '', pass: 'secret-test', items, mode } };
  win.window = win;
  vm.runInNewContext(SRC, { window: win, fetch, Promise, JSON, Error, TypeError, String, Math, Object, Array, encodeURIComponent });
  for (let i = 0; i < 200 && (!win.__mx || win.__mx.state === 'busy'); i++) await new Promise((r) => setImmediate(r));
  return { r: win.__mx, calls, win };
}
const writes = (calls) => calls.filter((c) => c.url === '/api/v1/stock-adjustments').map((c) => c.body.module);

test('both steps accepted: ok, each step sent once', async () => {
  const { r, calls, win } = await run();
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.sent, ['1000001', '1000003']);
  assert.deepEqual(writes(calls), ['MINUS_LIST', 'STOCK_ADJUSTMENT']);
  assert.equal(win.__mxIn, null, 'the input with the password is dropped from the page');
  assert.ok(!JSON.stringify(r).includes('secret-test'), 'the password is not in the result');
  assert.deepEqual(r.resp.minus.keys, ['ok'], 'only the shape of the answer is kept');
});

test('network drops while Minus lista is sent: unknown, Regulacija is not sent', async () => {
  const { r, calls } = await run({ minus: 'drop' });
  assert.equal(r.state, 'unknown');
  assert.equal(r.step, 'minus');
  assert.deepEqual(writes(calls), ['MINUS_LIST']);
});

test('server error on Minus lista: unknown, not "nothing sent"', async () => {
  const { r } = await run({ minus: 500 });
  assert.equal(r.state, 'unknown');
  assert.equal(r.step, 'minus');
});

test('Minus lista refused (4xx): a definite failure, nothing more sent', async () => {
  const { r, calls } = await run({ minus: 400 });
  assert.equal(r.state, 'error');
  assert.equal(r.step, 'minus');
  assert.deepEqual(writes(calls), ['MINUS_LIST']);
});

test('network drops while Regulacija is sent: unknown at adjust, Minus lista known to be accepted', async () => {
  const { r, calls } = await run({ adjust: 'drop' });
  assert.equal(r.state, 'unknown');
  assert.equal(r.step, 'adjust');
  assert.equal(r.minusOk, true);
  assert.deepEqual(writes(calls), ['MINUS_LIST', 'STOCK_ADJUSTMENT'], 'never sent a second time');
});

test('Regulacija refused (4xx): error at adjust (partial), the lines are named for sending Regulacija alone', async () => {
  const { r } = await run({ adjust: 422 });
  assert.equal(r.state, 'error');
  assert.equal(r.step, 'adjust');
  assert.deepEqual(r.sent, ['1000001', '1000003']);
});

test('wrong password: failed before anything was written', async () => {
  const { r, calls } = await run({ auth: 401 });
  assert.equal(r.state, 'error');
  assert.equal(r.why, 'auth');
  assert.deepEqual(writes(calls), []);
});

test('the list changed meanwhile: that line is skipped, the rest sent', async () => {
  const { r, calls } = await run({ list: [{ articleId: '1000001', totalStock: -2 }, { articleId: '1000003', totalStock: -3 }] });
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.sent, ['1000001']);
  assert.deepEqual(r.skipped.map((x) => x.num), ['1000003']);
  const adj = calls.find((c) => c.body && c.body.module === 'STOCK_ADJUSTMENT');
  assert.deepEqual(adj.body.stockAdjustments.map((x) => x.article), ['1000002']);
});

test('a replacement shared by two lines without stock for both: both skipped, nothing written', async () => {
  const shared = [{ ...ITEMS[0], target: '1000009' }, { ...ITEMS[1], target: '1000009' }];
  const { r, calls } = await run({ stock: 2 }, 'both', shared); // needs 3
  assert.equal(r.state, 'ok');
  assert.equal(r.sent.length, 0);
  assert.deepEqual(writes(calls), []);
});

test('only Regulacija (after a partial): no Minus lista request, network drop = unknown', async () => {
  const ok = await run({}, 'adjust');
  assert.equal(ok.r.state, 'ok');
  assert.deepEqual(writes(ok.calls), ['STOCK_ADJUSTMENT']);
  const drop = await run({ adjust: 'drop' }, 'adjust');
  assert.equal(drop.r.state, 'unknown');
  assert.equal(drop.r.step, 'adjust');
});

test('a second start while one runs does nothing', async () => {
  const win = { __mx: { state: 'busy' }, __mxIn: { items: ITEMS } };
  win.window = win;
  let n = 0;
  vm.runInNewContext(SRC, { window: win, fetch: async () => { n++; return {}; }, Promise, JSON });
  assert.equal(n, 0);
});

// Test builds (IN.sim, set only by a sandbox build): nothing that writes or checks the password reaches StoreFront,
// and every played ending goes through the same handling as a real one.
async function sim(simMode, mode = 'both') {
  const calls = [];
  const fetch = async (url, o = {}) => {
    calls.push({ url, method: o.method || 'GET' });
    const ok = (b) => ({ status: 200, ok: true, json: async () => b, text: async () => JSON.stringify(b) });
    if (url.startsWith('/api/v1/websapapi/user-details')) return ok({ userDetails: { username: '100001', storeInfo: { storeId: 'T001', catalogId: 'CAT-1' } } });
    if (url.startsWith('/api/v1/minus-list/')) return ok(ITEMS.map((x) => ({ articleId: x.num, totalStock: x.qty })));
    if (url.startsWith('/api/v1/article/masterdata')) { const n = /article=(\d+)/.exec(url)[1]; const it = ITEMS.find((x) => x.num === n); return ok([{ substitutionChain: [{ articleNumber: it.target, smDmData: { stock: 10 } }] }]); }
    throw new Error('a test build must not call ' + (o.method || 'GET') + ' ' + url);
  };
  const win = { __mxIn: { user: '', pass: 'x', items: ITEMS, mode, sim: simMode } };
  win.window = win;
  vm.runInNewContext(SRC, { window: win, fetch, Promise, JSON, Error, TypeError, String, Math, Object, Array, encodeURIComponent, setTimeout });
  for (let i = 0; i < 400 && (!win.__mx || win.__mx.state === 'busy'); i++) await new Promise((r) => setTimeout(r, 10));
  return { r: win.__mx, calls };
}

test('test build: every played ending, and only reads reach StoreFront', async () => {
  const want = {
    ok: ['ok', 'adjust'], 'drop-minus': ['unknown', 'minus'], 'drop-adjust': ['unknown', 'adjust'], '500-minus': ['unknown', 'minus'],
    '422-adjust': ['error', 'adjust'], auth: ['error', 'user'],
  };
  for (const [m, [state, step]] of Object.entries(want)) {
    const { r, calls } = await sim(m);
    assert.equal(r.state, state, m);
    assert.equal(r.step, step, m);
    assert.ok(calls.every((c) => c.method === 'GET'), m + ': only GET requests');
  }
  const hang = await sim('hang-minus');
  assert.equal(hang.r.state, 'busy', 'no answer: the phone time limit decides');
  assert.equal(hang.r.step, 'minus');
});
