import mongoose from 'mongoose';
import SocialIntegration, { ISocialIntegration } from '../models/SocialIntegration';
import { metaLeadsConfig } from '../config/metaLeads.config';

export type MetaLeadsPlatform = 'meta_leads';

export async function findMetaLeadsIntegrationByOrganization(
  organizationId: string
): Promise<ISocialIntegration | null> {
  const orgFilter = mongoose.Types.ObjectId.isValid(organizationId)
    ? new mongoose.Types.ObjectId(organizationId)
    : organizationId;

  return SocialIntegration.findOne({
    organizationId: orgFilter,
    platform: 'meta_leads',
    status: 'connected',
  }).sort({ updatedAt: -1 });
}

export async function findMetaLeadsIntegrationByPageId(
  pageId: string
): Promise<ISocialIntegration | null> {
  const pageIdStr = String(pageId).trim();
  if (!pageIdStr) return null;

  let integration = await SocialIntegration.findOne({
    platform: 'meta_leads',
    status: 'connected',
    'credentials.facebookPageId': pageIdStr,
    userId: { $exists: true, $ne: null },
  }).sort({ updatedAt: -1 });

  if (!integration && !Number.isNaN(Number(pageIdStr))) {
    integration = await SocialIntegration.findOne({
      platform: 'meta_leads',
      status: 'connected',
      'credentials.facebookPageId': Number(pageIdStr),
      userId: { $exists: true, $ne: null },
    }).sort({ updatedAt: -1 });
  }

  return integration;
}

/**
 * Page token for Graph API: org integration first, then global env (dev).
 */
export function resolveMetaLeadsPageAccessToken(
  integration?: { credentials?: { pageAccessToken?: string } } | null
): string | null {
  const fromIntegration = (integration?.credentials?.pageAccessToken || '').trim();
  if (fromIntegration) return fromIntegration;
  if (metaLeadsConfig.pageAccessToken) return metaLeadsConfig.pageAccessToken;
  return null;
}

export async function resolveMetaLeadsPageAccessTokenForOrg(
  organizationId: string
): Promise<{ token: string | null; integration: ISocialIntegration | null }> {
  const integration = await findMetaLeadsIntegrationByOrganization(organizationId);
  return {
    token: resolveMetaLeadsPageAccessToken(integration),
    integration,
  };
}
