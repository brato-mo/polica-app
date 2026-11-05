import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, total } from '../assets/js/smcheck.js';

const A = (num, st, o = {}) => ({ num, st, stock: 5, sm: 0, dm: 0, cap: 10, sold30: 3, ...o });

test('each article lands in the first group that fits', () => {
  const list = [
    A('1000001', '21', { sm: 8 }),
    A('1000002', '81', { dm: 2 }),
    A('1000003', '11', { sm: 4, sold30: 0, stock: 6 }),
    A('1000004', '11', { sm: 30, cap: 12 }),
    A('1000005', '12', { dm: 1 }),
    A('1000006', '11', { sm: 4 }),
    A('1000007', '11', { sm: 6, sold30: 0, stock: 2 }),
  ];
  const top = [A('2000001', '11', { sold30: 90 }), A('2000002', '11', { sold30: 80 }), A('1000006', '11', { sold30: 70 }), A('2000003', '21', { sold30: 60 })];
  const g = check(list, top, (n) => n === '2000002');
  assert.deepEqual(g.out.map((x) => x.num), ['1000001', '1000002']);
  assert.deepEqual(g.nosale.map((x) => x.num), ['1000007', '1000003']);
  assert.equal(g.overcap, undefined, 'SM over the shelf capacity is not a finding');
  assert.deepEqual(g.topnosm.map((x) => x.num), ['2000001'], 'in the planogram, already with SM, or going out: not flagged');
  assert.equal(total(g), 5);
});

test('nothing to say about a clean department', () => {
  assert.equal(total(check([A('1000006', '11', { sm: 4 })], [])), 0);
});
