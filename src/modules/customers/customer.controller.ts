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
        address: req.body.address || undefined,
        state: req.body.state || undefined,
        district: req.body.district || undefined,
        city: req.body.city || undefined,
        pincode: req.body.pincode || undefined,
        shippingAddress: req.body.shippingAddress || undefined,
        gstNumber: req.body.gstNumber || undefined,
        gstType: req.body.gstType || undefined,
        openingBalance: req.body.openingBalance !== undefined ? Number(req.body.openingBalance) : undefined,
        openingBalanceType: req.body.openingBalanceType || undefined,
        asOfDate: req.body.asOfDate || undefined,
        creditLimit: req.body.creditLimit !== undefined ? (req.body.creditLimit === null ? null : Number(req.body.creditLimit)) : undefined,
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
      if (req.body.address !== undefined) data.address = req.body.address || null;
      if (req.body.state !== undefined) data.state = req.body.state || null;
      if (req.body.district !== undefined) data.district = req.body.district || null;
      if (req.body.city !== undefined) data.city = req.body.city || null;
      if (req.body.pincode !== undefined) data.pincode = req.body.pincode || null;
      if (req.body.shippingAddress !== undefined) data.shippingAddress = req.body.shippingAddress || null;
      if (req.body.gstNumber !== undefined) data.gstNumber = req.body.gstNumber || null;
      if (req.body.gstType !== undefined) data.gstType = req.body.gstType || null;
      if (req.body.openingBalance !== undefined) data.openingBalance = Number(req.body.openingBalance) || 0;
      if (req.body.openingBalanceType !== undefined) data.openingBalanceType = req.body.openingBalanceType || null;
      if (req.body.asOfDate !== undefined) data.asOfDate = req.body.asOfDate || null;
      if (req.body.creditLimit !== undefined) data.creditLimit = req.body.creditLimit === null ? null : Number(req.body.creditLimit);

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

  static async getLedgerSummary(req: Request, res: Response) {
    try {
      const { franchiseId } = req.query;
      const summary = await CustomerService.getLedgerSummary(franchiseId as string);
      res.json(summary);
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
