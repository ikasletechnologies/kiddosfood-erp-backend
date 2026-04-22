import { Request, Response, NextFunction } from 'express';
import { JwtUtil } from '../lib/jwt.util';

export const authMiddleware = (requiredRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const decoded = JwtUtil.verifyAccessToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }

    const userRole: string = (decoded as any).role || '';
    const hasRole = requiredRoles.length === 0 || requiredRoles.includes(userRole);

    if (!hasRole) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }

    (req as any).user = decoded;
    next();
  };
};
