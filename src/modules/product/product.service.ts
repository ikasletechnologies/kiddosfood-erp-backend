import prisma from '../../lib/prisma';

export class ProductService {
  /**
   * Fetch all products
   */
  static async getAll(filters: any = {}) {
    return prisma.product.findMany({
      where: filters,
      include: { 
        recipe: {
          include: { recipeItems: true }
        }
      },
      orderBy: { name: 'asc' }
    });
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
