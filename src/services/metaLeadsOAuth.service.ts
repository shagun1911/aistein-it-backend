import axios from 'axios';
import { AppError } from '../middleware/error.middleware';
import { MetaOAuthService } from './metaOAuth.service';
import { getMetaLeadsGraphApiVersion } from '../config/metaLeads.config';

/** OAuth scopes for Meta Lead Ads only (not Messenger / WhatsApp). */
export const META_LEADS_OAUTH_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'leads_retrieval',
] as const;

export const META_LEADS_PAGE_SUBSCRIBED_FIELDS = ['leadgen'] as const;

function trim(value: string | undefined): string {
  return (value || '').trim();
}

/** Meta Leads app credentials — falls back to META_APP_* if dedicated vars unset. */
export function getMetaLeadsAppCredentials(): { appId: string; appSecret: string } {
  const appId = trim(process.env.META_LEADS_APP_ID) || trim(process.env.META_APP_ID);
  const appSecret = trim(process.env.META_LEADS_APP_SECRET) || trim(process.env.META_APP_SECRET);
  if (!appId || !appSecret) {
    throw new AppError(
      500,
      'CONFIGURATION_ERROR',
      'Set META_LEADS_APP_ID and META_LEADS_APP_SECRET (or META_APP_ID / META_APP_SECRET)'
    );
  }
  return { appId, appSecret };
}

export function getMetaLeadsOAuthRedirectUri(backendUrl: string): string {
  const base = backendUrl.replace(/\/$/, '');
  return `${base}/api/v1/social-integrations/meta-leads/oauth/callback`;
}

export function createMetaLeadsOAuthService(backendUrl: string): MetaOAuthService {
  const { appId, appSecret } = getMetaLeadsAppCredentials();
  return new MetaOAuthService({
    appId,
    appSecret,
    redirectUri: getMetaLeadsOAuthRedirectUri(backendUrl),
  });
}

/**
 * Build Facebook OAuth URL with Lead Ads scopes only.
 */
export function getMetaLeadsAuthorizationUrl(state: string, backendUrl: string): string {
  const { appId } = getMetaLeadsAppCredentials();
  const redirectUri = getMetaLeadsOAuthRedirectUri(backendUrl);
  const scopeString = META_LEADS_OAUTH_SCOPES.join(',');
  const apiVersion = getMetaLeadsGraphApiVersion();
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    scope: scopeString,
    response_type: 'code',
  });
  return `https://www.facebook.com/${apiVersion}/dialog/oauth?${params.toString()}`;
}

/**
 * Subscribe page to leadgen webhooks only (does not touch Messenger message fields).
 */
export async function subscribeMetaLeadsPageToWebhooks(
  pageId: string,
  pageAccessToken: string
): Promise<boolean> {
  const apiVersion = getMetaLeadsGraphApiVersion();
  try {
    const response = await axios.post(
      `https://graph.facebook.com/${apiVersion}/${pageId}/subscribed_apps`,
      { subscribed_fields: [...META_LEADS_PAGE_SUBSCRIBED_FIELDS] },
      { params: { access_token: pageAccessToken } }
    );
    console.log(`[Meta Leads OAuth] Page ${pageId} subscribed to leadgen:`, response.data);
    return response.data?.success === true;
  } catch (error: any) {
    console.error(
      '[Meta Leads OAuth] leadgen subscribe failed:',
      error.response?.data || error.message
    );
    return false;
  }
}

export function getMetaLeadsWebhookInfo(backendUrl: string): {
  callbackUrl: string;
  verifyTokenEnv: string;
} {
  const base = backendUrl.replace(/\/$/, '');
  return {
    callbackUrl: `${base}/api/v1/social-integrations/meta-leads/webhook`,
    verifyTokenEnv: 'META_LEADS_VERIFY_TOKEN',
  };
}
