import axios from 'axios';
import Automation from '../models/Automation';
import {
  findMetaLeadsIntegrationByPageId,
  resolveMetaLeadsPageAccessToken,
} from './metaLeadsIntegration.service';
import MetaLead from '../models/MetaLead';
import MetaLeadFormSync from '../models/MetaLeadFormSync';
import {
  getMetaLeadsGraphApiVersion,
  metaLeadsConfig,
} from '../config/metaLeads.config';

export type MetaLeadGraphRow = {
  id: string;
  created_time?: string;
  field_data?: Array<{ name?: string; values?: string[] }>;
  form_id?: string;
  page_id?: string;
};

export function flattenMetaLeadFieldData(
  fieldData: Array<{ name?: string; values?: string[] }> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of fieldData || []) {
    const name = item.name;
    if (!name) continue;
    const values = item.values || [];
    out[name] = values.length > 1 ? values.join(', ') : (values[0] ?? '');
  }
  return out;
}

/**
 * Fetch leads from Meta Graph API (test_leads or leads edge), with pagination.
 */
export async function fetchLeadsFromForm(
  formId: string,
  options?: { edge?: 'test_leads' | 'leads'; sinceUnix?: number }
): Promise<MetaLeadGraphRow[]> {
  const token = resolveMetaLeadsPageAccessToken(null);
  if (!token) {
    throw new Error('META_LEADS_PAGE_ACCESS_TOKEN is not set');
  }

  const edge = options?.edge ?? metaLeadsConfig.pollEdge();
  const apiVersion = getMetaLeadsGraphApiVersion();
  const fields = 'id,created_time,field_data,form_id,page_id';
  const leads: MetaLeadGraphRow[] = [];

  let url: string | null =
    `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(formId)}/${edge}`;

  const params: Record<string, string> = {
    fields,
    access_token: token,
    limit: '100',
  };

  if (edge === 'leads' && options?.sinceUnix && options.sinceUnix > 0) {
    params.filtering = JSON.stringify([
      { field: 'time_created', operator: 'GREATER_THAN', value: options.sinceUnix },
    ]);
  }

  type GraphListResponse = {
    data?: MetaLeadGraphRow[];
    paging?: { next?: string };
    error?: { message?: string };
  };

  let guard = 0;
  while (url && guard < 50) {
    guard += 1;
    const requestUrl = url;
    const res = await axios.get<GraphListResponse>(requestUrl, {
      params: guard === 1 ? params : undefined,
      timeout: 30000,
    });
    const data: GraphListResponse = res.data;
    if (data?.error) {
      throw new Error(data.error.message || 'Meta Graph API error');
    }
    for (const row of data?.data || []) {
      if (row?.id) {
        leads.push({
          id: String(row.id),
          created_time: row.created_time,
          field_data: row.field_data,
          form_id: row.form_id != null ? String(row.form_id) : formId,
          page_id:
            row.page_id != null
              ? String(row.page_id)
              : metaLeadsConfig.pageId || undefined,
        });
      }
    }
    url = data?.paging?.next || null;
    params.access_token = token;
  }

  return leads;
}

function plainNodeConfig(config: unknown): Record<string, unknown> {
  if (!config) return {};
  if (config instanceof Map) return Object.fromEntries(config);
  if (typeof config === 'object') return { ...(config as Record<string, unknown>) };
  return {};
}

/**
 * Resolve org/user for meta_lead automations.
 * Prefers env override, then active automation with matching formId (any org),
 * then Facebook integration fallback.
 */
