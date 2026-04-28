import { Request, Response } from 'express';
import { VendorInvoiceService } from './vendor-invoices.service';

export class VendorInvoiceController {
  static async getAll(req: Request, res: Response) {
    try {
      const data = await VendorInvoiceService.getAll(req.query as unknown as { vendorId?: string; status?: string });
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const invoice = await VendorInvoiceService.create(req.body);
      res.status(201).json(invoice);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async match(req: Request, res: Response) {
    try {
      const invoice = await VendorInvoiceService.match(req.params.id);
      res.json(invoice);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async updateStatus(req: Request, res: Response) {
    try {
      const { status } = req.body;
      const invoice = await VendorInvoiceService.updateStatus(req.params.id, status);
      res.json(invoice);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }
}
