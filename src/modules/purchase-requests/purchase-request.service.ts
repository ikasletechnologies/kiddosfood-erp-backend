import prisma from '../../lib/prisma';

export class PurchaseRequestService {
  static async getRequests(filters: { status?: string; search?: string; department?: string }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.department) where.department = filters.department;
    if (filters.search) {
      where.OR = [
        { prNumber: { contains: filters.search, mode: 'insensitive' } },
        { notes: { contains: filters.search, mode: 'insensitive' } }
      ];
    }

    return prisma.purchaseRequest.findMany({
      where,
      include: { items: { include: { inventoryItem: true } } },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getRequestById(id: string) {
    return prisma.purchaseRequest.findUnique({
      where: { id },
      include: { items: { include: { inventoryItem: true } } }
    });
  }

  static async createRequest(data: {
    department?: string;
    requestedBy?: string;
    notes?: string;
    items: Array<{ inventoryItemId: string; quantity: number; unit?: string; notes?: string }>;
  }) {
    const count = await prisma.purchaseRequest.count();
    const year = new Date().getFullYear();
    const prNumber = `PR-${year}-${(count + 1).toString().padStart(4, '0')}`;

    return prisma.purchaseRequest.create({
      data: {
        prNumber,
        department: data.department,
        requestedBy: data.requestedBy,
        notes: data.notes,
        status: 'PENDING_APPROVAL',
        items: {
          create: data.items.map(item => ({
            inventoryItemId: item.inventoryItemId,
            quantity: item.quantity,
            unit: item.unit,
            notes: item.notes
          }))
        }
      },
      include: { items: true }
    });
  }

  static async updateStatus(id: string, status: string, approvedBy?: string) {
    const pr = await prisma.purchaseRequest.findUnique({ where: { id } });
    if (!pr) throw new Error('Purchase Request not found');

    const updateData: any = { status };
    if (status === 'APPROVED') updateData.approvedBy = approvedBy;

    return prisma.purchaseRequest.update({
      where: { id },
      data: updateData,
      include: { items: true }
    });
  }

  static async deleteRequest(id: string) {
    const pr = await prisma.purchaseRequest.findUnique({ where: { id } });
    if (!pr) throw new Error('Purchase Request not found');
    if (pr.status !== 'DRAFT' && pr.status !== 'PENDING_APPROVAL') {
      throw new Error(`Cannot delete PR with status ${pr.status}`);
    }

    await prisma.purchaseRequestItem.deleteMany({ where: { purchaseRequestId: id } });
    return prisma.purchaseRequest.delete({ where: { id } });
  }
}
