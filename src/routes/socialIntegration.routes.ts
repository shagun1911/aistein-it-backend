import { Router } from 'express';
import socialIntegrationController from '../controllers/socialIntegration.controller';
import metaWebhookController from '../controllers/metaWebhook.controller';
import { authenticate } from '../middleware/auth.middleware';

// Note: Instagram webhook routes have been moved to /api/v1/webhooks/instagram
// See instagramWebhook.routes.ts for Instagram webhook handling

const router = Router();

// ============================================
// PUBLIC ROUTES - NO AUTHENTICATION REQUIRED
// ============================================
// These routes MUST be defined BEFORE router.use(authenticate)
// Meta sends webhooks and OAuth callbacks without JWT tokens

// Meta webhooks - public (Meta sends webhooks here, no auth required)
// WhatsApp webhook
router.get('/whatsapp/webhook', (req, res) => metaWebhookController.verify(req, res, 'whatsapp'));
router.post('/whatsapp/webhook', metaWebhookController.handleWhatsApp.bind(metaWebhookController));

// Messenger webhook
router.get('/messenger/webhook', (req, res) => metaWebhookController.verify(req, res, 'messenger'));
router.post('/messenger/webhook', metaWebhookController.handleMessenger.bind(metaWebhookController));

// Instagram webhook (backward compatibility - also available at /api/v1/webhooks/instagram)
router.get('/instagram/webhook', (req, res) => {
  console.log('[Instagram Webhook OLD PATH] GET hit - webhook verification');
  return metaWebhookController.verify(req, res, 'instagram');
});
router.post('/instagram/webhook', (req, res) => {
  console.log('[Instagram Webhook OLD PATH] POST hit - webhook event');
  if (req.body?.entry) {
    req.body.entry.forEach((entry: any, i: number) => {
      if (entry.messaging) {
        entry.messaging.forEach((msg: any, j: number) => {
          if (msg.sender?.id) {
            console.log(`[Instagram Webhook OLD PATH] Message ${i}-${j}: Sender ID = ${msg.sender.id}`);
          }
        });
      }
    });
  }
  return metaWebhookController.handleInstagram(req, res);
});

// OAuth callback routes - MUST BE PUBLIC (Meta redirects here without JWT tokens)
// These routes handle OAuth redirects from Meta and must remain public forever
// Support both GET and POST (some OAuth flows may use POST)
router.get('/facebook/oauth/callback', socialIntegrationController.oauthCallback.bind(socialIntegrationController));
router.post('/facebook/oauth/callback', socialIntegrationController.oauthCallback.bind(socialIntegrationController));
router.get('/whatsapp/oauth/callback', socialIntegrationController.oauthCallback.bind(socialIntegrationController));
router.post('/whatsapp/oauth/callback', socialIntegrationController.oauthCallback.bind(socialIntegrationController));
router.get('/instagram/oauth/callback', socialIntegrationController.oauthCallback.bind(socialIntegrationController));
router.post('/instagram/oauth/callback', socialIntegrationController.oauthCallback.bind(socialIntegrationController));

// Gmail OAuth callback - handled by Python API
// Support both GET and POST (Python API might redirect with POST or include data in body)
router.get('/gmail/oauth/callback', async (req, res) => {
  const gmailOAuthService = (await import('../services/gmailOAuth.service')).default;
  return gmailOAuthService.handleCallback(req, res);
});
router.post('/gmail/oauth/callback', async (req, res) => {
  const gmailOAuthService = (await import('../services/gmailOAuth.service')).default;
  return gmailOAuthService.handleCallback(req, res);
});

// Fallback for any other platform - support both GET and POST
router.get('/:platform/oauth/callback', socialIntegrationController.oauthCallback.bind(socialIntegrationController));
router.post('/:platform/oauth/callback', socialIntegrationController.oauthCallback.bind(socialIntegrationController));

// All other routes require authentication
router.use(authenticate);

// Facebook Lead Ads form fields (must be before /:platform)
router.get(
  '/facebook/forms/:formId/fields',
  socialIntegrationController.getFacebookFormFields.bind(socialIntegrationController)
);
router.post(
  '/facebook/resubscribe-webhooks',
  socialIntegrationController.resubscribeFacebookWebhooks.bind(socialIntegrationController)
);

// WhatsApp manual connection (without OAuth)
router.post('/whatsapp/connect-manual', socialIntegrationController.connectWhatsAppManual.bind(socialIntegrationController));

// Instagram manual connection (without OAuth)
router.post('/instagram/connect-manual', socialIntegrationController.connectInstagramManual.bind(socialIntegrationController));

// Facebook manual connection (without OAuth)
router.post('/facebook/connect-manual', socialIntegrationController.connectFacebookManual.bind(socialIntegrationController));

// Get all integrations
router.get('/', socialIntegrationController.getAll.bind(socialIntegrationController));

// Get specific platform integration
router.get('/:platform', socialIntegrationController.getByPlatform.bind(socialIntegrationController));

// OAuth flow - initiate OAuth (POST endpoint as frontend expects)
router.post('/:platform/oauth/initiate', socialIntegrationController.initiateOAuth.bind(socialIntegrationController));

// Page selection — used when user has multiple pages after OAuth
router.get('/:platform/pending-pages', socialIntegrationController.getPendingPages.bind(socialIntegrationController));
router.post('/:platform/select-page', socialIntegrationController.selectPage.bind(socialIntegrationController));

// Connect/update integration (manual method - kept for backward compatibility)
router.post('/:platform/connect', socialIntegrationController.connect.bind(socialIntegrationController));

// Test connection
router.post('/:platform/test', socialIntegrationController.testConnection.bind(socialIntegrationController));

// Disconnect integration (support both POST and DELETE methods for frontend compatibility)
router.post('/:platform/disconnect', socialIntegrationController.disconnect.bind(socialIntegrationController));
router.delete('/:platform/disconnect', socialIntegrationController.disconnect.bind(socialIntegrationController));

// Delete integration
router.delete('/:platform', socialIntegrationController.delete.bind(socialIntegrationController));

export default router;

