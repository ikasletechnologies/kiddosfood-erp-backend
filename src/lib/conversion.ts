// Centralized unit normalization for mass/volume quantities. RecipeItem.unit
// (e.g. "g") and InventoryItem.unit (e.g. "KG") are independent free-text
// fields — nothing keeps them in the same scale, so any code that compares or
// combines a recipe quantity with a stock quantity must convert through here
// first instead of comparing the raw numbers.

const MASS_TO_GRAMS: Record<string, number> = {
  g: 1,
  gm: 1,
  gms: 1,
  grm: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kgs: 1000,
  kilogram: 1000,
  kilograms: 1000,
  mg: 0.001,
  mgs: 0.001,
  milligram: 0.001,
  milligrams: 0.001,
};

const VOLUME_TO_ML: Record<string, number> = {
  ml: 1,
  mls: 1,
  milliliter: 1,
  milliliters: 1,
  millilitre: 1,
  millilitres: 1,
  l: 1000,
  ltr: 1000,
  ltrs: 1000,
  litre: 1000,
  litres: 1000,
  liter: 1000,
  liters: 1000,
};

const UNIT_SYNONYMS: Record<string, string> = {
  // Pieces / Count
  pc: 'PCS',
  pcs: 'PCS',
  piece: 'PCS',
  pieces: 'PCS',
  nos: 'PCS',
  no: 'PCS',
  number: 'PCS',
  numbers: 'PCS',
  unit: 'PCS',
  units: 'PCS',
  unt: 'PCS',

  // Packets / Packs
  pkt: 'PACKET',
  pkts: 'PACKET',
  pack: 'PACKET',
  packs: 'PACKET',
  packet: 'PACKET',
  packets: 'PACKET',

  // Boxes
  box: 'BOX',
  boxes: 'BOX',

  // Bags
  bag: 'BAG',
  bags: 'BAG',

  // Bottles
  btl: 'BOTTLE',
  btls: 'BOTTLE',
  bottle: 'BOTTLE',
  bottles: 'BOTTLE',

  // Bundles
  bdl: 'BDL',
  bundle: 'BDL',
  bundles: 'BDL',

  // Mass
  kg: 'KG',
  kgs: 'KG',
  kilogram: 'KG',
  kilograms: 'KG',

  g: 'G',
  gm: 'G',
  gms: 'G',
  grm: 'G',
  gram: 'G',
  grams: 'G',

  mg: 'MG',
  mgs: 'MG',
  milligram: 'MG',
  milligrams: 'MG',

  // Volume
  l: 'L',
  ltr: 'L',
  ltrs: 'L',
  liter: 'L',
  liters: 'L',
  litre: 'L',
  litres: 'L',

  ml: 'ML',
  mls: 'ML',
  milliliter: 'ML',
  milliliters: 'ML',
  millilitre: 'ML',
  millilitres: 'ML',

  // Other standard ERP units
  mtr: 'MTR',
  meter: 'MTR',
  meters: 'MTR',
  metre: 'MTR',
  metres: 'MTR',

  cms: 'CMS',
  centimeter: 'CMS',
  centimeters: 'CMS',

  dzn: 'DZN',
  dozen: 'DZN',
  dozens: 'DZN',

  ct: 'CT',
  carat: 'CT',
  carats: 'CT',

  roll: 'ROLL',
  rolls: 'ROLL',

  sqf: 'SQF',
  sqft: 'SQF',
  'square feet': 'SQF',

  tne: 'TNE',
  ton: 'TNE',
  tons: 'TNE',
};

function key(unit?: string | null): string {
  return (unit || '').trim().toLowerCase();
}

/**
 * Normalizes any recognized unit string or synonym into its standard canonical code (e.g. PC/PCS -> PCS, kgs -> KG, grm -> G, packet -> PACKET).
 */
export function normalizeUnit(unit?: string | null): string {
  const k = key(unit);
  if (!k || k === 'none') return '';
  return UNIT_SYNONYMS[k] || k.toUpperCase();
}

/**
 * Returns true if both units represent the exact same unit of measurement (e.g. PC and PCS, kgs and KG, g and grm, packet and pkt).
 */
export function areUnitsEquivalent(unitA?: string | null, unitB?: string | null): boolean {
  const a = key(unitA);
  const b = key(unitB);
  if (a === b) return true;
  const normA = normalizeUnit(unitA);
  const normB = normalizeUnit(unitB);
  if (!normA && !normB) return true;
  return normA === normB;
}

/**
 * Converts `quantity` from `fromUnit` to the equivalent amount in `toUnit`.
 * Only mass<->mass (g/kg/mg) and volume<->volume (ml/l) pairs are actually
 * converted — canonicalizing through grams / milliliters respectively.
 * Equivalent units (e.g. "PC" vs "PCS", "KG" vs "KGS") return `quantity` unchanged (1:1).
 * Anything else (unrecognized or cross-dimension pairs like kg vs l)
 * returns `quantity` unchanged, since there is nothing safe to convert.
 */
export function convertUnit(quantity: number, fromUnit?: string | null, toUnit?: string | null): number {
  if (areUnitsEquivalent(fromUnit, toUnit)) return quantity;

  const from = key(fromUnit);
  const to = key(toUnit);

  if (from in MASS_TO_GRAMS && to in MASS_TO_GRAMS) {
    return (quantity * MASS_TO_GRAMS[from]) / MASS_TO_GRAMS[to];
  }
  if (from in VOLUME_TO_ML && to in VOLUME_TO_ML) {
    return (quantity * VOLUME_TO_ML[from]) / VOLUME_TO_ML[to];
  }

  return quantity;
}

/** True when both units are recognized and belong to the same convertible dimension (mass or volume), or are equivalent units. */
export function areUnitsConvertible(unitA?: string | null, unitB?: string | null): boolean {
  if (areUnitsEquivalent(unitA, unitB)) return true;
  const a = key(unitA);
  const b = key(unitB);
  return (a in MASS_TO_GRAMS && b in MASS_TO_GRAMS) || (a in VOLUME_TO_ML && b in VOLUME_TO_ML);
}

/** Canonical base unit + normalized value — grams for any recognized mass unit, ml for any recognized volume unit, unchanged otherwise. */
export function toCanonical(quantity: number, unit?: string | null): { value: number; unit: string } {
  const u = key(unit);
  if (u in MASS_TO_GRAMS) return { value: quantity * MASS_TO_GRAMS[u], unit: 'g' };
  if (u in VOLUME_TO_ML) return { value: quantity * VOLUME_TO_ML[u], unit: 'ml' };
  return { value: quantity, unit: unit || '' };
}

export const formatQuantity = (quantity: number, unit: string): string => {
  const u = key(unit);
  if (u === 'kg' && quantity < 1) return `${(quantity * 1000).toFixed(0)}g`;
  if (u === 'l' && quantity < 1) return `${(quantity * 1000).toFixed(0)}ml`;
  return `${quantity.toFixed(2)}${unit}`;
};
