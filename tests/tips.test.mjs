import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, stale } from '../assets/js/tips.js';

const now = new Date(2026, 10, 6, 10, 0).getTime(); // a Friday

test('tips from every source, the urgent ones first', () => {
  const tips = build({
    furn: { at: now, list: [
      { num: '3670484', name: 'Komoda', st: '81', stock: -1, dm: 1 },
      { num: '3600001', name: 'Ormar', st: '21', stock: 0, dm: 1 },
      { num: '3600002', name: 'Stolica', st: '21', stock: 0, dm: 1, succ: { num: '3600003', st: '11' } },
      { num: '3600004', name: 'Stol', st: '21', stock: 4, dm: 0 },
    ] },
    audit: { at: now, groups: {
      out: [{ num: '4912309', name: 'Vreća', st: '21', sm: 22, dm: 14, succ: { num: '4912780', sm: 0, dm: 0 } }],
      nosale: [{ num: '4911111', name: 'Vaza', sm: 4, stock: 6 }],
      topnosm: [],
    } },
    ar: { enabled: true, done: false },
    tasks: [{ title: 'Inventura', days: 1, left: 'sutra' }, { title: 'Kasnije', days: 9, left: 'za 9 dana' }],
    top: { at: now, list: [
      { num: '4912783', name: 'Torba', st: '11', stock: 16, sold7: 40 },
      { num: '4912784', name: 'Svijeća', st: '11', stock: 90, sold7: 40 },
      { num: '4912785', name: 'Stara', st: '21', stock: 1, sold7: 40 },
    ] },
    home: { at: now, list: [
      { num: '4912030', name: 'Svijećnjak', st: '21', stock: 38, price: 3, group: '50101' },
      { num: '5120001', name: 'Božić', st: '81', stock: 40, price: 1, group: '51201' },
    ] },
  }, now);
  assert.deepEqual(tips.map((t) => t.id), ['furn-dm', 'sm-out', 'ar', 'tasks', 'top-low', 'clear-home', 'sm-nosale']);
  const f = tips[0];
  assert.match(f.title, /: 2$/, 'one with a replacement number is left out');
  assert.match(f.text, /1 je vjerovatno prodan/);
  assert.match(tips[1].text, /1 ima zamjenu/);
  assert.deepEqual(tips.find((t) => t.id === 'top-low').items.map((x) => x.num), ['4912783']);
  assert.equal(tips.find((t) => t.id === 'tasks').items.length, 1);
  assert.match(tips.find((t) => t.id === 'clear-home').title, /1 artikal, 114 KM/, 'Christmas left out');
});

test('nothing read yet: no tips, everything to read', () => {
  assert.deepEqual(build({}, now), []);
  assert.deepEqual(stale({}, now), ['audit', 'top', 'home', 'furn']);
  assert.deepEqual(stale({ audit: { at: now - 3600000 }, top: { at: now - 30 * 3600000 } }, now), ['top', 'home', 'furn']);
});
