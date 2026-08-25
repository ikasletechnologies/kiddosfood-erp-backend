// Centralized unit normalization for mass/volume quantities. RecipeItem.unit
// (e.g. "g") and InventoryItem.unit (e.g. "KG") are independent free-text
// fields — nothing keeps them in the same scale, so any code that compares or
// combines a recipe quantity with a stock quantity must convert through here
// first instead of comparing the raw numbers.

const MASS_TO_GRAMS: Record<string, number> = {
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kgs: 1000,
  kilogram: 1000,
  kilograms: 1000,
};

const VOLUME_TO_ML: Record<string, number> = {
  ml: 1,
  milliliter: 1,
  milliliters: 1,
  l: 1000,
  ltr: 1000,
  litre: 1000,
  litres: 1000,
  liter: 1000,
  liters: 1000,
};

function key(unit?: string | null): string {
  return (unit || '').trim().toLowerCase();
}

/**
 * Converts `quantity` from `fromUnit` to the equivalent amount in `toUnit`.
 * Only mass<->mass (g/kg) and volume<->volume (ml/l) pairs are actually
 * converted — canonicalizing through grams / milliliters respectively.
 * Anything else (identical units, or a unit pair we don't have a physical
 * conversion for — "pcs", "packet", cross-dimension pairs like kg vs l)
 * returns `quantity` unchanged, since there is nothing safe to convert and
 * silently guessing would produce a wrong-but-plausible number.
 */
export function convertUnit(quantity: number, fromUnit?: string | null, toUnit?: string | null): number {
  const from = key(fromUnit);
  const to = key(toUnit);
  if (from === to) return quantity;

  if (from in MASS_TO_GRAMS && to in MASS_TO_GRAMS) {
    return (quantity * MASS_TO_GRAMS[from]) / MASS_TO_GRAMS[to];
  }
  if (from in VOLUME_TO_ML && to in VOLUME_TO_ML) {
    return (quantity * VOLUME_TO_ML[from]) / VOLUME_TO_ML[to];
  }

  return quantity;
}

/** True when both units are recognized and belong to the same convertible dimension (mass or volume), or are the same unit. */
export function areUnitsConvertible(unitA?: string | null, unitB?: string | null): boolean {
  const a = key(unitA);
  const b = key(unitB);
  if (a === b) return true;
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
