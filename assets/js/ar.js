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

// Ready-made sentences per topic and score: 4 is a small slip, 3 a few things, 2 a lot, 1 hardly anything right.
// They say what was wrong and what is done about it; the employee picks the one that is true (or writes his own).
const TOPICS = [
  [/natpis|cjenovn|\bcijen[ae]\b|signage|price/i, {
    4: [
      'Dva-tri artikla bez cjenovne oznake, odmah dopunjeno.',
      'Jedna cijena nije odgovarala artiklu na polici, ispravljeno.',
      'Par oznaka malo oštećeno ili nakrivo, zamijenjeno i poravnato.',
      'Jedna akcijska oznaka ostala poslije kampanje, uklonjena.',
    ],
    3: [
      'Više artikala bez cjenovne oznake, oznake odštampane i postavljene.',
      'Nekoliko cijena ne odgovara artiklima na polici, provjereno i ispravljeno.',
      'Dio natpisa star ili oštećen, zamijenjen novim.',
      'Akcijske oznake na više mjesta ostale od prošle kampanje, uklonjene.',
    ],
    2: [
      'Na velikom dijelu odjela nedostaju cjenovne oznake, ponovo štampano i postavljeno.',
      'Mnogo cijena na polici ne odgovara artiklima, cijeli odjel prekontrolisan.',
      'Natpisi većinom stari i oštećeni, odjel ponovo označen.',
      'Stare i nove cijene izmiješane na više modula, sve uklonjeno i postavljeno ispravno.',
    ],
    1: [
      'Odjel skoro bez ispravnih cjenovnih oznaka, kompletno označavanje urađeno ispočetka.',
      'Cijene i natpisi uglavnom netačni ili nedostaju, potrebna hitna kontrola cijelog odjela.',
      'Kupci ne mogu pronaći cijene na većini artikala, cijeli odjel ponovo označen.',
    ],
  }],
  [/čist|cist|uredn|clean|tidy/i, {
    4: [
      'Police malo prašnjave na par mjesta, obrisano.',
      'Nekoliko artikala nije bilo povučeno naprijed, poravnato.',
      'Malo kartona i ambalaže na podu, uklonjeno.',
      'Par praznih mjesta na policama, dopunjeno iz skladišta.',
    ],
    3: [
      'Police prašnjave na više modula, očišćeno.',
      'Roba na više mjesta nije povučena naprijed ni poravnata, sređeno.',
      'Ambalaža i karton na nekoliko mjesta na odjelu, uklonjeno.',
      'Više praznina na policama zbog nedopunjene robe, dopunjeno.',
    ],
    2: [
      'Odjel neuredan, roba ispreturana na većini modula, sve ponovo složeno.',
      'Police i pod prljavi na većem dijelu odjela, urađeno detaljno čišćenje.',
      'Puno kartona, folije i praznih kutija na odjelu, sve uklonjeno.',
      'Velike praznine na policama, roba dopunjena iz skladišta.',
    ],
    1: [
      'Odjel vrlo neuredan i prljav, potrebno kompletno čišćenje i slaganje.',
      'Roba izmiješana i ispreturana po cijelom odjelu, sve složeno ispočetka.',
      'Prolazi zakrčeni kartonima i robom, odjel ispražnjen i sređen.',
    ],
  }],
  [/clearance|on ?line|rasprodaj/i, {
    4: [
      'Jedan-dva clearance artikla nisu bila na predviđenom mjestu, premješteno.',
      'Par clearance artikala bez oznake popusta, dopunjeno.',
      'Jedna online narudžba čekala na pripremu, pripremljena.',
    ],
    3: [
      'Više clearance artikala izvan predviđenog mjesta, premješteno.',
      'Dio clearance artikala bez oznake popusta, označeno.',
      'Nekoliko online narudžbi kasnilo s pripremom, pripremljeno.',
      'Oštećeni artikli nisu bili izdvojeni, izdvojeno za rasprodaju.',
    ],
    2: [
      'Clearance artikli razbacani po odjelu, sve skupljeno na jedno mjesto.',
      'Većina clearance artikala bez oznaka popusta, sve označeno.',
      'Online narudžbe nisu pripremljene na vrijeme, pripremljeno i javljeno kupcima.',
      'Puno oštećenih artikala na policama, izdvojeno i obrađeno.',
    ],
    1: [
      'Clearance i online artikli se ne obrađuju, potrebno sve sređivanje ispočetka.',
      'Clearance prostor neuredan i neoznačen, kompletno ponovo postavljen.',
      'Online narudžbe stoje neobrađene, hitno pripremljeno i javljeno voditelju.',
    ],
  }],
  [/koncept|concept|planogram/i, {
    4: [
      'Jedan-dva artikla nisu po planogramu, premješteno.',
      'Mala odstupanja od koncepta na jednom modulu, ispravljeno.',
      'Nova roba skoro složena po konceptu, ostalo završeno danas.',
    ],
    3: [
      'Dio robe nije po planogramu, premješteno prema konceptu.',
      'Nekoliko modula nije popunjeno prema planogramu, dopunjeno.',
      'Nova roba djelimično složena po konceptu, u toku.',
      'Nedostaje nekoliko artikala iz koncepta, provjereno stanje i naručeno.',
    ],
    2: [
      'Veliki dio odjela nije po planogramu, većina modula prepravljena.',
      'Novi koncept samo djelimično postavljen, nastavlja se sutra.',
      'Mnogo artikala iz koncepta nedostaje, urađena narudžba i javljeno voditelju.',
    ],
    1: [
      'Odjel uopšte nije po konceptu, potrebno kompletno postavljanje po planogramu.',
      'Novi planogram još nije postavljen, planirano postavljanje s voditeljem.',
      'Većina artikala iz koncepta nedostaje, javljeno voditelju i naručeno.',
    ],
  }],
  [/display|izlo|model/i, {
    4: [
      'Jedan izložbeni model malo prašnjav, očišćen.',
      'Izložbenom modelu nedostajala cijena, dopunjeno.',
    ],
    3: [
      'Više izložbenih modela prašnjavo, očišćeno.',
      'Jedan izložbeni model oštećen, zamijenjen.',
      'Nekoliko izložbenih modela bez cijene, oznake dopunjene.',
    ],
    2: [
      'Izložbeni modeli prljavi i oštećeni, očišćeno i oštećeni zamijenjeni.',
      'Većina izložbenih modela bez cijena, sve označeno.',
    ],
    1: [
      'Izložbeni modeli u lošem stanju, potrebna kompletna zamjena.',
      'Izložbeni modeli nedostaju ili su neupotrebljivi, javljeno voditelju.',
    ],
  }],
  [/\bsm\b|\bvm\b|vrijednost/i, {
    4: [
      'Jedan artikal mogao biti bolje istaknut, premješten na bolju poziciju.',
      'Mala odstupanja od VM pravila na jednom modulu, ispravljeno.',
    ],
    3: [
      'Robu treba bolje istaknuti prema VM pravilima, djelimično prepravljeno.',
      'Glavni artikli nisu dovoljno vidljivi, premješteni naprijed.',
      'Kompozicija na stolu ili modulu nije po VM uputstvu, složeno ponovo.',
    ],
    2: [
      'VM pravila se slabo primjenjuju na odjelu, većina kompozicija prepravljena.',
      'Glavni i kampanjski artikli nisu istaknuti, odjel ponovo uređen.',
    ],
    1: [
      'VM pravila se ne primjenjuju, potrebno kompletno ponovno uređenje odjela.',
      'Odjel ne djeluje privlačno kupcima, dogovoreno uređenje s voditeljem.',
    ],
  }],
];

