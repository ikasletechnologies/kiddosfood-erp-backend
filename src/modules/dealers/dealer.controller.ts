import { Request, Response } from 'express';
import { DealerService } from './dealer.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class DealerController {
  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { franchiseId: ownFranchiseId } = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = user?.role === 'SUPER_ADMIN'
        ? (req.query.franchiseId as string | undefined)
        : ownFranchiseId;
      const dealers = await DealerService.getAll(franchiseId);
      res.json(dealers);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = await IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);
      if (!franchiseId) {
        return res.status(400).json({ error: 'franchiseId is required' });
      }
      const {
        name, email, phone, contact, address, billingAddress, shippingAddress,
        pincode, state, city, district, gstNumber, gstin, taxNumber, gstType,
        openingBalance, openingBalanceType, asOfDate, creditLimit, status
      } = req.body;

      const normalizedEmail = email && typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : undefined;
      const normalizedPhone = (phone || contact) && typeof (phone || contact) === 'string' && (phone || contact).trim() ? (phone || contact).trim() : undefined;
      const resolvedAddress = address || billingAddress || undefined;
      const resolvedGst = gstNumber || gstin || taxNumber || undefined;

      const dealer = await DealerService.create({
        name: name ? String(name).trim() : '',
        email: normalizedEmail,
        phone: normalizedPhone,
        address: resolvedAddress,
        shippingAddress: shippingAddress || resolvedAddress || undefined,
        pincode: pincode || undefined,
        state: state || undefined,
        city: city || undefined,
        district: district || undefined,
        gstNumber: resolvedGst,
        gstType: gstType || 'Unregistered/Consumer',
        openingBalance: openingBalance !== undefined ? Number(openingBalance) : undefined,
        openingBalanceType: openingBalanceType || undefined,
        asOfDate: asOfDate || undefined,
        creditLimit: creditLimit !== undefined ? (creditLimit === null ? null : Number(creditLimit)) : undefined,
        status: status || 'ACTIVE',
        franchiseId
      });
      res.status(201).json(dealer);
    } catch (error: any) {
      const msg = String(error?.message || '');
      if (msg.includes('email') && (msg.includes('Unique constraint') || msg.includes('already exists'))) {
        return res.status(409).json({ error: 'A dealer with this email address already exists.' });
      }
      if ((msg.includes('phone') || msg.includes('contact')) && (msg.includes('Unique constraint') || msg.includes('already exists'))) {
        return res.status(409).json({ error: 'A dealer with this contact number already exists.' });
      }
      const cleanMsg = msg.replace(/Invalid `prisma.*?`invocation:\s*/gs, '').trim();
      res.status(400).json({ error: cleanMsg || 'Failed to create dealer' });
    }
  }

  static async getById(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { franchiseId: ownFranchiseId } = IsolationUtil.getFranchiseFilter(user);
      const dealer = await DealerService.getById(req.params.id, ownFranchiseId);
      if (!dealer) return res.status(404).json({ error: 'Dealer not found' });
      res.json(dealer);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { franchiseId: ownFranchiseId } = IsolationUtil.getFranchiseFilter(user);
      const {
        name, email, phone, contact, address, billingAddress, shippingAddress,
        pincode, state, city, district, gstNumber, gstin, taxNumber, gstType,
        openingBalance, openingBalanceType, asOfDate, creditLimit, status
      } = req.body;

      const normalizedEmail = email !== undefined ? (email && typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null) : undefined;
      const normalizedPhone = (phone !== undefined || contact !== undefined) ? ((phone || contact) && typeof (phone || contact) === 'string' && (phone || contact).trim() ? (phone || contact).trim() : null) : undefined;
      const resolvedAddress = (address !== undefined || billingAddress !== undefined) ? (address || billingAddress || null) : undefined;
      const resolvedGst = (gstNumber !== undefined || gstin !== undefined || taxNumber !== undefined) ? (gstNumber || gstin || taxNumber || null) : undefined;

      const dealer = await DealerService.update(req.params.id, {
        name: name !== undefined ? (name ? String(name).trim() : undefined) : undefined,
        email: normalizedEmail as any,
        phone: normalizedPhone as any,
        address: resolvedAddress as any,
        shippingAddress: shippingAddress !== undefined ? (shippingAddress || null) : undefined,
        pincode: pincode !== undefined ? (pincode || null) : undefined,
        state: state !== undefined ? (state || null) : undefined,
        city: city !== undefined ? (city || null) : undefined,
        district: district !== undefined ? (district || null) : undefined,
        gstNumber: resolvedGst as any,
        gstType: gstType !== undefined ? (gstType || 'Unregistered/Consumer') : undefined,
        openingBalance: openingBalance !== undefined ? (Number(openingBalance) || 0) : undefined,
        openingBalanceType: openingBalanceType !== undefined ? (openingBalanceType || null) : undefined,
        asOfDate: asOfDate !== undefined ? (asOfDate || null) : undefined,
        creditLimit: creditLimit !== undefined ? (creditLimit === null ? null : Number(creditLimit)) : undefined,
        status: status !== undefined ? status : undefined
      }, ownFranchiseId);
      res.json(dealer);
    } catch (error: any) {
      const msg = String(error?.message || '');
      if (msg === 'Dealer not found') return res.status(404).json({ error: 'Dealer not found' });
      if (msg.includes('email') && (msg.includes('Unique constraint') || msg.includes('already exists'))) {
        return res.status(409).json({ error: 'A dealer with this email address already exists.' });
      }
      if ((msg.includes('phone') || msg.includes('contact')) && (msg.includes('Unique constraint') || msg.includes('already exists'))) {
        return res.status(409).json({ error: 'A dealer with this contact number already exists.' });
      }
      const cleanMsg = msg.replace(/Invalid `prisma.*?`invocation:\s*/gs, '').trim();
      res.status(400).json({ error: cleanMsg || 'Failed to update dealer' });
    }
  }

  static async getTransactions(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { franchiseId: ownFranchiseId } = IsolationUtil.getFranchiseFilter(user);
      const transactions = await DealerService.getTransactions(req.params.id, ownFranchiseId);
      res.json(transactions);
    } catch (error) {
      const status = (error as Error).message === 'Dealer not found' ? 404 : 500;
      res.status(status).json({ error: (error as Error).message });
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { franchiseId: ownFranchiseId } = IsolationUtil.getFranchiseFilter(user);
      await DealerService.delete(req.params.id, ownFranchiseId);
      res.json({ message: 'Dealer deleted successfully' });
    } catch (error) {
      const status = (error as Error).message === 'Dealer not found' ? 404 : 500;
      res.status(status).json({ error: (error as Error).message });
    }
  }

  static async getItemHistory(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { franchiseId: ownFranchiseId } = IsolationUtil.getFranchiseFilter(user);
      const history = await DealerService.getItemHistory(req.params.id, ownFranchiseId);
      res.json(history);
    } catch (error: any) {
      const status = error.message === 'Dealer not found' ? 404 : 500;
      res.status(status).json({ error: error.message });
    }
  }

}
