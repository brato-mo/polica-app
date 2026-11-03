import test from 'node:test';
import assert from 'node:assert/strict';
import * as news from '../assets/js/news.js';

test('first read marks nothing new, a later read marks new ids', () => {
  const a = news.merge(null, { my: [{ id: '1', title: 'a' }], news: [] }, 1000);
  assert.equal(news.isNew(a, '1'), false);
  const b = news.merge(a, { my: [{ id: '1', title: 'a' }, { id: '2', title: 'b' }], news: [] }, 2000);
  assert.equal(news.isNew(b, '1'), false);
  assert.equal(news.isNew(b, '2'), true);
});

test('a failed read keeps nothing away: merge only runs on good data, old lists stay', () => {
  const a = news.merge(null, { news: [{ id: 'n1', title: 'x' }] }, 1000);
  assert.equal(a.news.length, 1);
});

test('my tasks: staff role and my own, not done ones', () => {
  const st = { my: [], loc: [{ id: '1', role: 'Store Staff', title: 'a' }, { id: '2', role: 'Store Manager', title: 'b' }, { id: '3', role: 'Store Staff', done: true, title: 'c' }] };
  assert.deepEqual(news.myTasks(st, 'Test Prodavac, 100200').map((t) => t.id), ['1']);
});

test('lastMorning is the last 8:00', () => {
  const at = new Date(2026, 10, 3, 7, 0).getTime();
  assert.equal(new Date(news.lastMorning(at)).getDate(), 2);
});
