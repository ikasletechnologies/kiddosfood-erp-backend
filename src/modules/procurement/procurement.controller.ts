import { Request, Response } from 'express';
import { ProcurementService } from './procurement.service';

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
      const po = await ProcurementService.createPurchaseOrder(req.body);
      res.status(201).json(po);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPOs(_req: Request, res: Response) {
    try {
      const pos = await ProcurementService.getPurchaseOrders();
      res.json(pos);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const po = await ProcurementService.getPurchaseOrderById(req.params.id);
      if (!po) return res.status(404).json({ error: 'Purchase Order not found' });
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
      const updatedPO = await ProcurementService.receiveGoods(req.params.id);
      res.status(200).json(updatedPO);
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

  static async linkMaterial(req: Request, res: Response) {
    try {
      const { vendorId, materialId, price } = req.body;
      const link = await ProcurementService.linkMaterialToVendor(vendorId, materialId, price);
      res.json(link);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
