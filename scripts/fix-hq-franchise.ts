import prisma from '../src/lib/prisma';

// One-time fix: the only Franchise in the system ("Default") was never
// flagged isHQ and was never linked to the only Warehouse ("Main ware
// house") — a broken invariant (FranchiseService.getHqFranchise() expects
// exactly one franchise with isHQ=true; zero had it). Several pages already
// assume an HQ franchise resolves and silently fall back to
// alphabetically-first when it doesn't — this only worked by accident so
// far because there's just one franchise.
async function main() {
  const before = await prisma.franchise.findMany({
    select: { id: true, name: true, isHQ: true, primaryWarehouseId: true },
  });
  console.log('Before:', JSON.stringify(before, null, 2));

  if (before.length !== 1) {
    console.error(`Expected exactly 1 franchise, found ${before.length}. Aborting — verify manually.`);
    process.exit(1);
  }

  const warehouse = await prisma.warehouse.findFirst();
  if (!warehouse) {
    console.error('No warehouse found. Aborting.');
    process.exit(1);
  }

  const updated = await prisma.franchise.update({
    where: { id: before[0].id },
    data: {
      name: 'Main Headquarters',
      isHQ: true,
      primaryWarehouseId: warehouse.id,
    },
  });
  console.log('After:', JSON.stringify({ id: updated.id, name: updated.name, isHQ: updated.isHQ, primaryWarehouseId: updated.primaryWarehouseId }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
