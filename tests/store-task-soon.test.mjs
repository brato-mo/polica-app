// assets/store-task.js 'soon' and 'hier': the coming status 21/81 from StoreFront's master data, by date; read only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../assets/store-task.js', import.meta.url), 'utf8');
const ok = (b) => ({ status: 200, ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(b) });
const day = (iso) => Date.parse(`${iso}T00:00:00Z`);
const MD = {
  1000001: { statusCode: '11', futurestatusCode: '21', futurestatusCodeValidFrom: day('2027-06-27'), title: 'Kasniji', smDmData: { smQuantity: 8, dmQuantity: 0, stock: 5, quantitySoldInPeriod: 3 } },
  1000002: { statusCode: '11', futurestatusCode: '21', futurestatusCodeValidFrom: day('2027-01-10'), title: 'Prvi', activeSalesPrice: 6.5, groupId: '50113', groupTitle: 'Svijeće', smDmData: { smQuantity: 12, dmQuantity: 2, stock: 30, quantitySoldInPeriod: 9, shelfCapacity: 18 } },
  1000003: { statusCode: '01', futurestatusCode: '11', futurestatusCodeValidFrom: day('2026-12-01'), title: 'Novi' },
  1000004: { statusCode: '11', futurestatusCode: '', futurestatusCodeValidFrom: null, title: 'Ništa' },
  1000005: { statusCode: '21', futurestatusCode: '21', futurestatusCodeValidFrom: day('2027-01-10'), title: 'Već 21' },
  1000006: { statusCode: '12', futurestatusCode: '81', futurestatusCodeValidFrom: 253370678400000, title: 'Bez datuma' },
};

async function run(arg, extra = () => null) {
  const calls = [];
  const fetch = async (url, o = {}) => {
    calls.push({ url, method: o.method || 'GET', body: o.body });
    if (url.startsWith('/api/v1/websapapi/user-details')) return ok({ userDetails: { username: '1', storeInfo: { storeId: 'T001', catalogId: 'CAT-1' } } });
    const m = url.match(/article\/masterdata\?article=(\d{7})/);
    if (m) return ok([MD[m[1]] || {}]);
    const r = extra(url, o);
    if (r) return ok(r);
    throw new Error(url);
  };
  const win = { __stArg: { ...arg, job: 'j1' } };
  win.window = win;
  vm.runInNewContext(SRC, { window: win, fetch, Promise, JSON, Error, String, Math, Object, Array, Date, isFinite, encodeURIComponent, setTimeout });
  for (let i = 0; i < 400 && (!win.__st || win.__st.state === 'busy'); i++) await new Promise((r) => setTimeout(r, 5));
  return { st: JSON.parse(JSON.stringify(win.__st)), calls };
}

test('soon: only coming 21/81 with a real date, soonest first, nothing is written', async () => {
  const { st, calls } = await run({ mode: 'soon', nums: Object.keys(MD).concat(['abc', '1000002']) });
  assert.equal(st.state, 'ok');
  assert.deepEqual(st.res.list.map((x) => x.num), ['1000002', '1000001']);
  const a = st.res.list[0];
  assert.equal(a.from, '2027-01-10');
  assert.equal(a.st, '11'); assert.equal(a.fut, '21'); assert.equal(a.sm, 12); assert.equal(a.dm, 2); assert.equal(a.sold30, 9); assert.equal(a.groupName, 'Svijeće');
  assert.equal(st.res.asked, 6);
  assert.ok(calls.every((c) => c.method === 'GET'));
});

test('soon: a product group is searched first (not yet 21/81), then read one by one', async () => {
  const { st, calls } = await run({ mode: 'soon', cats: ['405'] }, (url, o) => {
    if (url.startsWith('/api/v1/article/search')) {
      const b = JSON.parse(o.body);
      assert.deepEqual(b.categories, ['405']);
      assert.ok(!b.statusCodes.includes('21') && !b.statusCodes.includes('81'));
      return { articleResults: [{ id: '1000001' }, { id: '1000004' }], pagingInfo: { total: 2 } };
    }
    return null;
  });
  assert.equal(st.state, 'ok');
  assert.deepEqual(st.res.list.map((x) => x.num), ['1000001']);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});

test('soon: nothing to read is refused', async () => {
  const { st } = await run({ mode: 'soon' });
  assert.equal(st.state, 'error');
});

test('hier: two levels of product groups', async () => {
  const { st } = await run({ mode: 'hier' }, (url) => (url.startsWith('/api/v1/catalog/product-hierarchy-groups') ? [
    { groupId: '4', title: 'Namještaj', subGroups: [{ groupId: '405', title: 'Kancelarija', subGroups: [] }, { groupId: '', title: 'x' }] },
    { groupId: '', title: '' },
  ] : null));
  assert.equal(st.state, 'ok');
  assert.deepEqual(st.res.groups, [{ id: '4', title: 'Namještaj', subs: [{ id: '405', title: 'Kancelarija' }] }]);
});
