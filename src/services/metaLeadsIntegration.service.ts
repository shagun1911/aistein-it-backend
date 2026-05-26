import axios from 'axios';
import mongoose from 'mongoose';
import SocialIntegration, { ISocialIntegration } from '../models/SocialIntegration';
import { getMetaLeadsGraphApiVersion, metaLeadsConfig } from '../config/metaLeads.config';

export type LeadgenFormField = { key: string; label: string; type: string };

export type LeadgenFormGraphResult = {
  formName: string;
  fields: LeadgenFormField[];
};

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

function mapQuestionsToFields(questions: unknown[]): LeadgenFormField[] {
  if (!Array.isArray(questions)) return [];
  return questions
    .map((q: any) => ({
      key: String(q?.key || q?.id || '').trim(),
      label: String(q?.label || q?.key || q?.id || '').trim(),
      type: String(q?.type || 'CUSTOM'),
    }))
    .filter((f) => !!f.key);
}

/**
 * Load lead form questions from Meta Graph API.
 * Do NOT use /{pageId}/{formId} — Meta returns "Unknown path components".
 */
export async function fetchLeadgenFormFromMeta(params: {
  formId: string;
  pageAccessToken: string;
  pageId?: string;
}): Promise<LeadgenFormGraphResult> {
  const apiVersion = getMetaLeadsGraphApiVersion();
  const base = `https://graph.facebook.com/${apiVersion}`;
  const formIdStr = String(params.formId).trim();
  const token = params.pageAccessToken;
  const pageIdStr = params.pageId ? String(params.pageId).trim() : '';

  let lastMetaError: string | undefined;

  // 1) Direct leadgen form node
  try {
    const res = await axios.get(`${base}/${formIdStr}`, {
      params: {
        fields: 'id,name,questions{key,label,type}',
        access_token: token,
      },
      timeout: 15000,
    });
    const data = res.data;
    if (data?.id) {
      return {
        formName: data.name || '',
        fields: mapQuestionsToFields(data.questions?.data ?? data.questions ?? []),
      };
    }
  } catch (err: any) {
    lastMetaError = err?.response?.data?.error?.message || err?.message;
    console.warn('[fetchLeadgenFormFromMeta] direct form GET failed:', lastMetaError);
  }

  // 2) List forms on connected page and match by id
  if (pageIdStr) {
    try {
      let nextUrl: string | undefined = `${base}/${pageIdStr}/leadgen_forms`;
      const listParams = {
        fields: 'id,name,questions{key,label,type}',
        limit: '100',
        access_token: token,
      };

      for (let page = 0; page < 10 && nextUrl; page++) {
        const listRes: { data?: { data?: unknown[]; paging?: { next?: string } } } = await axios.get(
          nextUrl,
          {
            params: page === 0 ? listParams : undefined,
            timeout: 15000,
          }
        );

        const list = Array.isArray(listRes.data?.data) ? listRes.data.data : [];
        const match = list.find(
          (f): f is { id?: string; name?: string; questions?: unknown } =>
            typeof f === 'object' && f !== null && String((f as { id?: string }).id) === formIdStr
        );
        if (match) {
          const row = match as { name?: string; questions?: { data?: unknown[] } | unknown[] };
          const qRaw = row.questions;
          const qList = Array.isArray(qRaw)
            ? qRaw
            : Array.isArray((qRaw as { data?: unknown[] })?.data)
              ? (qRaw as { data: unknown[] }).data
              : [];
          return {
            formName: row.name || '',
            fields: mapQuestionsToFields(qList),
          };
        }

        nextUrl = listRes.data?.paging?.next;
      }

      lastMetaError = `Form ${formIdStr} not found on page ${pageIdStr}. Check the Form ID in Ads Manager.`;
    } catch (err: any) {
      lastMetaError = err?.response?.data?.error?.message || err?.message;
      console.warn('[fetchLeadgenFormFromMeta] leadgen_forms list failed:', lastMetaError);
    }
  }

  throw new Error(
    lastMetaError ||
      'Could not load form from Meta. Verify the Form ID belongs to your connected page and leads_retrieval is granted.'
  );
}
