import prisma from '../../lib/prisma';
import { ItemCategory, ProductType } from '@prisma/client';
import { FranchiseService } from '../franchise/franchise.service';

// Thrown when a Product.sku collides with an existing row — distinguished
// from other failures so callers (single create + bulk import) can report a
// clean "already exists" instead of letting the raw Prisma P2002 unique-
// constraint error surface as an opaque 500.
export class DuplicateProductError extends Error {
  sku: string;
  constructor(sku: string) {
    super(`A product with SKU "${sku}" already exists`);
    this.name = 'DuplicateProductError';
    this.sku = sku;
  }
}

// Mirrors src/lib/utils/erp.ts's generateSKU() on the frontend (used by the
// standalone Add Product screen) so a SKU for the same
// category/name/size comes out identical no matter which surface created
// it. Keep these two in sync if the prefix map or cleaning rules change.
const SKU_PREFIX_MAP: Record<string, string> = {
  RAW_MATERIAL: 'RM',
  RAW_GRAINS: 'RM-GR',
  RAW_OILS: 'RM-OL',
  RAW_SPICES: 'RM-SP',
  PACKAGING_POUCH: 'PK-PH',
  PACKAGING_LABEL: 'PK-LB',
  PACKAGING_CARTON: 'PK-CT',
  SEMI_FINISHED: 'SF',
  FINISHED_GOOD: 'FG',
  CONSUMABLE: 'CN',
  MAINTENANCE: 'MN',
};

export function generateSku(category: string, name: string, size?: string): string {
  const prefix = SKU_PREFIX_MAP[category] || 'MISC';
  const cleanName = name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const cleanSize = size ? size.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  return `${prefix}-${cleanName || 'ITEM'}${cleanSize ? '-' + cleanSize : ''}`;
}

// generateSku bakes the pack size (e.g. "500G", "1KG", "250ML") into the last
// SKU segment — there's no dedicated size/unit column on Product, so this is
// the only place that data survives. Every existing FINISHED_GOOD SKU in prod
// matches this shape (verified against all 217 rows), since AddProductClient
// and the bulk-import path both only ever append <number><KG|G|ML|L|PCS|PC>.
const SKU_SIZE_RE = /-(\d+(?:\.\d+)?)(KG|G|ML|L|PCS|PC)$/i;

export function parseSkuPackSize(sku: string | null | undefined): { qty: number; unit: string } | null {
  if (!sku) return null;
  const m = sku.match(SKU_SIZE_RE);
  if (!m) return null;
  return { qty: Number(m[1]), unit: m[2].toUpperCase() };
}

