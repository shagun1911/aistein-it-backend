import axios from 'axios';
import { AppError } from '../middleware/error.middleware';

// Use PYTHON_API_URL if available (for elvenlabs-voiceagent), otherwise fall back to COMM_API_URL
// This ensures consistency - if PYTHON_API_URL is set, use it for all Python API calls
const COMM_API_URL = process.env.PYTHON_API_URL || process.env.COMM_API_URL || 'https://elvenlabs-voiceagent.onrender.com';

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

export class BatchCallingService {
  private syncLocks = new Set<string>();

  /**
   * Submit batch calling job
   * Calls Python /api/v1/batch-calling/submit endpoint
   */
  async submitBatchCall(data: BatchCallRequest): Promise<BatchCallResponse> {
    try {
      const pythonUrl = `${COMM_API_URL}/api/v1/batch-calling/submit`;

      console.log('[Batch Calling Service] ===== SUBMITTING BATCH CALL =====');
      console.log('[Batch Calling Service] Python API URL:', pythonUrl);
      console.log('[Batch Calling Service] Request payload:', {
        agent_id: data.agent_id,
        call_name: data.call_name,
        phone_number_id: data.phone_number_id,
        recipients_count: data.recipients.length,
        retry_count: data.retry_count ?? null,
        scheduled_at: data.scheduled_at ?? null,
        timezone: data.timezone ?? null,
        target_concurrency_limit: data.target_concurrency_limit ?? null,
        has_sender_email: Boolean(data.sender_email)
      });

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

      // Log summary first
      console.log('[Batch Calling Service] 🚀 Submitting batch:', {
        recipients_count: payload.recipients.length,
        agent_id: payload.agent_id,
        phone_number_id: payload.phone_number_id,
        call_name: payload.call_name,
        retry_count: payload.retry_count ?? null,
        scheduled_at: payload.scheduled_at ?? null,
        timezone: payload.timezone ?? null,
        target_concurrency_limit: payload.target_concurrency_limit ?? null,
        has_sender_email: Boolean(payload.sender_email)
      });

      // Debug: print exact payload so it can be replayed directly in provider docs/tools.
      console.log('[Batch Calling Service] Exact submit payload JSON:', JSON.stringify(payload, null, 2));

      // Make the request
      console.log('[Batch Calling Service] Making POST request to:', pythonUrl);

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

      console.log('[Batch Calling Service] ✅ Batch call submitted successfully', {
        status: response.status,
        batch_id: response.data?.id,
        batch_status: response.data?.status
      });

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
  async getBatchJobStatus(jobId: string): Promise<BatchCallResponse> {
    try {
      const response = await axios.get<BatchCallResponse>(
        `${COMM_API_URL}/api/v1/batch-calling/${jobId}`,
        { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
      );
      return response.data;
    } catch (error: any) {
      console.error('[Batch Calling Service] ❌ Failed to get batch status:', jobId, error.response?.data || error.message);
      throw new AppError(
        error.response?.status || 500,
        'BATCH_CALL_ERROR',
        error.response?.data?.message || error.response?.data?.detail || 'Failed to get batch job status'
      );
    }
  }

  /**
   * Cancel batch job
   * Calls Python /api/v1/batch-calling/{job_id}/cancel endpoint
   */
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
      console.error(`[Batch Calling Service] ⚠️ Failed to fetch conversation ${conversationId}:`, error.message);
      return null;
    }
  }

  /**
   * Production-grade batch call sync.
   *
   * Flow:
   *   1. GET batch status → get recipients[] with per-recipient status + conversation_id
   *   2. For each recipient:
   *      - Already in processed_call_ids? → skip
   *      - recipient.status === "completed"? → fetch transcript via conversation_id
   *        → create/update conversation, save messages, trigger automation, mark done
   *      - recipient.status !== "completed"? → skip, check again next tick
   *   3. When all recipients are processed → conversations_synced = true, stop polling
   */
  async syncBatchCallConversations(jobId: string, organizationId: string): Promise<void> {
    if (this.syncLocks.has(jobId)) {
      console.log(`[Batch Calling Service] ⏳ Sync already running for ${jobId}, skipping`);
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
        console.log('[Batch Calling Service] ⏭️ Skipping cancelled batch:', jobId);
        return;
      }

      // Track which phones have had automation successfully triggered (source of truth for dedup).
      // We use this instead of processed_call_ids because processed_call_ids can get corrupted
      // by stale data from previous server runs / code versions.
      const automationDone = new Set<string>(batchCall.automation_triggered_phones || []);

      console.log(`[Batch Calling Service] 📋 Automation already done for ${automationDone.size} phone(s): [${[...automationDone].join(', ')}]`);

      // ── STEP 1: Get batch status with recipients list from Python API ──────
      let batchStatus: BatchCallResponse;
      try {
        batchStatus = await this.getBatchJobStatus(jobId);
      } catch (err: any) {
        console.error(`[Batch Calling Service] ❌ Cannot fetch batch status: ${err.message}`);
        return;
      }

      const recipients = batchStatus.recipients || [];
      if (recipients.length === 0) {
        console.warn(`[Batch Calling Service] ⚠️ No recipients in batch status for ${jobId}`);
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
        console.log(`[Batch Calling Service] 🔄 Status refreshed: ${batchCall.status} → ${batchStatus.status}`);
      }

      // ── STEP 2: Process each recipient ────────────────────────────────────
      const Conversation = (await import('../models/Conversation')).default;
      const Customer = (await import('../models/Customer')).default;
      const Message = (await import('../models/Message')).default;
      const mongoose = (await import('mongoose')).default;
      const { emitToOrganization } = await import('../config/socket');

      const orgObjectId = new mongoose.Types.ObjectId(organizationId);
      const userId = batchCall.userId?.toString() || organizationId;

      const hasMessages = (t: any): boolean =>
        t != null && (
          (Array.isArray(t) && t.length > 0) ||
          (typeof t === 'string' && t.trim().length > 0) ||
          (t.messages && Array.isArray(t.messages) && t.messages.length > 0) ||
          (t.items && Array.isArray(t.items) && t.items.length > 0)
        );

      let created = 0;
      let skipped = 0;
      let waiting = 0;
      let terminalWithoutConversation = 0;
      const automationTriggered: string[] = [];
      const terminalRecipientStatuses = new Set([
        'failed',
        'busy',
        'no_answer',
        'no-answer',
        'voicemail',
        'cancelled',
        'canceled'
      ]);

      console.log(`[Batch Calling Service] 📋 Processing ${recipients.length} recipients for batch ${jobId} (batch status: ${batchStatus.status})`);

      for (const recipient of recipients) {
        const phone = recipient.phone_number;
        const recipientStatus = recipient.status;
        const elevenLabsConvId = recipient.conversation_id;

        try {
          // 1. Automation already triggered for this phone? skip.
          //    Re-fetch the latest persisted set to defend against a parallel
          //    sync cycle that may have triggered the same phone milliseconds ago.
          if (!automationDone.has(phone)) {
            try {
              const latest = await BatchCall.findOne(
                { batch_call_id: jobId },
                { automation_triggered_phones: 1 }
              ).lean();
              for (const p of (latest?.automation_triggered_phones || [])) {
                automationDone.add(p);
              }
            } catch (_) { /* best-effort */ }
          }
          if (automationDone.has(phone)) {
            skipped++;
            console.log(`[Batch Calling Service] ⏭️ ${phone} – automation already triggered, skipping`);
            continue;
          }

          // 2. Terminal non-success statuses never produce a conversation/transcript.
          // Mark them resolved so polling can eventually stop.
          const normalizedRecipientStatus = String(recipientStatus || '').toLowerCase().trim();
          if (terminalRecipientStatuses.has(normalizedRecipientStatus)) {
            terminalWithoutConversation++;
            skipped++;
            console.log(`[Batch Calling Service] ⏭️ ${phone} – recipient terminal status "${recipientStatus}", no conversation expected`);
            continue;
          }

          // 3. Recipient NOT completed yet? keep polling until terminal/completed.
          if (recipientStatus !== 'completed') {
            waiting++;
            console.log(`[Batch Calling Service] ⏳ ${phone} – recipient status: "${recipientStatus}", waiting for completed`);
            continue;
          }

          // 4. Recipient completed but no conversation_id yet? keep waiting – it may arrive.
          if (!elevenLabsConvId) {
            waiting++;
            console.log(`[Batch Calling Service] ⏳ ${phone} – completed but no conversation_id yet, will retry`);
            continue;
          }

          // 5. Recipient completed + has conversation_id → fetch transcript
          console.log(`[Batch Calling Service] 🔍 ${phone} – recipient completed, fetching transcript from conv: ${elevenLabsConvId}`);

          const convDetail = await this.getConversationDetail(elevenLabsConvId);
          if (!convDetail) {
            waiting++;
            console.log(`[Batch Calling Service] ⏳ ${phone} – conversation ${elevenLabsConvId} not available yet, will retry`);
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
          const resolvedRecordingUrl = normalizeRecordingUrl(rawRecordingUrl, elevenLabsConvId);

          const transcript = convDetail?.transcript;
          const ready = hasMessages(transcript);
          const duration = convDetail?.metadata?.call_duration_secs || convDetail?.call_duration_secs || 0;
          const endReason = convDetail?.metadata?.termination_reason || (convDetail?.analysis?.call_successful ? 'completed' : '');

          const transcriptItems = transcript?.items || transcript?.messages || (Array.isArray(transcript) ? transcript : []);

          if (!ready) {
            waiting++;
            console.log(`[Batch Calling Service] ⏳ ${phone} – transcript not ready yet (conv: ${elevenLabsConvId}), will retry`);
            continue;
          }

          console.log(`[Batch Calling Service] ✅ ${phone} – transcript ready (${transcriptItems.length} items, ${duration}s)`);

          // ── Recipient completed + transcript ready → process + trigger automation ──
          const vars = recipient.conversation_initiation_client_data?.dynamic_variables || {};
          const firstName = vars.first_name || vars.customer_first_name;
          const lastName = vars.last_name || vars.customer_last_name;
          const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
          const name = fullName || vars.name || vars.customer_name || 'Unknown';
          const email = vars.email || vars.customer_email;

          console.log(`[Batch Calling Service] ✅ ${phone} (${name}) – completed, transcript ready (${transcriptItems.length} items, ${duration}s)`);

          // Check if conversation already exists in our DB
          const existing = await Conversation.findOne({
            organizationId: orgObjectId,
            channel: 'phone',
            'metadata.batch_call_id': jobId,
            'metadata.phone_number': phone
          });

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
                console.log(`[Batch Calling Service] ✅ Saved ${msgs.length} messages for existing conversation ${conversationId}`);
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

            console.log(`[Batch Calling Service] ✅ Conversation ${conversationId} created for ${name} (${phone})`);
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
                console.log(`[Batch Calling Service] ✅ Saved ${msgs.length} messages for ${conversationId}`);
              }
            }

            created++;
          }

          // ── Trigger automation ─────────────────────────────────────────────
          try {
            const { automationService } = await import('./automation.service');
            const appointmentDate =
              vars.appointment_date ||
              vars.preferred_date ||
              vars.scheduled_date ||
              vars.date ||
              '';
            const appointmentTime =
              vars.appointment_time ||
              vars.preferred_time ||
              vars.scheduled_time ||
              vars.time ||
              '';
            const recordingUrl = resolvedRecordingUrl;
            const csvOrCallAddress =
              vars.address ||
              vars.full_address ||
              vars.customer_address ||
              vars.home_address ||
              '';
            await automationService.triggerByEvent('batch_call_completed', {
              event: 'batch_call_completed',
              batch_id: jobId,
              conversation_id: conversationId,
              contactId,
              organizationId,
              source: 'batch_call',
              recording_url: recordingUrl,
              audio_url: recordingUrl,
              dynamic_variables: vars,
              appointment: {
                booked: Boolean(appointmentDate || appointmentTime),
                date: appointmentDate,
                time: appointmentTime
              },
              freshContactData: {
                name,
                first_name: firstName || '',
                last_name: lastName || '',
                email,
                phone,
                address: csvOrCallAddress
              }
            }, { userId, organizationId });
            console.log(`[Batch Calling Service] 🚀 Automation triggered for ${phone} (${name})`);
          } catch (err: any) {
            console.error(`[Batch Calling Service] ⚠️ Automation failed for ${phone}:`, err.message);
            continue; // don't mark processed – retry next tick
          }

          // Mark done ONLY after automation succeeds.
          // Persist immediately so a parallel sync can't re-fire it.
          automationTriggered.push(phone);
          automationDone.add(phone);
          try {
            await BatchCall.updateOne(
              { batch_call_id: jobId },
              { $addToSet: { automation_triggered_phones: phone } }
            );
          } catch (persistErr: any) {
            console.warn(
              `[Batch Calling Service] ⚠️ Could not persist automation_triggered phone ${phone} immediately:`,
              persistErr.message
            );
          }
          console.log(`[Batch Calling Service] ✅ ${phone} fully processed (conversation + automation done)`);

        } catch (err: any) {
          console.error(`[Batch Calling Service] ❌ Failed to process ${phone}:`, err.message);
        }
      }

