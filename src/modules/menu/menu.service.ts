import prisma from '../../lib/prisma';

export class MenuService {
  static async getItems(category?: string, search?: string) {
    return prisma.product.findMany({
      where: {
        ...(category ? { category } : {}),
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {})
      },
      orderBy: { name: 'asc' }
    });
  }

  static async createItem(data: {
    name: string;
    category: string;
    basePrice: number;
    taxPercent?: number;
    description?: string;
    sku?: string;
  }) {
    return prisma.product.create({
      data: {
        name: data.name,
        category: data.category,
        basePrice: data.basePrice,
        taxPercent: data.taxPercent ?? 5,
        description: data.description,
        sku: data.sku || `SKU-${Date.now()}`,
        isActive: true
      }
    });
  }

  static async updateItem(
    id: string,
    data: {
      name?: string;
      category?: string;
      basePrice?: number;
      taxPercent?: number;
      description?: string;
      isActive?: boolean;
    }
  ) {
    return prisma.product.update({ where: { id }, data });
  }

  static async deleteItem(id: string) {
    return prisma.product.delete({ where: { id } });
  }

  static async getCategories() {
    const products = await prisma.product.findMany({
      select: { category: true },
      distinct: ['category']
    });
    return products.map((p) => p.category).filter(Boolean);
  }

  static async createCategory(name: string) {
    // Categories are derived from products; return the name as confirmation
    return { name };
  }
}
