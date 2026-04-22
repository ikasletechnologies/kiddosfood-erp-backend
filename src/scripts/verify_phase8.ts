import prisma from '../lib/prisma';
import { IsolationUtil } from '../utils/isolation.util';
import { AuthService } from '../modules/auth/auth.service';
import { NavController } from '../modules/users/nav.controller';

/**
 * Verification Script for Phase 8: Franchise System & RBAC Isolation
 * RUN: npx ts-node src/scripts/verify_phase8.ts
 */
async function verify() {
  console.log('🚀 Starting Phase 8 Verification...');

  try {
    // 1. Roles Check
    const superAdminRole = await prisma.role.findUnique({ where: { name: 'SUPER_ADMIN' } });
    const adminRole = await prisma.role.findUnique({ where: { name: 'ADMIN' } });
    if (!superAdminRole || !adminRole) {
        throw new Error('Roles SUPER_ADMIN and ADMIN must exist. Ensure you ran the updated seed script.');
    }
    console.log('✅ Roles realigned successfully.');

    // 2. Data Isolation Check (Simulated)
    console.log('🛡️ Testing Data Isolation Logic...');
    
    const hqUser = { role: 'SUPER_ADMIN', userId: 'sa-1' };
    const branchUser = { role: 'ADMIN', franchiseId: 'branch-a', userId: 'adm-1' };

    const hqFilter = IsolationUtil.getFranchiseFilter(hqUser as any);
    const branchFilter = IsolationUtil.getFranchiseFilter(branchUser as any);

    console.log('Super Admin Filter:', hqFilter);
    console.log('Branch Admin Filter:', branchFilter);

    if (Object.keys(hqFilter).length !== 0 || branchFilter.franchiseId !== 'branch-a') {
        throw new Error('IsolationUtil logic mismatch!');
    }
    console.log('✅ IsolationUtil logic verified.');

    // 3. Navigation Check
    console.log('🧭 Testing Navigation Generation...');
    
    // Mock response for Staff and Super Admin
    let staffNav: any[] = [];
    let saNav: any[] = [];

    const mockRes = (setter: any) => ({
        json: (data: any) => setter(data),
        status: () => ({ json: () => {} })
    } as any);

    // Test NavController logic manually for logic check
    const NavControllerLocal = require('../modules/users/nav.controller').NavController;
    
    await NavControllerLocal.getNavigation({ user: { role: 'STAFF' } } as any, mockRes((d: any) => staffNav = d));
    await NavControllerLocal.getNavigation({ user: { role: 'SUPER_ADMIN' } } as any, mockRes((d: any) => saNav = d));

    const staffHasBranchMgmt = staffNav.some(m => m.title === 'Branch Management');
    const saHasBranchMgmt = saNav.some(m => m.title === 'Branch Management');

    console.log('Staff has Branch Management:', staffHasBranchMgmt);
    console.log('Super Admin has Branch Management:', saHasBranchMgmt);

    if (staffHasBranchMgmt || !saHasBranchMgmt) {
        throw new Error('Navigation role-filtering mismatch!');
    }
    console.log('✅ Premium Navigation role-filtering verified.');

    // 4. Grouping Check
    const salesMenu = saNav.find(m => m.title === 'Sales');
    if (!salesMenu || !salesMenu.children || salesMenu.children.length < 2) {
        throw new Error('Sales menu grouping is incorrect!');
    }
    console.log('✅ Menu grouping logic verified.');

    console.log('🌟 PHASE 8 VERIFIED SUCCESSFULLY! 🌟');

  } catch (error) {
    console.error('❌ Verification Failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

verify();
