import { Router } from 'express';
import { WarehouseController } from './warehouse.controller';
import { authenticate } from '../../middleware/rbac.middleware';

const router = Router();

router.use(authenticate);

// Main warehouse routes
router.get('/primary', WarehouseController.getPrimaryWarehouse);
router.get('/:warehouseId/stock', WarehouseController.getWarehouseStock);
router.get('/:warehouseId', WarehouseController.getWarehouseById);

// Bin management
router.post('/:warehouseId/bins', WarehouseController.createBin);
router.put('/bins/:binId', WarehouseController.updateBin);
router.delete('/bins/:binId', WarehouseController.deleteBin);

// Stock Assignment
router.post('/:warehouseId/assign-bin', WarehouseController.assignBin);

export default router;
