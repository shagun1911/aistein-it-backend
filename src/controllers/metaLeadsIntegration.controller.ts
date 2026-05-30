import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../middleware/auth.middleware';
import { AppError } from '../middleware/error.middleware';
import { successResponse } from '../utils/response.util';
import { SocialIntegrationService } from '../services/socialIntegration.service';
import {
  createMetaLeadsOAuthService,
  getMetaLeadsAppCredentials,
  getMetaLeadsAuthorizationUrl,
  getMetaLeadsWebhookInfo,
  META_LEADS_OAUTH_SCOPES,
  subscribeMetaLeadsPageToWebhooks,
} from '../services/metaLeadsOAuth.service';
import {
  appendSocialsQuery,
  getMetaLeadsOAuthRedirectUri,
  getPublicBackendBaseFromEnv,
  oauthSocialsReturnUrl,
  resolveOAuthReturnBase,
  resolveOAuthStateReturnUrl,
} from '../utils/publicUrl.util';
import { metaLeadsConfig } from '../config/metaLeads.config';
import redisClient, { isRedisAvailable } from '../config/redis';
import { findMetaLeadsIntegrationByOrganization } from '../services/metaLeadsIntegration.service';

const socialIntegrationService = new SocialIntegrationService();
const PENDING_PAGES_TTL = 600;

