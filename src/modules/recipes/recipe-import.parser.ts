/**
 * Turns the paragraphs of a recipe document (e.g. MEASUREMENTS.docx) into
 * reviewable recipe drafts. Pure: no database access.
 *
 * Layout understood (as used in MEASUREMENTS.docx):
 *   BATTERS                                  ← section heading (category)
 *   • Idli/ Dosa Batter                      ← list item = recipe title
 *   Ingredients: Parboiled Rice- 500 G       ← "name - quantity unit"
 *   Alkaline Water- As Required              ← no quantity: flagged
 *   Tempering:                               ← sub-group label
 *   Output (After Griding)- 1545 G           ← output stage + quantity
 *   Output (After Fermentation)- 1534 G
 *   No Fermentation                          ← note
 *
 * Nothing is invented: a missing unit, a range ("90- 100 Ml"), "As
 * Required" or an unreadable line is kept as written and flagged for review.
 */
import type { DocxParagraph } from './docx-reader';

export type LineIssue =
  | 'AS_REQUIRED'     // "As Required": no quantity to scale
  | 'QTY_MISSING'     // ingredient with no quantity at all ("Jaggery")
  | 'UNIT_MISSING'    // number with no unit ("Curry Leaves- 1")
  | 'RANGE'           // "90- 100 Ml"
  | 'UNKNOWN_UNIT'    // unit we don't recognise
  | 'UNPARSED'        // couldn't read a quantity
  | 'REPEATED';       // same ingredient listed again in this recipe

export interface ParsedIngredient {
  /** Name exactly as written (whitespace tidied). */
  sourceName: string;
  /** The original line. */
  sourceText: string;
  /** Number as written, e.g. "37.5"; null when there is none. */
  qtyText: string | null;
  quantity: number | null;
  /** Normalised unit (G, KG, MG, ML, L, PCS) or null. */
  unit: string | null;
  /** Text after the quantity, e.g. "(steam for 5-6 mins)". */
  note: string | null;
  /** "Tempering", "Powder", … when listed under a sub-heading. */
  group: string | null;
  issues: LineIssue[];
}

export interface ParsedOutput {
  /** "After Grinding", "After Fermentation" or "Final Output". */
  stage: string;
  /** The stage as written ("After Griding"). */
  stageText: string;
  quantity: number | null;
  qtyText: string | null;
  unit: string | null;
  note: string | null;
  sourceText: string;
}

export type RecipeIssue = 'NO_OUTPUT' | 'OUTPUT_UNCERTAIN' | 'MULTIPLE_STAGES' | 'NO_INGREDIENTS';

export interface ParsedRecipe {
  key: string;
  index: number;
  title: string;
  category: string | null;
  ingredients: ParsedIngredient[];
  outputs: ParsedOutput[];
  notes: string[];
  issues: RecipeIssue[];
}

const UNIT_ALIASES: Record<string, string> = {
  g: 'G', gm: 'G', gms: 'G', gram: 'G', grams: 'G', gr: 'G',
  kg: 'KG', kgs: 'KG', kilo: 'KG', kilogram: 'KG', kilograms: 'KG',
  mg: 'MG',
  ml: 'ML', mls: 'ML',
  l: 'L', ltr: 'L', ltrs: 'L', litre: 'L', liter: 'L', litres: 'L', liters: 'L',
  pc: 'PCS', pcs: 'PCS', nos: 'PCS', no: 'PCS', piece: 'PCS', pieces: 'PCS',
};

export const normalizeUnitText = (u: string | null | undefined): string | null =>
  u ? UNIT_ALIASES[u.trim().toLowerCase().replace(/\.$/, '')] ?? null : null;

const tidy = (s: string) => s.replace(/[\t\u00a0]+/g, ' ').replace(/\s+/g, ' ').trim();
const NUM = '(\\d+(?:\\.\\d+)?|\\.\\d+)';

/** Splits "Parboiled Rice- 500 G" into name and quantity text at the first dash. */
function splitLine(line: string): { name: string; rest: string | null } {
  const m = line.match(/^(.*?\S)\s*[-–—:]\s*(.*)$/);
  if (!m) return { name: line, rest: null };
  return { name: m[1].trim(), rest: m[2].trim() };
}

/** Reads "500 G", "1.5 Kg", "As Required", "90- 100 Ml", "80 g(steam …)", "4". */
export function parseQuantity(rest: string | null): Pick<ParsedIngredient, 'qtyText' | 'quantity' | 'unit' | 'note' | 'issues'> {
  if (rest === null || rest.trim() === '') return { qtyText: null, quantity: null, unit: null, note: null, issues: ['QTY_MISSING'] };
  const text = rest.trim();
  if (/^as\s+required\b/i.test(text)) {
    return { qtyText: null, quantity: null, unit: null, note: tidy(text.replace(/^as\s+required/i, '')) || null, issues: ['AS_REQUIRED'] };
  }
  const range = text.match(new RegExp(`^${NUM}\\s*[-–]\\s*${NUM}\\s*([a-zA-Z]+)?\\.?\\s*(.*)$`));
  if (range) {
    return { qtyText: `${range[1]}-${range[2]}`, quantity: null, unit: normalizeUnitText(range[3]), note: tidy(range[4]) || null, issues: ['RANGE'] };
  }
  const m = text.match(new RegExp(`^${NUM}\\s*([a-zA-Z]+)?\\.?\\s*(.*)$`));
  if (!m) return { qtyText: null, quantity: null, unit: null, note: text, issues: ['UNPARSED'] };
  const unit = normalizeUnitText(m[2]);
  const issues: LineIssue[] = [];
  if (!m[2]) issues.push('UNIT_MISSING');
  else if (!unit) issues.push('UNKNOWN_UNIT');
  // An unknown "unit" may really be the start of a note; keep it in the note.
  const note = tidy(!m[2] || unit ? m[3] : `${m[2]} ${m[3]}`) || null;
  return { qtyText: m[1], quantity: Number(m[1]), unit, note, issues };
}

