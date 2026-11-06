import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, evidence, locks, LABEL } from '../assets/js/minusop.js';

const T0 = Date.UTC(2026, 10, 6, 9, 0);
const items = [
  { num: '1000001', qty: -2, target: '1000002' },
  { num: '1000003', qty: -1, target: '1000004' },
];
const op = (o) => ({ id: 'x', kind: 'both', at: T0, end: T0 + 30000, items, ...o });

test('every state has its own words; only a confirmed sending reads as success', () => {
  for (const st of ['sending', 'confirmed', 'partial', 'failed', 'unknown']) {
    const d = describe(op({ state: st, step: 'adjust', sent: ['1000001', '1000003'] }));
    assert.equal(d.label, LABEL[st]);
    assert.ok(d.text.length > 10);
    if (st !== 'confirmed') assert.doesNotMatch(d.text, /prihvatio .*Regulaciju/);
  }
  assert.equal(describe(op({ state: 'unknown', step: 'minus' })).label, 'Ishod nepoznat – potrebna provjera');
  assert.match(describe(op({ state: 'unknown', step: 'adjust' })).text, /Minus lista je prihvaćena/);
  assert.match(describe(op({ state: 'unknown', step: 'minus' })).text, /Regulacija nije poslana/);
  assert.match(describe(op({ state: 'confirmed', sent: [], skipped: [{ num: '1' }] })).text, /nije ništa promijenio/);
  assert.equal(describe(null), null);
});

test('a running or an unresolved unknown sending locks new sendings; nothing else does', () => {
  assert.equal(locks(op({ state: 'sending' })), true);
  assert.equal(locks(op({ state: 'unknown' })), true);
  assert.equal(locks(op({ state: 'unknown', resolved: { how: 'notdone' } })), false);
  for (const st of ['confirmed', 'partial', 'failed']) assert.equal(locks(op({ state: st })), false);
  assert.equal(locks(null), false);
});

const mv = (art, q, dt, mine = true) => ({ art, q, t: T0 + dt, mine, type: '911' });

test('evidence: exactly one own movement of that quantity after the start is "seen"', () => {
  const e = evidence(op({ state: 'unknown' }), {
    hist: [mv('1000001', 2, 5000), mv('1000002', -2, 6000), mv('1000003', 1, 5000), mv('1000004', -1, 6000)],
    minus: {},
  });
  assert.equal(e.all, 'seen');
  assert.deepEqual(e.lines[0], { num: '1000001', target: '1000002', minus: 'seen', adjust: 'seen' });
});

test('evidence: nothing found, someone else, other quantity, too late = not seen', () => {
  const e = evidence(op({ state: 'unknown' }), {
    hist: [mv('1000002', -2, 5000, false), mv('1000004', -3, 5000), mv('1000001', 2, 3 * 3600000)],
    minus: { '1000001': -2, '1000003': -1 },
  });
  assert.equal(e.all, 'none');
});

test('evidence: the same correction also before the sending, or twice, is unclear (no guessing)', () => {
  const e = evidence(op({ state: 'unknown' }), {
    hist: [mv('1000002', -2, -3600000), mv('1000002', -2, 5000), mv('1000004', -1, 5000), mv('1000004', -1, 9000)],
    minus: {},
  });
  assert.equal(e.lines[0].adjust, 'unclear');
  assert.equal(e.lines[1].adjust, 'unclear');
  assert.equal(e.all, 'mixed');
});

test('evidence: still on the Minus lista with the same minus means the Minus lista step did not go', () => {
  const e = evidence(op({ state: 'unknown' }), { hist: [mv('1000001', 2, 5000)], minus: { '1000001': -2 } });
  assert.equal(e.lines[0].minus, 'none');
});

test('evidence for a Regulacija-only sending looks at the replacement only', () => {
  const e = evidence(op({ state: 'unknown', kind: 'adjust' }), { hist: [mv('1000002', -2, 5000), mv('1000004', -1, 5000)], minus: {} });
  assert.equal(e.lines[0].minus, 'skip');
  assert.equal(e.all, 'seen');
});
