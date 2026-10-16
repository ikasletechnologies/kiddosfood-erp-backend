/**
 * Suggests Raw Material, Finished Goods and existing-recipe matches for
 * imported recipe text. Pure: works on lists passed in.
 *
 * Confidence, strongest first:
 *   EXACT   – same name once punctuation/case/spacing are ignored
 *   LEARNED – a reviewer mapped this exact source name before
 *   ALIAS   – a known spelling/translation of the same ingredient
 *             (Asfatedita = Hing, Methi = Fenugreek, Poondu = Garlic …)
 *   FUZZY   – a typo-level difference on a long name ("whitw sesame seeds")
 * Anything else is UNMATCHED, with candidates for the reviewer to pick from.
 * Names that are merely similar ("red chilli" vs "red chilli powder") are
 * never matched automatically. Every suggestion is confirmed in review.
 */

export type MatchConfidence = 'EXACT' | 'LEARNED' | 'ALIAS' | 'FUZZY' | 'UNMATCHED' | 'AMBIGUOUS';

export interface MaterialRef { id: string; name: string; unit: string; sku?: string | null; category?: string }
export interface ProductRef { id: string; name: string; sku: string | null; category: string | null; basePrice?: number | null; linkedRecipeId?: string | null }

export interface MaterialMatch {
  confidence: MatchConfidence;
  inventoryItemId: string | null;
  candidates: Array<{ id: string; name: string; unit: string; reason: string }>;
}

/** Groups of names for the same ingredient. Spelling and Tamil/English pairs only. */
export const BUILT_IN_ALIASES: string[][] = [
  ['asafoetida', 'asafetida', 'asfatedita', 'hing'],
  ['fenugreek', 'fenugreek seeds', 'methi', 'vendayam'],
  ['garlic', 'poondu'],
  ['dried garlic', 'd garlic', 'dry garlic'],
  ['dried curry leaves', 'd curry leaves', 'dry curry leaves'],
  ['horse gram', 'horsegram', 'kollu'],
  ['green gram', 'pachapayaru', 'pachaipayaru', 'whole moong'],
  ['fennel seeds', 'fennel', 'sombu', 'saunf'],
  ['aval', 'poha', 'beaten rice'],
  ['javvarisi', 'sago', 'javvarisi sago'],
  ['thenai', 'thinai', 'foxtail millet'],
  ['cardamom', 'cardamon', 'elaichi'],
  ['groundnut', 'ground nut', 'grount nut', 'peanut'],
  ['cumin', 'cumin seeds', 'cumiin seeds', 'jeera', 'seeragam'],
  ['red chilli', 'red chilly', 'dry red chilli', 'dried red chilli'],
  ['green chilli', 'green chilly'],
  ['kashmiri red chilli', 'kasmiri red chilli'],
  ['murungai keerai', 'murunga leaves', 'drumstick leaves'],
  ['dried murungai leaves', 'dried murunga leaves', 'dried drumstick leaves'],
  ['coriander seeds', 'corinder seeds', 'dhania'],
  ['coriander leaves', 'coriander leaf'],
  ['mint leaves', 'mint leaf'],
  ['curry leaves', 'curry leaf'],
  ['black urad dal', 'black urad'],
  ['thoor dal', 'toor dal', 'tur dal', 'thuvaram paruppu'],
  ['kuthiraivali', 'barnyard millet'],
  ['varagu', 'kodo millet'],
  ['samai', 'little millet'],
  ['kambu', 'pearl millet', 'bajra'],
  ['ragi', 'finger millet'],
  ['white sesame seeds', 'white sesame'],
  ['black sesame seeds', 'black sesame'],
];

