import { Request, Response } from 'express';
import { RolesService } from './roles.service';

export class RolesController {
  static async getAll(req: Request, res: Response) {
    try {
      const roles = await RolesService.getAll();
      res.json(roles);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const role = await RolesService.getOne(req.params.id);
      if (!role) return res.status(404).json({ error: 'Role not found' });
      res.json(role);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const actingUserId = (req as any).user.userId;
      const role = await RolesService.create(req.body, actingUserId);
      res.status(201).json(role);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const actingUserId = (req as any).user.userId;
      const role = await RolesService.update(req.params.id, req.body, actingUserId);
      res.json(role);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      const actingUserId = (req as any).user.userId;
      await RolesService.delete(req.params.id, actingUserId);
      res.json({ message: 'Role deleted successfully' });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }
}
