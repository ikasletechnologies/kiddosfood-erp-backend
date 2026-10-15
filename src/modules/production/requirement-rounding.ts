import { convertUnit, toCanonical } from '../../lib/conversion';

/**
 * Production Planning quantity-rounding policy.
 *
 * A scaled ingredient requirement that is a weight below 1 KG is rounded UP
 * to the next whole gram (88.77 g → 89 g); from 1 KG it is used as
 * calculated. Planned starts apply this one rule to the requirement shown,
 * the stock check, the lot allocation check, the stock deduction and the
 * material cost, so what the screen shows is exactly what is consumed.
 *
 * Only the scaled requirement of a run is rounded: saved formulations,
 * imported reference measurements and their ratios are never touched.
 * Volumes and count units are left as calculated.
 */
export const REQUIREMENT_ROUNDING_POLICY = 'WEIGHT_BELOW_1KG_UP_TO_WHOLE_GRAM';

const GRAMS_PER_KG = 1000;

/** `qty` (in `unit`) with the policy applied, still in `unit`. */
export function roundRequirement(qty: number, unit: string): number {
  if (!Number.isFinite(qty) || qty <= 0) return qty;
  const canonical = toCanonical(qty, unit);
  if (canonical.unit !== 'g') return qty;
  // Strip float noise first so 0.025 KG (25.000000000000004 g) stays 25 g.
  const grams = Number(canonical.value.toFixed(6));
  if (grams >= GRAMS_PER_KG) return qty;
  const whole = Math.ceil(grams);
  return Number(convertUnit(whole, 'g', unit).toPrecision(12));
}
