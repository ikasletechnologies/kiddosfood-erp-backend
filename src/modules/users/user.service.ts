import prisma from '../../lib/prisma';
import { AuthService } from '../auth/auth.service';
import { AppError } from '../../middleware/error.middleware';

export class UserService {
  static async getAll(skip = 0, take = 20) {
    return prisma.user.findMany({
      skip,
      take,
      include: { role: true, franchise: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      include: { role: true, franchise: true }
    });
  }

  static async getByFranchise(franchiseId: string) {
    return prisma.user.findMany({
      where: { franchiseId },
      include: { role: true },
    });
  }

  static async create(data: {
    fullName: string;
    email: string;
    phone?: string;
    password?: string;
    roleName: string;
    franchiseId?: string;
  }) {
    // 1. Check if user exists
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new AppError('User with this email already exists', 400);

    // 2. Find Role
    const role = await prisma.role.findUnique({ where: { name: data.roleName.toUpperCase() } });
    if (!role) throw new AppError(`Role [${data.roleName}] not found`, 404);

    // 3. Hash Password (default to admin123 if not provided)
    const passwordHash = await AuthService.hashPassword(data.password || 'admin123');

    // 4. Create
    return prisma.user.create({
      data: {
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        passwordHash,
        roleId: role.id,
        franchiseId: data.franchiseId,
        is_active: true
      },
      include: { role: true, franchise: true }
    });
  }

  static async updatePassword(userId: string, newPassword: string) {
    const passwordHash = await AuthService.hashPassword(newPassword);
    return prisma.user.update({
      where: { id: userId },
      data: { passwordHash }
    });
  }

  static async update(id: string, data: any) {
    if (data.email) {
        const existing = await prisma.user.findFirst({
            where: { email: data.email, id: { not: id } }
        });
        if (existing) throw new AppError('Email already in use', 400);
    }

    return prisma.user.update({
      where: { id },
      data,
      include: { role: true }
    });
  }

  static async delete(id: string) {
    return prisma.user.delete({ where: { id } });
  }
}
