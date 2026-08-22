import { Request, Response } from 'express';
import { PermissionsService } from './permissions.service';

export class PermissionsController {
  static async getAll(req: Request, res: Response) {
    try {
      const permissions = await PermissionsService.getAll();
      const shaped = permissions.map((p) => ({
        id: p.id,
        key: p.key,
        module: p.module,
        action: p.action,
        label: p.label,
        roles: p.roles.map((rp) => rp.role),
      }));
      res.json(shaped);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }
}
