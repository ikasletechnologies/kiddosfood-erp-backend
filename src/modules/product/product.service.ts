import prisma from '../../lib/prisma';
import { ItemCategory, ProductType } from '@prisma/client';

// Keep the Product catalog and the HQ Finished-Goods inventory ledger in sync no matter
// which screen created the record (standalone Product form vs. Inventory Item Master).
// Mirrors the reverse sync in inventory.service.ts (InventoryItem -> Product).
async function syncInventoryItemForProduct(tx: any, product: { id: string; name: string; sku: string | null; basePrice: number; productType: ProductType }) {
  if (product.productType !== ProductType.FINISHED_GOOD) return;

  const hq = await tx.franchise.findFirst({
    where: {
      OR: [
        { id: 'hq-001' },
        { name: { contains: 'HQ', mode: 'insensitive' } },
        { name: { contains: 'Head', mode: 'insensitive' } },
      ],
    },
  });
  if (!hq) return; // No HQ configured yet — nothing to sync against.

  const existing = await tx.inventoryItem.findFirst({
    where: {
      OR: [
        ...(product.sku ? [{ sku: product.sku }] : []),
        { name: { equals: product.name, mode: 'insensitive' } },
      ],
    },
  });

  if (existing) {
    await tx.inventoryItem.update({
      where: { id: existing.id },
      data: {
        name: product.name,
        basePrice: product.basePrice || 0,
        customerPrice: product.basePrice || 0,
        franchiseId: existing.franchiseId || hq.id,
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
        franchiseId: hq.id,
        basePrice: product.basePrice || 0,
        customerPrice: product.basePrice || 0,
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

      console.log(`🔍 [ProductAPI] Sourcing stock from Franchise: ${franchiseId}`);
      const inventory = await prisma.inventoryItem.findMany({
        where: { 
          franchiseId,
          OR: [
            { sku: { in: skus } },
            { name: { in: names, mode: 'insensitive' } }
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
          conversions: inv.conversions
        };
      }).filter(Boolean) as any[];
    }

    return products;
  }

  /**
   * Create a new product
   */
  static async create(data: any) {
    const productType: ProductType = data.productType ?? ProductType.FINISHED_GOOD;
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
}
