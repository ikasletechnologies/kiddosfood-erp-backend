import { AppError } from '../../middleware/error.middleware';
import {FRANCHISE_PHOTO_ENTITY} from '../attachments/franchise-photo';
import { IsolationUtil } from '../../utils/isolation.util';
import { Request, Response } from 'express';
import { FranchiseService } from './franchise.service';
import { LogisticsService } from './logistics.service';
import prisma from '../../lib/prisma';
import { encryptField } from '../../lib/field-crypto';
import { FieldValidationError, validateKycFields } from './franchise.validation';

// Field-specific validation errors (400, or 409 for a duplicate email) carry a
// fieldErrors map the Add/Edit Franchise form shows next to each input.
function sendFranchiseError(res: Response, error: any) {
  if (error instanceof FieldValidationError) {
    return res.status(error.statusCode).json({ error: error.message, fieldErrors: error.fieldErrors });
  }
  return res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error.message });
}

export class FranchiseController {
  static async create(req: Request, res: Response) {
    try {
      const franchise = await FranchiseService.create(req.body,(req as any).user?.userId);
      res.status(201).json(franchise);
    } catch (error: any) {
      sendFranchiseError(res, error);
    }
  }

  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if(!user || (user.role!=='SUPER_ADMIN' && !user.franchiseId)) return res.status(403).json({error:'Franchise assignment is required'});
      const franchiseId = user.role !== 'SUPER_ADMIN' ? user.franchiseId : undefined;
      const franchises = await FranchiseService.getAll(franchiseId, { includeAadhaar: user?.role === 'SUPER_ADMIN' });
      res.json(franchises);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (!user || (user.role !== 'SUPER_ADMIN' && (!user.franchiseId || user.franchiseId !== req.params.id))) {
        return res.status(403).json({ error: 'Access denied to other franchise details' });
      }
      const franchise = await FranchiseService.getById(req.params.id, { includeAadhaar: user?.role === 'SUPER_ADMIN' });
      if (!franchise) return res.status(404).json({ error: 'Franchise not found' });
      res.json(franchise);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const actor=(req as any).user;
      if(!actor || (actor.role!=='SUPER_ADMIN' && (!actor.franchiseId || actor.franchiseId!==req.params.id))) return res.status(403).json({error:'Access denied to other franchise details'});
      const { name, location, ownerName, contactNum, status } = req.body;
      const updateData: any = {};
      if (name !== undefined) updateData.name = name;
      if (location !== undefined) updateData.location = location;
      if (ownerName !== undefined) updateData.ownerName = ownerName;
      if (contactNum !== undefined) updateData.contactNum = contactNum;
      if (status !== undefined) updateData.status = status;

      // Optional Aadhaar / PAN. Omitted or empty Aadhaar keeps the stored
      // value (the edit form can't pre-fill it); null removes it.
      const kycInput: any = {};
      if (req.body.aadhaarNumber !== undefined) kycInput.aadhaarNumber = req.body.aadhaarNumber;
      if (req.body.panNumber !== undefined) kycInput.panNumber = req.body.panNumber;
      const { data: kyc, errors } = validateKycFields(kycInput);
      if (Object.keys(errors).length) throw new FieldValidationError(errors);
      if (kyc.panNumber !== undefined) updateData.panNumber = kyc.panNumber;
      if (kyc.aadhaarNumber === null) {
        updateData.aadhaarEncrypted = null;
        updateData.aadhaarLast4 = null;
      } else if (kyc.aadhaarNumber) {
        updateData.aadhaarEncrypted = encryptField(kyc.aadhaarNumber);
        updateData.aadhaarLast4 = kyc.aadhaarNumber.slice(-4);
      }

      if(Object.prototype.hasOwnProperty.call(req.body,'photo')) updateData.photo=req.body.photo;
      const franchise = await FranchiseService.update(req.params.id,updateData,actor.userId);
      res.json(FranchiseService.toSafeFranchise(franchise));
    } catch (error: any) {
      sendFranchiseError(res, error);
    }
  }

  static async getPhoto(req:Request,res:Response) {
    try {
      const user=(req as any).user;
      if(!user || (user.role!=='SUPER_ADMIN' && (!user.franchiseId || user.franchiseId!==req.params.id)))return res.status(403).json({error:'Access denied to other franchise photos'});
      const file=await prisma.attachment.findFirst({where:{entityType:FRANCHISE_PHOTO_ENTITY,entityId:req.params.id},orderBy:{createdAt:'desc'}});
      if(!file)return res.status(404).json({error:'No franchise photo'});
      res.setHeader('Content-Type',file.mimeType);res.setHeader('Content-Length',String(file.size));
      res.setHeader('Content-Disposition','inline; filename="'+file.fileName+'"');
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','private, no-store');
      res.end(Buffer.from(file.data));
    } catch(error:any){sendFranchiseError(res,error);}
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