export async function resolveMetaLeadAutomationContext(
  formId: string,
  fallbackIntegration: { organizationId?: unknown; userId?: unknown }
): Promise<{ organizationId: string; userId: string; automationName?: string }> {
  if (metaLeadsConfig.organizationId) {
    const userId =
      metaLeadsConfig.userId ||
      (fallbackIntegration.userId != null ? String(fallbackIntegration.userId) : '');
    if (!userId) {
      throw new Error('META_LEADS_USER_ID is required when META_LEADS_ORGANIZATION_ID is set');
    }
    return {
      organizationId: metaLeadsConfig.organizationId,
      userId,
    };
  }

  const active = await Automation.find({ isActive: true }).lean();
  for (const automation of active) {
    const trigger = automation.nodes?.find(
      (n) => n.type === 'trigger' && n.service === 'meta_lead'
    );
    if (!trigger) continue;
    const cfg = plainNodeConfig(trigger.config);
    if (String(cfg.formId) !== String(formId)) continue;

    const organizationId = automation.organizationId?.toString();
    const userId =
      automation.userId?.toString() ||
      (fallbackIntegration.userId != null ? String(fallbackIntegration.userId) : '');
    if (organizationId && userId) {
      console.log(
        `[Meta Leads] Using active automation "${automation.name}" (org ${organizationId})`
      );
      return { organizationId, userId, automationName: automation.name };
    }
  }

  const organizationId =
    fallbackIntegration.organizationId != null
      ? String(fallbackIntegration.organizationId)
      : fallbackIntegration.userId != null
        ? String(fallbackIntegration.userId)
        : '';
  const userId =
    fallbackIntegration.userId != null ? String(fallbackIntegration.userId) : organizationId;

  if (!organizationId || !userId) {
    throw new Error(
      `No active meta_lead automation for form ${formId}. Add Form ID on an active automation, or set META_LEADS_ORGANIZATION_ID + META_LEADS_USER_ID, or connect Facebook as fallback.`
    );
  }

  if (fallbackIntegration.userId != null || fallbackIntegration.organizationId != null) {
    console.warn(
      `[Meta Leads] No active meta_lead automation for form ${formId} — using Facebook integration org ${organizationId}`
    );
  }
  return { organizationId, userId };
}

/**
 * Forms to poll: env META_LEADS_FORM_IDS if set, otherwise Form ID from each active meta_lead automation.
 */
export async function resolveMetaLeadsPollFormIds(): Promise<string[]> {
  if (metaLeadsConfig.formIds.length > 0) {
    return metaLeadsConfig.formIds;
  }

  const active = await Automation.find({ isActive: true }).lean();
  const ids = new Set<string>();
  for (const automation of active) {
    const trigger = automation.nodes?.find(
      (n) => n.type === 'trigger' && n.service === 'meta_lead'
    );
    if (!trigger) continue;
    const cfg = plainNodeConfig(trigger.config);
    const formId = String(cfg.formId ?? '').trim();
    if (formId) ids.add(formId);
  }
  return [...ids];
}

async function fetchLeadDetailFromGraph(leadgenId: string, pageAccessToken: string) {
  const apiVersion = getMetaLeadsGraphApiVersion();
  const res = await axios.get(`https://graph.facebook.com/${apiVersion}/${leadgenId}`, {
    params: {
      fields: 'created_time,field_data,form_id,page_id',
      access_token: pageAccessToken,
    },
    timeout: 15000,
  });
  return res.data || {};
}

/**
 * Process one lead: skip if batch call already dispatched; otherwise trigger meta_lead automation.
 */
