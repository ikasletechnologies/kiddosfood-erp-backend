import prisma from '../../lib/prisma';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';

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
      role: 'SUPER_ADMIN' as UserRole,
      is_active: true,
    },
    {
      email: 'admin@kiddosfood.com',
      fullName: 'Kiddos Super Admin',
      phone: '9999999999',
      passwordHash: commonPassword,
      role: 'SUPER_ADMIN' as UserRole,
      franchiseId: 'hq-001',
      is_active: true,
    },
    {
      email: 'franchise@erp.com',
      fullName: 'Downtown Manager',
      phone: '9876543210',
      passwordHash: franchisePassword,
      role: 'FRANCHISE_ADMIN' as UserRole,
      franchiseId: 'fran-downtown',
      is_active: true,
    },
    {
      email: 'hq@erp.com',
      fullName: 'HQ Manager',
      phone: '1112223333',
      passwordHash: commonPassword,
      role: 'FRANCHISE_ADMIN' as UserRole,
      franchiseId: 'hq-001',
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
