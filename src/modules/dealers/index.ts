import { Router } from 'express';
import { DealerController } from './dealer.controller';
import { authenticate, authorizeRole } from '../../middleware/rbac.middleware';

const router = Router();

router.get('/', authenticate, DealerController.getAll);
router.post('/', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), DealerController.create);
router.get('/:id', authenticate, DealerController.getById);
router.patch('/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), DealerController.update);
router.get('/:id/transactions', authenticate, DealerController.getTransactions);
router.delete('/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), DealerController.delete);

export default router;