/** Lower-case, punctuation-free, single-spaced; "D." → "dried". */
export function normalizeName(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/\bd\s*\.\s*/g, 'dried ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** alias text → group id, for built-in plus learned (text → canonical text) aliases. */
function aliasIndex(extra: string[][] = []): Map<string, number> {
  const index = new Map<string, number>();
  [...BUILT_IN_ALIASES, ...extra].forEach((group, gi) => group.forEach((n) => index.set(normalizeName(n), gi)));
  return index;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/** "bay leaves" → "bay leaf", "cloves" → "clove"; leaves "seeds"-style compounds comparable. */
const singular = (n: string) => n.split(' ').map((t) => {
  if (t === 'leaves') return 'leaf';
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}).join(' ');

const tokens = (s: string) => new Set(normalizeName(s).split(' ').filter((t) => t.length > 1));
function tokenScore(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  ta.forEach((t) => { if (tb.has(t)) shared++; });
  return shared / Math.max(ta.size, tb.size);
}

/** Typo-level: ≤1 edit on names of 6+ letters, ≤2 on 10+. Never on short names. */
const isTypo = (a: string, b: string) => {
  const len = Math.min(a.length, b.length);
  const d = levenshtein(a, b);
  return d > 0 && ((len >= 6 && d <= 1) || (len >= 10 && d <= 2));
};

/**
 * @param learned source name (normalised) → inventoryItemId, from earlier reviews.
 */
export function matchMaterial(sourceName: string, materials: MaterialRef[], learned: Record<string, string> = {}): MaterialMatch {
  const n = normalizeName(sourceName);
  const aliases = aliasIndex();
  const candidates = new Map<string, { id: string; name: string; unit: string; reason: string }>();
  const add = (m: MaterialRef, reason: string) => { if (!candidates.has(m.id)) candidates.set(m.id, { id: m.id, name: m.name, unit: m.unit, reason }); };
  const result = (confidence: MatchConfidence, id: string | null): MaterialMatch => ({ confidence, inventoryItemId: id, candidates: [...candidates.values()].slice(0, 8) });

  const exact = materials.filter((m) => normalizeName(m.name) === n);
  exact.forEach((m) => add(m, 'Same name'));
  if (exact.length === 1) return result('EXACT', exact[0].id);
  if (exact.length > 1) return result('AMBIGUOUS', null);

  const learnedId = learned[n];
  const learnedMat = learnedId ? materials.find((m) => m.id === learnedId) : undefined;
  if (learnedMat) { add(learnedMat, 'Mapped in an earlier review'); return result('LEARNED', learnedMat.id); }

  const group = aliases.get(n);
  if (group !== undefined) {
    const viaAlias = materials.filter((m) => aliases.get(normalizeName(m.name)) === group);
    viaAlias.forEach((m) => add(m, 'Known alias'));
    if (viaAlias.length === 1) return result('ALIAS', viaAlias[0].id);
    if (viaAlias.length > 1) return result('AMBIGUOUS', null);
  }

  // Same words in singular/plural ("Bay Leaf" = "bay leaves", "Cloves" = "clove"),
  // or a rice variety written with "rice" ("Manisamba rice" = "manisamba").
  for (const [variant, reason] of [[singular(n), 'Singular/plural'], [n.replace(/ rice$/, ''), 'Rice variety name']] as const) {
    if (variant === n && reason !== 'Singular/plural') continue;
    const same = materials.filter((m) => (reason === 'Singular/plural' ? singular(normalizeName(m.name)) : normalizeName(m.name)) === variant);
    same.forEach((m) => add(m, reason));
    if (same.length === 1) return result('ALIAS', same[0].id);
    if (same.length > 1) return result('AMBIGUOUS', null);
  }

  const typos = materials.filter((m) => isTypo(n, normalizeName(m.name)));
  typos.forEach((m) => add(m, 'Spelling differs slightly'));

  // Candidates only (never selected): shared words, e.g. "Parboiled Rice" → "Idli rice", "rice".
  materials
    .map((m) => ({ m, s: tokenScore(sourceName, m.name) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.m.name.localeCompare(b.m.name))
    .slice(0, 6)
    .forEach((x) => add(x.m, 'Similar words'));

  if (typos.length === 1) return result('FUZZY', typos[0].id);
  return result(typos.length > 1 ? 'AMBIGUOUS' : 'UNMATCHED', null);
}

// Words that describe the product form rather than which product it is.
const PRODUCT_STOPWORDS = new Set(['dosa', 'batter', 'ready', 'mix', 'premix', 'pre']);
const core = (s: string) => {
  const aliases = aliasIndex();
  return normalizeName(s.replace(/\(.*?\)/g, ' '))
    .split(' ')
    .filter((t) => t && !PRODUCT_STOPWORDS.has(t))
    .map((t) => { const g = aliases.get(t); return g === undefined ? t : `#${g}`; })
    .join(' ');
};

/** Product category families a document section corresponds to. */
const SECTION_FAMILY: Array<[RegExp, RegExp]> = [
  [/batter/i, /batter/i],
  [/spice blend|podi/i, /spice blend/i],
  [/spice powder/i, /spice powder/i],
  [/ready.?mix|pre.?mix/i, /pre.?mix|ready.?mix|health mix/i],
  [/tea/i, /tea|chai/i],
];
const familyOk = (section: string | null, productCategory: string | null) => {
  if (!section || !productCategory) return true;
  const fam = SECTION_FAMILY.find(([s]) => s.test(section));
  return !fam || fam[1].test(productCategory);
};

export interface ProductSuggestion { id: string; name: string; sku: string | null; category: string | null; basePrice: number | null; reason: string; linkedRecipeId: string | null }

/**
 * Finished goods for a recipe: every variant (pack size) of the product
 * whose name equals the recipe name, or whose name equals it without form
 * words ("Carrot dosa" → CARROT in a batter category). Suggestions only.
 */
export function suggestProducts(title: string, section: string | null, products: ProductRef[]): ProductSuggestion[] {
  const full = normalizeName(title.replace(/\(.*?\)/g, ' '));
  const c = core(title);
  const out: ProductSuggestion[] = [];
  for (const p of products) {
    const pn = normalizeName(p.name.replace(/\(.*?\)/g, ' '));
    let reason: string | null = null;
    if (pn === full) reason = 'Same name';
    else if (c && core(p.name) === c && familyOk(section, p.category)) reason = 'Same product name';
    if (reason) out.push({ id: p.id, name: p.name, sku: p.sku, category: p.category, basePrice: p.basePrice ?? null, reason, linkedRecipeId: p.linkedRecipeId ?? null });
  }
  return out.sort((a, b) => (a.sku || '').localeCompare(b.sku || ''));
}

/** Existing recipes with the same name (punctuation/case ignored). */
export function matchRecipe<T extends { id: string; name: string }>(title: string, recipes: T[]): T[] {
  const n = normalizeName(title);
  return recipes.filter((r) => normalizeName(r.name) === n);
}
