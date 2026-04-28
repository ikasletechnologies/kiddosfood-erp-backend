import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🚀 Starting Vendor Ledger Migration...');

  const vendors = await prisma.vendor.findMany({
    include: {
      orders: {
        where: { status: { not: 'CANCELLED' } }
      }
    }
  });

  for (const vendor of vendors) {
    console.log(`📦 Migrating Vendor: ${vendor.name}`);

    // 1. Check if ledger already has entries (idempotency)
    const existingLedger = await prisma.vendorLedger.count({
      where: { vendorId: vendor.id }
    });

    if (existingLedger > 0) {
      console.log(`⏩ Skipping ${vendor.name} (Ledger not empty)`);
      continue;
    }

    // 2. Process Orders
    for (const order of vendor.orders) {
      // Record DEBIT for PO total
      await prisma.vendorLedger.create({
        data: {
          vendorId: vendor.id,
          type: 'DEBIT',
          amount: order.totalAmount,
          referenceType: 'PO',
          referenceId: order.id,
          note: `System Migration: PO Total`,
          createdAt: order.createdAt
        }
      });

      // Record CREDIT for Advance Paid
      if (order.advancePaid > 0) {
        await prisma.vendorLedger.create({
          data: {
            vendorId: vendor.id,
            type: 'CREDIT',
            amount: order.advancePaid,
            referenceType: 'ADVANCE',
            referenceId: order.id,
            note: `System Migration: Advance Payment`,
            createdAt: order.createdAt
          }
        });
      }
    }

    // 3. Process Manual Adjustments (as OPENING_BALANCE)
    if (vendor.manualPurchaseAdj !== 0) {
      await prisma.vendorLedger.create({
        data: {
          vendorId: vendor.id,
          type: 'DEBIT',
          amount: Math.abs(vendor.manualPurchaseAdj),
          referenceType: 'OPENING_BALANCE',
          note: `Migration: Legacy Purchase Adjustment`,
        }
      });
    }

    if (vendor.manualAdvanceAdj !== 0) {
      await prisma.vendorLedger.create({
        data: {
          vendorId: vendor.id,
          type: 'CREDIT',
          amount: Math.abs(vendor.manualAdvanceAdj),
          referenceType: 'OPENING_BALANCE',
          note: `Migration: Legacy Advance Adjustment`,
        }
      });
    }

    console.log(`✅ Completed ${vendor.name}`);
  }

  console.log('✨ Migration Finished Successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error during migration:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
