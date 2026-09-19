import prisma from '../lib/prisma';
import { StockMovementType } from '@prisma/client';

function getStockMovementDirection(type: string, quantity: number): 'IN' | 'OUT' {
  switch (type) {
    case 'PURCHASE_IN':
    case 'PRODUCTION_IN':
    case 'TRANSFER_IN':
    case 'RECALL_RETURN_IN':
    case 'RETURN_QUARANTINE_IN':
    case 'SALES_RETURN_IN':
      return 'IN';
      
    case 'PRODUCTION_OUT':
    case 'SALES_OUT':
    case 'WASTE_OUT':
    case 'TRANSFER_OUT':
    case 'RETURN_OUT':
      return 'OUT';
      
    case 'ADJUSTMENT':
      return quantity >= 0 ? 'IN' : 'OUT';
      
    default:
      return 'OUT';
  }
}

async function testGetMovements(filters: any) {
  const movements = await prisma.stockMovement.findMany({
    where: filters,
    include: { item: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  if (movements.length === 0) {
    return [];
  }

  const itemIds = Array.from(new Set(movements.map(m => m.itemId)));
  const earliestDate = movements[0].createdAt;
  const latestDate = movements[movements.length - 1].createdAt;

  // 1. Calculate prior running balance for each item before earliestDate
  const priorMovements = await prisma.stockMovement.findMany({
    where: {
      itemId: { in: itemIds },
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      createdAt: { lt: earliestDate }
    },
    select: {
      itemId: true,
      movementType: true,
      quantity: true,
      baseQty: true
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  });

  const runningBalances = new Map<string, number>();
  for (const pm of priorMovements) {
    const dir = getStockMovementDirection(pm.movementType, pm.quantity);
    const val = pm.baseQty !== null && pm.baseQty !== undefined ? pm.baseQty : pm.quantity;
    const cur = runningBalances.get(pm.itemId) || 0;
    if (dir === 'IN') {
      runningBalances.set(pm.itemId, cur + Math.abs(val));
    } else {
      runningBalances.set(pm.itemId, cur - Math.abs(val));
    }
  }

  // 2. Intervening movements for these items
  const interveningMovements = await prisma.stockMovement.findMany({
    where: {
      itemId: { in: itemIds },
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      createdAt: { gte: earliestDate, lte: latestDate }
    },
    select: {
      id: true,
      itemId: true,
      movementType: true,
      quantity: true,
      baseQty: true,
      createdAt: true
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  });

  const balanceAfterMovement = new Map<string, number>();
  for (const im of interveningMovements) {
    const dir = getStockMovementDirection(im.movementType, im.quantity);
    const val = im.baseQty !== null && im.baseQty !== undefined ? im.baseQty : im.quantity;
    const cur = runningBalances.get(im.itemId) || 0;
    const next = dir === 'IN' ? cur + Math.abs(val) : cur - Math.abs(val);
    runningBalances.set(im.itemId, next);
    balanceAfterMovement.set(im.id, next);
  }

  // 3. Map filtered movements
  const enriched = movements.map(m => {
    const dir = getStockMovementDirection(m.movementType, m.quantity);
    const val = m.baseQty !== null && m.baseQty !== undefined ? m.baseQty : m.quantity;
    const absQty = Math.abs(val);
    const quantityIn = dir === 'IN' ? absQty : 0;
    const quantityOut = dir === 'OUT' ? absQty : 0;
    const balance = balanceAfterMovement.get(m.id) ?? (runningBalances.get(m.itemId) || 0);

    return {
      id: m.id,
      date: m.createdAt.toISOString(),
      itemName: m.item?.name,
      type: m.movementType,
      direction: dir,
      quantityIn,
      quantityOut,
      balance: Number(balance.toFixed(2)),
      runningBalance: Number(balance.toFixed(2)),
      stockAfter: Number(balance.toFixed(2))
    };
  });

  enriched.reverse();
  return enriched;
}

async function main() {
  // Test with HQ APPAM item (c6836d71-9230-4fda-a4a4-b87007898215)
  const results = await testGetMovements({ itemId: 'c6836d71-9230-4fda-a4a4-b87007898215' });
  console.log(`\nStock Detail Movements for HQ APPAM (${results.length} movements):`);
  console.log('---------------------------------------------------------------------------------------------------');
  console.log('DATE                     | ITEM NAME | TYPE           | QTY IN | QTY OUT | BALANCE');
  console.log('---------------------------------------------------------------------------------------------------');
  for (const r of results) {
    const d = r.date.padEnd(24);
    const name = (r.itemName || '').padEnd(9);
    const t = r.type.padEnd(14);
    const qIn = (r.quantityIn ? String(r.quantityIn) : '—').padEnd(6);
    const qOut = (r.quantityOut ? String(r.quantityOut) : '—').padEnd(7);
    const bal = String(r.balance);
    console.log(`${d} | ${name} | ${t} | ${qIn} | ${qOut} | ${bal}`);
  }
  console.log('---------------------------------------------------------------------------------------------------');

  // Test with Franchise APPAM item (93c8960b-e787-4274-a127-ddad415ccc5f)
  const branchResults = await testGetMovements({ itemId: '93c8960b-e787-4274-a127-ddad415ccc5f' });
  console.log(`\nStock Detail Movements for Franchise APPAM (${branchResults.length} movements):`);
  console.log('---------------------------------------------------------------------------------------------------');
  console.log('DATE                     | ITEM NAME | TYPE             | QTY IN | QTY OUT | BALANCE');
  console.log('---------------------------------------------------------------------------------------------------');
  for (const r of branchResults) {
    const d = r.date.padEnd(24);
    const name = (r.itemName || '').padEnd(9);
    const t = r.type.padEnd(16);
    const qIn = (r.quantityIn ? String(r.quantityIn) : '—').padEnd(6);
    const qOut = (r.quantityOut ? String(r.quantityOut) : '—').padEnd(7);
    const bal = String(r.balance);
    console.log(`${d} | ${name} | ${t} | ${qIn} | ${qOut} | ${bal}`);
  }
  console.log('---------------------------------------------------------------------------------------------------');
}

main().catch(console.error).finally(() => prisma.$disconnect());
