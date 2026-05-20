import axios from 'axios';
import { AppError } from '../middleware/error.middleware';
import {
  assertCommApiResponseData,
  formatCommApiError,
  getCommApiBaseUrl,
  isCommApiCircuitOpen,
  isCommApiUnavailableError,
  recordCommApiFailure,
  recordCommApiSuccess
} from '../utils/commApiHealth';

const COMM_API_URL = getCommApiBaseUrl();

export interface BatchCallRecipient {
  phone_number: string;
  name: string;
  email?: string;
  dynamic_variables?: Record<string, any>;
}

export interface BatchCallRequest {
  agent_id: string;
  call_name: string;
  phone_number_id: string; // ElevenLabs phone number ID
  recipients: BatchCallRecipient[];
  retry_count?: number;
  scheduled_at?: string;
  timezone?: string;
  target_concurrency_limit?: number;
  sender_email?: string;
}

export interface BatchRecipientStatus {
  id: string;
  phone_number: string;
  status: string; // "completed" | "in_progress" | "pending" | "failed"
  conversation_id?: string;
  created_at_unix?: number;
  updated_at_unix?: number;
  conversation_initiation_client_data?: {
    dynamic_variables?: Record<string, string>;
    [key: string]: any;
  };
}

export interface BatchCallResponse {
  id: string;
  name: string;
  agent_id: string;
  status: string;
  phone_number_id: string;
  phone_provider: string;
  created_at_unix: number;
  scheduled_time_unix: number;
  timezone: string;
  total_calls_dispatched: number;
  total_calls_scheduled: number;
  total_calls_finished: number;
  last_updated_at_unix: number;
  retry_count: number;
  agent_name: string;
  recipients?: BatchRecipientStatus[];
}

export interface BatchCallResult {
  [key: string]: any;
}

export interface BatchJobCallsResponse {
  calls: BatchCallResult[];
  cursor?: string;
}

/** Batch job statuses that may still change — only these are refreshed on list load. */
export const ACTIVE_BATCH_STATUSES = new Set([
  'pending',
  'scheduled',
  'running',
  'in_progress',
  'retrying',
  'queued',
  'processing',
  'initiated'
]);

export function isActiveBatchStatus(status: string | undefined): boolean {
  return ACTIVE_BATCH_STATUSES.has(String(status || '').toLowerCase().trim());
}

export class BatchCallingService {
  private syncLocks = new Set<string>();

