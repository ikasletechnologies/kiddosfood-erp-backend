import prisma from '../lib/prisma';
import { LogisticsService } from '../modules/franchise/logistics.service';
import { StockMovementType } from '@prisma/client';

/**
 * Verification Script for Phase 10: Inter-Branch Logistics
 * RUN: npx ts-node src/scripts/verify_phase10.ts
 */
async function verify() {
  console.log('🚀 Starting Phase 10 Verification...');

  try {
    // 1. Setup Data
    const hq = await prisma.franchise.findFirst({ where: { name: { contains: 'Headquarters' } } });
    const branch = await prisma.franchise.findFirst({ where: { name: { contains: 'Distribution' } } });

    if (!hq || !branch) throw new Error('Branches not found. Run seed script.');

    // Find a real user for audit logs
    const adminUser = await prisma.user.findFirst();
    const adminId = adminUser?.id || 'sys-verify';

    // Find an item in HQ
    const hqItem = await prisma.inventoryItem.findFirst({ where: { franchiseId: hq.id } });
    if (!hqItem) throw new Error('No items in HQ inventory.');

    console.log(`📦 Testing Transfer of [${hqItem.name}] from HQ to Branch...`);
    const initialHqStock = hqItem.currentStock;

    // 2. Create Transfer
    const transfer = await LogisticsService.createTransfer({
      fromBranchId: hq.id,
      toBranchId: branch.id,
      items: [{ inventoryItemId: hqItem.id, quantity: 5 }],
      initiatedBy: adminId
    });
    console.log('✅ Transfer created.');

    // 3. Mark as SHIPPED (Deduct from HQ)
    await LogisticsService.updateTransferStatus(transfer.id, 'SHIPPED', adminId);
    const updatedHqItem = await prisma.inventoryItem.findUnique({ where: { id: hqItem.id } });
    if (!updatedHqItem || updatedHqItem.currentStock !== initialHqStock - 5) {
        throw new Error('Stock deduction at Source failed.');
    }
    console.log('✅ SHIPPED: Stock deducted from source branch successfully.');

    // 4. Mark as COMPLETED (Add to Destination)
    await LogisticsService.updateTransferStatus(transfer.id, 'COMPLETED', adminId);
    
    // Check destination stock
    const destItem = await prisma.inventoryItem.findFirst({
        where: { sku: hqItem.sku, franchiseId: branch.id }
    });
    if (!destItem || destItem.currentStock < 5) {
        throw new Error('Stock addition at Destination failed.');
    }
    console.log('✅ COMPLETED: Stock added to destination branch successfully.');

    // 5. Check Audit Logs
    const logs = await prisma.activityLog.findMany({
        where: { action: { contains: 'STOCK' } },
        orderBy: { createdAt: 'desc' },
        take: 5
    });
    console.log(`📝 Audit Logs Found: ${logs.length}`);

    console.log('🌟 PHASE 10 VERIFIED SUCCESSFULLY! 🌟');

  } catch (error) {
    console.error('❌ Verification Failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

verify();
