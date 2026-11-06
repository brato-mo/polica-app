// The state of the last Minus lista / Regulacija zalihe sending, as the employee sees it, and the read-only check of
// a sending whose outcome is not known. Pure functions (no page, no phone): tested in tests/minusop.test.mjs.
//
// The record itself is kept by the phone (OpLog.java, data/minus-op.json), written before anything is sent.

export const LABEL = {
  prepared: 'Pripremljeno',
  confirming: 'Čeka potvrdu',
  sending: 'Slanje u toku',
  confirmed: 'Potvrđeno',
  partial: 'Djelimično završeno',
  failed: 'Neuspjelo',
  unknown: 'Ishod nepoznat – potrebna provjera',
};

const STEP = { start: 'čitanje Minus liste', check: 'provjera liste', user: 'provjera korisnika', minus: 'Minus lista', adjust: 'Regulacija zalihe' };

/** The sending is still open: no new sending until it is resolved. */
export function locks(op) {
  if (!op) return false;
  if (op.state === 'sending') return true;
  return op.state === 'unknown' && !op.resolved;
}

/**
 * What the screen says about a record. Answer: { state, label, tone: ok | warn | bad | busy, text, lock } or null.
 * Words are chosen so that nothing reads as success unless StoreFront accepted it.
 */
export function describe(op) {
  if (!op || !op.state) return null;
  const n = (op.sent || op.items || []).length;
  const k = (op.skipped || []).length;
  const adjustOnly = op.kind === 'adjust';
  const where = STEP[op.step] || op.step || '';
  const base = { state: op.state, label: LABEL[op.state] || op.state, lock: locks(op) };
  switch (op.state) {
    case 'sending':
      return { ...base, tone: 'busy', text: `Šalje se u StoreFront (${where}). Ne zatvaraj aplikaciju.` };
    case 'confirmed':
      if (!n) return { ...base, tone: 'warn', text: `StoreFront nije ništa promijenio: ${k ? `${k} preskočeno jer se lista promijenila.` : 'ništa nije bilo za slanje.'}` };
      return { ...base, tone: 'ok', text: `StoreFront je prihvatio ${adjustOnly ? 'Regulaciju zalihe' : 'Minus listu i Regulaciju zalihe'} za ${n} ${n === 1 ? 'artikal' : 'artikala'}.${k ? ` Preskočeno ${k} (promijenilo se u međuvremenu).` : ''}` };
    case 'partial':
      return { ...base, tone: 'warn', text: 'Minus lista je ispravljena, Regulacija zalihe je odbijena. Pošalji samo Regulaciju ili je uradi u StoreFrontu.' };
    case 'failed':
      return { ...base, tone: 'bad', text: op.step === 'minus' ? 'StoreFront je odbio Minus listu. Ništa nije promijenjeno.' : 'Slanje nije počelo. Ništa nije promijenjeno.' };
    case 'unknown': {
      if (op.resolved) {
        return { ...base, lock: false, tone: op.resolved.how === 'done' ? 'ok' : 'warn',
          text: op.resolved.how === 'done' ? 'Provjereno u StoreFrontu: prošlo je.' : 'Provjereno u StoreFrontu: nije prošlo. Možeš poslati ponovo.' };
      }
      const what = op.step === 'adjust'
        ? (adjustOnly ? 'Regulacija zalihe je poslana, ali odgovor nije stigao.' : 'Minus lista je prihvaćena. Regulacija zalihe je poslana, ali odgovor nije stigao.')
        : op.step === 'minus' ? 'Minus lista je poslana, ali odgovor nije stigao. Regulacija nije poslana.'
          : `Slanje je prekinuto (${where}).`;
      return { ...base, tone: 'bad', text: `${what} Provjeri u StoreFrontu prije ponovnog slanja; aplikacija neće slati ništa sama.` };
    }
    default:
      return { ...base, tone: 'warn', text: '' };
  }
}

/**
 * Compares a record with what StoreFront shows now (store-task.js opcheck: stock history since shortly before the
 * sending, and the Minus lista). For every line and step: 'seen' (exactly one movement by this user of exactly that
 * quantity on that article after the sending began), 'none', or 'unclear' (more than one, or one also before).
 * The answer only HELPS the employee: same article and quantity is not proof, so nothing is marked done from it.
 * Answer: { lines: [{ num, target, minus, adjust }], all: 'seen' | 'none' | 'mixed' }.
 */
export function evidence(op, chk, slackMs = 2 * 60 * 1000) {
  const since = (op && op.at) || 0;
  const until = ((op && op.end) || since) + 15 * 60 * 1000;
  const hist = (chk && chk.hist) || [];
  const minusNow = (chk && chk.minus) || {};
  const look = (art, q) => {
    const mine = hist.filter((h) => h.art === art && h.q === q && h.mine);
    const after = mine.filter((h) => h.t >= since - slackMs && h.t <= until);
    const before = mine.filter((h) => h.t < since - slackMs);
    if (after.length === 1 && !before.length) return 'seen';
    if (!after.length) return 'none';
    return 'unclear';
  };
  const lines = ((op && op.items) || []).map((it) => {
    const n = Math.abs(+it.qty);
    let minus = op.kind === 'adjust' ? 'skip' : look(it.num, n);
    // still on the Minus lista with the same minus: the Minus lista step did not go through for this line
    if (minus !== 'skip' && minusNow[it.num] === +it.qty) minus = 'none';
    return { num: it.num, target: it.target, minus, adjust: look(it.target, -n) };
  });
  const vals = lines.flatMap((l) => [l.minus, l.adjust]).filter((v) => v !== 'skip');
  const all = vals.length && vals.every((v) => v === 'seen') ? 'seen' : vals.length && vals.every((v) => v === 'none') ? 'none' : 'mixed';
  return { lines, all };
}
