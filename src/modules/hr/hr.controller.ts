import { Request, Response } from 'express';
import { HRService } from './hr.service';

export class HRController {
  static async checkIn(req: Request, res: Response) {
    try {
      const { userId } = req.body;
      const log = await HRService.checkIn(userId);
      res.status(201).json(log);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async checkOut(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const log = await HRService.checkOut(id);
      res.json(log);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getAttendance(req: Request, res: Response) {
    try {
      const logs = await HRService.getDailyLogs(new Date());
      res.json(logs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
