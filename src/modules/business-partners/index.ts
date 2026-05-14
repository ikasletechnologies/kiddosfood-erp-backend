import { Router } from 'express';
import { BusinessPartnerController } from './business-partner.controller';
import { authenticate, authorizeRole } from '../../middleware/rbac.middleware';

const router = Router();

router.get('/', authenticate, BusinessPartnerController.getAll);
router.post('/', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), BusinessPartnerController.create);
router.delete('/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), BusinessPartnerController.delete);

export default router;
