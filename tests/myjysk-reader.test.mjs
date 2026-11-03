// Runs assets/myjysk-reader.js against a fake MYJYSK: result shape, at most 6 article calls at once, login detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../assets/myjysk-reader.js', import.meta.url), 'utf8');

function fake({ status = 200, kb = 24 } = {}) {
  let now = 0, peak = 0;
  const res = (body) => ({ status, ok: status === 200, json: async () => body, headers: { get: () => 'application/json' } });
  const fetch = async (u) => {
    if (u.startsWith('/learnapi/')) {
      now++; peak = Math.max(peak, now);
      await new Promise((r) => setTimeout(r, 3));
      now--;
      return res({ sections: [{ isActive: true, order: 1, content: '<p>17.10.26: Novo</p>' }], lastUpdated: '2026-10-17T10:00:00' });
    }
    if (u.startsWith('/searchapi/search')) return res({ results: Array.from({ length: kb }, (_, i) => ({ id: 100 + i, title: `${i % 2 ? 2 : 3}) Planogram ${i}`, articleTopicName: '05 Homeware', articleTopicId: 9 })) });
    if (u.startsWith('/searchapi/widgets')) return res({ results: [{ objectId: 1, title: 'Zadatak', endDate: '2026-11-05' }], total: 1 });
    return res({ articles: [{ objectId: 5, title: 'Vijest', content: 'x' }], total: 1 });
  };
  return { fetch, peak: () => peak };
}

async function run(f) {
  const win = {};
  class DOMParser { parseFromString() { return { querySelectorAll: () => [], body: { textContent: '' } }; } }
  vm.runInContext(SRC, vm.createContext({ window: win, fetch: f.fetch, DOMParser, URL, Promise, JSON, Array, Object, String, Math }));
  for (let i = 0; i < 400 && win.__mjr.state === 'busy'; i++) await new Promise((r) => setTimeout(r, 5));
  return win.__mjr;
}

test('reads tasks, news and the concept, with at most 6 article calls at a time', async () => {
  const f = fake();
  const r = await run(f);
  assert.equal(r.state, 'ok');
  assert.equal(r.my.length, 1);
  assert.equal(r.news.length, 1);
  assert.ok(r.kb && Array.isArray(r.kb.upds));
  assert.ok(f.peak() <= 6, `peak ${f.peak()}`);
  assert.ok(f.peak() >= 2);
});

test('a refused session is reported as login, not as an error', async () => {
  const r = await run(fake({ status: 401 }));
  assert.equal(r.state, 'login');
});
