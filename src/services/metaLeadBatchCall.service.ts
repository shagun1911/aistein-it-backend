import axios from 'axios';
import mongoose from 'mongoose';
import { AppError } from '../middleware/error.middleware';

export type MetaLeadBatchCallRecipient = {
  phone_number: string;
  name: string;
  email?: string;
  dynamic_variables?: Record<string, string>;
};

export type MetaLeadBatchCallResult = {
  id: string;
  status?: string;
  name?: string;
  phone_number_id?: string;
  agent_id?: string;
  agent_name?: string;
  phone_provider?: string;
  created_at_unix?: number;
  scheduled_time_unix?: number;
  timezone?: string;
  total_calls_dispatched?: number;
  total_calls_scheduled?: number;
  total_calls_finished?: number;
  last_updated_at_unix?: number;
  retry_count?: number;
  [key: string]: unknown;
};

/** Same host order as campaigns (commApiHealth: PYTHON_API_URL first). Keplerov1 has no /batch-calling/submit. */
function getMetaCommApiBaseUrl(): string {
  const raw =
    process.env.META_LEADS_COMM_API_URL ||
    process.env.PYTHON_API_URL ||
    process.env.COMM_API_URL ||
    'https://eleven.candexai.co.in';
  let base = raw.trim().replace(/\/$/, '');
  if (base.startsWith('http://eleven.candexai.co.in')) {
    base = base.replace('http://', 'https://');
  }
  return base;
}

/** Same phone lookup as BatchCallingController (no batchCalling.service import). */
async function resolveElevenLabsPhoneNumberId(params: {
  phoneNumberId: string;
  organizationId: string;
  userId: string;
}): Promise<string> {
  const PhoneNumber = (await import('../models/PhoneNumber')).default;
  const requestedPhoneId = String(params.phoneNumberId).trim();
  const organizationId = new mongoose.Types.ObjectId(params.organizationId);
  const userId = new mongoose.Types.ObjectId(params.userId);

  const phoneNumber = await PhoneNumber.findOne({
    $and: [
      {
        $or: [
          { phone_number_id: requestedPhoneId },
          { elevenlabs_phone_number_id: requestedPhoneId },
        ],
      },
      { $or: [{ organizationId }, { userId }] },
    ],
  }).lean();

  if (!phoneNumber) {
    throw new AppError(
      404,
      'PHONE_NUMBER_NOT_FOUND',
      `Phone number ${requestedPhoneId} not found for this organization`
    );
  }

  let elevenlabsPhoneNumberId =
    phoneNumber.elevenlabs_phone_number_id ||
    (phoneNumber.phone_number_id === requestedPhoneId ? requestedPhoneId : '');

  if (phoneNumber.elevenlabs_phone_number_id === requestedPhoneId) {
    elevenlabsPhoneNumberId = requestedPhoneId;
  }

  if (!elevenlabsPhoneNumberId) {
    throw new AppError(
      400,
      'PHONE_NUMBER_NOT_REGISTERED',
      `Phone number ${requestedPhoneId} is not registered with ElevenLabs. Register it under Settings → Phone Numbers (same as Campaigns).`
    );
  }

  return String(elevenlabsPhoneNumberId).trim();
}

/**
 * Submit Meta lead batch call directly to comm API (COMM_API_URL), matching campaigns payload
 * but avoiding batchCalling.service which uses PYTHON_API_URL and returns 404 on /submit.
 */
export async function submitMetaLeadBatchCallViaApi(params: {
  userId: string;
  organizationId: string;
  agent_id: string;
  phone_number_id: string;
  call_name: string;
  recipients: MetaLeadBatchCallRecipient[];
}): Promise<MetaLeadBatchCallResult> {
  const elevenlabsPhoneNumberId = await resolveElevenLabsPhoneNumberId({
    phoneNumberId: params.phone_number_id,
    organizationId: params.organizationId,
    userId: params.userId,
  });

  const recipients = params.recipients.map((r) => {
    const out: Record<string, unknown> = {
      phone_number: r.phone_number,
      name: r.name,
    };
    if (r.email) out.email = r.email;
    if (r.dynamic_variables) out.dynamic_variables = r.dynamic_variables;
    return out;
  });

  const payload = {
    agent_id: params.agent_id,
    call_name: params.call_name,
    phone_number_id: elevenlabsPhoneNumberId,
    recipients,
    timezone: 'Europe/Rome',
    retry_count: 0,
  };

  const commUrl = `${getMetaCommApiBaseUrl()}/api/v1/batch-calling/submit`;
  console.log('[Meta Lead Batch Call] POST comm API (COMM_API_URL)', {
    commUrl,
    requested_phone: params.phone_number_id,
    elevenlabs_phone_number_id: elevenlabsPhoneNumberId,
    recipients_count: recipients.length,
  });

  try {
    const response = await axios.post<MetaLeadBatchCallResult>(commUrl, payload, {
      timeout: 300_000,
      headers: { 'Content-Type': 'application/json' },
    });

    const result = response.data;
    if (!result?.id) {
      throw new AppError(500, 'BATCH_CALL_ERROR', 'Comm API batch submit response missing job id');
    }

    const BatchCall = (await import('../models/BatchCall')).default;
    await BatchCall.create({
      userId: new mongoose.Types.ObjectId(params.userId),
      organizationId: new mongoose.Types.ObjectId(params.organizationId),
      batch_call_id: result.id,
      name: result.name || params.call_name,
      agent_id: result.agent_id || params.agent_id,
      status: result.status || 'pending',
      phone_number_id: result.phone_number_id || elevenlabsPhoneNumberId,
      phone_provider: result.phone_provider || 'elevenlabs',
      created_at_unix: result.created_at_unix ?? Math.floor(Date.now() / 1000),
      scheduled_time_unix: result.scheduled_time_unix ?? Math.floor(Date.now() / 1000),
      timezone: result.timezone || 'Europe/Rome',
      total_calls_dispatched: result.total_calls_dispatched ?? 0,
      total_calls_scheduled: result.total_calls_scheduled ?? recipients.length,
      total_calls_finished: result.total_calls_finished ?? 0,
      last_updated_at_unix: result.last_updated_at_unix ?? Math.floor(Date.now() / 1000),
      retry_count: result.retry_count ?? 0,
      agent_name: result.agent_name || '',
      call_name: params.call_name,
      recipients_count: recipients.length,
      conversations_synced: false,
    });

    console.log('[Meta Lead Batch Call] ✅ Submitted:', {
      id: result.id,
      status: result.status,
    });

    return result;
  } catch (err: unknown) {
    const ax = err as {
      response?: { status?: number; data?: { detail?: unknown; message?: string } };
      message?: string;
    };
    const detail = ax.response?.data?.detail ?? ax.response?.data?.message;
    const msg =
      typeof detail === 'string'
        ? detail
        : detail != null
          ? JSON.stringify(detail)
          : ax.message || 'Meta lead batch call failed';
    console.error('[Meta Lead Batch Call] ❌ Comm API error:', msg);
    throw new AppError(ax.response?.status || 500, 'BATCH_CALL_ERROR', msg);
  }
}
