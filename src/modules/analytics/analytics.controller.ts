import { Request, Response } from 'express';
import { AnalyticsService } from './analytics.service';

export class AnalyticsController {
  static async getProductPerformance(req: Request, res: Response) {
    try {
      const { startDate, endDate, franchiseId } = req.query;
      const data = await AnalyticsService.getProductPerformance({
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        franchiseId: franchiseId as string
      });
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPaymentDistribution(req: Request, res: Response) {
    try {
      const { startDate, endDate, franchiseId } = req.query;
      const data = await AnalyticsService.getPaymentDistribution({
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        franchiseId: franchiseId as string
      });
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getWastageSummary(req: Request, res: Response) {
    try {
      const { startDate, endDate, franchiseId } = req.query;
      const data = await AnalyticsService.getWastageSummary({
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        franchiseId: franchiseId as string
      });
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getDailySalesSummary(req: Request, res: Response) {
    try {
      const { startDate, endDate, franchiseId } = req.query;
      const data = await AnalyticsService.getDailySalesSummary({
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        franchiseId: franchiseId as string
      });
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
