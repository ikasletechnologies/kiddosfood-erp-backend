import prisma from '../../lib/prisma';

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
        
        return {
          ...p,
          currentStock: inv ? inv.currentStock : 0,
          inventoryFranchiseId: inv ? inv.franchiseId : (franchiseId || null),
          inventoryBasePrice: inv ? inv.basePrice : null,
          inventoryCostPrice: inv ? inv.costPrice : null,
          baseUnit: inv ? inv.baseUnit : null,
          conversions: inv ? inv.conversions : []
        };
      });
    }

    return products;
  }

  /**
   * Create a new product
   */
  static async create(data: any) {
    return prisma.product.create({
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
      },
      include: {
        recipe: true
      }
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
    return prisma.product.update({
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
      },
      include: { recipe: true }
    });
  }

  static async delete(id: string) {
    return prisma.product.delete({ where: { id } });
  }
}
