import { IsolationUtil } from '../../utils/isolation.util';
import { Request, Response } from 'express';
import { FranchiseService } from './franchise.service';
import { LogisticsService } from './logistics.service';
import prisma from '../../lib/prisma';

export class FranchiseController {
  static async create(req: Request, res: Response) {
    try {
      const franchise = await FranchiseService.create(req.body);
      res.status(201).json(franchise);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = user && user.role !== 'SUPER_ADMIN' ? user.franchiseId : undefined;
      const franchises = await FranchiseService.getAll(franchiseId);
      res.json(franchises);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (user && user.role !== 'SUPER_ADMIN' && user.franchiseId && user.franchiseId !== req.params.id) {
        return res.status(403).json({ error: 'Access denied to other franchise details' });
      }
      const franchise = await FranchiseService.getById(req.params.id);
      if (!franchise) return res.status(404).json({ error: 'Franchise not found' });
      res.json(franchise);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const { name, location, ownerName, contactNum, status } = req.body;
      const updateData: any = {};
      if (name !== undefined) updateData.name = name;
      if (location !== undefined) updateData.location = location;
      if (ownerName !== undefined) updateData.ownerName = ownerName;
      if (contactNum !== undefined) updateData.contactNum = contactNum;
      if (status !== undefined) updateData.status = status;

      const franchise = await prisma.franchise.update({ 
        where: { id: req.params.id }, 
        data: updateData 
      });
      res.json(franchise);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async deleteFranchise(req: Request, res: Response) {
    try {
      // Soft delete: Change status to DELETED
      await prisma.franchise.update({ 
        where: { id: req.params.id }, 
        data: { status: 'DELETED' } 
      });
      res.json({ message: 'Franchise deactivated and marked as deleted' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getRequests(req: Request, res: Response) {
    try {
      const requests = await prisma.stockRequest.findMany({
        include: { franchise: true, items: { include: { inventoryItem: true } } },
        orderBy: { requestedAt: 'desc' }
      });
      res.json(requests);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createRequest(req: Request, res: Response) {
    try {
      const { franchiseId, items } = req.body;
      const request = await prisma.stockRequest.create({
        data: {
          franchiseId,
          status: 'PENDING',
          items: {
            create: items.map((i: any) => ({
              inventoryItemId: i.inventoryItemId,
              requestedQty: i.requestedQty
            }))
          }
        },
        include: { items: true }
      });
      res.status(201).json(request);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // --- Fulfillment & Logistics ---

  static async fulfillRequest(req: Request, res: Response) {
    try {
      const { requestId, fromBranchId } = req.body;
      const user = (req as any).user;
      const transfer = await LogisticsService.fulfillRequest(requestId, fromBranchId, user.userId);
      res.json(transfer);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getAllTransfers(req: Request, res: Response) {
    try {
        const transfers = await prisma.stockTransfer.findMany({
            include: { fromBranch: true, toBranch: true, items: true },
            orderBy: { createdAt: 'desc' }
        });
        res.json(transfers);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
  }

  static async updateTransferStatus(req: Request, res: Response) {
    try {
      const { status } = req.body;
      const user = (req as any).user;
      const transfer = await LogisticsService.updateTransferStatus(req.params.id, status, user.userId);
      res.json(transfer);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ─── Franchise Product Requests (FranchiseRequest model) ─────────────────────

  static async getProductRequests(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const where: any = { requestType: 'PRODUCT_REQUEST' };
      if (user.franchiseId) where.franchiseId = user.franchiseId;

      const requests = await prisma.franchiseRequest.findMany({
        where,
        include: { franchise: true },
        orderBy: { createdAt: 'desc' },
      });
      res.json(requests);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createProductRequest(req: Request, res: Response) {
    try {
      const { franchiseId, products } = req.body;
      const request = await prisma.franchiseRequest.create({
        data: {
          franchiseId,
          requestType: 'PRODUCT_REQUEST',
          status: 'PENDING',
          details: { products },
        },
        include: { franchise: true },
      });
      res.status(201).json(request);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async deleteProductRequest(req: Request, res: Response) {
    try {
      await prisma.franchiseRequest.delete({ where: { id: req.params.id } });
      res.json({ message: 'Request deleted' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateProductRequest(req: Request, res: Response) {
    try {
      const { status, adminResponse } = req.body;
      const user = (req as any).user;
      const request = await prisma.franchiseRequest.update({
        where: { id: req.params.id },
        data: { status, adminResponse, managedById: user.userId },
        include: { franchise: true },
      });
      res.json(request);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async verifyDashboardPassword(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { password } = req.body;
      const isValid = await FranchiseService.verifyDashboardPassword(id, password);
      res.json({ isValid });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getWarehouseStatus(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = user.role === 'SUPER_ADMIN'
        ? ((req.query.franchiseId as string) || user.franchiseId)
        : user.franchiseId;

      if (!franchiseId) {
        return res.status(400).json({ error: 'Franchise context is required' });
      }

      const status = await FranchiseService.getWarehouseStatus(franchiseId);
      res.json(status);
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message });
    }
  }

  static async setupWarehouse(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = user.role === 'SUPER_ADMIN'
        ? ((req.body.franchiseId as string) || (req.query.franchiseId as string) || user.franchiseId)
        : user.franchiseId;

      if (!franchiseId) {
        return res.status(400).json({ error: 'Franchise context is required' });
      }

      const { name, location, code } = req.body;
      const warehouse = await FranchiseService.setupFranchiseWarehouse(franchiseId, {
        name,
        location,
        code,
      });
      res.status(201).json(warehouse);
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message });
    }
  }

}
