import { Request, Response } from 'express';
import { CustomerService } from './customer.service';
import { CRMService } from '../crm/crm.service';

export class CustomerController {
  static async getAll(req: Request, res: Response) {
    try {
      const { search, franchiseId } = req.query;
      const customers = await CustomerService.getAll(search as string, franchiseId as string);
      res.json(customers);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const customer = await CustomerService.getById(req.params.id);
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      res.json(customer);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const data: any = {
        name: req.body.name,
        phone: req.body.phone || undefined,
        email: req.body.email || undefined,
      };

      if ((req as any).user?.role === 'FRANCHISE_ADMIN' || (req as any).user?.role?.name === 'FRANCHISE_ADMIN') {
        data.franchiseId = (req as any).user.franchiseId;
      } else if (req.body.franchiseId) {
        data.franchiseId = req.body.franchiseId;
      }

      const customer = await CustomerService.create(data);
      res.status(201).json(customer);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const data: any = {};
      if (req.body.name !== undefined) data.name = req.body.name;
      if (req.body.phone !== undefined) data.phone = req.body.phone || null;
      if (req.body.email !== undefined) data.email = req.body.email || null;

      const customer = await CustomerService.update(req.params.id, data);
      res.json(customer);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      await CustomerService.delete(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getHistory(req: Request, res: Response) {
    try {
      const history = await CRMService.getCustomerSummary(req.params.id);
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
