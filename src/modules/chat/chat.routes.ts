import { Router } from 'express';
import { authenticate } from '../../middleware/rbac.middleware';
import { ChatController } from './chat.controller';

// Role and franchise checks happen in ChatService against the DB user, so
// they apply equally here and on the /chat socket namespace.
const router = Router();

router.use(authenticate);

router.get('/unread', ChatController.unread);
router.get('/conversations', ChatController.inbox); // Super Admin inbox
router.get('/conversations/mine', ChatController.mine); // Franchise user's own thread
router.post('/conversations/franchise/:franchiseId', ChatController.openForFranchise); // Super Admin
router.get('/conversations/:id/messages', ChatController.messages);
router.post('/conversations/:id/messages', ChatController.send);
router.post('/conversations/:id/read', ChatController.markRead);

export default router;
