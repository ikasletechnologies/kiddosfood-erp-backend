import { Router } from 'express';
import { SetupController } from './setup.controller';
import { authenticate } from '../../middleware/rbac.middleware';

const router = Router();

router.use(authenticate);

// No role restriction — every authenticated role can cheaply ask "is the
// system set up"; only an {id, name} summary is exposed, nothing sensitive.
router.get('/status', SetupController.getStatus);

export default router;
