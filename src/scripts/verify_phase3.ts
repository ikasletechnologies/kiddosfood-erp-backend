import prisma from '../lib/prisma';
import { POSService } from '../modules/pos/pos.service';
import { InventoryService } from '../modules/inventory/inventory.service';
import { RecipeService } from '../modules/recipes/recipe.service';

/**
 * Verification Script for Phase 3: Inventory + Recipe
 * RUN: npx ts-node src/scripts/verify_phase3.ts
 */
async function verify() {
  console.log('🚀 Starting Phase 3 Verification...');

  try {
    const franchiseId = 'root-franchise';

    // 1. Create Raw Material (Batter)
    console.log('📦 Creating Raw Material...');
    const material = await InventoryService.createItem({
      name: 'Test Batter',
      sku: `BATTER-${Date.now()}`,
      category: 'RAW_MATERIAL',
      currentStock: 1000, // 1000g
      unit: 'g',
      franchiseId
    });
    console.log(`✅ Created Material: ${material.name} (Stock: ${material.currentStock}g)`);

    // 2. Create Product (Idli)
    console.log('🍔 Creating Product...');
    const product = await prisma.product.create({
      data: {
        name: 'Test Idli',
        basePrice: 50,
        isVeg: true,
        is_menu_item: true // REQUESTED FIELD
      }
    });
    console.log(`✅ Created Product: ${product.name}`);

    // 3. Create Recipe (1 Idli = 100g Batter)
    console.log('📜 Creating Recipe...');
    await RecipeService.upsertRecipe({
      productId: product.id,
      name: 'Idli Recipe',
      yieldQty: 1,
      instructions: 'Steam it.',
      items: [
        { inventoryItemId: material.id, quantityRequired: 100, unit: 'g' }
      ]
    });
    console.log(`✅ Created Recipe: 1 ${product.name} needs 100g ${material.name}`);

    // 4. Create Order (Qty: 2)
    console.log('🛒 Creating Order...');
    const order = await POSService.createOrder({ franchiseId });
    await POSService.addItemsToOrder(order.id, [
      { productId: product.id, quantity: 2 }
    ]);
    console.log(`✅ Created Order for 2x ${product.name}`);

    // 5. Update Status to READY and check stock
    console.log('⏳ Moving Order to READY (Triggering Deduction)...');
    await POSService.updateOrderStatus(order.id, 'READY');
    
    let updatedMaterial = await prisma.inventoryItem.findUnique({ where: { id: material.id } });
    console.log(`📊 Stock after READY: ${updatedMaterial?.currentStock}g (Expected: 800g)`);

    if (updatedMaterial?.currentStock !== 800) {
      throw new Error('Deduction failed or incorrect!');
    }

    // 6. Update Status to COMPLETED and verify no double deduction
    console.log('🏁 Moving Order to COMPLETED (Should NOT deduct again)...');
    await POSService.updateOrderStatus(order.id, 'COMPLETED');
    
    updatedMaterial = await prisma.inventoryItem.findUnique({ where: { id: material.id } });
    console.log(`📊 Stock after COMPLETED: ${updatedMaterial?.currentStock}g (Expected: 800g)`);

    if (updatedMaterial?.currentStock !== 800) {
      throw new Error('Double deduction detected!');
    }

    console.log('🌟 PHASE 3 VERIFIED SUCCESSFULLY! 🌟');

  } catch (error) {
    console.error('❌ Verification Failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

verify();
