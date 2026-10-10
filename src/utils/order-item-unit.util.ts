import prisma from '../lib/prisma';
import { FranchiseService } from '../modules/franchise/franchise.service';

// "NONE" is OrderItem.unit's schema default, and InventoryService.
// convertUnitToBase treats it as "the inventory item's own unit" (1:1). So a
// line saved as NONE was sold — and its stock deducted — in the unit of the
// InventoryItem that sale resolved (same SKU, then name, lookup as POS
// checkout, scoped to the selling franchise's inventory). That unit is the
// line's real historical UOM; nothing is guessed and no record is changed.
export const isRealUnit = (unit?: string | null): unit is string =>
  !!unit && unit.trim() !== '' && unit.trim().toUpperCase() !== 'NONE';

/**
 * Returns a resolver for display units of sold lines, caching lookups across
 * calls. Resolves to the line's own unit when one was recorded, else the unit
 * of the inventory item the sale deducted from, else null (unknown — callers
 * must not substitute a made-up unit).
 */
export function createOrderItemUnitResolver(tx: any = prisma) {
  const scopeCache = new Map<string, string | null>();
  const unitCache = new Map<string, string | null>();

  return async (
    line: { unit?: string | null; product?: { sku?: string | null; name?: string | null } | null },
    sellingFranchiseId?: string | null
  ): Promise<string | null> => {
    if (isRealUnit(line.unit)) return line.unit.trim();
    const sku = line.product?.sku?.trim() || null;
    const name = line.product?.name?.trim() || null;
    if (!sku && !name) return null;

    let scopeId: string | null = null;
    if (sellingFranchiseId) {
      if (!scopeCache.has(sellingFranchiseId)) {
        scopeCache.set(sellingFranchiseId, await FranchiseService.toInventoryScopeId(tx, sellingFranchiseId));
      }
      scopeId = scopeCache.get(sellingFranchiseId) ?? null;
    }

    const key = `${scopeId ?? 'HQ'}|${sku ?? ''}|${name ?? ''}`;
    if (!unitCache.has(key)) {
      const inv = sku
        ? await tx.inventoryItem.findFirst({ where: { sku, franchiseId: scopeId }, select: { unit: true } })
        : await tx.inventoryItem.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, franchiseId: scopeId }, select: { unit: true } });
      unitCache.set(key, isRealUnit(inv?.unit) ? inv!.unit.trim() : null);
    }
    return unitCache.get(key) ?? null;
  };
}
