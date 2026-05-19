import { Request, Response, NextFunction } from 'express';
import { JwtUtil } from '../lib/jwt.util';
import { AppError } from './error.middleware';
import prisma from '../lib/prisma';

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next(new AppError('Unauthorized: No token provided', 401));
  }

  const decoded = JwtUtil.verifyAccessToken(token);
  if (!decoded) {
    return next(new AppError('Unauthorized: Invalid or expired access token', 401));
  }

  (req as any).user = decoded;
  next();
};

export const authorizeRole = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    
    // Diagnostic Log
    console.log(`[RBAC] UserID: ${user?.userId} | Role: ${user?.role} | Required: [${allowedRoles.join(', ')}]`);

    // Super Admin bypass (God-Mode)
    if (user && user.role === 'SUPER_ADMIN') {
        return next();
    }

    if (!user || !allowedRoles.includes(user.role)) {
      return next(new AppError('Forbidden: Insufficient role permissions', 403));
    }
    next();
  };
};
