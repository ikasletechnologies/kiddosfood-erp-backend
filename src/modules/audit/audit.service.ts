import prisma from '../../lib/prisma';

export class AuditService {
  /**
   * Log a system activity
   */
  static async log(data: {
    userId: string;
    action: string;
    entityType?: string;
    entityId?: string;
    targetFranchiseId?: string;
    details?: any;
  }) {
    try {
      return await prisma.activityLog.create({
        data: {
          userId: data.userId,
          action: data.action,
          entityType: data.entityType,
          entityId: data.entityId,
          targetFranchiseId: data.targetFranchiseId,
          details: data.details || {}
        }
      });
    } catch (error) {
      console.error('Failed to create audit log:', error);
      // We don't throw here to avoid crashing the main transaction
    }
  }

  /**
   * Fetch logs for Super Admin review
   */
  static async getLogs(filters: { 
    franchiseId?: string; 
    userId?: string; 
    action?: string; 
    startDate?: Date; 
    endDate?: Date;
    take?: number;
    skip?: number;
  }) {
    return prisma.activityLog.findMany({
      where: {
        targetFranchiseId: filters.franchiseId,
        userId: filters.userId,
        action: filters.action,
        createdAt: {
          gte: filters.startDate,
          lte: filters.endDate
        }
      },
      include: {
        user: { select: { fullName: true, role: { select: { name: true } } } },
        franchise: { select: { name: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: filters.take || 50,
      skip: filters.skip || 0
    });
  }
}
