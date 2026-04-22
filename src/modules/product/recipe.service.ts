import prisma from '../../lib/prisma';

export class RecipeService {
  static async create(data: {
    productId: string;
    name: string;
    yieldQty: number;
    instructions?: string;
    items: { inventoryItemId: string; quantityRequired: number; unit: string }[];
  }) {
    return prisma.recipe.create({
      data: {
        productId: data.productId,
        name: data.name,
        yieldQty: data.yieldQty,
        instructions: data.instructions,
        recipeItems: {
          create: data.items.map(i => ({
            inventoryItemId: i.inventoryItemId,
            quantityRequired: i.quantityRequired,
            unit: i.unit
          }))
        }
      },
      include: { recipeItems: { include: { inventoryItem: true } } }
    });
  }

  static async getAll() {
    return prisma.recipe.findMany({
      include: { product: true, recipeItems: { include: { inventoryItem: true } } }
    });
  }

  static async update(id: string, data: { name?: string; yieldQty?: number; instructions?: string }) {
    return prisma.recipe.update({ where: { id }, data });
  }

  static async delete(id: string) {
    return prisma.$transaction(async (tx) => {
      await tx.recipeItem.deleteMany({ where: { recipeId: id } });
      return tx.recipe.delete({ where: { id } });
    });
  }
}
