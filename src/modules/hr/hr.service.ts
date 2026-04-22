import prisma from '../../lib/prisma';

export class HRService {
  static async checkIn(userId: string) {
    return prisma.attendance.create({
      data: {
        userId,
        checkIn: new Date(),
        status: 'PRESENT'
      }
    });
  }

  static async checkOut(id: string) {
    return prisma.attendance.update({
      where: { id },
      data: { checkOut: new Date() }
    });
  }

  static async getDailyLogs(date: Date) {
    const startOfDay = new Date(date.setHours(0, 0, 0, 0));
    const endOfDay = new Date(date.setHours(23, 59, 59, 999));

    return prisma.attendance.findMany({
      where: {
        checkIn: { gte: startOfDay, lte: endOfDay }
      },
      include: { user: true }
    });
  }
}
