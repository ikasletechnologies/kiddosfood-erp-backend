import { Request, Response } from 'express';
import { AuditService } from './audit.service';

export class AuditController {
  static async getLogs(req: Request, res: Response) {
    try {
      const { franchiseId, userId, action, startDate, endDate, take, skip } = req.query;
      
      const logs = await AuditService.getLogs({
        franchiseId: franchiseId as string,
        userId: userId as string,
        action: action as string,
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