export class MetaLeadsIntegrationController {
  /**
   * GET /api/v1/social-integrations/meta-leads/integration
   */
  async getIntegration(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');

      const integration = await findMetaLeadsIntegrationByOrganization(String(organizationId));
      if (!integration) {
        res.json(successResponse(null, 'Meta Lead Ads not connected'));
        return;
      }

      const backendUrl = getPublicBackendBaseFromEnv() || 'http://localhost:5001';
      const webhook = getMetaLeadsWebhookInfo(backendUrl);

      res.json(
        successResponse(
          {
            platform: 'meta_leads',
            status: integration.status,
            webhookVerified: integration.webhookVerified,
            credentials: {
              facebookPageId: integration.credentials?.facebookPageId,
              apiKey: '***********',
            },
            metadata: integration.metadata,
            lastSyncedAt: integration.lastSyncedAt,
            webhookConfiguration: {
              callbackUrl: webhook.callbackUrl,
              verifyTokenEnv: webhook.verifyTokenEnv,
              hasVerifyToken: Boolean(metaLeadsConfig.verifyToken),
            },
          },
          'Meta Lead Ads integration'
        )
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/social-integrations/meta-leads/oauth/initiate
   */
  async initiateOAuth(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user?._id) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');

      const organizationId = req.user.organizationId || req.user._id;
      const backendUrl = getPublicBackendBaseFromEnv();
      if (!backendUrl) {
        throw new AppError(500, 'CONFIGURATION_ERROR', 'BACKEND_URL is required');
      }

      getMetaLeadsAppCredentials();

      const returnOrigin =
        typeof req.body?.returnOrigin === 'string' ? req.body.returnOrigin : undefined;
      const redirectUrl = oauthSocialsReturnUrl(resolveOAuthReturnBase(returnOrigin));

      const state = Buffer.from(
        JSON.stringify({
          userId: req.user._id.toString(),
          organizationId: organizationId.toString(),
          platform: 'meta_leads',
          redirectUrl,
        })
      ).toString('base64');

      const authUrl = getMetaLeadsAuthorizationUrl(state, backendUrl);
      const oauthRedirectUri = getMetaLeadsOAuthRedirectUri(backendUrl);
      console.log('[Meta Leads OAuth] Initiate — return URL:', redirectUrl);
      console.log('[Meta Leads OAuth] Initiate — redirect URI:', oauthRedirectUri);

      res.json(successResponse({ authUrl }, 'Meta Lead Ads OAuth URL generated'));
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET|POST /api/v1/social-integrations/meta-leads/oauth/callback
   */
  async oauthCallback(req: Request, res: Response) {
    const defaultReturnUrl = oauthSocialsReturnUrl(resolveOAuthReturnBase());
    try {
      const code = (req.query.code as string) || (req.body?.code as string);
      const stateRaw = (req.query.state as string) || (req.body?.state as string);
      const errorParam = req.query.error as string;

      let state: { userId?: string; organizationId?: string; redirectUrl?: string } = {};
      if (stateRaw) {
        try {
          state = JSON.parse(Buffer.from(stateRaw, 'base64').toString('utf8'));
        } catch {
          state = {};
        }
      }
      const returnUrl = resolveOAuthStateReturnUrl(state.redirectUrl) || defaultReturnUrl;

      if (errorParam) {
        return res.redirect(
          appendSocialsQuery(returnUrl, { error: errorParam, platform: 'meta_leads' })
        );
      }

      if (!code || !stateRaw) {
        return res.redirect(
          appendSocialsQuery(returnUrl, {
            error: 'Missing OAuth code',
            platform: 'meta_leads',
          })
        );
      }

      const { userId, organizationId } = state;
      if (!userId || !organizationId) {
        throw new Error('Invalid OAuth state');
      }

      const backendUrl = getPublicBackendBaseFromEnv() || 'http://localhost:5001';
      const { appId } = getMetaLeadsAppCredentials();
      const metaOAuth = createMetaLeadsOAuthService(backendUrl);

      const tokenResponse = await metaOAuth.exchangeCodeForToken(code);
      const accessToken = tokenResponse.access_token;

      let metaUserId: string | undefined;
      let userName: string | undefined;
      try {
        const userInfo = await metaOAuth.getUserInfo(accessToken);
        metaUserId = userInfo.id;
        userName = userInfo.name;
      } catch {
        /* optional */
      }

      const pages = await metaOAuth.getUserPages(accessToken);
      if (pages.length === 0) {
        return res.redirect(
          appendSocialsQuery(returnUrl, {
            error: 'No Facebook Pages found',
            platform: 'meta_leads',
          })
        );
      }

      if (pages.length > 1 && isRedisAvailable()) {
        const sessionKey = randomUUID();
        await redisClient.setEx(
          `oauth_pending_pages:${sessionKey}`,
          PENDING_PAGES_TTL,
          JSON.stringify({
            userId,
            organizationId,
            platform: 'meta_leads',
            accessToken,
            appUserId: userId,
            metaUserId,
            userName,
            pages: pages.map((p) => ({
              id: p.id,
              name: p.name,
              category: p.category || '',
              pageAccessToken: p.access_token,
            })),
          })
        );
        return res.redirect(
          appendSocialsQuery(returnUrl, {
            select_page: 'true',
            platform: 'meta_leads',
            session: sessionKey,
          })
        );
      }

      const selectedPage = pages[0];
      await this.saveMetaLeadsIntegration({
        userId,
        organizationId,
        appId,
        userAccessToken: accessToken,
        page: selectedPage,
        metaUserId,
        userName,
      });

      return res.redirect(
        appendSocialsQuery(returnUrl, { success: 'true', platform: 'meta_leads' })
      );
    } catch (err: any) {
      console.error('[Meta Leads OAuth] Callback error:', err?.message || err);
      const message = err?.message || 'OAuth failed';
      console.error('[Meta Leads OAuth] redirect_uri used:', getMetaLeadsOAuthRedirectUri());
      return res.redirect(
        appendSocialsQuery(defaultReturnUrl, {
          error: message,
          platform: 'meta_leads',
        })
      );
    }
  }

  /**
   * GET /api/v1/social-integrations/meta-leads/oauth/pending-pages?session=
   */
  async getPendingPages(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const session = req.query.session as string;
      if (!session) throw new AppError(400, 'MISSING_SESSION', 'session is required');
      if (!isRedisAvailable()) {
        throw new AppError(503, 'REDIS_UNAVAILABLE', 'Page selection temporarily unavailable');
      }

      const raw = await redisClient.get(`oauth_pending_pages:${session}`);
      if (!raw) throw new AppError(404, 'SESSION_EXPIRED', 'Session expired — connect again');

      const sessionData = JSON.parse(raw);
      if (sessionData.platform !== 'meta_leads') {
        throw new AppError(400, 'INVALID_SESSION', 'Not a Meta Lead Ads session');
      }

      const pages = (sessionData.pages as any[]).map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category || '',
      }));

