import { Request, Response } from 'express';
import { CustomerService } from './customer.service';
import { CRMService } from '../crm/crm.service';

export class CustomerController {
  static async getAll(req: Request, res: Response) {
    try {
      const customers = await CustomerService.getAll(req.query.search as string);
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
      const customer = await CustomerService.create(req.body);
      res.status(201).json(customer);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const customer = await CustomerService.update(req.params.id, req.body);
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
