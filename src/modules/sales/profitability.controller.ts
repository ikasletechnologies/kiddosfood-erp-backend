import { Request, Response } from 'express';
import { IsolationUtil } from '../../utils/isolation.util';
import { SalesProfitabilityService } from './sales-profitability.service';
import { canViewCost } from './profitability';

/**
 * Estimated profit/loss for Sales Orders and POS. Read-only: prices, tax and
 * discounts are re-derived server-side; nothing is saved or deducted. Cost
 * data is only returned to roles allowed to see it.
 */
export class ProfitabilityController {
  static async estimateSalesOrder(req: Request, res: Response) {
    if (!canViewCost((req as any).user)) return res.status(403).json({ error: 'Not authorized to view cost and profit.' });
    try {
      res.json(await SalesProfitabilityService.estimateSalesOrder({ items: req.body?.items, discountAmount: req.body?.discountAmount }));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async estimatePos(req: Request, res: Response) {
    const user = (req as any).user;
    if (!canViewCost(user)) return res.status(403).json({ error: 'Not authorized to view cost and profit.' });
    try {
      // Same franchise scoping as POS checkout.
      const franchiseId = await IsolationUtil.enforceFranchiseMatch(user, req.body?.franchiseId);
      if (!franchiseId) return res.status(400).json({ error: 'Franchise could not be resolved for this bill.' });
      res.json(await SalesProfitabilityService.estimatePos({
        franchiseId,
        partyType: req.body?.partyType,
        items: req.body?.items,
        manualDiscount: req.body?.manualDiscount,
      }));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }
}
