import '../scripts/guard-destructive-db-command';
import prisma from '../src/lib/prisma';

/**
 * Removes all business/operational data from the database — every Order,
 * Payment, Invoice, Customer, Vendor, Production run, etc.
 * Preserves: Franchise, User, Role, Permission, RolePermission records.
 * NOT "safe to run on live DB" in any everyday sense — it deletes every
 * real business transaction that exists. Guarded against the shared
 * Supabase DB (see guard-destructive-db-command.ts); only bypass that
 * guard for a deliberate, confirmed wipe.
 */
async function cleanupData() {
  console.log('🧹 Starting targeted data cleanup...');
  console.log('   Preserving: Franchise, User, Role, Permission, RolePermission');
  console.log('   Removing: All business/operational data\n');

  try {
    // Delete in FK-safe order (children before parents)

    // HR / Payroll
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
    console.log('✅ HR/Payroll data cleared');

    // CRM
    await prisma.locationLog.deleteMany({});
    await prisma.fieldVisit.deleteMany({});
    await prisma.serviceTicket.deleteMany({});
    await prisma.cRMForm.deleteMany({});
    await prisma.lead.deleteMany({});
    await prisma.pipeline.deleteMany({});
    await prisma.customer.deleteMany({});
    console.log('✅ CRM data cleared');

    // Sales / Orders
    await prisma.returnItem.deleteMany({});
    await prisma.returnOrder.deleteMany({});
    await prisma.salesOrderItem.deleteMany({});
    await prisma.salesOrder.deleteMany({});
    await prisma.quotationItem.deleteMany({});
    await prisma.quotation.deleteMany({});
    await prisma.rFQItem.deleteMany({});
    await prisma.purchaseRFQ.deleteMany({});
    await prisma.orderItem.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.invoice.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.delivery.deleteMany({});
    await prisma.expense.deleteMany({});
    await prisma.wastage.deleteMany({});
    console.log('✅ Sales/Orders data cleared');

    // Production & Stock Transfers
    await prisma.productionItem.deleteMany({});
    await prisma.franchiseOrderItem.deleteMany({});
    await prisma.franchiseOrder.deleteMany({});
    await prisma.productBatch.deleteMany({});
    await prisma.production.deleteMany({});
    await prisma.stockTransferItem.deleteMany({});
    await prisma.stockTransfer.deleteMany({});
    await prisma.stockRequestItem.deleteMany({});
    await prisma.stockRequest.deleteMany({});
    console.log('✅ Production/Stock Transfer data cleared');

    // Products & Recipes
    await prisma.recipeItem.deleteMany({});
    await prisma.recipe.deleteMany({});
    await prisma.product.deleteMany({});
    console.log('✅ Products/Recipes data cleared');

    // Procurement / GRN
    await prisma.goodsReceiptItem.deleteMany({});
    await prisma.goodsReceipt.deleteMany({});
    await prisma.vendorInvoice.deleteMany({});
    await prisma.procurementOrderItem.deleteMany({});
    await prisma.procurementOrder.deleteMany({});
    await prisma.vendorLedger.deleteMany({});
    await prisma.vendorMaterial.deleteMany({});
    await prisma.vendor.deleteMany({});
    console.log('✅ Procurement/Vendor data cleared');

    // Inventory
    await prisma.stockMovement.deleteMany({});
    await prisma.inventoryItem.deleteMany({});
    console.log('✅ Inventory data cleared');

    // Auth sessions
    await prisma.refreshToken.deleteMany({});
    console.log('✅ Refresh tokens cleared');

    console.log('\n🎉 Cleanup complete! Database now contains only:');
    const franchiseCount = await prisma.franchise.count();
    const userCount = await prisma.user.count();
    const roleCount = await prisma.role.count();
    const permissionCount = await prisma.permission.count();
    console.log(`   Franchises : ${franchiseCount}`);
    console.log(`   Users      : ${userCount}`);
    console.log(`   Roles      : ${roleCount}`);
    console.log(`   Permissions: ${permissionCount}`);

  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

cleanupData();
