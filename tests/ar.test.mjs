import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questions, suggestions, answers, missing, weekStart, doneThisWeek, optionFor } from '../assets/js/ar.js';

const opts = [['11', '1'], ['12', '2'], ['13', '3'], ['14', '4'], ['15', '5']].map(([id, text]) => ({ id, text }));
const form = {
  guid: '00000000-0000-0000-0000-000000000001', name: 'AR Time - TEST',
  qs: [
    { id: 1, guid: 'g1', type: 4, req: true, name: 'Ocijenite koliko su natpisi i cjenovne oznake ispravni', opts },
    { id: 2, guid: 'g2', type: 2, req: false, name: 'Za rezultate ispod 5 napišite potencijal za poboljšanje', opts: [] },
    { id: 3, guid: 'g3', type: 4, req: true, name: 'Procijenite koliko se dobro postupa s Clearance/ On line artiklima', opts },
    { id: 4, guid: 'g4', type: 2, req: false, name: 'Za rezultate ispod 5 napišite potencijal za poboljšanje', opts: [] },
    { id: 5, guid: 'g5', type: 4, req: true, name: 'Procijenite koliko dobro trgovina radi s SM vrijednostima i VM', opts },
  ],
};

test('rating questions carry the comment field that follows them', () => {
  const qs = questions(form);
  assert.deepEqual(qs.map((q) => [q.id, q.note && q.note.id]), [[1, 2], [3, 4], [5, null]]);
});

test('ready-made comments fit the question; own earlier comments come first', () => {
  const qs = questions(form);
  assert.match(suggestions(qs[0])[0], /cjenovn|cijen/i);
  assert.match(suggestions(qs[1]).join(' '), /clearance/i, '"Procijenite" is not a question about prices');
  assert.match(suggestions(qs[2]).join(' '), /VM/);
  assert.equal(suggestions(qs[0], ['Moj komentar.'])[0], 'Moj komentar.');
});

test('all fives: only the scores are sent', () => {
  const qs = questions(form);
  assert.deepEqual(answers(qs, {}, {}), [
    { fieldId: 1, fieldGuid: 'g1', fieldType: 4, value: '15' },
    { fieldId: 3, fieldGuid: 'g3', fieldType: 4, value: '15' },
    { fieldId: 5, fieldGuid: 'g5', fieldType: 4, value: '15' },
  ]);
  assert.deepEqual(missing(qs, {}, {}), []);
});

test('a four needs a comment, which is sent right after its score', () => {
  const qs = questions(form);
  assert.deepEqual(missing(qs, { 3: 4 }, {}).map((q) => q.id), [3]);
  const a = answers(qs, { 3: 4 }, { 3: '  Oznake dopunjene. ' });
  assert.deepEqual(a.map((x) => [x.fieldId, x.value]), [[1, '15'], [3, '14'], [4, 'Oznake dopunjene.'], [5, '15']]);
  assert.equal(optionFor(qs[0], 2).id, '12');
});

test('one rating per week, from Monday', () => {
  const thu = new Date(2026, 10, 5, 10, 0).getTime();
  assert.equal(new Date(weekStart(thu)).getDate(), 2);
  assert.ok(doneThisWeek({ at: new Date(2026, 10, 2, 9).getTime() }, thu));
  assert.ok(!doneThisWeek({ at: new Date(2026, 10, 1, 20).getTime() }, thu));
  assert.ok(!doneThisWeek(null, thu));
});
