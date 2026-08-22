import { Request, Response } from 'express';
import { WorkflowApprovalsService } from './workflow-approvals.service';
import prisma from '../../lib/prisma';

export class WorkflowApprovalsController {
  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const category = req.query.category as any;
      const franchiseId = user.role === 'SUPER_ADMIN' ? undefined : user.franchiseId;
      const items = await WorkflowApprovalsService.getAll(category || undefined, franchiseId);
      res.json(items);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = user.role === 'SUPER_ADMIN' ? undefined : user.franchiseId;
      const item = await WorkflowApprovalsService.getOne(req.params.id, franchiseId);
      if (!item) return res.status(404).json({ error: 'Workflow request not found' });
      res.json(item);
    } catch (error) {
      res.status((error as any).statusCode || 500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const dbUser = await prisma.user.findUnique({ where: { id: user.userId } });
      const item = await WorkflowApprovalsService.create(req.body, {
        userId: user.userId,
        fullName: dbUser?.fullName,
        role: user.role,
        franchiseId: user.franchiseId,
      });
      res.status(201).json(item);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async approve(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const dbUser = await prisma.user.findUnique({ where: { id: user.userId } });
      const item = await WorkflowApprovalsService.approve(
        req.params.id,
        { userId: user.userId, role: user.role, fullName: dbUser?.fullName, franchiseId: user.franchiseId },
        req.body?.notes
      );
      res.json(item);
    } catch (error) {
      res.status((error as any).statusCode || 400).json({ error: (error as Error).message });
    }
  }
}
