// The weekly AR rating of the employee's department ("AR Time - ..." in MYJYSK): questions, ready-made comments
// for scores under 5, and the answers that are sent. Pure functions, no access to the page or the phone.

export const DEFAULT_FORM = 'AR Time - MALI ARTIKLI';

/** Rating questions (1-5) with the comment field that follows each one. */
export function questions(form) {
  const out = [];
  const qs = (form && form.qs) || [];
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    if (q.type !== 4 || !q.opts || !q.opts.length) continue;
    const next = qs[i + 1];
    const note = next && next.type === 2 ? next : null;
    out.push({ ...q, note });
  }
  return out;
}

// Ready-made sentences per topic. They say what was wrong and what was done about it; the employee picks the
// one that is true (or writes his own).
const TOPICS = [
  [/natpis|cjenovn|\bcijen[ae]\b|signage|price/i, [
    'Nekoliko artikala bez cjenovne oznake, oznake dopunjene.',
    'Par cijena nije odgovaralo artiklu na polici, ispravljeno.',
    'Natpisi djelimično oštećeni ili stari, zamijenjeni novim.',
    'Akcijske oznake ostale nakon kampanje, uklonjene.',
  ]],
  [/čist|cist|uredn|clean|tidy/i, [
    'Police prašnjave na par mjesta, očišćeno.',
    'Artikli nisu bili povučeni naprijed, poravnato i dopunjeno.',
    'Ambalaža i karton ostali na podu odjela, uklonjeno.',
    'Praznine na policama zbog nedopunjene robe, dopunjeno iz skladišta.',
  ]],
  [/clearance|on ?line|rasprodaj/i, [
    'Clearance artikli nisu bili na predviđenom mjestu, premješteni.',
    'Nekim clearance artiklima nedostaje oznaka popusta, dopunjeno.',
    'Online narudžbe čekale na pripremu, pripremljene.',
    'Oštećeni artikli nisu bili izdvojeni, izdvojeno za rasprodaju.',
  ]],
  [/koncept|concept|planogram/i, [
    'Dio robe nije po planogramu, premješteno prema konceptu.',
    'Nova roba još nije složena prema konceptu, u toku.',
    'Moduli nisu potpuno popunjeni prema planogramu, dopunjeno.',
    'Nedostaje nekoliko artikala iz koncepta, provjereno stanje i naručeno.',
  ]],
  [/display|izlo|model/i, [
    'Izložbeni modeli prašnjavi, očišćeni.',
    'Jedan izložbeni model oštećen, zamijenjen.',
    'Izložbeni modeli bez cijene, oznake dopunjene.',
  ]],
  [/\bsm\b|\bvm\b|vrijednost/i, [
    'Robu treba bolje istaknuti prema VM pravilima, prepravljeno.',
    'Glavni artikli nisu bili dovoljno vidljivi, premješteni na bolju poziciju.',
    'Kompozicija na stolu/modulu nije po VM uputstvu, složeno ponovo.',
  ]],
];

const GENERIC = [
  'Manji nedostaci na odjelu, ispravljeno u toku smjene.',
  'Potrebno dodatno uređivanje, planirano za sutra ujutro.',
];

/** Comments to choose from for a question with a score under 5; the employee's own earlier ones first. */
export function suggestions(question, used = []) {
  const name = String(question && question.name || '');
  let list = GENERIC;
  for (const [rx, l] of TOPICS) if (rx.test(name)) { list = l; break; }
  const own = (used || []).filter((x) => x && typeof x === 'string');
  return [...new Set([...own, ...list])].slice(0, 6);
}

/** The option of a question for a score (1-5). */
export function optionFor(question, score) {
  return (question.opts || []).find((o) => String(o.text).trim() === String(score)) || null;
}

/** What is still missing before the answers can be sent: questions under 5 without a comment. */
export function missing(qs, scores, notes) {
  return qs.filter((q) => {
    const sc = +(scores[q.id] || 5);
    return sc < 5 && q.note && !String(notes[q.id] || '').trim();
  });
}

/** The answers to send, in the order of the form: every score, and a comment where the score is under 5. */
export function answers(qs, scores, notes) {
  const out = [];
  for (const q of qs) {
    const sc = +(scores[q.id] || 5);
    const opt = optionFor(q, sc);
    if (!opt) throw new Error(`no option ${sc} for ${q.id}`);
    out.push({ fieldId: q.id, fieldGuid: q.guid, fieldType: q.type, value: opt.id });
    if (q.note && sc < 5) {
      out.push({ fieldId: q.note.id, fieldGuid: q.note.guid, fieldType: q.note.type, value: String(notes[q.id] || '').trim().slice(0, 1000) });
    }
  }
  return out;
}

/** Monday 00:00 of the week of t: one AR rating per week. */
export function weekStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

export const doneThisWeek = (last, now) => !!(last && last.at && last.at >= weekStart(now));
