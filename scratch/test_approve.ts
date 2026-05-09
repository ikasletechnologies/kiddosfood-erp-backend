import { ProcurementService } from '../src/modules/procurement/procurement.service';
import prisma from '../src/lib/prisma';

async function testApprove() {
  const poId = '2e950eea-c916-4934-9d39-6c0f1ae7f67b';
  try {
    const result = await ProcurementService.approvePO(poId);
    console.log('PO ID:', result.id);
    console.log('Status:', result.status);
    console.log('Approved At:', result.approvedAt);
    console.log('Approved By:', result.approvedBy);
  } catch (error) {
    console.error('Approval failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

testApprove();
