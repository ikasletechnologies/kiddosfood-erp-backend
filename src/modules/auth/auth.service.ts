import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma';
import { JwtUtil, TokenPayload } from '../../lib/jwt.util';
import { AppError } from '../../middleware/error.middleware';

export class AuthService {
  static async hashPassword(password: string): Promise<string> {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
  }

  static async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  static async login(identifier: string, password: string) {
    // 1. Find user by email or phone
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { phone: identifier }
        ]
      },
      include: { 
        role: {
          include: {
            permissions: {
              include: { permission: true }
            }
          }
        }
      }
    });

    if (!user) throw new AppError('Invalid credentials', 401);
    if (!user.is_active) throw new AppError('Account is inactive. Please contact admin.', 403);

    // 2. Check password
    const isMatch = await this.comparePassword(password, user.passwordHash);
    if (!isMatch) throw new AppError('Invalid credentials', 401);

    // 3. Prepare payload
    const permissions = user.role.permissions.map(rp => rp.permission.key);
    const payload: TokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role.name,
      franchiseId: user.franchiseId,
      branchId: user.branchId,
      permissions
    };

    // 4. Generate Tokens
    const accessToken = JwtUtil.generateAccessToken(payload);
    const refreshToken = JwtUtil.generateRefreshToken(payload);

    // 5. Store Refresh Token in DB
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      }
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role.name,
        franchiseId: user.franchiseId,
        permissions
      }
    };
  }

  static async refresh(refreshToken: string) {
    // 1. Verify token signature
    const payload = JwtUtil.verifyRefreshToken(refreshToken);
    if (!payload) throw new AppError('Invalid refresh token', 401);

    // 2. Check DB
    const storedToken = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: { include: { role: { include: { permissions: { include: { permission: true } } } } } } }
    });

    if (!storedToken || storedToken.isRevoked || storedToken.expiresAt < new Date()) {
      throw new AppError('Refresh token expired or revoked', 401);
    }

    // 3. Optional: Rotation (Revoke old, issue new)
    await prisma.refreshToken.deleteMany({ where: { id: storedToken.id } });

    const user = storedToken.user;
    const permissions = user.role.permissions.map(rp => rp.permission.key);
    const newPayload: TokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role.name,
      franchiseId: user.franchiseId,
      branchId: user.branchId,
      permissions
    };

    const newAccessToken = JwtUtil.generateAccessToken(newPayload);
    const newRefreshToken = JwtUtil.generateRefreshToken(newPayload);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: newRefreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }
    });

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    };
  }

  static async logout(refreshToken: string) {
    await prisma.refreshToken.deleteMany({
      where: { token: refreshToken }
    });
  }

  static async register(data: { fullName: string; email: string; phone?: string; password: string; roleName: string }) {
    // 1. Check if user exists
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email: data.email },
          ...(data.phone ? [{ phone: data.phone }] : [])
        ]
      }
    });

    if (existing) {
      throw new AppError('User with this email or phone already exists', 400);
    }

    // 2. Find role
    if (!data.roleName) {
        throw new AppError('roleName is required for registration', 400);
    }
    const role = await prisma.role.findUnique({
      where: { name: data.roleName.toUpperCase() }
    });

    if (!role) {
      throw new AppError(`Role [${data.roleName}] not found`, 404);
    }

    // 3. Hash password
    const passwordHash = await this.hashPassword(data.password);

    // 4. Create user
    const user = await prisma.user.create({
      data: {
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        passwordHash,
        roleId: role.id,
        is_active: true
      },
      include: { role: true }
    });

    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role.name
    };
  }
}
