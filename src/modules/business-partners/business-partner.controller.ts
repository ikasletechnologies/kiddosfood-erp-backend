import { Request, Response } from 'express';
import { BusinessPartnerService } from './business-partner.service';
import { PartnerType } from '@prisma/client';

export class BusinessPartnerController {
  static async getAll(req: Request, res: Response) {
    try {
      const { franchiseId, type } = req.query;
      const partners = await BusinessPartnerService.getAll(
        franchiseId as string, 
        type as PartnerType
      );
      res.json(partners);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const partner = await BusinessPartnerService.create(req.body);
      res.status(201).json(partner);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      await BusinessPartnerService.delete(req.params.id);
      res.json({ message: 'Business partner deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }
}
