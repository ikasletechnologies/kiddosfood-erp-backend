import prisma from '../src/lib/prisma';
import bcrypt from 'bcryptjs';

// This is what `prisma migrate reset` (and a `migrate dev` drift-resolution
// reset) automatically runs afterward — see package.json's "prisma.seed".
// It previously created ONLY the Super Admin and left the HQ Franchise as
// a "create manually" follow-up step that nobody ever came back to,
// exactly once before (see scripts/fix-hq-franchise.ts, a one-time fix for
// the identical gap) and again this time (see the Franchise-table
// investigation) — every HQ-dependent module (Inventory, POS, Procurement,
// Dispatch, ...) silently breaks the moment isHQ resolves to nothing.
// Seeding the HQ here means any future reset self-heals instead of
// repeating the same multi-day mystery a third time.
async function main() {
  console.log('🌱 Starting Clean Production Seeding...');

  // Default Super Admin User
  const password = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);

  await prisma.user.upsert({
    where: { email: 'admin@kiddosfood.com' },
    update: {
      passwordHash: password,
      role: 'SUPER_ADMIN',
      franchiseId: null
    },
    create: {
      email: 'admin@kiddosfood.com',
      passwordHash: password,
      fullName: 'System Super Admin',
      role: 'SUPER_ADMIN',
      franchiseId: null,
      is_active: true,
    },
  });
  console.log('✅ Super Admin ready.');

  // The one HQ franchise — same canonical identity as
  // src/scripts/seed/franchises.ts, so a fresh reset and a manual reseed
  // agree on which id is HQ. Only creates it if no franchise is already
  // flagged isHQ, so this never fights a real HQ someone has since
  // configured differently (renamed, moved to a different franchise id).
  const existingHQ = await prisma.franchise.findFirst({ where: { isHQ: true } });
  if (!existingHQ) {
    await prisma.franchise.upsert({
      where: { id: 'root-franchise' },
      update: { isHQ: true },
      create: {
        id: 'root-franchise',
        name: 'Headquarters (HQ)',
        location: 'Central Plaza, Tech Hub',
        ownerName: 'System Owner',
        contactNum: '1112223333',
        isHQ: true,
        status: 'ACTIVE',
      },
    });
    console.log('✅ HQ franchise ready (root-franchise).');
  } else {
    console.log(`✅ HQ franchise already configured (${existingHQ.name}).`);
  }

  console.log('✅ Seeding complete. Warehouses, Accounts, and Workflow Requests can still be created manually.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
