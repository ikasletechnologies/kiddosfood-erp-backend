import { Request, Response } from 'express';
import { AuditService } from './audit.service';

export class AuditController {
  static async getLogs(req: Request, res: Response) {
    try {
      const { franchiseId, userId, action, entityType, startDate, endDate, take, skip } = req.query;
      // Empty-string query params (e.g. an untouched filter field on the
      // frontend) must mean "no filter" — passed straight through, Prisma
      // reads `action: ''` as "match rows where action equals empty string",
      // which is never true, silently hiding every real log.
      const asFilter = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

      const logs = await AuditService.getLogs({
        franchiseId: asFilter(franchiseId),
        userId: asFilter(userId),
        action: asFilter(action),
        entityType: asFilter(entityType),
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        take: take ? parseInt(take as string) : undefined,
        skip: skip ? parseInt(skip as string) : undefined
      });
      
      res.json(logs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
