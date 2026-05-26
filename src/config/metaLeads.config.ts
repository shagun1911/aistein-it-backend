/**
 * Meta Lead Ads — dedicated env (META_LEADS_*).
 * Separate from META_APP_ID / META_APP_SECRET used for Messenger, Instagram, OAuth.
 */

function trim(value: string | undefined): string {
  return (value || '').trim();
}

function parseFormIds(raw: string | undefined): string[] {
  return trim(raw)
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

export const metaLeadsConfig = {
  /** Webhook verify token (Meta Lead Ads subscription) */
  verifyToken: trim(process.env.META_LEADS_VERIFY_TOKEN),

  /** App secret for this Meta app (lead ads / page token app) */
  appSecret: trim(process.env.META_LEADS_APP_SECRET),

  /** Page access token from me/accounts — used for form fields + leadgen Graph API */
  pageAccessToken: trim(process.env.META_LEADS_PAGE_ACCESS_TOKEN),

  /** Facebook Page ID that owns the lead forms */
  pageId: trim(process.env.META_LEADS_PAGE_ID),

  /**
   * Optional poll allowlist. Empty = poll forms from active meta_lead automation triggers only.
   * When set, only these form IDs are polled; trigger Form ID in UI must still match each lead.
   */
  formIds: parseFormIds(process.env.META_LEADS_FORM_IDS),

  /** Graph API version, e.g. v25.0 */
  apiVersion: trim(process.env.META_LEADS_API_VERSION) || 'v25.0',

  /** Optional secret for cron / internal lead sync jobs */
  cronSecret: trim(process.env.META_LEADS_CRON_SECRET),

  /** Force automations to run under this org (must match where Meta Lead workflow lives) */
  organizationId: trim(process.env.META_LEADS_ORGANIZATION_ID),

  /** Optional user id for batch call context */
  userId: trim(process.env.META_LEADS_USER_ID),

  /**
   * Scheduled Graph poll as fallback (missed webhooks / downtime).
   * Primary delivery: POST /api/v1/social-integrations/meta-leads/webhook
   * Set META_LEADS_POLL_FALLBACK_ENABLED=true (or legacy META_LEADS_POLL_ENABLED=true).
   */
  pollFallbackEnabled(): boolean {
    const fallback = trim(process.env.META_LEADS_POLL_FALLBACK_ENABLED).toLowerCase();
    if (fallback === 'true') return true;
    if (fallback === 'false') return false;
    return trim(process.env.META_LEADS_POLL_ENABLED).toLowerCase() === 'true';
  },

  /** Poll interval in hours when fallback scheduler is on (default 6) */
  pollIntervalHours: Math.max(
    1,
    Number.parseFloat(trim(process.env.META_LEADS_POLL_INTERVAL_HOURS) || '6') || 6
  ),

  /** Graph edge: test_leads (dev) or leads (production ads) */
  pollLeadsType: (trim(process.env.META_LEADS_POLL_TYPE) || 'test') as 'test' | 'real',

  pollIntervalMs(): number {
    return this.pollIntervalHours * 60 * 60 * 1000;
  },

  pollEdge(): 'test_leads' | 'leads' {
    return this.pollLeadsType === 'real' ? 'leads' : 'test_leads';
  },

  isConfigured(): boolean {
    return Boolean(this.pageAccessToken && this.pageId);
  },

  hasFormAllowlist(): boolean {
    return this.formIds.length > 0;
  },

  isAllowedFormId(formId: string | undefined | null): boolean {
    if (!formId) return !this.hasFormAllowlist();
    if (!this.hasFormAllowlist()) return true;
    return this.formIds.includes(String(formId).trim());
  },

  isAllowedPageId(pageId: string | undefined | null): boolean {
    if (!this.pageId) return true;
    if (!pageId) return false;
    return String(pageId).trim() === this.pageId;
  },
};

/** Page token: per-org integration first, then env (dev fallback). */
export function resolveMetaLeadsPageAccessToken(integrationToken?: string | null): string | null {
  const fromIntegration = trim(integrationToken || undefined);
  if (fromIntegration) return fromIntegration;
  if (metaLeadsConfig.pageAccessToken) return metaLeadsConfig.pageAccessToken;
  return null;
}

export function getMetaLeadsAppId(): string {
  return trim(process.env.META_LEADS_APP_ID) || trim(process.env.META_APP_ID);
}

export function getMetaLeadsGraphApiVersion(): string {
  return metaLeadsConfig.apiVersion;
}
