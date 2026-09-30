import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorizeRole } from '../../middleware/rbac.middleware';
import { AttachmentService } from './attachment.service';

const router = Router();

router.use(authenticate);
router.use(authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']));

const handle = (fn: (req: Request, user: any) => Promise<any>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await fn(req, (req as any).user));
    } catch (err) {
      next(err);
    }
  };

// GET /api/attachments?entityType=SALES_ORDER&entityId=…  → metadata only
router.get('/', handle((req, user) => AttachmentService.list(user, String(req.query.entityType || ''), String(req.query.entityId || ''))));

// POST /api/attachments  { entityType, entityId, kind, fileName, mimeType, dataBase64 }
router.post('/', handle((req, user) => AttachmentService.upload(user, req.body || {})));

// GET /api/attachments/:id/file  → the file bytes (inline, so images/PDFs open in the browser)
router.get('/:id/file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const file = await AttachmentService.getFile((req as any).user, req.params.id);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(Buffer.from(file.data));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', handle((req, user) => AttachmentService.remove(user, req.params.id)));

export default router;
