import { Request, Response } from 'express';
import { ProcurementService } from './procurement.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class ProcurementController {
  // --- Supplier (Vendor) Management ---
  static async createVendor(req: Request, res: Response) {
    try {
      const vendor = await ProcurementService.createVendor(req.body);
      res.status(201).json(vendor);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getAllVendors(_req: Request, res: Response) {
    try {
      const vendors = await ProcurementService.getVendors();
      res.json(vendors);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getVendorById(req: Request, res: Response) {
    try {
      const vendor = await ProcurementService.getVendorById(req.params.id);
      if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
      res.json(vendor);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateVendor(req: Request, res: Response) {
    try {
      const vendor = await ProcurementService.updateVendor(req.params.id, req.body);
      res.json(vendor);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async deleteVendor(req: Request, res: Response) {
    try {
      await ProcurementService.deleteVendor(req.params.id);
      res.json({ message: 'Vendor deleted' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // --- Purchase Order (Procurement Order) Management ---
  static async createPO(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = await IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);

      const po = await ProcurementService.createPurchaseOrder({ ...req.body, franchiseId });
      res.status(201).json(po);
    } catch (error: any) {
      console.error(`[ProcurementController] createPO Error:`, error);
      res.status(500).json({ error: error.message });
    }
  }

  static async getPOs(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = user?.role === 'SUPER_ADMIN'
        ? (req.query.franchiseId as string || franchiseFilter.franchiseId)
        : franchiseFilter.franchiseId;

      const pos = await ProcurementService.getPurchaseOrders(franchiseId);
      res.json(pos);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const po = await ProcurementService.getPurchaseOrderById(req.params.id);
      if (!po) return res.status(404).json({ error: 'Purchase Order not found' });
      if (user && user.role !== 'SUPER_ADMIN' && po.franchiseId && po.franchiseId !== user.franchiseId) {
        return res.status(403).json({ error: 'Forbidden: Access denied to this purchase order' });
      }
      res.json(po);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GRN: Receive Goods and Increase Inventory Stock
   * POST /api/purchase-orders/:id/receive
   */
  static async receiveGoods(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const po = await ProcurementService.getPurchaseOrderById(req.params.id);
      if (!po) return res.status(404).json({ error: 'Purchase Order not found' });
      if (user && user.role !== 'SUPER_ADMIN' && po.franchiseId && po.franchiseId !== user.franchiseId) {
        return res.status(403).json({ error: 'Forbidden: Access denied to receive this purchase order' });
      }

      const updatedPO = await ProcurementService.receiveGoods(req.params.id);
      res.status(200).json(updatedPO);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async updatePO(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const po = await ProcurementService.getPurchaseOrderById(req.params.id);
      if (!po) return res.status(404).json({ error: 'Purchase Order not found' });
      if (user && user.role !== 'SUPER_ADMIN' && po.franchiseId && po.franchiseId !== user.franchiseId) {
        return res.status(403).json({ error: 'Forbidden: Access denied to update this purchase order' });
      }

      const updatedPo = await ProcurementService.updatePO(req.params.id, req.body);
      res.json(updatedPo);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async approvePO(req: Request, res: Response) {
    try {
      const po = await ProcurementService.approvePO(req.params.id);
      res.json(po);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async updatePOStatus(req: Request, res: Response) {
    try {
      const { status } = req.body;
      const po = await ProcurementService.updatePOStatus(req.params.id, status);
      res.json(po);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async cancelPO(req: Request, res: Response) {
    try {
      const po = await ProcurementService.cancelPO(req.params.id);
      res.json(po);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async deletePO(req: Request, res: Response) {
    try {
      await ProcurementService.deletePO(req.params.id);
      res.json({ message: 'Purchase Order deleted' });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /**
   * Record advance payment against a PO
   * PATCH /api/purchase-orders/:id/advance
   */
  static async recordAdvance(req: Request, res: Response) {
    try {
      const { advancePaid } = req.body;
      if (typeof advancePaid !== 'number' || advancePaid < 0) {
        return res.status(400).json({ error: 'advancePaid must be a non-negative number' });
      }
      const po = await ProcurementService.recordAdvancePayment(req.params.id, advancePaid);
      res.json(po);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Apply available vendor credit balance to an existing PO (mark as paid from ledger)
   * POST /api/purchase-orders/:id/apply-advance
   */
  static async applyAdvance(req: Request, res: Response) {
    try {
      const po = await ProcurementService.applyAdvanceToPO(req.params.id);
      res.json(po);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async linkMaterial(req: Request, res: Response) {
    try {
      const { vendorId, materialId, price, quantity } = req.body;
      const link = await ProcurementService.linkMaterialToVendor(vendorId, materialId, price, quantity);
      res.json(link);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getVendorSummary(_req: Request, res: Response) {
    try {
      const summary = await ProcurementService.getVendorsSummary();
      res.json(summary);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async filterVendors(req: Request, res: Response) {
    try {
      const { materialId, balanceType, minPrice, maxPrice } = req.query;
      const data = await ProcurementService.filterVendors({
        materialId,
        balanceType,
        minPrice,
        maxPrice
      });
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // --- Ledger Management ---
  static async getVendorLedger(req: Request, res: Response) {
    try {
      const data = await ProcurementService.getVendorLedger(req.params.id, req.query);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async recordPayment(req: Request, res: Response) {
    try {
      const data = await ProcurementService.recordPayment(req.params.id, req.body);
      res.json(data);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async recordAdjustment(req: Request, res: Response) {
    try {
      const { amount, type, note, referenceType } = req.body;
      const data = await ProcurementService.recordAdjustment(req.params.id, amount, type, note, referenceType);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getVendorAging(req: Request, res: Response) {
    try {
      const aging = await ProcurementService.getVendorAging(req.params.id);
      res.json(aging);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getNextPaymentNumber(req: Request, res: Response) {
    try {
      const data = await ProcurementService.getNextPaymentNumber(req.query.date as string | undefined);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
