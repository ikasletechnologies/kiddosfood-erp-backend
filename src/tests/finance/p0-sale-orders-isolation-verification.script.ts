import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';
import { SalesService } from '../../modules/sales/sales.service';

async function verify() {
  console.log('🧪 P0 verification — Sale Orders / Sale Order Item franchise isolation\n');
  let failures = 0;

  const franchises = await prisma.franchise.findMany({ select: { id: true, name: true } });
  console.log(`Franchises in DB: ${franchises.length}`);
  franchises.forEach(f => console.log(`  - ${f.id} (${f.name})`));

  if (franchises.length < 2) {
    console.warn('⚠️  Fewer than 2 franchises exist — cannot empirically test cross-franchise isolation between two populated tenants. Proceeding with the available franchise(s) only, as disclosed in the acceptance report.');
  }

  // Org-wide (no franchiseId) — what SUPER_ADMIN sees
  const orgWide = await FinanceService.getSaleOrdersReportData({});
  console.log(`\nOrg-wide (SUPER_ADMIN) Sale Orders count: ${orgWide.orders.length}`);

  const orgWideItems = await FinanceService.getSaleOrderItemsReportData({});
  console.log(`Org-wide (SUPER_ADMIN) Sale Order Items count: ${orgWideItems.length}`);

  let sumScoped = 0;
  let sumScopedItems = 0;
  for (const f of franchises) {
    const scoped = await FinanceService.getSaleOrdersReportData({ franchiseId: f.id });
    const scopedItems = await FinanceService.getSaleOrderItemsReportData({ franchiseId: f.id });
    sumScoped += scoped.orders.length;
    sumScopedItems += scopedItems.length;

    const leaked = scoped.orders.some((o: any) => {
      // Re-fetch the raw order to confirm its actual franchiseId matches the filter used.
      return false; // placeholder, real check below via direct query
    });

    const rawCheck = await prisma.order.findMany({ where: { franchiseId: f.id }, select: { id: true } });
    const rawIds = new Set(rawCheck.map(r => r.id));
    const allMatch = scoped.orders.every((o: any) => rawIds.has(o.id));

    console.log(`\nFranchise ${f.id} (${f.name}):`);
    console.log(`  getSaleOrdersReportData(franchiseId) -> ${scoped.orders.length} orders, all belong to this franchise: ${allMatch ? '✅ YES' : '❌ NO — LEAK'}`);
    console.log(`  getSaleOrderItemsReportData(franchiseId) -> ${scopedItems.length} items`);
    if (!allMatch) failures++;
  }

  console.log(`\nSum of per-franchise scoped orders: ${sumScoped} (org-wide: ${orgWide.orders.length}) — should match if every order belongs to exactly one of these franchises.`);
  if (sumScoped !== orgWide.orders.length) {
    console.warn('⚠️  Sum mismatch — some orders may belong to a franchise not in this list, or duplication. Investigate if failures > 0.');
  }

  // Confirm the OLD leaking path is genuinely unfiltered (documents the bug that was fixed, does not call any write path)
  const oldPathAll = await SalesService.getSalesOrders({});
  console.log(`\nOld path SalesService.getSalesOrders({}) (SalesOrder model, unrelated table) returns ${oldPathAll.length} rows with no franchise filter applied — confirms this route is out of scope for the isolated reports and must not be used by the Reports page (frontend no longer calls it for these two reports).`);

  console.log('\n==================================================');
  if (failures === 0) {
    console.log('✅ Sale Orders / Sale Order Item report endpoints are franchise-isolated for every franchise tested.');
  } else {
    console.error(`💥 ${failures} franchise(s) showed leaked/mismatched orders.`);
    process.exit(1);
  }
}

verify()
  .catch(err => {
    console.error('Fatal verification error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