export async function processPolledLead(lead: MetaLeadGraphRow): Promise<{
  leadgen_id: string;
  status:
    | 'skipped_already_called'
    | 'skipped_no_integration'
    | 'skipped_form'
    | 'dispatched'
    | 'no_matching_automation'
    | 'error';
  error?: string;
  automationsTriggered?: string[];
}> {
  const leadgenId = lead.id;
  const formId = lead.form_id || metaLeadsConfig.formIds[0] || '';
  const pageId = lead.page_id || metaLeadsConfig.pageId || '';

  if (!metaLeadsConfig.isAllowedFormId(formId)) {
    return { leadgen_id: leadgenId, status: 'skipped_form' };
  }

  const existing = await MetaLead.findOne({ leadgen_id: leadgenId }).lean();
  if (existing?.batch_call_dispatched) {
    return { leadgen_id: leadgenId, status: 'skipped_already_called' };
  }

  const integration = await findMetaLeadsIntegrationByPageId(
    metaLeadsConfig.pageId || pageId
  );

  const pageAccessToken = resolveMetaLeadsPageAccessToken(integration);
  if (!pageAccessToken) {
    return {
      leadgen_id: leadgenId,
      status: 'skipped_no_integration',
      error:
        'Connect Meta Lead Ads in Settings (OAuth), or set META_LEADS_PAGE_ACCESS_TOKEN for development',
    };
  }

  if (!integration?.userId) {
    return {
      leadgen_id: leadgenId,
      status: 'skipped_no_integration',
      error: 'No Meta Lead Ads connection for this page',
    };
  }

  const fallbackIntegration = {
    organizationId: integration.organizationId,
    userId: integration.userId,
  };

  let fieldData = lead.field_data;
  let createdTime = lead.created_time;
  let resolvedFormId = formId;
  let resolvedPageId = pageId;

  if (!fieldData?.length) {
    const detail = await fetchLeadDetailFromGraph(leadgenId, pageAccessToken);
    fieldData = detail.field_data;
    createdTime = createdTime || detail.created_time;
    resolvedFormId = resolvedFormId || (detail.form_id != null ? String(detail.form_id) : '');
    resolvedPageId = resolvedPageId || (detail.page_id != null ? String(detail.page_id) : '');
  }

  const flattened = flattenMetaLeadFieldData(fieldData);

  let organizationId: string;
  let userId: string;
  try {
    const ctx = await resolveMetaLeadAutomationContext(resolvedFormId, fallbackIntegration);
    organizationId = ctx.organizationId;
    userId = ctx.userId;
  } catch (ctxErr: any) {
    return {
      leadgen_id: leadgenId,
      status: 'no_matching_automation',
      error: ctxErr?.message || String(ctxErr),
    };
  }

  await MetaLead.findOneAndUpdate(
    { leadgen_id: leadgenId },
    {
      $set: {
        form_id: resolvedFormId,
        page_id: resolvedPageId,
        organizationId: organizationId,
        processedAt: new Date(),
        source: 'poll',
      },
      $setOnInsert: { batch_call_dispatched: false },
    },
    { upsert: true }
  );

  const { automationEngine } = await import('./automationEngine.service');
  const automationData = {
    event: 'meta_lead',
    form_id: resolvedFormId,
    page_id: resolvedPageId,
    leadgen_id: leadgenId,
    created_time: createdTime,
    data: flattened,
    organizationId,
    userId,
    source: 'meta_lead_poll',
  };

  try {
    const triggered = await automationEngine.triggerByEvent('meta_lead', automationData, {
      organizationId,
      userId,
    });
    if (!triggered?.length) {
      console.warn(
        `[Meta Leads Poll] No matching active meta_lead automation for form ${resolvedFormId} in org ${organizationId}. ` +
          'Enable your "Meta Lead → Batch Call" workflow and set trigger Form ID to ' +
          resolvedFormId
      );
      return {
        leadgen_id: leadgenId,
        status: 'no_matching_automation',
        error: `No active meta_lead automation for form ${resolvedFormId} in org ${organizationId}`,
      };
    }
    return {
      leadgen_id: leadgenId,
      status: 'dispatched',
      automationsTriggered: triggered.map((r: { name?: string }) => r.name).filter(Boolean) as string[],
    };
  } catch (err: any) {
    return { leadgen_id: leadgenId, status: 'error', error: err?.message || String(err) };
  }
}

export type PollRunSummary = {
  form_id: string;
  edge: string;
  candidates: number;
  dispatched: number;
  skipped_already_called: number;
  skipped_no_integration: number;
  skipped_form: number;
  no_matching_automation: number;
  errors: number;
};

/**
 * Poll all configured forms and trigger automations for leads not yet batch-called.
 */
