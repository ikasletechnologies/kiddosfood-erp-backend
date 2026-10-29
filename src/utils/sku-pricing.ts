import { Prisma } from '@prisma/client';

export const SKU_PRICE_KEYS = ['customerPrice', 'dealerPrice', 'franchisePrice'] as const;
export type SkuPrices = Record<typeof SKU_PRICE_KEYS[number], number | null>;

export function configuredSkuPrices(source: Partial<Record<typeof SKU_PRICE_KEYS[number], unknown>>): SkuPrices {
  const price = (v: unknown) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
  return { customerPrice: price(source.customerPrice), dealerPrice: price(source.dealerPrice), franchisePrice: price(source.franchisePrice) };
}

export function hasCompleteSkuPrices(source: Partial<Record<typeof SKU_PRICE_KEYS[number], unknown>>): boolean {
  const prices = configuredSkuPrices(source);
  return SKU_PRICE_KEYS.every(key => prices[key] != null);
}

/** Existing HQ stock item is the price master. Never use a name, cost or legacy lot price. */
export async function resolveSkuPriceMaster(tx: { inventoryItem: { findFirst(args: { where: Prisma.InventoryItemWhereInput; orderBy: Prisma.InventoryItemOrderByWithRelationInput[]; select: { id: true; basePrice: true; customerPrice: true; dealerPrice: true; franchisePrice: true; upcountryFranchisePrice: true; mrp: true; whiteLabelCost: true; gstRate: true; unit: true } }): PromiseLike<{ id: string; basePrice: number | null; customerPrice: number | null; dealerPrice: number | null; franchisePrice: number | null; upcountryFranchisePrice: Prisma.Decimal | null; mrp: Prisma.Decimal | null; whiteLabelCost: Prisma.Decimal | null; gstRate: number; unit: string } | null> } }, sku: string) {
  return tx.inventoryItem.findFirst({
    where: { sku, category: 'FINISHED_GOOD', OR: [{ franchiseId: null }, { franchise: { isHQ: true } }] },
    orderBy: [{ franchiseId: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    select: { id: true, basePrice: true, customerPrice: true, dealerPrice: true, franchisePrice: true, upcountryFranchisePrice: true, mrp: true, whiteLabelCost: true, gstRate: true, unit: true },
  });
}
