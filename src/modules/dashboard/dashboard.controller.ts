import { Request, Response } from 'express';
import { DashboardService } from './dashboard.service';

export class DashboardController {
  static async getSummary(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { startDate, endDate } = req.query;

      // Logic:
      // 1. If Super Admin and req.query.franchiseId exists, use it to filter a specific branch.
      // 2. If Super Admin and no query param, results are global (undefined franchiseId).
      // 3. If not Super Admin, always use user.franchiseId.
      let franchiseId: string | undefined = req.query.franchiseId as string | undefined;

      if (user.role !== 'SUPER_ADMIN') {
        franchiseId = user.franchiseId;
      }

      const summary = await DashboardService.getSummary({
        franchiseId,
        startDate: startDate as string,
        endDate: endDate as string,
        period: (req.query.period as string) || 'month'
      });
      res.json(summary);
    } catch (error: any) {
      console.error("[Dashboard Error]", error);
      res.status(500).json({ error: error.message });
    }
  }
}
