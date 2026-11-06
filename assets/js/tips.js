// "Prijedlozi danas": what is worth doing today, put together from what the app already read (StoreFront: SM/DM
// check, best sellers, the lists to sell out; MYJYSK: AR and tasks). Pure functions, no access to the page or the
// phone. Every tip says where it comes from and leads to the screen where it is done.

const OUT = new Set(['21', '81']);

/**
 * src: { audit: { at, groups }, top: { at, list }, home: { at, list }, furn: { at, list }, ar: { done }, tasks: [] }
 * groups is smcheck.check() of the audit. Answer: tips, most urgent first:
 * { id, level: 1 (do now) | 2 (today) | 3 (when there is time), title, text, items: [{ num, name, sub }], go }
 */
export function build(src, now = Date.now()) {
  const out = [];
  const furn = (src.furn && src.furn.list) || [];
  const onDisplay = furn.filter((x) => x.dm > 0 && x.stock <= 0 && !x.succ);
  if (onDisplay.length) {
    const sold = onDisplay.filter((x) => x.stock + x.dm <= 0).length;
    out.push({
      id: 'furn-dm', level: 1, go: 'clear-furn',
      title: `Namještaj na izlogu bez zalihe: ${onDisplay.length}`,
      text: `Status 21/81, stoji u DM, a zaliha je 0 ili manje.${sold ? ` ${sold} ${sold === 1 ? 'je vjerovatno prodan' : 'su vjerovatno prodani'} sa izloga, a DM nije skinut.` : ''} Skini s DM da kupci vide zalihu, odnosno da stanje bude tačno.`,
      items: onDisplay.slice(0, 5).map((x) => ({ num: x.num, name: x.name, sub: `zaliha ${x.stock}, DM ${x.dm}` })),
    });
  }

  const g = (src.audit && src.audit.groups) || null;
  if (g && g.out && g.out.length) {
    const moves = g.out.filter((x) => x.succ && (x.succ.sm < x.sm || x.succ.dm < x.dm)).length;
    out.push({
      id: 'sm-out', level: 1, go: 'audit',
      title: `Ukinuti artikli sa SM/DM: ${g.out.length}`,
      text: `Smjernica: kad artikal pređe na status 21, ukloni SM i DM.${moves ? ` ${moves} ${moves === 1 ? 'ima zamjenu' : 'imaju zamjenu'} na koju treba prebaciti SM/DM.` : ''} Vrijednosti unesene prije 22:00 ulaze u sutrašnji prijedlog narudžbe.`,
      items: g.out.slice(0, 5).map((x) => ({ num: x.num, name: x.name, sub: `status ${x.st}, SM ${x.sm}, DM ${x.dm}` })),
    });
  }

  if (src.ar && src.ar.enabled && !src.ar.done) {
    out.push({ id: 'ar', level: new Date(now).getDay() >= 4 || new Date(now).getDay() === 0 ? 1 : 2, go: 'ar', title: 'AR artikli ove sedmice nisu urađeni', text: 'Ocjena odjela jednom sedmično. Sve je unaprijed na 5, promijeniš samo ono što nije.', items: [] });
  }

  const tasks = (src.tasks || []).filter((t) => t.days != null && t.days <= 2);
  if (tasks.length) {
    out.push({
      id: 'tasks', level: tasks.some((t) => t.days < 0) ? 1 : 2, go: 'news',
      title: `MYJYSK zadaci sa rokom do prekosutra: ${tasks.length}`,
      text: 'Zadaci koji su tvoji ili za sve prodavače u trgovini.',
      items: tasks.slice(0, 5).map((t) => ({ num: '', name: t.title, sub: t.left })),
    });
  }

  const top = ((src.top && src.top.list) || []).filter((x) => !OUT.has(x.st));
  const low = top.filter((x) => typeof x.sold7 === 'number' && x.sold7 > 0 && x.stock < x.sold7).sort((a, b) => b.sold7 - a.sold7);
  if (low.length) {
    out.push({
      id: 'top-low', level: 2, go: 'top',
      title: `Najprodavaniji pri kraju zalihe: ${low.length}`,
      text: 'Zaliha je manja od prodaje zadnjih 7 dana. Provjeri policu i skladište, SM i SAO prijedlog narudžbe.',
      items: low.slice(0, 5).map((x) => ({ num: x.num, name: x.name, sub: `zaliha ${x.stock}, prodano 7 dana ${x.sold7}` })),
    });
  }

  if (g && g.topnosm && g.topnosm.length) {
    out.push({
      id: 'top-nosm', level: 2, go: 'audit',
      title: `Najprodavaniji bez SM, nisu u planogramu: ${g.topnosm.length}`,
      text: 'Smjernica: SM, DepSM i AR prate SM na najprodavanijim artiklima. Ako je izložen izvan planograma (Powerline, endframe), treba mu SM.',
      items: g.topnosm.slice(0, 5).map((x) => ({ num: x.num, name: x.name, sub: `prodano 30 dana ${x.sold30}` })),
    });
  }

  const home = ((src.home && src.home.list) || []).filter((x) => x.stock > 0 && !String(x.group || '').startsWith('512'));
  if (home.length) {
    const val = (x) => (x.price || 0) * x.stock;
    const big = home.slice().sort((a, b) => val(b) - val(a));
    const total = home.reduce((s, x) => s + val(x), 0);
    out.push({
      id: 'clear-home', level: 2, go: 'clear-home',
      title: `Za rasprodaju u odjelu: ${home.length} ${home.length === 1 ? 'artikal' : 'artikala'}, ${Math.round(total)} KM`,
      text: 'Status 21/81 sa zalihom. Najveća vrijednost prvo: daj im najbolje mjesto (izlog, ulaz, kraj gondole).',
      items: big.slice(0, 5).map((x) => ({ num: x.num, name: x.name, sub: `${x.stock} kom · ${Math.round(val(x))} KM` })),
    });
  }

  if (g && g.nosale && g.nosale.length) {
    out.push({
      id: 'sm-nosale', level: 3, go: 'audit',
      title: `SM, a ništa prodano 30 dana: ${g.nosale.length}`,
      text: 'Provjeri da li je ekspozicija izvan planograma još tu; ako nije, SM treba ukloniti.',
      items: g.nosale.slice(0, 5).map((x) => ({ num: x.num, name: x.name, sub: `SM ${x.sm}, zaliha ${x.stock}` })),
    });
  }

  return out.sort((a, b) => a.level - b.level);
}

/** Which sources are missing or older than a day: those are read again by "Osvježi sve". */
export function stale(src, now = Date.now()) {
  const old = (s) => !s || !s.at || now - s.at > 24 * 3600000;
  return ['audit', 'top', 'home', 'furn'].filter((k) => old(src[k]));
}
