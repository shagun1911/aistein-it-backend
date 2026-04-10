import { Router } from 'express';
import { conversationController } from '../controllers/conversation.controller';
import { authenticate } from '../middleware/auth.middleware';
import { attachmentUpload } from '../config/multer';
import { requireUsage } from '../middleware/usageEnforcement.middleware';
import { enforceChatLimit } from '../middleware/planEnforcement.middleware';

const router = Router();

// Public widget endpoint (no authentication required)
// Usage tracking handled in controller (widgetId = userId)
router.post('/widget', conversationController.saveWidgetConversation);

router.use(authenticate); // All other routes require authentication

router.get('/', conversationController.getAll);
router.get('/search-messages', conversationController.searchMessages);
// Enforce conversation limit before bulk creation (org-based usage + legacy subscription counter)
router.post('/bulk', requireUsage('conversations'), enforceChatLimit, conversationController.bulkCreate);
router.post('/bulk-delete', conversationController.bulkDelete);
router.get('/transcript/:callerId', conversationController.fetchTranscript);
router.get('/:conversationId/audio', conversationController.fetchAudio);
router.get('/:conversationId', conversationController.getById);
router.post(
  '/:conversationId/messages',
  enforceChatLimit,
  attachmentUpload.array('attachments', 5),
  conversationController.addMessage
);
router.post('/:conversationId/take-control', conversationController.takeControl);
router.post('/:conversationId/release-control', conversationController.releaseControl);
router.patch('/:conversationId/status', conversationController.updateStatus);
router.patch('/:conversationId/assign', conversationController.assignOperator);
router.patch('/:conversationId/labels', conversationController.updateLabels);
router.patch('/:conversationId/folder', conversationController.moveToFolder);
router.patch('/:conversationId/bookmark', conversationController.toggleBookmark);
router.delete('/:conversationId', conversationController.delete);

export default router;
