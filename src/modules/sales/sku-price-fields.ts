import { Prisma } from '@prisma/client';
import { LotPricingError } from './lot-pricing.service';

export const PRICING_FIELDS = [
  { key: 'customerPrice', label: 'Customer', selling: true },
  { key: 'dealerPrice', label: 'Dealer', selling: true },
  { key: 'franchisePrice', label: 'Franchise', selling: true },
  { key: 'upcountryFranchisePrice', label: 'Upcountry Franchise', selling: true },
  { key: 'mrp', label: 'MRP (including GST)', selling: false },
  { key: 'whiteLabelCost', label: 'White Label Cost', selling: false },
] as const;
export type PricingField = typeof PRICING_FIELDS[number]['key'];
export type PricingValues = Record<PricingField, number | null>;
export type PricingInput = Partial<Record<PricingField, unknown>>;
export const readPricing = (source: PricingInput): PricingValues => Object.fromEntries(PRICING_FIELDS.map(({ key }) => {
  const n = Number(source[key]);
  return [key, Number.isFinite(n) && n > 0 ? n : null];
})) as PricingValues;

/** Money is rounded with Decimal; MRP is always inclusive, all other fields are stored exclusive. */
export function mergePricing(previous: PricingValues, input: PricingInput, taxInclusive: boolean, taxPercent: number) {
  const next = { ...previous };
  for (const { key, label } of PRICING_FIELDS) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) { next[key] = null; continue; }
    if ((typeof raw !== 'number' && typeof raw !== 'string') || !Number.isFinite(Number(raw))) throw new LotPricingError(label + ' must be a valid monetary amount.', 'INVALID_PRICE');
    const value = new Prisma.Decimal(raw);
    if (!value.gt(0) || value.gt(10000000) || value.decimalPlaces() > 2) throw new LotPricingError(label + ' must be above zero, at most 10,000,000, with at most 2 decimal places.', 'INVALID_PRICE');
    const stored = key !== 'mrp' && taxInclusive ? value.div(new Prisma.Decimal(1).plus(new Prisma.Decimal(taxPercent).div(100))).toDecimalPlaces(2) : value;
    if (!stored.gt(0)) throw new LotPricingError(label + ' is too small.', 'INVALID_PRICE');
    next[key] = stored.toNumber();
  }
  return next;
}

export function mrpWarnings(prices: PricingValues, taxPercent: number): string[] {
  if (prices.mrp == null || prices.customerPrice == null) return [];
  const inclusive = new Prisma.Decimal(prices.customerPrice).times(new Prisma.Decimal(1).plus(new Prisma.Decimal(taxPercent).div(100))).toDecimalPlaces(2);
  return inclusive.gt(prices.mrp) ? ['Warning: Customer price including GST exceeds MRP (' + prices.mrp.toFixed(2) + ' including GST).'] : [];
}
