// assets/store-task.js 'pics': only GETs, only JYSK's own image server addresses come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../assets/store-task.js', import.meta.url), 'utf8');

test('pictures: read only, at most 40, foreign or odd addresses dropped', async () => {
  const calls = [];
  const ok = (b) => ({ status: 200, ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(b) });
  const fetch = async (url, o = {}) => {
    calls.push(`${o.method || 'GET'} ${url.split('?')[0]}`);
    if (url.startsWith('/api/v1/websapapi/user-details')) return ok({ userDetails: { username: '1', storeInfo: { storeId: 'T001', catalogId: 'CAT-1' } } });
    if (url.startsWith('/api/v1/article/details')) {
      const n = new URL(url, 'https://x').searchParams.get('articleId');
      const pic = { '1000001': ['//resources.jysk.com/getimage/wd2.small/218486', '//resources.jysk.com/getimage/wd2.medium/218486'],
        '1000002': ['https://evil.example/getimage/wd2.small/1', '//cdn3.jysk.com/getimage/wd3.medium/243315'],
        '1000003': [null, null] }[n] || ['//resources.jysk.com/getimage/wd2.small/1?x=1', ''];
      return ok({ basicArticleData: { thumbnailUrl: pic[0], webPictureUrl: pic[1] } });
    }
    throw new Error(url);
  };
  const nums = ['1000001', '1000002', '1000003', 'abc', ...Array.from({ length: 50 }, (_, i) => String(2000000 + i))];
  const win = { __stArg: { mode: 'pics', nums, job: 'j1' } };
  win.window = win;
  vm.runInNewContext(SRC, { window: win, fetch, Promise, JSON, Error, String, Math, Object, Array, isFinite, encodeURIComponent, setTimeout });
  for (let i = 0; i < 400 && (!win.__st || win.__st.state === 'busy'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(win.__st.state, 'ok');
  assert.ok(calls.every((c) => c.startsWith('GET ')), 'nothing but GETs');
  const p = win.__st.res.pics;
  assert.equal(p.length, 40);
  assert.deepEqual({ ...p[0] }, { num: '1000001', s: 'https://resources.jysk.com/getimage/wd2.small/218486', m: 'https://resources.jysk.com/getimage/wd2.medium/218486' });
  assert.deepEqual({ ...p[1] }, { num: '1000002', s: '', m: 'https://cdn3.jysk.com/getimage/wd3.medium/243315' });
  assert.deepEqual({ ...p[2] }, { num: '1000003', s: '', m: '' });
  assert.deepEqual({ ...p[3] }, { num: '2000000', s: '', m: '' });
});
