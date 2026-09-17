import { Request, Response } from 'express';
import { AlertService } from './alert.service';

export class AlertController {
  static async getAlerts(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const result = await AlertService.getAlerts(user, req.query as any);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getSummary(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const summary = await AlertService.getSummary(user, req.query.franchiseId as string);
      res.json(summary);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async markAsRead(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { id } = req.params;
      const success = await AlertService.markAsRead(id, user);
      if (!success) {
        return res.status(404).json({ error: 'Alert not found or unauthorized' });
      }
      res.json({ message: 'Alert marked as read', success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async markAllAsRead(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const count = await AlertService.markAllAsRead(user, req.body?.franchiseId || (req.query?.franchiseId as string));
      res.json({ message: 'All alerts marked as read', updatedCount: count, success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async reconcile(req: Request, res: Response) {
    try {
      const franchiseId = req.query.franchiseId as string;
      await AlertService.reconcileAllActiveConditions(franchiseId);
      res.json({ message: 'Alerts reconciled successfully', success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
