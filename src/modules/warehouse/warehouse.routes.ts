import { Router } from 'express';
import { WarehouseController } from './warehouse.controller';
import { authenticate } from '../../middleware/rbac.middleware';

const router = Router();

router.use(authenticate);

// Bin management (placed before /:warehouseId to avoid param collision)
router.get('/bins', WarehouseController.getAllBins);
router.post('/bins', WarehouseController.createBinDirect);
router.put('/bins/:binId', WarehouseController.updateBin);
router.delete('/bins/:binId', WarehouseController.deleteBin);

// Main warehouse routes
router.get('/primary', WarehouseController.getPrimaryWarehouse);
router.get('/:warehouseId/stock', WarehouseController.getWarehouseStock);
router.get('/:warehouseId', WarehouseController.getWarehouseById);

// Bin creation under specific warehouse
router.post('/:warehouseId/bins', WarehouseController.createBin);

// Stock Assignment
router.post('/:warehouseId/assign-bin', WarehouseController.assignBin);

export default router;
