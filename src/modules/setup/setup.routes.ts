import { Router } from 'express';
import { SetupController } from './setup.controller';
import { authenticate, authorizeRole } from '../../middleware/rbac.middleware';

const router = Router();

router.use(authenticate);

// No role restriction — every authenticated role can cheaply ask "is the
// system set up"; only an {id, name} summary is exposed, nothing sensitive.
router.get('/status', SetupController.getStatus);

// Creating the HQ warehouse is a setup-time, SUPER_ADMIN-only action.
router.post('/warehouse', authorizeRole(['SUPER_ADMIN']), SetupController.createWarehouse);

export default router;
