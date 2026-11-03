// Runs assets/minus-apply.js against a fake StoreFront and checks what it would send.
// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../assets/minus-apply.js', import.meta.url), 'utf8');

function fakeStore({ minus = { '1234567': -2 }, stock = 5, passOk = 'good', user = '294641' } = {}) {
  const calls = [];
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: () => 'application/json' } });
  const fetch = async (u, o = {}) => {
    const body = o.body ? JSON.parse(o.body) : null;
    calls.push({ u, method: o.method || 'GET', body });
    if (u.startsWith('/api/v1/websapapi/user-details')) return res(200, { userDetails: { username: user, employeeNumber: user, storeInfo: { storeId: '1014', catalogId: 'BA-cat' } } });
    if (u.startsWith('/api/v1/minus-list/')) return res(200, Object.entries(minus).map(([a, q]) => ({ articleId: a, totalStock: q })));
    if (u.startsWith('/api/v1/article/masterdata')) return res(200, [{ substitutionChain: [{ articleNumber: '7654321', smDmData: { stock } }] }]);
    if (u.endsWith('/validate-non-store-user') || u.endsWith('/validate-user-in-correct-store')) return res(200, {});
    if (u === '/api/v1/validate-sap-user') return res(body.password === passOk ? 200 : 401, {});
    if (u === '/api/v1/stock-adjustments') return res(200, {});
    return res(404, {});
  };
  return { calls, fetch };
}

async function run(input, store) {
  const win = { __mxIn: input };
  const ctx = vm.createContext({ window: win, fetch: store.fetch, Promise, JSON, encodeURIComponent, Array, Object, Math, String });
  vm.runInContext(SRC, ctx);
  for (let i = 0; i < 50 && (!win.__mx || win.__mx.state === 'busy'); i++) await new Promise((r) => setTimeout(r, 5));
  return win.__mx;
}

const item = { num: '1234567', qty: -2, target: '7654321', c1: 'a', c2: 'b' };
const sends = (calls) => calls.filter((c) => c.u === '/api/v1/stock-adjustments');

test('no HR number typed: the StoreFront user is used and both steps are sent once', async () => {
  const st = fakeStore();
  const r = await run({ user: '', pass: 'good', items: [item], mode: 'both' }, st);
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.sent, ['1234567']);
  const v = st.calls.find((c) => c.u === '/api/v1/validate-sap-user');
  assert.equal(v.body.username, '294641');
  assert.equal(sends(st.calls).length, 2);
  assert.deepEqual(sends(st.calls).map((c) => c.body.module), ['MINUS_LIST', 'STOCK_ADJUSTMENT']);
});

test('a refused password sends nothing', async () => {
  const st = fakeStore();
  const r = await run({ user: '', pass: 'bad', items: [item], mode: 'both' }, st);
  assert.equal(r.state, 'error');
  assert.equal(r.why, 'auth');
  assert.equal(sends(st.calls).length, 0);
});

test('a line that changed meanwhile is skipped, nothing sent', async () => {
  const st = fakeStore({ minus: { '1234567': -3 } });
  const r = await run({ user: '', pass: 'good', items: [item], mode: 'both' }, st);
  assert.equal(r.state, 'ok');
  assert.equal(r.sent.length, 0);
  assert.equal(r.skipped[0].num, '1234567');
  assert.equal(sends(st.calls).length, 0);
});

test('StoreFront gives no usable user number: nothing sent', async () => {
  const st = fakeStore({ user: 'someone@x' });
  const r = await run({ user: '', pass: 'good', items: [item], mode: 'both' }, st);
  assert.equal(r.state, 'error');
  assert.equal(r.why, 'nouser');
  assert.equal(sends(st.calls).length, 0);
});

test('only Regulacija: one sending, MINUS_LIST untouched', async () => {
  const st = fakeStore({ minus: {} });
  const r = await run({ user: '294641', pass: 'good', items: [item], mode: 'adjust' }, st);
  assert.equal(r.state, 'ok');
  assert.deepEqual(sends(st.calls).map((c) => c.body.module), ['STOCK_ADJUSTMENT']);
});

test('the password does not stay in the page', async () => {
  const st = fakeStore();
  const input = { user: '', pass: 'good', items: [item], mode: 'both' };
  const win = { __mxIn: input };
  vm.runInContext(SRC, vm.createContext({ window: win, fetch: st.fetch, Promise, JSON, encodeURIComponent, Array, Object, Math, String }));
  assert.equal(win.__mxIn, null);
  assert.equal(input.pass, null);
});