export async function runMetaLeadsPoll(): Promise<{
  ok: boolean;
  forms: PollRunSummary[];
  error?: string;
}> {
  if (!metaLeadsConfig.pageAccessToken) {
    return { ok: false, forms: [], error: 'META_LEADS_PAGE_ACCESS_TOKEN is not set' };
  }

  const formIds = await resolveMetaLeadsPollFormIds();
  if (!formIds.length) {
    return {
      ok: false,
      forms: [],
      error:
        'No form IDs to poll: set META_LEADS_FORM_IDS or add Form ID on an active Meta Lead automation trigger',
    };
  }

  const edge = metaLeadsConfig.pollEdge();
  const runStartedUnix = Math.floor(Date.now() / 1000);
  const summaries: PollRunSummary[] = [];

  for (const formId of formIds) {
    const summary: PollRunSummary = {
      form_id: formId,
      edge,
      candidates: 0,
      dispatched: 0,
      skipped_already_called: 0,
      skipped_no_integration: 0,
      skipped_form: 0,
      no_matching_automation: 0,
      errors: 0,
    };

    try {
      let sinceUnix = 0;
      if (edge === 'leads') {
        const syncRow = await MetaLeadFormSync.findOne({ form_id: formId });
        const nowUnix = Math.floor(Date.now() / 1000);
        const storedLast = syncRow?.last_sync_unix ?? 0;
        sinceUnix = storedLast > 0 ? storedLast : nowUnix - 7 * 86400;
      }

      const leads = await fetchLeadsFromForm(formId, { edge, sinceUnix });
      summary.candidates = leads.length;

      for (const lead of leads) {
        const result = await processPolledLead(lead);
        switch (result.status) {
          case 'dispatched':
            summary.dispatched += 1;
            break;
          case 'skipped_already_called':
            summary.skipped_already_called += 1;
            break;
          case 'skipped_no_integration':
            summary.skipped_no_integration += 1;
            break;
          case 'skipped_form':
            summary.skipped_form += 1;
            break;
          case 'no_matching_automation':
            summary.no_matching_automation += 1;
            break;
          case 'error':
            summary.errors += 1;
            console.error('[Meta Leads Poll] Lead error:', result.leadgen_id, result.error);
            break;
        }
      }

      if (edge === 'leads') {
        const maxSeen = leads.reduce((m, s) => {
          const t = Date.parse(s.created_time || '');
          const u = Number.isFinite(t) ? Math.floor(t / 1000) : 0;
          return Math.max(m, u);
        }, sinceUnix);
        const syncRow = await MetaLeadFormSync.findOne({ form_id: formId });
        const storedLast = syncRow?.last_sync_unix ?? 0;
        const nextLast =
          leads.length > 0 ? Math.max(storedLast, maxSeen) : Math.max(storedLast, runStartedUnix - 60);

        await MetaLeadFormSync.findOneAndUpdate(
          { form_id: formId },
          {
            $set: {
              last_sync_unix: nextLast,
              last_run_at_unix: runStartedUnix,
              last_run_candidates: summary.candidates,
              last_run_dispatched: summary.dispatched,
            },
          },
          { upsert: true }
        );
      }
    } catch (formErr: any) {
      console.error(`[Meta Leads Poll] Form ${formId} failed:`, formErr?.message || formErr);
      summary.errors += 1;
    }

    summaries.push(summary);
    console.log('[Meta Leads Poll] Form summary:', JSON.stringify(summary));
  }

  return { ok: true, forms: summaries };
}

let pollIntervalHandle: ReturnType<typeof setInterval> | null = null;
let pollRunning = false;

export function startMetaLeadsPollingScheduler(): void {
  if (!metaLeadsConfig.pollFallbackEnabled()) {
    console.log(
      '[Meta Leads] Delivery: webhook only (poll fallback off — set META_LEADS_POLL_FALLBACK_ENABLED=true to enable scheduled catch-up)'
    );
    return;
  }

  const intervalMs = metaLeadsConfig.pollIntervalMs();
  console.log(
    `[Meta Leads] Delivery: webhook (primary) + poll fallback every ${metaLeadsConfig.pollIntervalHours}h, edge=${metaLeadsConfig.pollEdge()}`
  );

  const tick = async () => {
    if (pollRunning) {
      console.log('[Meta Leads Poll] Previous fallback run still in progress, skipping');
      return;
    }
    pollRunning = true;
    try {
      console.log('[Meta Leads Poll] Fallback catch-up run starting…');
      const result = await runMetaLeadsPoll();
      if (!result.ok) {
        console.warn('[Meta Leads Poll] Fallback run failed:', result.error);
      }
    } catch (e: any) {
      console.error('[Meta Leads Poll] Fallback tick error:', e?.message || e);
    } finally {
      pollRunning = false;
    }
  };

  // Do not poll on boot — webhooks handle new leads; first fallback run after one interval.
  pollIntervalHandle = setInterval(tick, intervalMs);
}

export function stopMetaLeadsPollingScheduler(): void {
  if (pollIntervalHandle) {
    clearInterval(pollIntervalHandle);
    pollIntervalHandle = null;
  }
}
