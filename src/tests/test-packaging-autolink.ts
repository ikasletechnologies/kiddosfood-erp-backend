import prisma from '../lib/prisma';
import { ProductionService } from '../modules/production/production.service';

async function testPackagingAutoLink() {
  console.log('--- TESTING PACKAGING AUTO-LINK ---');

  const testId = `autolink-${Date.now()}`;
  
  // 1. Setup minimal required data
  const franchise = await prisma.franchise.create({
    data: {
      name: `Test Franchise ${testId}`,
      contactNum: '1234567890',
      ownerName: 'Test Owner',
      location: 'Test Location',
    }
  });

  const recipe = await prisma.recipe.create({
    data: {
      name: `Test Recipe ${testId}`,
      yieldQty: 100,
      yieldUnit: 'KG'
    }
  });

  const rawItem = await prisma.inventoryItem.create({
    data: {
      name: `${recipe.name} - Bulk`,
      sku: `TEST-RECIPE-${testId}-BULK`,
      unit: 'KG',
      franchiseId: franchise.id,
      currentStock: 100,
      costPrice: 50,
      category: 'RAW_MATERIAL'
    }
  });

  const production = await prisma.production.create({
    data: {
      recipeId: recipe.id,
      quantity: 100,
      franchiseId: franchise.id,
      status: 'COMPLETED',
      productionType: 'BULK',
      actualYield: 100
    }
  });

  const batch = await prisma.productBatch.create({
    data: {
      batchCode: `BATCH-${testId}`,
      productionId: production.id,
      franchiseId: franchise.id,
      mfgDate: new Date(),
      qcStatus: 'APPROVED',
      quantity: 100,
      approvedQty: 100,
      packagedQty: 0
    }
  });

  // 2. Test Success Case (Create New Product)
  console.log('\n--- 1. Testing Atomic Auto-Link (New Product) ---');
  const newSku = `SKU-SUCCESS-${testId}`;
  const startPackResult = await ProductionService.startPackaging({
    batchId: batch.id,
    packetSize: '500g',
    quantityPackets: 10,
    newProduct: {
      name: 'Test New Finished Good',
      sku: newSku,
      basePrice: 150
    }
  });

  // Verify
  const linkedBatch = await prisma.productBatch.findUnique({ where: { id: batch.id } });
  const createdProduct = await prisma.product.findUnique({ where: { id: linkedBatch?.productId! } });
  
  if (createdProduct && createdProduct.sku === newSku) {
    console.log(`✅ Success: Product securely created (ID: ${createdProduct.id}) and automatically linked to batch!`);
  } else {
    console.error(`❌ Failed: Product not created or not linked correctly.`);
    process.exit(1);
  }

  // 3. Test Failure Case (Duplicate SKU)
  console.log('\n--- 2. Testing Duplicate SKU Rejection ---');
  try {
    await ProductionService.startPackaging({
      batchId: batch.id,
      packetSize: '250g',
      quantityPackets: 5,
      newProduct: {
        name: 'Another Finished Good',
        sku: newSku, // Deliberately using the exact same SKU just created
        basePrice: 200
      }
    });
    console.error(`❌ Failed: Duplicate SKU should have been rejected but wasn't!`);
    process.exit(1);
  } catch (err: any) {
    if (err.message.includes('already exists')) {
      console.log(`✅ Success: Duplicate SKU cleanly rejected (${err.message})!`);
    } else {
      console.error(`❌ Failed: Unexpected error -> ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\n✅ ALL PACKAGING AUTO-LINK TESTS PASSED!');
}

testPackagingAutoLink()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
