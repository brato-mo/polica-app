// The full check of a department's SM and DM values ("Master provjera"). Pure functions: StoreFront's numbers in,
// findings out. The first rule is the written guideline; the others are hints for the employee to look at. (SM above
// the shelf capacity and DM of 1-2 pieces were left out: in the real data they were mostly right, so only noise.)

export const GROUPS = [
  { id: 'out', title: 'Ukinuti (21/81) sa SM ili DM', why: 'Smjernica: kad artikal pređe na status 21, ukloni SM i DM. Ako ima zamjenu (novi broj), SM/DM se prebacuje na nju.', fix: true },
  { id: 'nosale', title: 'SM, a ništa prodano 30 dana', why: 'Ima SM, a ni jedan komad nije prodan za 30 dana. Provjeri da li je ekspozicija izvan planograma još tu; ako nije, SM treba ukloniti.' },
  { id: 'topnosm', title: 'Najprodavaniji bez SM, nisu u tvom planogramu', why: 'Smjernica: SM, DepSM i AR prate SM na najprodavanijim artiklima. Ako je artikal izložen izvan planograma (Powerline, endframe), treba mu SM.' },
];

const OUT = new Set(['21', '81']);

/**
 * list: articles with an SM or DM value ({ num, st, stock, sm, dm, cap, sold30, succ }); top: best sellers of the last
 * 30 days; inPlan(num): whether the article is in the employee's planograms.
 * Answer: { [group id]: [article] }, every article only once, in the first group that fits.
 */
export function check(list, top, inPlan = () => false) {
  const g = Object.fromEntries(GROUPS.map((x) => [x.id, []]));
  const seen = new Set();
  const put = (id, x) => { if (!seen.has(x.num)) { seen.add(x.num); g[id].push(x); } };
  for (const x of list || []) if (OUT.has(x.st) && (x.sm > 0 || x.dm > 0)) put('out', x);
  for (const x of list || []) if (!OUT.has(x.st) && x.sm > 0 && !(x.sold30 > 0)) put('nosale', x);
  const have = new Set((list || []).map((x) => x.num));
  for (const x of (top || []).slice(0, 30)) if (!have.has(x.num) && !(x.sm > 0) && !(x.dm > 0) && !OUT.has(x.st) && !inPlan(x.num)) put('topnosm', x);
  g.nosale.sort((a, b) => b.sm - a.sm);
  g.topnosm.sort((a, b) => b.sold30 - a.sold30);
  return g;
}

export const total = (g) => Object.values(g).reduce((n, l) => n + l.length, 0);
