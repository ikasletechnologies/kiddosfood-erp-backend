import prisma from '../../lib/prisma';

export class DeliveryService {
  static async createOrder(data: { orderId: string, riderName?: string, customerPhone: string }) {
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    return prisma.delivery.create({
      data: {
        orderId: data.orderId,
        riderName: data.riderName,
        customerPhone: data.customerPhone,
        otp,
        status: 'PENDING'
      }
    });
  }

  static async updateStatus(id: string, status: string) {
    return prisma.delivery.update({
      where: { id },
      data: { status }
    });
  }

  static async verifyOTP(id: string, otp: string) {
    const delivery = await prisma.delivery.findUnique({ where: { id } });
    if (delivery?.otp === otp) {
      return prisma.delivery.update({
        where: { id },
        data: { status: 'DELIVERED' }
      });
    }
    throw new Error('Invalid OTP');
  }

  static async getActiveDeliveries() {
    return prisma.delivery.findMany({
      where: {
        status: { in: ['PENDING', 'ASSIGNED', 'IN_TRANSIT'] }
      },
      include: {
        order: { include: { orderItems: { include: { product: true } }, customer: true } }
      }
    });
  }
}
