import prisma from '../../lib/prisma';
import { PartnerType } from '@prisma/client';

export class BusinessPartnerService {
  static async getAll(franchiseId?: string, type?: PartnerType) {
    return prisma.businessPartner.findMany({
      where: {
        ...(franchiseId && { franchiseId }),
        ...(type && { type })
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async create(data: { name: string; type: PartnerType; email?: string; phone?: string; address?: string; franchiseId: string }) {
    return prisma.businessPartner.create({
      data
    });
  }

  static async delete(id: string) {
    return prisma.businessPartner.delete({ where: { id } });
  }
}
