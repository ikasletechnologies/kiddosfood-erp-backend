import prisma from '../../lib/prisma';

export async function seedFranchises() {
  console.log('🏢 Seeding Franchises...');
  const franchises = [
    {
      id: 'root-franchise',
      name: 'Headquarters (HQ)',
      location: 'Central Plaza, Tech Hub',
      ownerName: 'System Owner',
      contactNum: '1112223333',
      isHQ: true,
    },
    {
      id: 'distribution-branch',
      name: 'Distribution Center',
      location: 'Industrial Estate, Sector 5',
      ownerName: 'Logistics Manager',
      contactNum: '4445556666',
    },
    {
      id: 'test-franchise-id',
      name: 'Downtown Outlet',
      location: 'Main Street, City Center',
      ownerName: 'Jane Doe',
      contactNum: '9876543210',
    }
  ];

  for (const f of franchises) {
    await prisma.franchise.upsert({
      where: { id: f.id },
      update: f,
      create: { ...f, status: 'ACTIVE' },
    });
  }
  console.log('✅ Franchises created');
}