      // ── Persist automation-triggered phones atomically ─────────────────
      if (automationTriggered.length > 0) {
        await BatchCall.updateOne(
          { batch_call_id: jobId },
          { $addToSet: { automation_triggered_phones: { $each: automationTriggered } } }
        );
        console.log(`[Batch Calling Service] 💾 Saved ${automationTriggered.length} phone(s) as automation-triggered: [${automationTriggered.join(', ')}]`);
      }

      // ── Mark batch fully done ──────────────────────────────────────────────
      // ONLY mark done when:
      //   1. Batch status is "completed" (all calls dispatched)
      //   2. No recipients still waiting (everyone is either automation-done or skipped)
      //   3. Total phones with automation triggered matches total recipients
      const totalAutomationDone = automationDone.size + automationTriggered.length;
      const totalResolvedRecipients = totalAutomationDone + terminalWithoutConversation;
      const allDone = waiting === 0
        && batchStatus.status === 'completed'
        && totalResolvedRecipients >= recipients.length;
      if (allDone) {
        await BatchCall.updateOne(
          { batch_call_id: jobId },
          { $set: { conversations_synced: true }, $unset: { syncErrorCount: '' } }
        );
        console.log(`[Batch Calling Service] ✅ Batch ${jobId} ALL DONE – ${created} created, ${automationTriggered.length} automations triggered, ${terminalWithoutConversation} terminal-without-conversation, ${skipped} already done`);
      } else {
        console.log(`[Batch Calling Service] 📊 Batch ${jobId}: ${created} created, ${automationTriggered.length} automations triggered, ${terminalWithoutConversation} terminal-without-conversation, ${skipped} already done, ${waiting} still waiting – will check again`);
      }

      if (created > 0 || automationTriggered.length > 0) {
        try { emitToOrganization(organizationId, 'batch:conversations-synced', { batch_call_id: jobId, conversationsCreated: created, automationsTriggered: automationTriggered.length, pendingRecipients: waiting }); } catch (_) {}
      }

    } catch (error: any) {
      console.error('[Batch Calling Service] ❌ Sync error:', error.message);
      await BatchCall.updateOne({ batch_call_id: jobId }, { $inc: { syncErrorCount: 1 } });
      throw error;
    } finally {
      this.syncLocks.delete(jobId);
    }
  }
}

export const batchCallingService = new BatchCallingService();
