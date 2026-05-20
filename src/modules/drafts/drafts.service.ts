import prisma from '../../lib/prisma';

export class DraftsService {
  static async getDrafts(userId: string, type: string) {
    return prisma.draft.findMany({
      where: { userId, type },
      orderBy: { updatedAt: 'desc' },
    });
  }

  static async saveDraft(userId: string, draft: { id?: string; type: string; data: any }) {
    if (draft.id) {
      return prisma.draft.update({
        where: { id: draft.id },
        data: { data: draft.data, updatedAt: new Date() },
      });
    }
    return prisma.draft.create({
      data: { type: draft.type, userId, data: draft.data },
    });
  }

  static async deleteDraft(id: string) {
    return prisma.draft.delete({ where: { id } });
  }
}
