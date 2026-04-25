import { Request, Response } from 'express';
import { SettingsService } from './settings.service';

export class SettingsController {
  static async getAll(req: Request, res: Response) {
    try {
      const settings = await SettingsService.getAllSettings();
      res.json(settings);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async setSetting(req: Request, res: Response) {
    try {
      const { key, value, group, description } = req.body;
      const setting = await SettingsService.setSetting(key, value, group, description);
      res.status(200).json(setting);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getCompanyProfile(req: Request, res: Response) {
    try {
      const profile = await SettingsService.getCompanyProfile();
      res.json(profile);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateCompanyProfile(req: Request, res: Response) {
    try {
      const profile = await SettingsService.updateCompanyProfile(req.body);
      res.json(profile);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
