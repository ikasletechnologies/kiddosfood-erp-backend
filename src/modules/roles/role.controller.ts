import { Request, Response } from 'express';
import { RoleService } from './role.service';

export class RoleController {
  static async getAll(req: Request, res: Response) {
    try {
      const roles = await RoleService.getRoles();
      res.json(roles);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const role = await RoleService.getRoleById(req.params.id);
      if (!role) return res.status(404).json({ error: 'Role not found' });
      res.json(role);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const role = await RoleService.createRole(req.body);
      res.status(201).json(role);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const role = await RoleService.updateRole(req.params.id, req.body);
      res.json(role);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      await RoleService.deleteRole(req.params.id);
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