const GENERIC = {
  4: ['Sitni nedostaci, ispravljeno u toku smjene.', 'Skoro sve u redu, jedna sitnica ispravljena odmah.'],
  3: ['Više nedostataka na odjelu, većina ispravljena danas.', 'Potrebno dodatno uređivanje, nastavlja se sutra ujutro.'],
  2: ['Ozbiljniji nedostaci na većem dijelu odjela, započeto sređivanje.', 'Puno posla na odjelu, javljeno voditelju.'],
  1: ['Stanje vrlo loše, potrebno kompletno sređivanje odjela.', 'Hitno sređivanje potrebno, javljeno voditelju.'],
};

/**
 * Comments to choose from for a question with a score under 5: the employee's own earlier ones for that score
 * first, then the ready-made ones for that topic and score.
 */
export function suggestions(question, score = 4, used = []) {
  const name = String(question && question.name || '');
  const sc = Math.min(4, Math.max(1, Math.round(+score) || 4));
  let lists = GENERIC;
  for (const [rx, l] of TOPICS) if (rx.test(name)) { lists = l; break; }
  const own = (Array.isArray(used) ? used : (used && used[sc]) || []).filter((x) => x && typeof x === 'string');
  return [...new Set([...own, ...(lists[sc] || GENERIC[sc])])].slice(0, 6);
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