  /**
   * Submit batch calling job
   * Calls Python /api/v1/batch-calling/submit endpoint
   */
  async submitBatchCall(data: BatchCallRequest): Promise<BatchCallResponse> {
    try {
      const pythonUrl = `${COMM_API_URL}/api/v1/batch-calling/submit`;

      // Validate phone_number_id is provided and is a non-empty string
      if (!data.phone_number_id || typeof data.phone_number_id !== 'string' || data.phone_number_id.trim() === '') {
        console.error('[Batch Calling Service] ❌ phone_number_id validation failed:', {
          provided: data.phone_number_id,
          type: typeof data.phone_number_id,
          isEmpty: !data.phone_number_id || data.phone_number_id.trim() === ''
        });
        throw new AppError(
          400,
          'BATCH_CALL_ERROR',
          'phone_number_id is required and must be a non-empty string'
        );
      }

      // Build payload with EXACTLY the required fields - no transformations, no enrichment
      // Preserve recipients exactly as received, including dynamic_variables as-is
      const payload: any = {
        agent_id: data.agent_id,
        call_name: data.call_name,
        phone_number_id: String(data.phone_number_id).trim(),
        recipients: data.recipients.map((recipient) => {
          const recipientPayload: any = {
            phone_number: recipient.phone_number,
            name: recipient.name
          };
          // Include email if provided
          if (recipient.email) {
            recipientPayload.email = recipient.email;
          }
          // Include dynamic_variables ONLY if provided (preserve exactly as received)
          if (recipient.dynamic_variables !== undefined && recipient.dynamic_variables !== null) {
            recipientPayload.dynamic_variables = recipient.dynamic_variables;
          }
          return recipientPayload;
        })
      };

      if (data.retry_count !== undefined) payload.retry_count = data.retry_count;
      if (data.scheduled_at) payload.scheduled_at = data.scheduled_at;
      if (data.timezone) payload.timezone = data.timezone;
      if (data.target_concurrency_limit !== undefined) payload.target_concurrency_limit = data.target_concurrency_limit;
      if (data.sender_email) payload.sender_email = data.sender_email;

      const response = await axios.post<BatchCallResponse>(
        pythonUrl,
        payload,
        {
          timeout: 600000, // 10 minutes timeout
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(
        `[Batch Calling Service] Batch call started: "${data.call_name}" → ${response.data?.id} ` +
        `(${payload.recipients.length} recipient(s), status: ${response.data?.status || 'pending'})`
      );

      return response.data;
    } catch (error: any) {
      console.error('[Batch Calling Service] ❌ Failed to submit batch call:', error.response?.data || error.message);
      throw new AppError(
        error.response?.status || 500,
        'BATCH_CALL_ERROR',
        error.response?.data?.message || error.response?.data?.detail || 'Failed to submit batch call'
      );
    }
  }

  /**
   * Get batch job status
   * Calls Python /api/v1/batch-calling/{job_id} endpoint
   */
  async getBatchJobStatus(jobId: string, timeoutMs = 10000): Promise<BatchCallResponse> {
    if (isCommApiCircuitOpen()) {
      throw new AppError(
        503,
        'COMM_API_UNAVAILABLE',
        'Comm API is temporarily unavailable; batch status sync is paused'
      );
    }

    try {
      const response = await axios.get<BatchCallResponse>(
        `${COMM_API_URL}/api/v1/batch-calling/${jobId}`,
        { timeout: timeoutMs, headers: { 'Content-Type': 'application/json' } }
      );
      assertCommApiResponseData(response.data, `batch status ${jobId}`);
      recordCommApiSuccess();
      return response.data;
    } catch (error: any) {
      if (isCommApiUnavailableError(error)) {
        recordCommApiFailure(error);
      }
      const message = formatCommApiError(error, `batch status ${jobId}`);
      console.error('[Batch Calling Service] ❌ Failed to get batch status:', jobId, message);
      throw new AppError(
        error.response?.status || (isCommApiUnavailableError(error) ? 503 : 500),
        isCommApiUnavailableError(error) ? 'COMM_API_UNAVAILABLE' : 'BATCH_CALL_ERROR',
        message
      );
    }
  }

  /**
   * Pull latest summary counters from the Python API and persist to Mongo.
   * Used for list refresh on in-flight batches only (not full recipient sync).
   */
  async refreshBatchSummaryInDb(batchCallId: string, timeoutMs = 20000): Promise<{
    status: string;
    total_calls_dispatched: number;
    total_calls_scheduled: number;
    total_calls_finished: number;
    last_updated_at_unix: number;
  } | null> {
    const latestStatus = await this.getBatchJobStatus(batchCallId, timeoutMs);
    const BatchCall = (await import('../models/BatchCall')).default;
    await BatchCall.updateOne(
      { batch_call_id: batchCallId },
      {
        $set: {
          status: latestStatus.status,
          total_calls_dispatched: latestStatus.total_calls_dispatched,
          total_calls_scheduled: latestStatus.total_calls_scheduled,
          total_calls_finished: latestStatus.total_calls_finished,
          last_updated_at_unix: latestStatus.last_updated_at_unix
        }
      }
    );
    return {
      status: latestStatus.status,
      total_calls_dispatched: latestStatus.total_calls_dispatched,
      total_calls_scheduled: latestStatus.total_calls_scheduled,
      total_calls_finished: latestStatus.total_calls_finished,
      last_updated_at_unix: latestStatus.last_updated_at_unix
    };
  }

  /**
   * Cancel batch job
   * Calls Python /api/v1/batch-calling/{job_id}/cancel endpoint
   */
  /**
   * Retry batch job (failed and no-response recipients)
   * Calls Python POST /api/v1/batch-calling/{batch_id}/retry
   */
  async retryBatchJob(jobId: string): Promise<BatchCallResponse> {
    try {
      const pythonUrl = `${COMM_API_URL}/api/v1/batch-calling/${jobId}/retry`;
      console.log('[Batch Calling Service] Retrying batch job:', jobId);

      const response = await axios.post<BatchCallResponse>(
        pythonUrl,
        {},
        { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
      );

      console.log('[Batch Calling Service] ✅ Batch job retry initiated successfully');
      console.log('[Batch Calling Service] Response status:', response.status);
      console.log('[Batch Calling Service] Response body:', JSON.stringify(response.data, null, 2));

      return response.data;
    } catch (error: any) {
      console.error('[Batch Calling Service] ❌ Failed to retry batch job:', error.response?.data || error.message);
      throw new AppError(
        error.response?.status || 500,
        'BATCH_CALL_ERROR',
        error.response?.data?.message || error.response?.data?.detail || 'Failed to retry batch job'
      );
    }
  }

  async cancelBatchJob(jobId: string): Promise<{ success: boolean; message: string }> {
    try {
      const pythonUrl = `${COMM_API_URL}/api/v1/batch-calling/${jobId}/cancel`;
      console.log('[Batch Calling Service] Cancelling batch:', jobId);

      const response = await axios.post<{ success: boolean; message: string }>(
        pythonUrl,
        {},
        {
          timeout: 30000, // 30 seconds timeout
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('[Batch Calling Service] ✅ Batch job cancelled successfully');
      console.log('[Batch Calling Service] Response status:', response.status);
      console.log('[Batch Calling Service] Response body:', JSON.stringify(response.data, null, 2));

      return response.data;
    } catch (error: any) {
      console.error('[Batch Calling Service] ❌ Failed to cancel batch job:', error.response?.data || error.message);
      throw new AppError(
        error.response?.status || 500,
        'BATCH_CALL_ERROR',
        error.response?.data?.message || error.response?.data?.detail || 'Failed to cancel batch job'
      );
    }
  }

  /**
   * Resume batch job
   * Calls Python /api/v1/batch-calling/{job_id}/resume endpoint
   */
  async resumeBatchJob(jobId: string): Promise<{ success: boolean; message: string }> {
    try {
      const pythonUrl = `${COMM_API_URL}/api/v1/batch-calling/${jobId}/resume`;
      console.log('[Batch Calling Service] Resuming batch:', jobId);

      const response = await axios.post<{ success: boolean; message: string }>(
        pythonUrl,
        {},
        {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('[Batch Calling Service] ✅ Batch job resumed successfully');
      return response.data;
    } catch (error: any) {
      console.error('[Batch Calling Service] ❌ Failed to resume batch job:', error.response?.data || error.message);
      throw new AppError(
        error.response?.status || 500,
        'BATCH_CALL_ERROR',
        error.response?.data?.message || error.response?.data?.detail || 'Failed to resume batch job'
      );
    }
  }

  /**
   * Get batch job calls (individual call results)
   * Calls Python /api/v1/batch-calling/{job_id}/calls endpoint
   * If endpoint doesn't exist (404), returns empty result gracefully
   */
  async getBatchJobCalls(
    jobId: string,
    options?: {
      status?: string;
      cursor?: string;
      page_size?: number;
    }
  ): Promise<BatchJobCallsResponse> {
    try {
      const params: Record<string, any> = {};
      if (options?.status) params.status = options.status;
      if (options?.cursor) params.cursor = options.cursor;
      if (options?.page_size) params.page_size = options.page_size;

      const response = await axios.get<BatchJobCallsResponse>(
        `${COMM_API_URL}/api/v1/batch-calling/${jobId}/calls`,
        { params, timeout: 30000, headers: { 'Content-Type': 'application/json' } }
      );

      return response.data;
    } catch (error: any) {
      // Handle 404 gracefully - endpoint might not be implemented yet
      if (error.response?.status === 404) {
        console.warn('[Batch Calling Service] ⚠️  Batch job calls endpoint not found (404). This endpoint may not be implemented in the Python API yet.');
        console.warn('[Batch Calling Service] Returning empty result. Endpoint:', `${COMM_API_URL}/api/v1/batch-calling/${jobId}/calls`);

        // Return empty result instead of throwing error
        return {
          calls: [],
          cursor: undefined
        };
      }

      console.error('[Batch Calling Service] ❌ Failed to get batch job calls:', error.response?.data || error.message);
      throw new AppError(
        error.response?.status || 500,
        'BATCH_CALL_ERROR',
        error.response?.data?.message || error.response?.data?.detail || 'Failed to get batch job calls'
      );
    }
  }

  /**
   * Get batch job results with transcripts
   * Calls Python /api/v1/batch-calling/{job_id}/results endpoint
   */
  async getBatchJobResults(
    jobId: string,
    includeTranscript: boolean = true
  ): Promise<any> {
    try {
      const params: Record<string, any> = {};
      if (includeTranscript !== undefined) params.include_transcript = includeTranscript;

      const response = await axios.get<any>(
        `${COMM_API_URL}/api/v1/batch-calling/${jobId}/results`,
        { params, timeout: 60000, headers: { 'Content-Type': 'application/json' } }
      );

      return response.data;
    } catch (error: any) {
      console.error('[Batch Calling Service] ❌ Failed to get batch job results:', jobId, error.response?.data || error.message);
      throw new AppError(
        error.response?.status || 500,
        'BATCH_CALL_ERROR',
        error.response?.data?.message || error.response?.data?.detail || 'Failed to get batch job results'
      );
    }
  }

  /**
   * Fetch a single ElevenLabs conversation by conversation_id.
   * Returns the full conversation object including transcript, duration, status, etc.
   * Returns null if conversation not found or API error.
   */
  async getConversationDetail(conversationId: string): Promise<any | null> {
    try {
      const response = await axios.get(
        `${COMM_API_URL}/api/v1/conversations/${conversationId}`,
        { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
      );
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) return null;
      return null;
    }
  }

  private static readonly TERMINAL_RECIPIENT_STATUSES = new Set([
    'failed',
    'busy',
    'no_answer',
    'no-answer',
    'voicemail',
    'cancelled',
    'canceled'
  ]);

  /** Match phones across CSV, DB, and ElevenLabs (+91… vs 91… vs spaces). */
  private normalizePhoneKey(phone: string): string {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length >= 10) return digits.slice(-10);
    return digits;
  }

  private isAutomationDoneForPhone(automationDoneKeys: Set<string>, phone: string): boolean {
    const key = this.normalizePhoneKey(phone);
    if (!key) return false;
    return automationDoneKeys.has(key);
  }

  private isBatchFullyDone(batch: BatchCallResponse): boolean {
    const s = String(batch.status || '').toLowerCase();
    if (s === 'completed' || s === 'done' || s === 'finished') return true;
    const scheduled = batch.total_calls_scheduled ?? 0;
    const finished = batch.total_calls_finished ?? 0;
    return scheduled > 0 && Number.isFinite(finished) && finished >= scheduled;
  }

  private isCompletedLikeRecipientStatus(status: string): boolean {
    const raw = String(status || '').toLowerCase().trim();
    return (
      raw === 'completed' ||
      raw === 'complete' ||
      raw === 'done' ||
      raw === 'finished' ||
      raw === 'success' ||
      raw === 'successful'
    );
  }

  private recipientLooksInFlight(status: string): boolean {
    const s = String(status || '')
      .toLowerCase()
      .replace(/_/g, ' ')
      .replace(/-/g, ' ')
      .trim();
    if (!s) return false;
    return (
      s === 'pending' ||
      s === 'queued' ||
      s === 'scheduled' ||
      s === 'initiated' ||
      s.includes('in progress') ||
      s.includes('ringing') ||
      s.includes('dialing') ||
      s.includes('calling') ||
      s.includes('processing')
    );
  }

  /**
   * Decide whether to fetch conversation detail and attempt automation for a recipient.
   * Mirrors batch UI outcome logic — do not rely on recipient.status === "completed" alone.
   */
  private resolveRecipientSyncAction(
    recipient: BatchRecipientStatus,
    batchFullyDone: boolean
  ): 'process' | 'wait' | 'terminal_no_call' {
    const normalized = String(recipient.status || '').toLowerCase().trim();

    // Status can lag (e.g. no_answer → completed). If we have a conversation id, always verify.
    if (recipient.conversation_id) {
      return 'process';
    }
    if (this.isCompletedLikeRecipientStatus(recipient.status || '')) {
      return 'wait';
    }
    if (BatchCallingService.TERMINAL_RECIPIENT_STATUSES.has(normalized)) {
      return batchFullyDone ? 'terminal_no_call' : 'wait';
    }
    if (batchFullyDone && !this.recipientLooksInFlight(recipient.status || '')) {
      return 'terminal_no_call';
    }
    return 'wait';
  }

  private conversationHasCallableContent(convDetail: any): {
    ready: boolean;
    duration: number;
    transcriptItems: any[];
  } {
    const hasMessages = (t: any): boolean =>
      t != null && (
        (Array.isArray(t) && t.length > 0) ||
        (typeof t === 'string' && t.trim().length > 0) ||
        (t.messages && Array.isArray(t.messages) && t.messages.length > 0) ||
        (t.items && Array.isArray(t.items) && t.items.length > 0)
      );

    const transcript = convDetail?.transcript;
    const duration =
      convDetail?.metadata?.call_duration_secs ??
      convDetail?.call_duration_secs ??
      convDetail?.metadata?.call_duration_seconds ??
      0;
    const transcriptItems =
      transcript?.items ||
      transcript?.messages ||
      (Array.isArray(transcript) ? transcript : []);
    const liveStatus = String(convDetail?.status || convDetail?.conversation_status || '').toLowerCase();
    const liveDone =
      liveStatus === 'done' ||
      liveStatus === 'completed' ||
      liveStatus === 'finished';
    const ready =
      hasMessages(transcript) ||
      Number(duration) >= 1 ||
      liveDone ||
      convDetail?.analysis?.call_successful === true;

    return { ready, duration: Number(duration) || 0, transcriptItems };
  }

  /**
   * Production-grade batch call sync.
   *
   * Flow:
   *   1. GET batch status → recipients with status + conversation_id
   *   2. For each recipient: if conversation exists (or call evidence), fetch transcript
   *      → create/update conversation → trigger automation (even if API status lags)
   *   3. When all recipients resolved → conversations_synced = true, stop polling
   */
  async syncBatchCallConversations(jobId: string, organizationId: string): Promise<void> {
    if (isCommApiCircuitOpen()) {
      return;
    }

    if (this.syncLocks.has(jobId)) {
      return;
    }
    this.syncLocks.add(jobId);

    const BatchCall = (await import('../models/BatchCall')).default;

    try {
      const batchCall = await BatchCall.findOne({ batch_call_id: jobId }).lean() as any;
      if (!batchCall) {
        console.error('[Batch Calling Service] ❌ Batch not found:', jobId);
        return;
      }
      if (batchCall.status === 'cancelled') {
        return;
      }

      // Track which phones have had automation successfully triggered (source of truth for dedup).
      // We use this instead of processed_call_ids because processed_call_ids can get corrupted
      // by stale data from previous server runs / code versions.
      const automationDoneKeys = new Set<string>(
        (batchCall.automation_triggered_phones || []).map((p: string) => this.normalizePhoneKey(p))
      );

      // ── STEP 1: Get batch status with recipients list from Python API ──────
      let batchStatus: BatchCallResponse;
      try {
        batchStatus = await this.getBatchJobStatus(jobId);
      } catch (err: any) {
        await BatchCall.updateOne({ batch_call_id: jobId }, { $inc: { syncErrorCount: 1 } });
        if (!isCommApiCircuitOpen()) {
          console.error(`[Batch Calling Service] ❌ Cannot fetch batch status: ${err.message}`);
        }
        return;
      }

      const recipients = batchStatus.recipients || [];
      if (recipients.length === 0) {
        return;
      }

      // Update DB with live status
      if (batchStatus.status && batchStatus.status !== batchCall.status) {
        await BatchCall.updateOne({ batch_call_id: jobId }, {
          $set: {
            status: batchStatus.status,
            total_calls_dispatched: batchStatus.total_calls_dispatched,
            total_calls_scheduled: batchStatus.total_calls_scheduled,
            total_calls_finished: batchStatus.total_calls_finished
          }
        });
      }

      // ── STEP 2: Process each recipient ────────────────────────────────────
      const Conversation = (await import('../models/Conversation')).default;
      const Customer = (await import('../models/Customer')).default;
      const Message = (await import('../models/Message')).default;
      const mongoose = (await import('mongoose')).default;
      const { emitToOrganization } = await import('../config/socket');

      const orgObjectId = new mongoose.Types.ObjectId(organizationId);
      const userId = batchCall.userId?.toString() || organizationId;

      let created = 0;
      let skipped = 0;
      let waiting = 0;
      let terminalWithoutConversation = 0;
      const automationTriggered: string[] = [];
      const batchFullyDone = this.isBatchFullyDone(batchStatus);

      for (const recipient of recipients) {
        const phone = recipient.phone_number;
        const recipientStatus = recipient.status;
        let elevenLabsConvId = recipient.conversation_id;

        try {
          if (!this.isAutomationDoneForPhone(automationDoneKeys, phone)) {
            try {
              const latest = await BatchCall.findOne(
                { batch_call_id: jobId },
                { automation_triggered_phones: 1 }
              ).lean();
              for (const p of (latest?.automation_triggered_phones || [])) {
                automationDoneKeys.add(this.normalizePhoneKey(p));
              }
            } catch (_) { /* best-effort */ }
          }
          if (this.isAutomationDoneForPhone(automationDoneKeys, phone)) {
            skipped++;
            continue;
          }

          const syncAction = this.resolveRecipientSyncAction(recipient, batchFullyDone);
          if (syncAction === 'terminal_no_call') {
            terminalWithoutConversation++;
            skipped++;
            continue;
          }
          if (syncAction === 'wait') {
            waiting++;
            continue;
          }

          const convDetail = await this.getConversationDetail(elevenLabsConvId!);
          if (!convDetail) {
            waiting++;
            continue;
          }

          const pickFirstNonEmpty = (...vals: any[]): string => {
            for (const v of vals) {
              if (v === null || v === undefined) continue;
              const s = String(v).trim();
              if (s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'undefined') return s;
            }
            return '';
          };

          const audioFallbackUrl = (conversationId: string) =>
            `${COMM_API_URL}/api/v1/conversations/${conversationId}/audio`;

          // Public proxy on OUR backend — forces inline playback.
          const backendPublicBase = (
            process.env.BACKEND_URL ||
            process.env.PUBLIC_API_URL ||
            `http://localhost:${process.env.PORT || 5001}`
          ).replace(/\/+$/, '');
          const publicProxyUrl = (conversationId: string) =>
            `${backendPublicBase}/api/v1/conversations/recording/${conversationId}`;

          // Always return a directly-playable audio URL — never a JSON endpoint.
          // Prefers our public proxy (inline disposition) so links play instead of
          // downloading.
          const normalizeRecordingUrl = (raw: string, conversationId: string): string => {
            if (conversationId) return publicProxyUrl(conversationId);

            const value = String(raw || '').trim();
            if (!value) return audioFallbackUrl(conversationId);

            // Bare id/token → use audio fallback
            if (!value.includes('.') && !value.includes('/')) {
              return audioFallbackUrl(conversationId);
            }

            // Path → prefix host
            if (value.startsWith('/')) {
              const full = `${COMM_API_URL}${value}`;
              return /\/conversations\/[^/]+\/?$/i.test(full) ? `${full.replace(/\/$/, '')}/audio` : full;
            }

            // Add scheme if missing
            const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;

            // If it points to the JSON conversation detail endpoint, append /audio so it streams.
            if (/\/conversations\/[^/?#]+\/?(\?|#|$)/i.test(withScheme) && !/\/audio(\?|#|$)/i.test(withScheme)) {
              return withScheme.replace(/\/conversations\/([^/?#]+)\/?/i, '/conversations/$1/audio');
            }

            return withScheme;
          };

          const rawRecordingUrl = pickFirstNonEmpty(
            convDetail?.recording_url,
            convDetail?.audio_url,
            convDetail?.recordingUrl,
            convDetail?.audioUrl,
            convDetail?.signed_url,
            convDetail?.signedUrl,
            convDetail?.public_audio_url,
            convDetail?.metadata?.recording_url,
            convDetail?.metadata?.audio_url,
            convDetail?.metadata?.recordingUrl,
            convDetail?.metadata?.audioUrl,
            convDetail?.metadata?.signed_url,
            convDetail?.analysis?.recording_url,
            convDetail?.analysis?.audio_url
          );
          const resolvedRecordingUrl = normalizeRecordingUrl(rawRecordingUrl, elevenLabsConvId!);

          const transcript = convDetail?.transcript;
          const { ready, duration, transcriptItems } = this.conversationHasCallableContent(convDetail);
          const endReason = convDetail?.metadata?.termination_reason || (convDetail?.analysis?.call_successful ? 'completed' : '');

          const statusSaysDone = this.isCompletedLikeRecipientStatus(recipientStatus || '');

          // Transcript content guard — must come BEFORE the ready/statusSaysDone gate.
          //
          // ElevenLabs marks a call "completed" in the batch recipients list before
          // the transcript is written. If we let execution proceed immediately with
          // an empty conversation (no transcript items, zero duration), the
          // appointment extraction always returns "no appointment booked", the phone
          // is permanently added to automation_triggered_phones, and it is never
          // retried — so only the recipient(s) whose transcript happened to be ready
          // on the first sync ever have their appointment booking automation run.
          //
          // Fix: if both transcript items and duration are zero, keep the recipient
          // in the waiting bucket and retry on the next poll cycle. After 3 retries
          // (≈90 s) we accept that the call genuinely produced no transcript.
          const transcriptMissing = transcriptItems.length === 0 && Number(duration) === 0;
          if (transcriptMissing) {
            if (!batchFullyDone) {
              waiting++;
              continue;
            }
            // Batch is fully done but transcript still empty: retry up to 3
            // poll cycles before giving up.
            const retryKey = `transcript_pending_${this.normalizePhoneKey(phone)}`;
            const retryCount: number = (batchCall as any)[retryKey] || 0;
            if (retryCount < 3) {
              try {
                await BatchCall.updateOne(
                  { batch_call_id: jobId },
                  { $set: { [retryKey]: retryCount + 1 } }
                );
              } catch (_) { /* best-effort */ }
              waiting++;
              continue;
            }
            // After 3 retries fall through: accept a genuinely empty call.
          }

          if (!ready && !statusSaysDone) {
            if (batchFullyDone) {
              terminalWithoutConversation++;
              skipped++;
              continue;
            }
            waiting++;
            continue;
          }

          // ── Recipient completed + transcript ready → process + trigger automation ──
          const vars = recipient.conversation_initiation_client_data?.dynamic_variables || {};
          const firstName = vars.first_name || vars.customer_first_name;
          const lastName = vars.last_name || vars.customer_last_name;
          const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
          const name = fullName || vars.name || vars.customer_name || 'Unknown';
          const email = vars.email || vars.customer_email;

          let existing: any = null;
          if (elevenLabsConvId) {
            existing = await Conversation.findOne({
              organizationId: orgObjectId,
              channel: 'phone',
              'metadata.batch_call_id': jobId,
              'metadata.conversation_id': elevenLabsConvId
            });
          }
          if (!existing) {
            const phoneKey = this.normalizePhoneKey(phone);
            const batchConversations = await Conversation.find({
              organizationId: orgObjectId,
              channel: 'phone',
              'metadata.batch_call_id': jobId
            }).lean();
            existing = batchConversations.find(
              (c: any) => this.normalizePhoneKey(c?.metadata?.phone_number) === phoneKey
            ) || null;
          }

          let conversationId: string;
          let contactId: string;

          if (existing) {
            conversationId = existing._id.toString();
            contactId = existing.customerId?.toString() || '';

            // Update transcript on existing conversation
            await Conversation.updateOne({ _id: existing._id }, {
              $set: {
                transcript,
                'metadata.duration_seconds': duration,
                'metadata.call_duration_secs': duration,
                'metadata.end_reason': endReason,
                'metadata.conversation_id': elevenLabsConvId,
                'metadata.recording_url': resolvedRecordingUrl,
                'metadata.audio_url': resolvedRecordingUrl
              }
            });

            // Save messages if not already saved
            const existingMsgCount = await Message.countDocuments({ conversationId: existing._id, type: 'message' });
            if (existingMsgCount === 0 && transcriptItems.length > 0) {
              const msgs: any[] = [];
              for (const item of transcriptItems) {
                const text = item.message || item.content || item.text || (Array.isArray(item.content) ? item.content.join(' ') : '');
                if (!text?.trim()) continue;
                const role = item.role;
                msgs.push({
                  conversationId: existing._id,
                  sender: (role === 'agent' || role === 'assistant') ? 'ai' : 'customer',
                  text: text.trim(),
                  type: 'message',
                  attachments: [], sourcesUsed: [], topics: [],
                  timestamp: new Date(item.timestamp || Date.now()),
                  metadata: { fromBatchCall: true }
                });
              }
              if (msgs.length > 0) {
                await Message.insertMany(msgs);
              }
            }
            skipped++;
          } else {
            // ── Find or create customer ──────────────────────────────────────
            let customer = await Customer.findOne({ phone, organizationId: orgObjectId });
            if (!customer) {
              customer = await Customer.create({
                name, phone, email,
                organizationId: orgObjectId,
                source: 'phone',
                color: `#${Math.floor(Math.random() * 16777215).toString(16)}`
              });
            } else {
              let updated = false;
              if (name !== 'Unknown' && customer.name !== name) { customer.name = name; updated = true; }
              if (email && customer.email !== email) { customer.email = email; updated = true; }
              if (updated) await customer.save();
            }

            contactId = customer._id.toString();

            // ── Create conversation ──────────────────────────────────────────
            const conversation = await Conversation.create({
              organizationId: orgObjectId,
              customerId: customer._id,
              channel: 'phone',
              status: 'closed',
              transcript,
              isAiManaging: true,
              unread: false,
              metadata: {
                batch_call_id: jobId,
                conversation_id: elevenLabsConvId,
                recipient_id: recipient.id,
                phone_number: phone,
                callerId: elevenLabsConvId,
                duration_seconds: duration,
                call_duration_secs: duration,
                call_successful: true,
                end_reason: endReason,
                recording_url: resolvedRecordingUrl,
                audio_url: resolvedRecordingUrl,
                callInitiated: new Date(duration ? Date.now() - duration * 1000 : Date.now()),
                callCompletedAt: new Date(),
                source: 'batch'
              }
            });

            conversationId = conversation._id.toString();

            try { emitToOrganization(organizationId, 'conversation:new', { conversationId, channel: 'phone', source: 'batch', customerId: contactId, customerName: name }); } catch (_) {}

            // ── Save messages ────────────────────────────────────────────────
            if (transcriptItems.length > 0) {
              const msgs: any[] = [];
              for (const item of transcriptItems) {
                const text = item.message || item.content || item.text || (Array.isArray(item.content) ? item.content.join(' ') : '');
                if (!text?.trim()) continue;
                const role = item.role;
                msgs.push({
                  conversationId: conversation._id,
                  sender: (role === 'agent' || role === 'assistant') ? 'ai' : 'customer',
                  text: text.trim(),
                  type: 'message',
                  attachments: [], sourcesUsed: [], topics: [],
                  timestamp: new Date(item.timestamp || Date.now()),
                  metadata: { transcriptItemId: `${recipient.id}_${msgs.length}`, fromBatchCall: true }
                });
              }
              if (msgs.length > 0) {
                await Message.insertMany(msgs);
              }
            }

            created++;
          }

          // ── Trigger automation ─────────────────────────────────────────────
          try {
            const { automationService } = await import('./automation.service');
            const recordingUrl = resolvedRecordingUrl;
            const csvOrCallAddress =
              vars.address ||
              vars.full_address ||
              vars.customer_address ||
              vars.home_address ||
              '';
            console.log(
              `[Batch Calling Service] Call completed — triggering automation | contact: ${name} | phone: ${phone} | batch: ${jobId}`
            );
            const triggerResults = await automationService.triggerByEvent('batch_call_completed', {
              event: 'batch_call_completed',
              batch_id: jobId,
              conversation_id: conversationId,
              contactId,
              organizationId,
              source: 'batch_call',
              recording_url: recordingUrl,
              audio_url: recordingUrl,
              dynamic_variables: vars,
              selected_dynamic_variable_keys: batchCall.selected_dynamic_variable_keys || [],
              freshContactData: {
                name,
                first_name: firstName || '',
                last_name: lastName || '',
                email,
                phone,
                address: csvOrCallAddress
              }
            }, { userId, organizationId });
            const workflowNames = (triggerResults || [])
              .map((r: any) => r?.name)
              .filter(Boolean)
              .join(', ') || 'none';
            console.log(
              `[Batch Calling Service] ✅ AUTOMATION TRIGGERED | contact: ${name} | phone: ${phone} | batch: ${jobId} | conv: ${elevenLabsConvId} | workflow(s): ${workflowNames}`
            );
          } catch (err: any) {
            console.error(
              `[Batch Calling Service] ❌ AUTOMATION FAILED | contact: ${name} | phone: ${phone} | batch: ${jobId} |`,
              err.message
            );
            continue; // don't mark processed – retry next tick
          }

          // Mark done ONLY after automation succeeds.
          // Persist immediately so a parallel sync can't re-fire it.
          automationTriggered.push(phone);
          automationDoneKeys.add(this.normalizePhoneKey(phone));
          try {
            await BatchCall.updateOne(
              { batch_call_id: jobId },
              { $addToSet: { automation_triggered_phones: phone } }
            );
          } catch (_) { /* best-effort persist */ }

        } catch (err: any) {
          console.error(`[Batch Calling Service] Failed to process ${phone}:`, err.message);
        }
      }

      // ── Persist automation-triggered phones atomically ─────────────────
      if (automationTriggered.length > 0) {
        await BatchCall.updateOne(
          { batch_call_id: jobId },
          { $addToSet: { automation_triggered_phones: { $each: automationTriggered } } }
        );
        console.log(
          `[Batch Calling Service] Batch ${jobId}: automation triggered this cycle for ${automationTriggered.length} contact(s): ${automationTriggered.join(', ')}`
        );
      }

      // ── Mark batch fully done ──────────────────────────────────────────────
      const totalResolvedRecipients = automationDoneKeys.size + terminalWithoutConversation;
      const allDone = waiting === 0 && totalResolvedRecipients >= recipients.length;
      if (allDone) {
        await BatchCall.updateOne(
          { batch_call_id: jobId },
          { $set: { conversations_synced: true }, $unset: { syncErrorCount: '' } }
        );
      }

      if (created > 0 || automationTriggered.length > 0) {
        try { emitToOrganization(organizationId, 'batch:conversations-synced', { batch_call_id: jobId, conversationsCreated: created, automationsTriggered: automationTriggered.length, pendingRecipients: waiting }); } catch (_) {}
      }

    } catch (error: any) {
      console.error('[Batch Calling Service] Sync error:', error.message);
      await BatchCall.updateOne({ batch_call_id: jobId }, { $inc: { syncErrorCount: 1 } });
      throw error;
    } finally {
      this.syncLocks.delete(jobId);
    }
  }
}

export const batchCallingService = new BatchCallingService();
