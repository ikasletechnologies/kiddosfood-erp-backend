import prisma from '../../lib/prisma';
import bcrypt from 'bcryptjs';

export async function seedUsers(roleMap: Record<string, any>) {
  console.log('👤 Seeding Users...');
  const commonPassword = await bcrypt.hash('admin123', 10);
  const franchisePassword = await bcrypt.hash('franchise123', 10);

  const usersData = [
    {
      email: 'admin@fooderp.com',
      fullName: 'System Admin',
      phone: '0000000000',
      passwordHash: commonPassword,
      roleId: roleMap['SUPER_ADMIN'].id,
      is_active: true,
    },
    {
      email: 'admin@kiddosfood.com',
      fullName: 'Kiddos Super Admin',
      phone: '9999999999',
      passwordHash: commonPassword,
      roleId: roleMap['SUPER_ADMIN'].id,
      franchiseId: 'root-franchise',
      is_active: true,
    },
    {
      email: 'franchise@erp.com',
      fullName: 'Downtown Manager',
      phone: '9876543210',
      passwordHash: franchisePassword,
      roleId: roleMap['FRANCHISE_ADMIN'].id,
      franchiseId: 'test-franchise-id',
      is_active: true,
    },
    {
      email: 'hq@erp.com',
      fullName: 'HQ Manager',
      phone: '1112223333',
      passwordHash: commonPassword,
      roleId: roleMap['FRANCHISE_ADMIN'].id,
      franchiseId: 'root-franchise',
      is_active: true,
    }
  ];

  for (const u of usersData) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: u,
      create: u,
    });
  }
  console.log('✅ Users created');
}