const OUTPUT_RE = /^output\b\s*(?:\(?\s*([^)\-–:]*?)\s*\)?)?\s*[-–:]\s*(.*)$/i;

function parseOutput(line: string): ParsedOutput | null {
  const m = line.match(OUTPUT_RE);
  if (!m) return null;
  const stageText = tidy(m[1] || '');
  const q = parseQuantity(m[2]);
  return {
    stage: normalizeStage(stageText),
    stageText,
    // Kept even when the unit is missing; OUTPUT_UNCERTAIN flags it for review.
    quantity: q.issues.some((i) => i !== 'UNIT_MISSING' && i !== 'UNKNOWN_UNIT') ? null : q.quantity,
    qtyText: q.qtyText,
    unit: q.unit,
    note: q.note,
    sourceText: line,
  };
}

/** "after griding" → "After Grinding"; "" → "Final Output". */
export function normalizeStage(text: string): string {
  const t = text.toLowerCase();
  if (!t) return 'Final Output';
  if (/ferment/.test(t)) return 'After Fermentation';
  if (/grind|grid/.test(t)) return 'After Grinding';
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A section heading: all capitals, no digits, no dash-quantity, short. */
function isSectionHeading(p: DocxParagraph, text: string): boolean {
  return !p.listItem && text.length <= 40 && /^[A-Z][A-Z &/-]*[A-Z]$/.test(text) && !/\d/.test(text) && !/^(INGREDIENTS|OUTPUT)\b/.test(text);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
export const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s/(-])([a-z])/g, (_, a, b) => a + b.toUpperCase());

export function parseRecipeDocument(paragraphs: DocxParagraph[]): ParsedRecipe[] {
  const recipes: ParsedRecipe[] = [];
  let section: string | null = null;
  let current: ParsedRecipe | null = null;
  let group: string | null = null;

  const finish = () => {
    if (!current) return;
    const r = current;
    if (r.ingredients.length === 0) r.issues.push('NO_INGREDIENTS');
    if (r.outputs.length === 0) r.issues.push('NO_OUTPUT');
    else if (r.outputs.some((o) => o.quantity === null || !o.unit)) r.issues.push('OUTPUT_UNCERTAIN');
    if (r.outputs.length > 1) r.issues.push('MULTIPLE_STAGES');
    // Flag an ingredient listed more than once (e.g. again under "Tempering:").
    const seen = new Map<string, number>();
    r.ingredients.forEach((ing) => {
      const k = ing.sourceName.toLowerCase().replace(/[^a-z0-9]/g, '');
      seen.set(k, (seen.get(k) || 0) + 1);
    });
    r.ingredients.forEach((ing) => {
      if ((seen.get(ing.sourceName.toLowerCase().replace(/[^a-z0-9]/g, '')) || 0) > 1) ing.issues.push('REPEATED');
    });
    recipes.push(r);
    current = null;
  };

  for (const p of paragraphs) {
    const text = tidy(p.text);
    if (!text) continue;

    if (isSectionHeading(p, text)) {
      finish();
      section = titleCase(text);
      continue;
    }
    // A list item with no quantity is a recipe title.
    if (p.listItem && !/[-–]\s*\d/.test(text) && !OUTPUT_RE.test(text)) {
      finish();
      const index = recipes.length;
      current = { key: `r${index + 1}-${slug(text)}`, index, title: text, category: section, ingredients: [], outputs: [], notes: [], issues: [] };
      group = null;
      continue;
    }
    if (!current) continue; // text before the first recipe (document title etc.)
    const r: ParsedRecipe = current;

    const output = parseOutput(text);
    if (output) { r.outputs.push(output); continue; }

    const body = text.replace(/^ingredients\s*:\s*/i, '').trim();
    if (!body) continue;
    const groupLabel = body.match(/^([A-Za-z][A-Za-z ]{1,30}):$/);
    if (groupLabel) { group = titleCase(groupLabel[1]); continue; }

    const { name, rest } = splitLine(body);
    const hasDigits = /\d/.test(body);
    // After the output, or plain text with no quantity once outputs exist, is a note.
    if (r.outputs.length > 0 || (!hasDigits && rest === null && /\b(no|not|with|without|steam|soak|ferment)\b/i.test(body))) {
      r.notes.push(body);
      continue;
    }
    const q = parseQuantity(rest);
    r.ingredients.push({ sourceName: tidy(name), sourceText: text, group, ...q });
  }
  finish();
  return recipes;
}
