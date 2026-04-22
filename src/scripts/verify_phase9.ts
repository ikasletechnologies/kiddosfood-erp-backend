import prisma from '../lib/prisma';
import { AuditService } from '../modules/audit/audit.service';
import { SettingsService } from '../modules/settings/settings.service';
import { DashboardService } from '../modules/dashboard/dashboard.service';

/**
 * Verification Script for Phase 9: Enterprise Governance
 * RUN: npx ts-node src/scripts/verify_phase9.ts
 */
async function verify() {
  console.log('🚀 Starting Phase 9 Verification...');

  try {
    // 1. Audit Logging Check
    console.log('📝 Testing Audit Logging...');
    const log = await AuditService.log({
      userId: (await prisma.user.findFirst())?.id || 'sys-1',
      action: 'VERIFY_TEST',
      entityType: 'SYSTEM',
      details: { message: 'Verification in progress' }
    });

    if (!log) throw new Error('Audit log creation failed.');
    console.log('✅ Audit logging verified.');

    // 2. System Settings Check
    console.log('⚙️ Testing System Settings...');
    await SettingsService.setSetting('tax_rate', '5', 'FINANCE', 'Global GST Rate');
    const taxRate = await SettingsService.getSettingValue('tax_rate');
    
    if (taxRate !== '5') throw new Error('Settings storage/retrieval mismatch.');
    console.log('✅ System settings verified.');

    // 3. Global Dashboard Check
    console.log('📊 Testing Global Dashboard Aggregation...');
    // We expect this to run without error for both global (undefined franchiseId) and specific branch
    const globalSummary = await DashboardService.getSummary({});
    console.log('Global Orders Today:', globalSummary.stats.ordersToday);
    
    const firstBranch = await prisma.franchise.findFirst();
    if (firstBranch) {
        const branchSummary = await DashboardService.getSummary({ franchiseId: firstBranch.id });
        console.log(`Branch [${firstBranch.name}] Orders Today:`, branchSummary.stats.ordersToday);
    }
    
    console.log('✅ Dashboard aggregation logic verified.');

    console.log('🌟 PHASE 9 VERIFIED SUCCESSFULLY! 🌟');

  } catch (error) {
    console.error('❌ Verification Failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

verify();
