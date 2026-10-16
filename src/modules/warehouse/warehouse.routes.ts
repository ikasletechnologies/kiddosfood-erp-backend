import { Router } from 'express';
import { WarehouseController } from './warehouse.controller';
import { authenticate, authorizeRole } from '../../middleware/rbac.middleware';

const router = Router();

router.use(authenticate);

// Central Warehouse is an HQ-only flow. These routes are deliberately
// separate from the franchise-aware warehouse endpoints below.
router.get('/central', authorizeRole(['SUPER_ADMIN']), WarehouseController.getCentralWarehouse);
router.patch('/central', authorizeRole(['SUPER_ADMIN']), WarehouseController.updateCentralWarehouse);
router.get('/central/funds', authorizeRole(['SUPER_ADMIN']), WarehouseController.getCentralFunds);
router.post('/central/funds', authorizeRole(['SUPER_ADMIN']), WarehouseController.addCentralFund);
router.patch('/central/funds/:paymentId', authorizeRole(['SUPER_ADMIN']), WarehouseController.updateCentralFund);
router.post('/central/bins', authorizeRole(['SUPER_ADMIN']), WarehouseController.createCentralBin);
router.put('/central/bins/:binId', authorizeRole(['SUPER_ADMIN']), WarehouseController.updateCentralBin);
router.delete('/central/bins/:binId', authorizeRole(['SUPER_ADMIN']), WarehouseController.deleteCentralBin);
router.post('/central/stock-in', authorizeRole(['SUPER_ADMIN']), WarehouseController.centralStockIn);
router.post('/central/stock-out', authorizeRole(['SUPER_ADMIN']), WarehouseController.centralStockOut);
router.post('/central/move-stock', authorizeRole(['SUPER_ADMIN']), WarehouseController.moveCentralStock);

// Bin management (placed before /:warehouseId to avoid param collision)
router.get('/preview-code', WarehouseController.previewCode);
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
