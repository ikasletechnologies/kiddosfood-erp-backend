import prisma from '../../lib/prisma';

export class WasteService {
  static async getAll(_dateFrom?: string, _dateTo?: string) {
    return [];
  }

  static async getById(_id: string) {
    return null;
  }

  static async create(data: any) {
    console.log('WasteService.create (MOCKED - Model deleted):', data);
    return { id: 'mocked', ...data };
  }

  static async getSummary() {
    return {
      todayCost: 0,
      todayQty: 0,
      weekCost: 0,
      topWastedItem: null
    };
  }
}