// Keep the Product catalog and the HQ Finished-Goods inventory ledger in sync no matter
// which screen created the record (standalone Product form vs. Inventory Item Master).
// Mirrors the reverse sync in inventory.service.ts (InventoryItem -> Product).
// GST is a single value per Finished Good: Product.taxPercent is authoritative
// and always pushed onto the linked InventoryItem.gstRate here, so the two
// screens that read either field never disagree on the tax rate.
async function syncInventoryItemForProduct(tx: any, product: { id: string; name: string; sku: string | null; basePrice: number; taxPercent: number; productType: ProductType }) {
  if (product.productType !== ProductType.FINISHED_GOOD) return;

  // franchiseId: null is the canonical "HQ-scoped" convention used
  // everywhere else (see InventoryService.createItem, and
  // FinishedGoodsStockClient's isHqFranchise, which treats both a real
  // isHQ-flagged franchise AND a null franchiseId as HQ). This must never
  // be the HQ Franchise row's own id — Franchise.isHQ identifies which
  // franchise IS headquarters; InventoryItem.franchiseId = null is the
  // separate, independent convention for "this stock belongs to HQ".
  // Conflating the two (writing hq.id here) is exactly what caused
  // HQ-owned InventoryItems to end up split between null and the literal
  // HQ id. Always null, regardless of whether an HQ franchise row exists.
  const hqFranchiseId = null;

  // Match by SKU alone when the product has one — falling back to name would
  // wrongly collapse two distinctly-SKU'd weight variants of the same name
  // (e.g. IDLI PODI 150G / 250G) onto a single InventoryItem, since they
  // share a name but must each keep their own stock record. Name-only
  // matching is only correct for the legacy case of a product with no SKU.
  const existing = await tx.inventoryItem.findFirst({
    where: product.sku
      ? { sku: product.sku }
      : { name: { equals: product.name, mode: 'insensitive' } },
  });

  if (existing) {
    await tx.inventoryItem.update({
      where: { id: existing.id },
      data: {
        name: product.name,
        basePrice: product.basePrice || 0,
        customerPrice: product.basePrice || 0,
        gstRate: product.taxPercent,
        franchiseId: existing.franchiseId ?? hqFranchiseId,
      },
    });
  } else {
    await tx.inventoryItem.create({
      data: {
        name: product.name,
        sku: product.sku || `FG-${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
        category: ItemCategory.FINISHED_GOOD,
        currentStock: 0,
        unit: 'PC',
        franchiseId: hqFranchiseId,
        basePrice: product.basePrice || 0,
        customerPrice: product.basePrice || 0,
        gstRate: product.taxPercent,
      },
    });
  }
}

export class ProductService {
  /**
   * Fetch all products
   */
  static async getAll(filters: any = {}, franchiseId?: string) {
    const products = await prisma.product.findMany({
      where: filters,
      include: { 
        recipe: {
          include: { recipeItems: true }
        }
      },
      orderBy: { name: 'asc' }
    });

    if (franchiseId) {
      const skus = products.map(p => p.sku).filter(Boolean) as string[];
      const names = products.map(p => p.name);

      // A null-franchiseId InventoryItem is the established "HQ-scoped"
      // convention used elsewhere (see InventoryService.createItem and
      // FinishedGoodsStockClient's isHqFranchise) — a strict `franchiseId`
      // equality match here never matches those rows at all, so an HQ item
      // with real stock silently vanished from POS. Only widen the match
      // to include null when this call is actually resolving HQ's own
      // stock (franchiseId IS the real HQ's id, via getHqFranchiseOrNull —
      // the one central resolver every HQ-dependent module must use, never
      // an independent "first active franchise" guess) — a genuine
      // branch's own POS must still see only what's been explicitly
      // dispatched to it, never HQ's central stock for free.
      const hq = await FranchiseService.getHqFranchiseOrNull();
      const resolvingHQStock = !hq || hq.id === franchiseId;
      const scopeFilter = resolvingHQStock
        ? { OR: [{ franchiseId }, { franchiseId: null }] }
        : { franchiseId };

      console.log(`🔍 [ProductAPI] Sourcing stock from Franchise: ${franchiseId}${resolvingHQStock ? ' (+ HQ-scoped/null items)' : ''}`);
      const inventory = await prisma.inventoryItem.findMany({
        where: {
          AND: [
            scopeFilter,
            { OR: [{ sku: { in: skus } }, { name: { in: names, mode: 'insensitive' } }] }
          ]
        },
        include: { baseUnit: true, conversions: { include: { unit: true } } }
      });
      console.log(`📦 [ProductAPI] Found ${inventory.length} matching inventory items for stock display`);
      
      return products.map(p => {
        const pName = p.name.trim().toLowerCase();
        // Match by SKU first, then fallback to Name (case-insensitive + trimmed)
        const inv = inventory.find(i => i.sku && p.sku && i.sku.trim() === p.sku.trim()) || 
                   inventory.find(i => i.name.trim().toLowerCase() === pName);
        
        if (!inv) return null;

        return {
          ...p,
          currentStock: inv.currentStock,
          inventoryFranchiseId: inv.franchiseId || (franchiseId || null),
          inventoryBasePrice: inv.basePrice,
          inventoryCostPrice: inv.costPrice,
          baseUnit: inv.baseUnit,
          conversions: inv.conversions,
          packSize: parseSkuPackSize(p.sku)
        };
      }).filter(Boolean) as any[];
    }

    return products.map(p => ({ ...p, packSize: parseSkuPackSize(p.sku) }));
  }

  /**
   * Create a new product
   */
  static async create(data: any) {
    const productType: ProductType = data.productType ?? ProductType.FINISHED_GOOD;

    // Pre-check rather than letting the DB's unique constraint on `sku`
    // surface as a raw Prisma P2002 — callers (single create + bulk import)
    // need a clean, catchable "already exists" instead of an opaque 500.
    if (data.sku) {
      const existing = await prisma.product.findUnique({ where: { sku: data.sku } });
      if (existing) throw new DuplicateProductError(data.sku);
    }

    return prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          name: data.name,
          sku: data.sku,
          description: data.description,
          basePrice: data.basePrice,
          category: data.category,
          taxPercent: data.taxPercent || 5,
          isActive: true,
          emoji: data.emoji,
          isVeg: data.isVeg ?? true,
          productType,
          shelfLifeDays: data.shelfLifeDays !== undefined && data.shelfLifeDays !== null && data.shelfLifeDays !== ''
            ? Number(data.shelfLifeDays)
            : null,
        },
        include: {
          recipe: true
        }
      });

      await syncInventoryItemForProduct(tx, product);
      return product;
    });
  }

  /**
   * Bulk-create Finished Good catalog entries (e.g. from an Excel import).
   * Each row becomes its own Product + synced HQ InventoryItem via the same
   * create() path above — no STOCK is ever created here (currentStock
   * stays 0; that only ever comes from PO -> GRN or an explicit opening/
   * adjustment), this only builds the master/catalog. sellingPrice sets
   * Product.basePrice — a separate concept from stock qty, and the only
   * thing POS actually reads for the price it shows; omit it and the
   * product is created at ₹0 (importable now, priced before going live).
   * A per-row failure (duplicate SKU or anything else) is collected and
   * reported, never aborts the rest of the batch.
   */
  static async bulkCreateFinishedGoods(rows: Array<{
    category?: string;
    name: string;
    size?: string;
    unit?: string;
    gstPercent?: number;
    sellingPrice?: number;
  }>) {
    const created: Array<{ id: string; name: string; sku: string | null }> = [];
    const duplicates: Array<{ name: string; sku: string; reason: string }> = [];
    const invalid: Array<{ name: string; reason: string }> = [];

    for (const row of rows) {
      const name = (row.name || '').trim();
      if (!name) {
        invalid.push({ name: row.name || '', reason: 'Missing name' });
        continue;
      }

      const sizeUnit = row.size ? `${row.size}${row.unit || ''}` : '';
      const sku = generateSku('FINISHED_GOOD', name, sizeUnit);
      const gstPercent = row.gstPercent !== undefined && row.gstPercent !== null && !isNaN(Number(row.gstPercent))
        ? Number(row.gstPercent)
        : 5;
      const sellingPrice = row.sellingPrice !== undefined && row.sellingPrice !== null && !isNaN(Number(row.sellingPrice))
        ? Number(row.sellingPrice)
        : 0;

      try {
        const product = await this.create({
          name,
          sku,
          basePrice: sellingPrice,
          category: row.category || null,
          taxPercent: gstPercent,
          productType: ProductType.FINISHED_GOOD,
          isVeg: true,
          is_menu_item: true,
        });
        created.push({ id: product.id, name: product.name, sku: product.sku });
      } catch (error: any) {
        if (error instanceof DuplicateProductError) {
          duplicates.push({ name, sku, reason: error.message });
        } else {
          invalid.push({ name, reason: error?.message || 'Unknown error' });
        }
      }
    }

    return { success: created.length, created, duplicates, invalid };
  }

  static async getById(id: string) {
    return prisma.product.findUnique({
      where: { id },
      include: {
        recipe: {
          include: { recipeItems: true }
        }
      }
    });
  }

  static async update(id: string, data: any) {
    const current = await prisma.product.findUniqueOrThrow({ where: { id } });
    const productType: ProductType = data.productType ?? current.productType;
    const basePrice = data.basePrice !== undefined ? Number(data.basePrice) : current.basePrice;

    // Same pre-check as create() — a SKU edit that collides with a
    // DIFFERENT product must surface as a clean, catchable error instead
    // of a raw Prisma P2002 unique-constraint 500.
    if (data.sku !== undefined && data.sku !== current.sku) {
      const existing = await prisma.product.findUnique({ where: { sku: data.sku } });
      if (existing && existing.id !== id) throw new DuplicateProductError(data.sku);
    }

    return prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.sku !== undefined && { sku: data.sku }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.basePrice !== undefined && { basePrice: data.basePrice }),
          ...(data.category !== undefined && { category: data.category }),
          ...(data.taxPercent !== undefined && { taxPercent: data.taxPercent }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
          ...(data.emoji !== undefined && { emoji: data.emoji }),
          ...(data.isVeg !== undefined && { isVeg: data.isVeg }),
          ...(data.productType !== undefined && { productType: data.productType }),
          ...(data.shelfLifeDays !== undefined && {
            shelfLifeDays: data.shelfLifeDays === null || data.shelfLifeDays === ''
              ? null
              : Number(data.shelfLifeDays),
          }),
        },
        include: { recipe: true }
      });

      await syncInventoryItemForProduct(tx, product);
      return product;
    });
  }

  static async delete(id: string) {
    return prisma.product.delete({ where: { id } });
  }

  static async linkExistingProduct(data: { inventoryItemId: string; productId: string }) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findUnique({ where: { id: data.inventoryItemId } });
      if (!item) throw new Error('Inventory item not found');

      const product = await tx.product.findUnique({ where: { id: data.productId } });
      if (!product) throw new Error('Product not found');

      if (product.sku && item.sku && product.sku.toUpperCase() !== item.sku.toUpperCase()) {
        throw new Error(`Cannot link these products because their SKUs are different.\nInventory SKU: ${item.sku}\nProduct SKU: ${product.sku}.\nCreate a Product using the existing inventory SKU (${item.sku}) instead, or select a Product with the same SKU.`);
      }

      await tx.inventoryItem.update({
        where: { id: item.id },
        data: {
          name: product.name,
          basePrice: product.basePrice || item.basePrice || 0,
          gstRate: product.taxPercent,
        },
      });

      if (item.sku.toUpperCase().startsWith('RCP-')) {
        const recipeCode = item.sku.split('-').slice(0, 2).join('-');
        const recipe = await tx.recipe.findFirst({
          where: { OR: [{ recipeCode }, { name: { equals: item.name, mode: 'insensitive' } }] },
        });
        if (recipe) {
          await tx.recipe.update({
            where: { id: recipe.id },
            data: { productId: product.id },
          });
        }
      }

      return { success: true, item, product };
    });
  }
}
