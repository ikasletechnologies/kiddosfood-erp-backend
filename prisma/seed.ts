import prisma from '../src/lib/prisma';
import bcrypt from 'bcryptjs';

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

  console.log('✅ Seeding complete: Super Admin created. All other entities (Franchises, Warehouses, Accounts, Workflow Requests) can be created manually.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
