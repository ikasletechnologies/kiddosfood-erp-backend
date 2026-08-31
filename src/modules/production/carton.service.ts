import prisma from '../../lib/prisma';

export class CartonService {
  static async getAll(franchiseId?: string, startDate?: string, endDate?: string) {
    const where: any = {};
    if (franchiseId) where.franchiseId = franchiseId;
    if (startDate || endDate) {
      const createdAtFilter: any = {};
      if (startDate) createdAtFilter.gte = new Date(startDate.includes('T') ? startDate : `${startDate}T00:00:00.000`);
      if (endDate) createdAtFilter.lte = new Date(endDate.includes('T') ? endDate : `${endDate}T23:59:59.999`);
      where.createdAt = createdAtFilter;
    }
    return prisma.carton.findMany({
      where,
      include: { batch: { include: { product: true } } },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async create(data: {
    batchId: string;
    cartonSize: string;
    unitsPerCarton: number;
    cartonCount: number;
    weightPerCarton?: number;
    franchiseId?: string;
    createdBy?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const batch = await tx.productBatch.findUnique({ where: { id: data.batchId } });
      if (!batch) throw new Error('Batch not found');
      if (batch.qcStatus !== 'APPROVED') throw new Error('Batch must be QC APPROVED before carton packing');

      const totalUnits = data.unitsPerCarton * data.cartonCount;
      if (totalUnits <= 0) throw new Error('Carton count and units per carton must be greater than zero');

      // Only QC-approved output can be consolidated into cartons; cap against
      // whatever hasn't already been cartoned. Previously there was no cap at
      // all — a user could "pack" more cartons than the batch actually had.
      const remaining = (batch.approvedQty || 0) - (batch.cartonedQty || 0);
      if (totalUnits > remaining + 0.001) {
        throw new Error(`Cannot pack more than the batch's remaining approved quantity (${remaining} units left).`);
      }

      const year = new Date().getFullYear();
      const count = await tx.carton.count({ where: { createdAt: { gte: new Date(year, 0, 1) } } });
      const cartonCode = `CRT-${year}-${(count + 1).toString().padStart(5, '0')}`;

      const carton = await tx.carton.create({
        data: {
          cartonCode,
          batchId: data.batchId,
          cartonSize: data.cartonSize,
          unitsPerCarton: data.unitsPerCarton,
          cartonCount: data.cartonCount,
          totalUnits,
          weightPerCarton: data.weightPerCarton,
          franchiseId: data.franchiseId || batch.franchiseId,
          createdBy: data.createdBy,
        },
        include: { batch: { include: { product: true } } }
      });

      await tx.productBatch.update({
        where: { id: data.batchId },
        data: { cartonedQty: (batch.cartonedQty || 0) + totalUnits }
      });

      return carton;
    });
  }
}