      res.json(successResponse({ pages, platform: 'meta_leads' }, 'Pages fetched'));
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/social-integrations/meta-leads/oauth/select-page
   */
  async selectPage(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { sessionKey, pageId } = req.body as { sessionKey?: string; pageId?: string };
      if (!sessionKey || !pageId) {
        throw new AppError(400, 'MISSING_FIELDS', 'sessionKey and pageId are required');
      }
      if (!isRedisAvailable()) {
        throw new AppError(503, 'REDIS_UNAVAILABLE', 'Page selection temporarily unavailable');
      }

      const raw = await redisClient.get(`oauth_pending_pages:${sessionKey}`);
      if (!raw) throw new AppError(404, 'SESSION_EXPIRED', 'Session expired');

      const sessionData = JSON.parse(raw);
      if (sessionData.platform !== 'meta_leads') {
        throw new AppError(400, 'INVALID_SESSION', 'Not a Meta Lead Ads session');
      }

      const page = (sessionData.pages as any[]).find((p: any) => p.id === pageId);
      if (!page) throw new AppError(400, 'INVALID_PAGE', 'Page not found');

      const { appId } = getMetaLeadsAppCredentials();
      const integration = await this.saveMetaLeadsIntegration({
        userId: sessionData.userId,
        organizationId: sessionData.organizationId,
        appId,
        userAccessToken: sessionData.accessToken,
        page: {
          id: page.id,
          name: page.name,
          access_token: page.pageAccessToken,
        },
        metaUserId: sessionData.metaUserId,
        userName: sessionData.userName,
      });

      await redisClient.del(`oauth_pending_pages:${sessionKey}`);

      const backendUrl = getPublicBackendBaseFromEnv() || 'http://localhost:5001';
      const webhook = getMetaLeadsWebhookInfo(backendUrl);

      res.json(
        successResponse(
          {
            integration: {
              platform: 'meta_leads',
              status: integration.status,
              webhookVerified: integration.webhookVerified,
              credentials: {
                facebookPageId: integration.credentials?.facebookPageId,
              },
            },
            webhookConfiguration: {
              callbackUrl: webhook.callbackUrl,
              verifyTokenEnv: webhook.verifyTokenEnv,
              subscribed: integration.webhookVerified,
            },
          },
          'Meta Lead Ads connected'
        )
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/social-integrations/meta-leads/disconnect
   */
  async disconnect(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');

      await socialIntegrationService.disconnectIntegration(String(organizationId), 'meta_leads');
      res.json(successResponse(null, 'Meta Lead Ads disconnected'));
    } catch (error) {
      next(error);
    }
  }

  private async saveMetaLeadsIntegration(params: {
    userId: string;
    organizationId: string;
    appId: string;
    userAccessToken: string;
    page: { id: string; name: string; access_token: string };
    metaUserId?: string;
    userName?: string;
  }) {
    let webhookVerified = false;
    try {
      webhookVerified = await subscribeMetaLeadsPageToWebhooks(
        params.page.id,
        params.page.access_token
      );
    } catch (e: any) {
      console.warn('[Meta Leads OAuth] Webhook subscribe warning:', e?.message);
    }

    return socialIntegrationService.upsertIntegration({
      userId: params.userId,
      organizationId: params.organizationId,
      platform: 'meta_leads',
      apiKey: params.userAccessToken,
      clientId: params.appId,
      facebookPageId: params.page.id,
      skipVerification: true,
      webhookVerified,
      credentials: {
        apiKey: params.userAccessToken,
        clientId: params.appId,
        facebookPageId: params.page.id,
        pageAccessToken: params.page.access_token,
      },
      metadata: {
        connectedAt: new Date().toISOString(),
        pageName: params.page.name,
        metaUserId: params.metaUserId,
        userName: params.userName,
        scopes: [...META_LEADS_OAUTH_SCOPES],
      },
    });
  }
}

export default new MetaLeadsIntegrationController();
