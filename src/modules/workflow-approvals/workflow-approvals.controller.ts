import { Request, Response } from 'express';
import { WorkflowApprovalsService } from './workflow-approvals.service';
import prisma from '../../lib/prisma';

function canView(user: any) {
  return user?.role === 'SUPER_ADMIN' || !!user?.customRoleId;
}

export class WorkflowApprovalsController {
  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (!canView(user)) return res.status(403).json({ error: 'Forbidden: no assigned role for workflow approvals' });
      const category = req.query.category as any;
      const items = await WorkflowApprovalsService.getAll(category || undefined);
      res.json(items);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (!canView(user)) return res.status(403).json({ error: 'Forbidden: no assigned role for workflow approvals' });
      const item = await WorkflowApprovalsService.getOne(req.params.id);
      if (!item) return res.status(404).json({ error: 'Workflow request not found' });
      res.json(item);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const dbUser = await prisma.user.findUnique({ where: { id: user.userId } });
      const item = await WorkflowApprovalsService.create(req.body, {
        userId: user.userId,
        fullName: dbUser?.fullName,
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
        { userId: user.userId, role: user.role, fullName: dbUser?.fullName },
        req.body?.notes
      );
      res.json(item);
    } catch (error) {
      res.status((error as any).statusCode || 400).json({ error: (error as Error).message });
    }
  }
}
