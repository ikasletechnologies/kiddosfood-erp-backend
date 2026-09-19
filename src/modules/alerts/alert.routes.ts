import { Router } from 'express';
import { authenticate, authorizeRole } from '../../middleware/rbac.middleware';
import { AlertController } from './alert.controller';

const router = Router();

router.use(authenticate);
router.use(authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']));

router.get('/', AlertController.getAlerts);
router.get('/summary', AlertController.getSummary);
router.patch('/:id/read', AlertController.markAsRead);
router.post('/mark-all-read', AlertController.markAllAsRead);
router.post('/reconcile', AlertController.reconcile);

export default router;
