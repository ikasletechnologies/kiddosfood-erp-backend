import dotenv from 'dotenv';
import path from 'path';
import bcrypt from 'bcryptjs';

// 1. Explicitly load .env from the backend root folder BEFORE any database imports
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  console.log('🚀 STARTING DATABASE PURGE FOR PRODUCTION GO-LIVE...');
  console.log('   Purging all transactional, operational, and test seed data.');
  console.log('   Retaining ONLY the SUPER_ADMIN account and Headquarters (hq-001) franchise.');

  // 2. Dynamically import prisma AFTER process.env is configured
  const { default: prisma } = await import('../src/lib/prisma');

  try {
    // Delete in FK-safe order (children before parents)

    // 1. HR & Payroll
    console.log('   🧹 Clearing HR & Payroll...');
    await prisma.payslip.deleteMany({});
    await prisma.payroll.deleteMany({});
    await prisma.employeeShift.deleteMany({});
    await prisma.leave.deleteMany({});
    await prisma.leaveType.deleteMany({});
    await prisma.shift.deleteMany({});
    await prisma.salaryStructureItem.deleteMany({});
    await prisma.salaryStructure.deleteMany({});
    await prisma.salaryComponent.deleteMany({});
    await prisma.employee.deleteMany({});

    // 2. CRM
    console.log('   🧹 Clearing CRM & Customers...');
    await prisma.cRMForm.deleteMany({});
    await prisma.lead.deleteMany({});
    await prisma.pipeline.deleteMany({});
    await prisma.customerLedger.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.dealer.deleteMany({});
    await prisma.businessPartner.deleteMany({});

    // 3. Sales & Orders
    console.log('   🧹 Clearing Orders, Payments & Invoices...');
    await prisma.returnItem.deleteMany({});
    await prisma.returnOrder.deleteMany({});
    await prisma.salesOrderItem.deleteMany({});
    await prisma.salesOrder.deleteMany({});
    await prisma.quotationItem.deleteMany({});
    await prisma.quotation.deleteMany({});
    await prisma.rFQItem.deleteMany({});
    await prisma.purchaseRFQ.deleteMany({});
    await prisma.purchaseReturnItem.deleteMany({});
    await prisma.purchaseReturn.deleteMany({});
    await prisma.purchaseRequestItem.deleteMany({});
    await prisma.purchaseRequest.deleteMany({});
    await prisma.vendorQuotationItem.deleteMany({});
    await prisma.vendorQuotation.deleteMany({});
    await prisma.requestForQuotation.deleteMany({});
    await prisma.orderItem.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.invoice.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.delivery.deleteMany({});
    await prisma.expense.deleteMany({});
    await prisma.cheque.deleteMany({});

    // 4. Production, Transfers & Batches
    console.log('   🧹 Clearing Production, Stocks & Batches...');
    await prisma.productionItem.deleteMany({});
    await prisma.franchiseOrderItem.deleteMany({});
    await prisma.franchiseOrder.deleteMany({});
    await prisma.productBatch.deleteMany({});
    await prisma.production.deleteMany({});
    await prisma.stockTransferItem.deleteMany({});
    await prisma.stockTransfer.deleteMany({});
    await prisma.stockRequestItem.deleteMany({});
    await prisma.stockRequest.deleteMany({});
    await prisma.activityLog.deleteMany({});
    await prisma.franchiseRequest.deleteMany({});
    await prisma.financialPayment.deleteMany({});
    await prisma.franchiseLedger.deleteMany({});
    await prisma.inventoryBatch.deleteMany({});

    // 5. Products & Recipes
    console.log('   🧹 Clearing Products & Recipes...');
    await prisma.recipeItem.deleteMany({});
    await prisma.recipe.deleteMany({});
    await prisma.product.deleteMany({});

    // 6. Procurement & Goods Receipt
    console.log('   🧹 Clearing Procurement & Goods Receipts...');
    await prisma.inspectionRecord.deleteMany({});
    await prisma.goodsReceiptItem.deleteMany({});
    await prisma.goodsReceipt.deleteMany({});
    await prisma.vendorInvoice.deleteMany({});
    await prisma.procurementOrderItem.deleteMany({});
    await prisma.procurementOrder.deleteMany({});
    await prisma.vendorLedger.deleteMany({});
    await prisma.vendorMaterial.deleteMany({});
    await prisma.vendor.deleteMany({});

    // 7. Inventory & Warehouse Bins
    console.log('   🧹 Clearing Inventory & Warehouses...');
    await prisma.stockMovement.deleteMany({});
    await prisma.inventoryItem.deleteMany({});
    await prisma.warehouseBin.deleteMany({});
    await prisma.warehouse.deleteMany({});

    // 8. Auth sessions & Audits
    console.log('   🧹 Clearing Refresh Tokens & Audits...');
    await prisma.refreshToken.deleteMany({});
    await prisma.auditLog.deleteMany({});

    // 9. Clear Financial Accounts
    console.log('   🧹 Resetting Financial Accounts...');
    await prisma.account.deleteMany({});

    // 10. Clean Users: Delete all users except super admin
    console.log('   👥 Clearing users other than Super Admin...');
    await prisma.user.deleteMany({
      where: {
        email: { not: 'admin@kiddosfood.com' }
      }
    });

    // 11. Clean Franchises: Delete all franchises except HQ (hq-001)
    console.log('   🏢 Clearing franchises other than Headquarters...');
    await prisma.franchise.deleteMany({
      where: {
        id: { not: 'hq-001' }
      }
    });

    // 12. Ensure Headquarters is created
    console.log('   🏢 Establishing Headquarters details...');
    const hq = await prisma.franchise.upsert({
      where: { id: 'hq-001' },
      update: {
        name: 'Kiddos Food Headquarters',
        location: 'Main Warehouse & Office, Mumbai',
        ownerName: 'Super Admin',
        contactNum: '9999999999',
        status: 'ACTIVE',
        creditLimit: 0,
        outstandingAmount: 0,
        walletBalance: 0
      },
      create: {
        id: 'hq-001',
        name: 'Kiddos Food Headquarters',
        location: 'Main Warehouse & Office, Mumbai',
        ownerName: 'Super Admin',
        contactNum: '9999999999',
        status: 'ACTIVE',
        creditLimit: 0,
        outstandingAmount: 0,
        walletBalance: 0
      }
    });

    // 13. Ensure Super Admin user exists
    console.log('   👤 Seed/Ensure Super Admin Account credentials...');
    const password = await bcrypt.hash('admin123', 10);
    await prisma.user.upsert({
      where: { email: 'admin@kiddosfood.com' },
      update: {
        passwordHash: password,
        fullName: 'HQ Super Admin',
        role: 'SUPER_ADMIN',
        franchiseId: hq.id,
        is_active: true
      },
      create: {
        email: 'admin@kiddosfood.com',
        passwordHash: password,
        fullName: 'HQ Super Admin',
        role: 'SUPER_ADMIN',
        franchiseId: hq.id,
        is_active: true
      }
    });

    // 14. Establish clean starting accounts for the Super Admin
    console.log('   💰 Seeding clean headquarters accounts...');
    await prisma.account.createMany({
      data: [
        {
          id: 'ebd81368-66e8-4de8-b6ca-a672a82c61f4',
          name: 'HQ Cash Account',
          accountCode: 'ACC-001',
          type: 'CASH',
          balance: 0,
          franchiseId: null
        },
        {
          name: 'HQ Bank Account',
          accountCode: 'ACC-002',
          type: 'BANK',
          balance: 0,
          franchiseId: null
        },
        {
          name: 'HQ UPI Account',
          accountCode: 'ACC-003',
          type: 'UPI',
          balance: 0,
          franchiseId: null
        }
      ]
    });

    console.log('\n🎉 DATABASE PURGED & TRANSITIONED TO PRODUCTION READY!');
    console.log('   Keep Super Admin Account: admin@kiddosfood.com / admin123');

  } catch (error) {
    console.error('❌ Clean database transition failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
