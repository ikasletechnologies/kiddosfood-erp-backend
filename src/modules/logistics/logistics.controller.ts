import { Request, Response } from 'express';
import { LogisticsService } from './logistics.service';
import { IsolationUtil } from '../../utils/isolation.util';
import { TransferValidationError } from '../../utils/errors';

export class LogisticsController {
  /**
   * --- STOCK REQUESTS ---
   */
  static async createRequest(req: Request, res: Response) {
    try {
      const result = await LogisticsService.createRequest({
        ...req.body,
        userId: (req as any).user?.userId
      });
      res.status(201).json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async approveRequest(req: Request, res: Response) {
    try {
      const { approvedItems } = req.body;
      const result = await LogisticsService.approveRequest(
        req.params.id, 
        approvedItems, 
        (req as any).user?.userId
      );
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getRequests(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      // Same pattern as getTransfers/getInTransit below: a Franchise Admin is
      // always scoped to their own branch regardless of what franchiseId (if
      // any) the request asked for; only SUPER_ADMIN's query param is honored.
      const franchiseId = user?.role === 'SUPER_ADMIN'
        ? (req.query.franchiseId as string | undefined)
        : IsolationUtil.getFranchiseFilter(user).franchiseId;
      const result = await LogisticsService.getRequests(franchiseId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * --- STOCK TRANSFERS ---
   */
  static async initiateTransfer(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const result = await LogisticsService.initiateTransfer({
        ...req.body,
        userId: user?.userId,
        requestingUser: user
      });
      res.status(201).json(result);
    } catch (error: any) {
      if (error instanceof TransferValidationError) {
        res.status(error.statusCode).json({ error: error.message, details: error.details });
      } else {
        res.status(400).json({ error: error.message });
      }
    }
  }

  static async dispatchTransfer(req: Request, res: Response) {
    try {
      const result = await LogisticsService.dispatchTransfer(
        req.params.id,
        (req as any).user
      );
      res.json(result);
    } catch (error: any) {
      if (error instanceof TransferValidationError) {
        res.status(error.statusCode).json({ error: error.message, details: error.details });
      } else {
        res.status(400).json({ error: error.message });
      }
    }
  }

  static async completeTransfer(req: Request, res: Response) {
    try {
      const result = await LogisticsService.completeTransfer(
        req.params.id,
        (req as any).user
      );
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async getTransfers(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      // Non-super-admins are always scoped to their own branch, regardless
      // of what franchiseId (if any) the request asked for.
      const franchiseId = user?.role === 'SUPER_ADMIN'
        ? (req.query.franchiseId as string | undefined)
        : IsolationUtil.getFranchiseFilter(user).franchiseId;
      const result = await LogisticsService.getTransfers(franchiseId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getInTransit(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = user?.role === 'SUPER_ADMIN'
        ? (req.query.franchiseId as string | undefined)
        : IsolationUtil.getFranchiseFilter(user).franchiseId;
      const result = await LogisticsService.getInTransit(franchiseId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
