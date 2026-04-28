import { Request, Response } from 'express';
import { UserService } from './user.service';
import { AuthenticatedRequest } from '../../types/request';

export class UserController {
  static async getAll(req: Request, res: Response) {
    try {
      const skip = parseInt(req.query.skip as string) || 0;
      const take = parseInt(req.query.take as string) || 20;
      const users = await UserService.getAll(skip, take);
      res.json(users);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getByFranchise(req: Request, res: Response) {
    try {
      const users = await UserService.getByFranchise(req.params.id);
      res.json(users);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const user = await UserService.create(req.body);
      res.status(201).json(user);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const user = await UserService.update(req.params.id, req.body);
      res.json(user);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async resetPassword(req: Request, res: Response) {
    try {
      const { password } = req.body;
      if (!password) {
        return res.status(400).json({ error: 'Password is required' });
      }
      await UserService.updatePassword(req.params.id, password);
      res.json({ message: 'Password reset successfully' });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const user = await UserService.getById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json(user);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getMe(req: Request, res: Response) {
    try {
      // User is already attached by authenticate middleware
      res.json((req as AuthenticatedRequest).user);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      await UserService.delete(req.params.id);
      res.json({ message: 'User deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }
}
