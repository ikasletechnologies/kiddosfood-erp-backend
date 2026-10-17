import { Request, Response } from 'express';
import { IsolationUtil } from '../../utils/isolation.util';
import { LotPricingError, LotPricingService } from './lot-pricing.service';
import { canEditLotPrice } from './lot-pricing';
import { ProductPricingService } from './product-pricing.service';

function fail(res: Response, error: unknown) {
  if (error instanceof LotPricingError) {
    return res.status(error.status).json({ error: error.message, code: error.code, details: error.details });
  }
  return res.status(400).json({ error: (error as Error).message });
}

/** Production > Set Price (product prices), finished-goods lots and sales lot selection. */
export class LotPricingController {
  static async listLots(req: Request, res: Response) {
    try {
      res.json(await LotPricingService.listLots(req.query as any, (req as any).user));
    } catch (error) {
      fail(res, error);
    }
  }

  static async getLot(req: Request, res: Response) {
    try {
      res.json(await LotPricingService.getLot(req.params.id, (req as any).user));
    } catch (error) {
      fail(res, error);
    }
  }

  // ─── Product-level prices (Customer / Dealer / Franchise) ───────────────

  static async listProducts(req: Request, res: Response) {
    try {
      res.json(await ProductPricingService.listProducts(req.query as any, (req as any).user));
    } catch (error) {
      fail(res, error);
    }
  }

  static async getProduct(req: Request, res: Response) {
    try {
      res.json(await ProductPricingService.getProduct(req.params.id, (req as any).user));
    } catch (error) {
      fail(res, error);
    }
  }

  static async setProductPrices(req: Request, res: Response) {
    const user = (req as any).user;
    // Same authority as Product Master pricing; the route is also role-gated.
    if (!canEditLotPrice(user)) return res.status(403).json({ error: 'Not authorized to change selling prices.' });
    try {
      res.json(await ProductPricingService.setPrices(req.params.id, req.body || {}, user));
    } catch (error) {
      fail(res, error);
    }
  }

  static async saleLotOptions(req: Request, res: Response) {
    const user = (req as any).user;
    try {
      const productId = String(req.query.productId || '');
      if (!productId) return res.status(400).json({ error: 'productId is required.' });
      // scope=HQ: Estimate / Sales Order / Proforma, which always price from
      // HQ stock (see applyAuthoritativePricing). Otherwise the seller
      // branch: a branch user only ever gets its own branch's lots; super
      // admin may name a branch, or gets HQ by default.
      const requested = req.query.franchiseId ? String(req.query.franchiseId) : undefined;
      const franchiseId = req.query.scope === 'HQ'
        ? null
        : user?.role === 'SUPER_ADMIN'
          ? requested || null
          : await IsolationUtil.enforceFranchiseMatch(user, requested);
      res.json(await LotPricingService.saleLotOptions({ productId, franchiseId }, user));
    } catch (error) {
      fail(res, error);
    }
  }
}
