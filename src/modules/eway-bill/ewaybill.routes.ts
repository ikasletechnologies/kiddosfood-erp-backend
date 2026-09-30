import { Router } from 'express';
import { authenticate, authorizeRole } from '../../middleware/rbac.middleware';
import { EWayBillController } from './ewaybill.controller';

const router = Router();

router.use(authenticate);
router.use(authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']));

router.get('/masters', EWayBillController.masters);
router.get('/stats', EWayBillController.stats);
router.get('/sources', EWayBillController.sources);
router.get('/prefill', EWayBillController.prefill);
router.post('/export-json', EWayBillController.exportJson);
router.get('/', EWayBillController.list);
router.post('/', EWayBillController.create);
router.get('/:id', EWayBillController.getOne);
router.patch('/:id', EWayBillController.update);
router.delete('/:id', EWayBillController.remove);
router.post('/:id/generate', EWayBillController.generate);
router.post('/:id/vehicle', EWayBillController.updateVehicle);
router.post('/:id/extend', EWayBillController.extend);
router.post('/:id/cancel', EWayBillController.cancel);

export default router;
