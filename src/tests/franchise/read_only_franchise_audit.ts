import prisma from '../../lib/prisma';
import fs from 'fs';
import path from 'path';

async function runReadOnlyFranchiseAudit() {
  console.log('================================================================');
  console.log('🔍 FRANCHISE MODULE — READ-ONLY DATABASE & SCHEMA AUDIT');
  console.log('================================================================\n');

  try {
    // 1. Franchise Accounts & Users Audit
    const totalFranchises = await prisma.franchise.count();
    const activeFranchises = await prisma.franchise.count({ where: { status: 'ACTIVE' } });
    const hqFranchise = await prisma.franchise.findFirst({ where: { isHQ: true } });
    const franchiseAdmins = await prisma.user.count({ where: { role: 'FRANCHISE_ADMIN' } });
    const superAdmins = await prisma.user.count({ where: { role: 'SUPER_ADMIN' } });

    console.log('1️⃣ FRANCHISE & USER COUNTS:');
    console.log(`   - Total Franchises: ${totalFranchises}`);
    console.log(`   - Active Franchises: ${activeFranchises}`);
    console.log(`   - HQ Franchise ID: ${hqFranchise?.id || 'None'} ("${hqFranchise?.name || 'N/A'}")`);
    console.log(`   - Super Admin Users: ${superAdmins}`);
    console.log(`   - Franchise Admin Users: ${franchiseAdmins}`);

    // 2. Inventory Items Audit
    const hqInventoryItems = await prisma.inventoryItem.count({ where: { franchiseId: null } });
    const franchiseInventoryItems = await prisma.inventoryItem.count({ where: { franchiseId: { not: null } } });
    const totalInventoryItems = await prisma.inventoryItem.count();

    console.log('\n2️⃣ INVENTORY ITEMS SCOPING:');
    console.log(`   - Total InventoryItems: ${totalInventoryItems}`);
    console.log(`   - HQ-Scoped (franchiseId = null): ${hqInventoryItems}`);
    console.log(`   - Franchise-Scoped (franchiseId != null): ${franchiseInventoryItems}`);

    // 3. Inventory Batches Audit
    const totalBatches = await prisma.inventoryBatch.count();

    console.log('\n3️⃣ INVENTORY BATCHES SCOPING:');
    console.log(`   - Total InventoryBatches: ${totalBatches}`);

    // 4. Production & Packaging Audit
    const totalProductions = await prisma.production.count();
    const franchiseProductions = await prisma.production.count({ where: { franchiseId: { not: '' } } });

    const totalProductBatches = await prisma.productBatch.count();
    const franchiseProductBatches = await prisma.productBatch.count({ where: { franchiseId: { not: null } } });

    const totalPackagings = await prisma.productPackaging.count();

    console.log('\n4️⃣ PRODUCTION & PACKAGING SCOPING:');
    console.log(`   - Total Productions: ${totalProductions} (Franchise-Scoped: ${franchiseProductions})`);
    console.log(`   - Total ProductBatches: ${totalProductBatches} (Franchise-Scoped: ${franchiseProductBatches})`);
    console.log(`   - Total ProductPackagings: ${totalPackagings}`);

    // 5. Orders & POS Audit
    const totalOrders = await prisma.order.count();
    const franchiseOrders = await prisma.order.count({ where: { franchiseId: { not: '' } } });

    const totalPayments = await prisma.payment.count();

    console.log('\n5️⃣ ORDERS & POS SCOPING:');
    console.log(`   - Total Orders: ${totalOrders} (Franchise-Scoped: ${franchiseOrders})`);
    console.log(`   - Total Payments: ${totalPayments}`);

    // 6. Procurement Audit
    const totalPO = await prisma.procurementOrder.count();
    const franchisePO = await prisma.procurementOrder.count({ where: { franchiseId: { not: '' } } });

    const totalGRN = await prisma.goodsReceipt.count();
    const totalVendorBills = await prisma.vendorInvoice.count();

    console.log('\n6️⃣ PROCUREMENT SCOPING:');
    console.log(`   - Total ProcurementOrders: ${totalPO} (Franchise-Scoped: ${franchisePO})`);
    console.log(`   - Total GRNs: ${totalGRN}`);
    console.log(`   - Total VendorInvoices: ${totalVendorBills}`);

    // 7. Ledger & Financial Audit
    const totalFranchiseLedgers = await prisma.franchiseLedger.count();
    const totalVendorLedgers = await prisma.vendorLedger.count();
    const totalCustomerLedgers = await prisma.customerLedger.count();

    const totalExpenses = await prisma.expense.count();
    const franchiseExpenses = await prisma.expense.count({ where: { franchiseId: { not: '' } } });

    console.log('\n7️⃣ FINANCIAL & LEDGER SCOPING:');
    console.log(`   - FranchiseLedgers: ${totalFranchiseLedgers}`);
    console.log(`   - VendorLedgers: ${totalVendorLedgers}`);
    console.log(`   - CustomerLedgers: ${totalCustomerLedgers}`);
    console.log(`   - Total Expenses: ${totalExpenses} (Franchise-Scoped: ${franchiseExpenses})`);

    // 8. Integrity Checks: Orphaned & Unexpected Relationships
    console.log('\n8️⃣ INTEGRITY CHECKS (ORPHANED & MISMATCHED DATA):');
    const orphanedUsers = await prisma.user.count({
      where: { role: 'FRANCHISE_ADMIN', franchiseId: null }
    });
    console.log(`   - Franchise Admins without franchiseId: ${orphanedUsers}`);

  } catch (err: any) {
    console.error('❌ Error during read-only franchise database audit:', err);
  } finally {
    await prisma.$disconnect();
  }
}

runReadOnlyFranchiseAudit();
