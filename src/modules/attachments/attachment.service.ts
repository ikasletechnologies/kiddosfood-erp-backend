import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error.middleware';
import { TokenPayload } from '../../lib/jwt.util';

// File attachments for documents (first user: Sales Order Image/Document).
// Files arrive base64-encoded in JSON and are stored as bytes in the
// Attachment table — no external storage to configure per host.

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB per file
const MAX_PER_ENTITY = 10;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const DOCUMENT_TYPES = [
  ...IMAGE_TYPES,
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
];

// Entity types that may carry attachments, and how to confirm the record exists.
const ENTITY_LOOKUP: Record<string, (id: string) => Promise<unknown>> = {
  SALES_ORDER: (id) => prisma.salesOrder.findUnique({ where: { id }, select: { id: true } }),
};

type Meta = { id: string; entityType: string; entityId: string; kind: string; fileName: string; mimeType: string; size: number; createdAt: Date };
const META_SELECT = { id: true, entityType: true, entityId: true, kind: true, fileName: true, mimeType: true, size: true, createdAt: true, franchiseId: true } as const;

export class AttachmentService {
  private static assertEntityType(entityType: string) {
    if (!ENTITY_LOOKUP[entityType]) throw new AppError(`Attachments are not supported for "${entityType}"`, 400);
  }

  private static canAccess(user: TokenPayload, row: { franchiseId: string | null }) {
    return user.role === 'SUPER_ADMIN' || row.franchiseId === (user.franchiseId || null);
  }

  static async list(user: TokenPayload, entityType: string, entityId: string): Promise<Meta[]> {
    this.assertEntityType(entityType);
    if (!entityId) throw new AppError('entityId is required', 400);
    const rows = await prisma.attachment.findMany({
      where: { entityType, entityId, ...(user.role === 'SUPER_ADMIN' ? {} : { franchiseId: user.franchiseId || null }) },
      select: META_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(({ franchiseId, ...m }) => m);
  }

  static async upload(user: TokenPayload, body: { entityType?: string; entityId?: string; kind?: string; fileName?: string; mimeType?: string; dataBase64?: string }) {
    const entityType = String(body.entityType || '');
    const entityId = String(body.entityId || '');
    this.assertEntityType(entityType);
    if (!entityId) throw new AppError('entityId is required', 400);
    if (!(await ENTITY_LOOKUP[entityType](entityId))) throw new AppError('The document to attach to was not found', 404);

    const kind = body.kind === 'IMAGE' ? 'IMAGE' : 'DOCUMENT';
    const mimeType = String(body.mimeType || '').toLowerCase();
    const allowed = kind === 'IMAGE' ? IMAGE_TYPES : DOCUMENT_TYPES;
    if (!allowed.includes(mimeType)) {
      throw new AppError(kind === 'IMAGE'
        ? 'Only JPG, PNG, WEBP or GIF images can be attached'
        : 'Only PDF, Word, Excel, CSV, text or image files can be attached', 422);
    }

    const fileName = String(body.fileName || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 200) || 'file';
    const b64 = String(body.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!b64) throw new AppError('File content is empty', 422);
    const data = Buffer.from(b64, 'base64');
    if (data.length === 0) throw new AppError('File content is empty', 422);
    if (data.length > MAX_ATTACHMENT_BYTES) throw new AppError('File is larger than 5 MB', 413);

    const count = await prisma.attachment.count({ where: { entityType, entityId } });
    if (count >= MAX_PER_ENTITY) throw new AppError(`A document can have at most ${MAX_PER_ENTITY} attachments`, 422);

    const row = await prisma.attachment.create({
      data: {
        entityType, entityId, kind, fileName, mimeType, size: data.length, data,
        franchiseId: user.franchiseId || null, uploadedBy: user.userId,
      },
      select: META_SELECT,
    });
    const { franchiseId, ...meta } = row;
    return meta;
  }

  static async getFile(user: TokenPayload, id: string) {
    const row = await prisma.attachment.findUnique({ where: { id } });
    if (!row || !this.canAccess(user, row)) throw new AppError('Attachment not found', 404);
    return row;
  }

  static async remove(user: TokenPayload, id: string) {
    const row = await prisma.attachment.findUnique({ where: { id }, select: { id: true, franchiseId: true } });
    if (!row || !this.canAccess(user, row)) throw new AppError('Attachment not found', 404);
    await prisma.attachment.delete({ where: { id } });
    return { success: true };
  }
}
