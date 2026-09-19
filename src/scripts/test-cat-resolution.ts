import prisma from '../lib/prisma';

function isTechnicalCategory(cat?: string | null): boolean {
  if (!cat) return true;
  const clean = cat.trim().toUpperCase().replace(/[\s_-]+/g, '');
  return (
    clean === 'FINISHEDGOOD' ||
    clean === 'FINISHEDGOODS' ||
    clean === 'RAWMATERIAL' ||
    clean === 'RAWMATERIALS' ||
    clean === 'SEMIFINISHED' ||
    clean === 'SEMIFINISHEDGOOD' ||
    clean === 'SEMIFINISHEDGOODS' ||
    clean === 'PACKAGING' ||
    clean === 'CONSUMABLE' ||
    clean === 'MAINTENANCE' ||
    clean === 'UNCATEGORIZED'
  );
}

function finalSaleWhere(extra: Record<string, any> = {}) {
  return {
    ...extra,
    OR: [
      { orderType: 'TAX_INVOICE', status: { not: 'CANCELLED' as any } },
      { orderType: { not: 'TAX_INVOICE' }, status: { in: ['COMPLETED', 'REFUNDED'] as any } }
    ]
  };
}

function formatCategoryName(name: string): string {
  if (!name || name === 'Uncategorized') return 'Uncategorized';
  return name
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

async function testResolution() {
  // Pre-load catalog mappings
  const [allProducts, allRecipes] = await Promise.all([
    prisma.product.findMany({
      select: { id: true, sku: true, name: true, category: true }
    }),
    prisma.recipe.findMany({
      select: {
        id: true,
        name: true,
        category: true,
        productId: true,
        product: { select: { category: true, name: true } },
        recipeItems: {
          select: { inventoryItemId: true }
        }
      }
    })
  ]);

  const skuToCategory = new Map<string, string>();
  const nameToCategory = new Map<string, string>();
  const prodIdToCategory = new Map<string, string>();

  for (const p of allProducts) {
    if (p.category && !isTechnicalCategory(p.category)) {
      const cleanCat = formatCategoryName(p.category);
      if (p.sku) skuToCategory.set(p.sku.trim().toUpperCase(), cleanCat);
      if (p.name) nameToCategory.set(p.name.trim().toUpperCase(), cleanCat);
      prodIdToCategory.set(p.id, cleanCat);
    }
  }

  // Also map Recipe categories for raw materials and products
  const invIdToCategory = new Map<string, string>();
  const recipeNameToCategory = new Map<string, string>();
  for (const r of allRecipes) {
    const rawRecipeCat = r.product?.category || r.category;
    if (rawRecipeCat && !isTechnicalCategory(rawRecipeCat)) {
      const cleanCat = formatCategoryName(rawRecipeCat);
      if (r.name) recipeNameToCategory.set(r.name.trim().toUpperCase(), cleanCat);
      for (const item of r.recipeItems) {
        if (item.inventoryItemId && !invIdToCategory.has(item.inventoryItemId)) {
          invIdToCategory.set(item.inventoryItemId, cleanCat);
        }
      }
      if (r.productId && !prodIdToCategory.has(r.productId)) {
        prodIdToCategory.set(r.productId, cleanCat);
      }
    }
  }

  // Resolve helper
  const resolveProductCategory = (prod?: { id?: string; sku?: string | null; name?: string | null; category?: string | null } | null): string => {
    if (!prod) return 'Uncategorized';
    if (prod.category && !isTechnicalCategory(prod.category)) {
      return formatCategoryName(prod.category);
    }
    if (prod.sku && skuToCategory.has(prod.sku.trim().toUpperCase())) {
      return skuToCategory.get(prod.sku.trim().toUpperCase())!;
    }
    if (prod.name && nameToCategory.has(prod.name.trim().toUpperCase())) {
      return nameToCategory.get(prod.name.trim().toUpperCase())!;
    }
    if (prod.id && prodIdToCategory.has(prod.id)) {
      return prodIdToCategory.get(prod.id)!;
    }
    // Check if base name matches (e.g. "APPAM 450G..." -> "APPAM")
    if (prod.name) {
      const cleanUpper = prod.name.trim().toUpperCase();
      for (const [knownName, cat] of nameToCategory.entries()) {
        if (cleanUpper.startsWith(knownName) || knownName.startsWith(cleanUpper)) {
          return cat;
        }
      }
      for (const [recipeName, cat] of recipeNameToCategory.entries()) {
        if (cleanUpper.startsWith(recipeName) || recipeName.startsWith(cleanUpper)) {
          return cat;
        }
      }
    }
    return 'Uncategorized';
  };

  const resolveInventoryItemCategory = (inv?: { id?: string; sku?: string | null; name?: string | null; category?: string | null } | null): string => {
    if (!inv) return 'Uncategorized';
    // 1. Check if direct inventory item ID was mapped via recipe
    if (inv.id && invIdToCategory.has(inv.id)) {
      return invIdToCategory.get(inv.id)!;
    }
    // 2. Check if sku or name matches a Product with category
    if (inv.sku && skuToCategory.has(inv.sku.trim().toUpperCase())) {
      return skuToCategory.get(inv.sku.trim().toUpperCase())!;
    }
    if (inv.name && nameToCategory.has(inv.name.trim().toUpperCase())) {
      return nameToCategory.get(inv.name.trim().toUpperCase())!;
    }
    // 3. Check base name match
    if (inv.name) {
      const cleanUpper = inv.name.trim().toUpperCase();
      for (const [knownName, cat] of nameToCategory.entries()) {
        if (cleanUpper.startsWith(knownName) || knownName.startsWith(cleanUpper)) {
          return cat;
        }
      }
    }
    // 4. If inventory item category is not technical
    if (inv.category && !isTechnicalCategory(inv.category)) {
      return formatCategoryName(inv.category);
    }
    return 'Uncategorized';
  };

  const [orders, purchases] = await Promise.all([
    prisma.order.findMany({
      where: finalSaleWhere({}),
      include: { orderItems: { include: { product: true } } }
    }),
    prisma.procurementOrder.findMany({
      where: { status: { notIn: ['CANCELLED'] as any } },
      include: {
        poItems: { include: { inventoryItem: true } },
        goodsReceipts: {
          where: { status: 'COMPLETED' },
          include: { items: { include: { inventoryItem: true } } }
        }
      }
    })
  ]);

  interface CategoryAgg {
    category: string;
    categoryName: string;
    saleQty: number;
    saleQuantity: number;
    saleAmount: number;
    purchaseQty: number;
    purchaseQuantity: number;
    purchaseAmount: number;
    grossMargin: number;
  }

  const categoryMap: Record<string, CategoryAgg> = {};

  const getOrCreate = (cat: string) => {
    const key = cat || 'Uncategorized';
    if (!categoryMap[key]) {
      categoryMap[key] = {
        category: key,
        categoryName: key,
        saleQty: 0,
        saleQuantity: 0,
        saleAmount: 0,
        purchaseQty: 0,
        purchaseQuantity: 0,
        purchaseAmount: 0,
        grossMargin: 0
      };
    }
    return categoryMap[key];
  };

  orders.forEach(o => {
    o.orderItems.forEach(item => {
      const cat = resolveProductCategory(item.product);
      const agg = getOrCreate(cat);
      const qty = item.quantity || 0;
      const amt = item.totalAmount || (qty * (item.price || 0));
      agg.saleQty += qty;
      agg.saleQuantity += qty;
      agg.saleAmount += amt;
    });
  });

  purchases.forEach(p => {
    p.goodsReceipts.forEach(grn => {
      grn.items.forEach(item => {
        if (!item.acceptedQty) return;
        const poItem = p.poItems.find(pi => pi.inventoryItemId === item.materialId);
        const invItem = item.inventoryItem || poItem?.inventoryItem;
        const cat = resolveInventoryItemCategory(invItem);
        const agg = getOrCreate(cat);
        const qty = item.acceptedQty || 0;
        const amt = qty * (item.price || 0);
        agg.purchaseQty += qty;
        agg.purchaseQuantity += qty;
        agg.purchaseAmount += amt;
      });
    });
  });

  const data = Object.values(categoryMap).map(r => ({
    ...r,
    saleQty: Number(r.saleQty.toFixed(2)),
    saleQuantity: Number(r.saleQuantity.toFixed(2)),
    saleAmount: Number(r.saleAmount.toFixed(2)),
    purchaseQty: Number(r.purchaseQty.toFixed(2)),
    purchaseQuantity: Number(r.purchaseQuantity.toFixed(2)),
    purchaseAmount: Number(r.purchaseAmount.toFixed(2)),
    grossMargin: Number((r.saleAmount - r.purchaseAmount).toFixed(2))
  }));

  console.log('Resulting Data:', JSON.stringify(data, null, 2));

  const totalSaleQty = data.reduce((s, r) => s + r.saleQty, 0);
  const totalSaleAmount = data.reduce((s, r) => s + r.saleAmount, 0);
  const totalPurchaseQty = data.reduce((s, r) => s + r.purchaseQty, 0);
  const totalPurchaseAmount = data.reduce((s, r) => s + r.purchaseAmount, 0);

  console.log('Totals:', {
    totalSaleQty,
    totalSaleAmount,
    totalPurchaseQty,
    totalPurchaseAmount
  });
}

testResolution().catch(console.error).finally(() => prisma.$disconnect());
