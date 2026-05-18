import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { logger } from '../utils/logger.util';

/**
 * Handle webhooks from ElevenLabs API
 * POST /api/v1/webhook/elevenlabs
 * 
 * This endpoint receives webhook events from ElevenLabs when various events occur
 * (e.g., post_call_audio, call_started, call_ended, etc.)
 * 
 * Webhooks are logged to console. Only post_call_transcription webhooks are logged to structured logger.
 */
export class ElevenLabsWebhookController {

  /**
   * Handle incoming ElevenLabs webhook events
   * 
   * Always returns 200 OK to prevent retries from ElevenLabs.
   * All webhooks are logged to console. Only post_call_transcription webhooks are logged to structured logger.
   */
  handleWebhook = async (req: Request, res: Response) => {
    try {
      // Acknowledge receipt immediately
      res.status(200).json({ success: true, message: 'Webhook received' });

      // Extract all relevant data
      const body = req.body;
      const method = req.method;
      const url = req.originalUrl;
      const ip = req.ip || req.socket.remoteAddress;
      const timestamp = new Date().toISOString();

      // Log all webhooks to console
      console.log('[ElevenLabs Webhook] 📥 Webhook received');
      console.log('  Type:', body?.type || 'N/A');
      console.log('  Agent ID:', body?.data?.agent_id || 'N/A');
      console.log('  Conversation ID:', body?.data?.conversation_id || 'N/A');
      console.log('  Timestamp:', timestamp);
      console.log('  IP:', ip);
      console.log('  URL:', url);

      // Only log post_call_transcription to structured logger
      if (body?.type === 'post_call_transcription') {
        logger.info('[ElevenLabs Webhook] post_call_transcription received', {
          type: body?.type,
          agent_id: body?.data?.agent_id,
          agent_name: body?.data?.agent_name,
          conversation_id: body?.data?.conversation_id,
          user_id: body?.data?.user_id,
          event_timestamp: body?.event_timestamp,
          status: body?.data?.status,
          ip,
          url
        });
      }

      // Process inbound calls
      if (body?.type === 'post_call_transcription' || body?.type === 'post_call_audio') {
        try {
          await this.processInboundCall(body);
        } catch (processError: any) {
          console.error('[ElevenLabs Webhook] ⚠️ Failed to process inbound call:', processError.message);
          logger.error('[ElevenLabs Webhook] Failed to process inbound call', {
            error: processError.message,
            stack: processError.stack,
            type: body?.type,
            agent_id: body?.data?.agent_id,
            conversation_id: body?.data?.conversation_id
          });
        }
      }

      // For outbound (batch) calls – trigger an immediate sync so the transcript is
      // picked up without waiting for the next 30s poll tick.
      if (body?.type === 'post_call_transcription') {
        const direction = body?.data?.metadata?.phone_call?.direction;
        if (direction === 'outbound') {
          try {
            await this.processBatchCallWebhook(body);
          } catch (batchError: any) {
            console.error('[ElevenLabs Webhook] ⚠️ Failed to process outbound batch call webhook:', batchError.message);
          }
        }
      }

    } catch (error: any) {
      // Log error but still return 200 to prevent retries
      console.error('[ElevenLabs Webhook] ❌ ERROR PROCESSING WEBHOOK:', error);
      logger.error('[ElevenLabs Webhook] Error processing webhook', {
        error: error.message,
        stack: error.stack,
        body: req.body,
        headers: req.headers
      });

      // Already sent response, so nothing to do here
    }
  };

  /**
   * Process inbound call webhooks
   * Creates conversations for inbound calls similar to outbound calls
   */
  private async processInboundCall(webhookBody: any) {
    const data = webhookBody?.data;
    if (!data) {
      console.log('[ElevenLabs Webhook] No data in webhook body, skipping processing');
      return;
    }

    // Check if this is an inbound call
    const phoneCall = data.metadata?.phone_call;
    const direction = phoneCall?.direction;

    if (direction !== 'inbound') {
      console.log('[ElevenLabs Webhook] Call direction is not inbound, skipping:', direction);
      return;
    }

    console.log('[ElevenLabs Webhook] 📞 Processing inbound call webhook');
    console.log('  Agent ID:', data.agent_id);
    console.log('  Conversation ID:', data.conversation_id);
    console.log('  Direction:', direction);

    // Find agent by agent_id
    const Agent = (await import('../models/Agent')).default;
    const agent = await Agent.findOne({ agent_id: data.agent_id });

    if (!agent) {
      console.warn('[ElevenLabs Webhook] ⚠️ Agent not found:', data.agent_id);
      return;
    }

    console.log('[ElevenLabs Webhook] ✅ Found agent:', agent.name);

    // Get user and organization
    const User = (await import('../models/User')).default;
    const Organization = (await import('../models/Organization')).default;

    const user = await User.findById(agent.userId);
    if (!user) {
      console.warn('[ElevenLabs Webhook] ⚠️ User not found for agent:', agent.userId);
      return;
    }

    // Resolve organizationId
    let organizationId: mongoose.Types.ObjectId;
    if (user.organizationId) {
      const orgId = user.organizationId;
      organizationId = orgId instanceof mongoose.Types.ObjectId
        ? orgId
        : new mongoose.Types.ObjectId(String(orgId));
    } else {
      // Try to find organization by ownerId
      const organization = await Organization.findOne({ ownerId: user._id });
      if (organization) {
        organizationId = organization._id;
      } else {
        // Single-tenant: use userId as organizationId
        organizationId = user._id;
      }
    }

    console.log('[ElevenLabs Webhook] ✅ Resolved organizationId:', organizationId.toString());

    // Check if organization is locked due to plan limits
    const { usageTrackerService } = await import('../services/usage/usageTracker.service');
    const lockStatus = await usageTrackerService.isOrganizationLocked(organizationId.toString());
    
    if (lockStatus.locked) {
      console.warn(`[ElevenLabs Webhook] ⚠️ Organization ${organizationId} is LOCKED due to plan limits. Inbound call not processed.`);
      // Optionally, you might want to create a system notification here
      // return early to prevent further processing and usage
      return;
    }

    // Extract phone number from webhook
    const externalNumber = phoneCall?.external_number || data.user_id;
    if (!externalNumber) {
      console.warn('[ElevenLabs Webhook] ⚠️ No phone number found in webhook');
      return;
    }

    // Find or create customer
    const Customer = (await import('../models/Customer')).default;
    let customer = await Customer.findOne({
      phone: externalNumber,
      organizationId: organizationId
    });

    if (!customer) {
      // Create customer with phone number
      customer = await Customer.create({
        name: `Caller ${externalNumber}`,
        phone: externalNumber,
        organizationId: organizationId,
        source: 'phone',
        color: `#${Math.floor(Math.random() * 16777215).toString(16)}`
      });
      console.log('[ElevenLabs Webhook] ✅ Created customer:', customer._id);
    } else {
      console.log('[ElevenLabs Webhook] ✅ Found existing customer:', customer._id);
    }

    // Handle different webhook types
    if (webhookBody.type === 'post_call_transcription') {
      await this.handleTranscriptionWebhook(data, customer._id, organizationId, agent);
    } else if (webhookBody.type === 'post_call_audio') {
      await this.handleAudioWebhook(data, customer._id, organizationId);
    }
  }

  /**
   * Handle post_call_transcription webhook
   * Creates conversation with transcript and messages
   */
  private async handleTranscriptionWebhook(
    data: any,
    customerId: mongoose.Types.ObjectId,
    organizationId: mongoose.Types.ObjectId,
    agent: any
  ) {
    const Conversation = (await import('../models/Conversation')).default;
    const Message = (await import('../models/Message')).default;

    const conversationId = data.conversation_id;
    const transcript = data.transcript || [];
    const metadata = data.metadata || {};
    const phoneCall = metadata.phone_call || {};
    const status = data.status || 'unknown';

    // Check if conversation already exists (might have been created by audio webhook first)
    let conversation = await Conversation.findOne({
      'metadata.conversation_id': conversationId,
      organizationId: organizationId
    });

    if (conversation) {
      console.log('[ElevenLabs Webhook] ✅ Found existing conversation, updating with transcript');

      // Update conversation with transcript
      conversation.transcript = transcript;
      conversation.status = status === 'done' ? 'closed' : 'open';
      conversation.metadata = {
        ...conversation.metadata,
        conversation_id: conversationId,
        agent_id: data.agent_id,
        agent_name: data.agent_name,
        call_duration_secs: metadata.call_duration_secs,
        call_sid: phoneCall.call_sid,
        phone_number_id: phoneCall.phone_number_id,
        agent_number: phoneCall.agent_number,
        external_number: phoneCall.external_number,
        direction: phoneCall.direction,
        callInitiated: metadata.start_time_unix_secs
          ? new Date(metadata.start_time_unix_secs * 1000)
          : new Date(),
        callCompletedAt: metadata.accepted_time_unix_secs
          ? new Date((metadata.accepted_time_unix_secs + (metadata.call_duration_secs || 0)) * 1000)
          : new Date(),
        termination_reason: metadata.termination_reason,
        error: metadata.error,
        source: 'inbound_webhook'
      };

      await conversation.save();
    } else {
      // Create new conversation
      conversation = await Conversation.create({
        organizationId: organizationId,
        customerId: customerId,
        channel: 'phone',
        status: status === 'done' ? 'closed' : 'open',
        transcript: transcript,
        isAiManaging: true,
        unread: true,
        metadata: {
          conversation_id: conversationId,
          agent_id: data.agent_id,
          agent_name: data.agent_name,
          call_duration_secs: metadata.call_duration_secs,
          call_sid: phoneCall.call_sid,
          phone_number_id: phoneCall.phone_number_id,
          agent_number: phoneCall.agent_number,
          external_number: phoneCall.external_number,
          direction: phoneCall.direction,
          callInitiated: metadata.start_time_unix_secs
            ? new Date(metadata.start_time_unix_secs * 1000)
            : new Date(),
          callCompletedAt: metadata.accepted_time_unix_secs
            ? new Date((metadata.accepted_time_unix_secs + (metadata.call_duration_secs || 0)) * 1000)
            : new Date(),
          termination_reason: metadata.termination_reason,
          error: metadata.error,
          source: 'inbound_webhook'
        }
      });

      console.log('[ElevenLabs Webhook] ✅ Created conversation:', conversation._id);
    }

    // Create messages from transcript
    if (Array.isArray(transcript) && transcript.length > 0) {
      // Delete existing messages from this conversation to avoid duplicates
      await Message.deleteMany({
        conversationId: conversation._id,
        'metadata.from_transcript': true
      });

      // Create messages from transcript items
      for (const item of transcript) {
        if (item.message && item.role) {
          await Message.create({
            conversationId: conversation._id,
            sender: item.role === 'user' ? 'customer' : 'ai',
            text: item.message,
            type: 'message',
            timestamp: metadata.start_time_unix_secs && item.time_in_call_secs
              ? new Date((metadata.start_time_unix_secs + item.time_in_call_secs) * 1000)
              : new Date(),
            metadata: {
              from_transcript: true,
              time_in_call_secs: item.time_in_call_secs,
              interrupted: item.interrupted,
              agent_metadata: item.agent_metadata
            }
          });
        }
      }

      console.log('[ElevenLabs Webhook] ✅ Created', transcript.length, 'messages from transcript');

      // 🚀 TRIGGER INBOUND CALL AUTOMATION
      try {
        const { automationService } = await import('../services/automation.service');
        const phone = phoneCall.external_number || data.user_id;
        const name = (conversation as any).customerName || `Caller ${phone}`;
        const email = (conversation as any).customerEmail;

        console.log(`[ElevenLabs Webhook] 🚀 Triggering automation for inbound call completed: ${phone}`);

        await automationService.triggerByEvent('inbound_call_completed', {
          event: 'inbound_call_completed',
          conversation_id: conversation._id.toString(),
          contactId: customerId.toString(),
          organizationId: organizationId.toString(),
          source: 'inbound_call',
          freshContactData: { name, email, phone }
        }, { organizationId: organizationId.toString() });
      } catch (automationError: any) {
        console.error('[ElevenLabs Webhook] ⚠️ Failed to trigger inbound call automation:', automationError.message);
      }
    }

    // Add initial note if conversation was just created
    if (!conversation.metadata?.initial_note_added) {
      await Message.create({
        conversationId: conversation._id,
        type: 'internal_note',
        text: `Inbound call received from ${phoneCall.external_number || 'unknown'}`,
        sender: 'ai',
        timestamp: new Date()
      });

      conversation.metadata = {
        ...conversation.metadata,
        initial_note_added: true
      };
      await conversation.save();
    }
  }

  /**
   * Handle post_call_audio webhook
   * Updates conversation with audio recording
   */
  private async handleAudioWebhook(
    data: any,
    customerId: mongoose.Types.ObjectId,
    organizationId: mongoose.Types.ObjectId
  ) {
    const Conversation = (await import('../models/Conversation')).default;
    const Message = (await import('../models/Message')).default;

    const conversationId = data.conversation_id;
    const fullAudio = data.full_audio; // Base64 encoded audio

    // Find existing conversation
    let conversation = await Conversation.findOne({
      'metadata.conversation_id': conversationId,
      organizationId: organizationId
    });

    if (conversation) {
      // Update conversation with audio
      conversation.metadata = {
        ...conversation.metadata,
        audio_base64: fullAudio,
        audio_received_at: new Date().toISOString()
      };
      await conversation.save();
      console.log('[ElevenLabs Webhook] ✅ Updated conversation with audio:', conversation._id);
    } else {
      // Create conversation placeholder (transcript will come later)
      conversation = await Conversation.create({
        organizationId: organizationId,
        customerId: customerId,
        channel: 'phone',
        status: 'open',
        isAiManaging: true,
        unread: true,
        metadata: {
          conversation_id: conversationId,
          agent_id: data.agent_id,
          agent_name: data.agent_name,
          audio_base64: fullAudio,
          audio_received_at: new Date().toISOString(),
          direction: 'inbound',
          source: 'inbound_webhook',
          waiting_for_transcript: true,
          external_number: data.user_id // Store phone number from user_id
        }
      });

      // Add initial note
      await Message.create({
        conversationId: conversation._id,
        type: 'internal_note',
        text: `Inbound call received from ${data.user_id || 'unknown'}. Audio recording available.`,
        sender: 'ai',
        timestamp: new Date()
      });

      console.log('[ElevenLabs Webhook] ✅ Created conversation placeholder with audio:', conversation._id);
    }
  }

  /** Grep for this marker in logs: BATCH_CALL_POST_CALL_TRANSCRIPTION_WEBHOOK */
  private static readonly BATCH_POST_CALL_LOG_MARKER = 'BATCH_CALL_POST_CALL_TRANSCRIPTION_WEBHOOK';

  /**
   * Log the complete post_call_transcription payload for an outbound (batch) call.
   * Uses a fixed marker so the entry is easy to find in console and log files.
   */
  private logBatchPostCallTranscriptionWebhook(webhookBody: unknown): void {
    const marker = ElevenLabsWebhookController.BATCH_POST_CALL_LOG_MARKER;
    const body = webhookBody as Record<string, any> | null | undefined;
    const data = body?.data;

    const summary = {
      marker,
      type: body?.type,
      event_timestamp: body?.event_timestamp,
      conversation_id: data?.conversation_id,
      status: data?.status,
      batch_call_id: data?.metadata?.batch_call?.batch_call_id,
      phone: data?.metadata?.phone_call?.external_number || data?.user_id,
      direction: data?.metadata?.phone_call?.direction,
      transcript_turns: Array.isArray(data?.transcript) ? data.transcript.length : 0,
      call_duration_secs: data?.metadata?.call_duration_secs,
    };

    const fullPayloadJson = JSON.stringify(body ?? webhookBody, null, 2);
    const separator = '='.repeat(80);

    console.log(`\n${separator}`);
    console.log(`[${marker}] post_call_transcription webhook — outbound batch call ended`);
    console.log(`[${marker}] summary:`, JSON.stringify(summary, null, 2));
    console.log(`[${marker}] full payload:\n${fullPayloadJson}`);
    console.log(`${separator}\n`);

    logger.info(`[${marker}] post_call_transcription webhook (outbound batch)`, {
      ...summary,
      full_payload: body ?? webhookBody,
    });
  }

  /**
   * When ElevenLabs fires post_call_transcription for an outbound (batch) call the full
   * transcript array is already in the webhook payload. We use it directly to:
   *   1. Identify the batch via data.metadata.batch_call.batch_call_id (direct DB lookup).
   *   2. Get dynamic_variables from data.conversation_initiation_client_data.dynamic_variables.
   *   3. Create/update the Conversation + Messages in Mongo.
   *   4. Trigger automation immediately — no polling delay, no getBatchJobStatus call.
   *
   * Gate: only run the fast path when data.status === "done". ElevenLabs sets this only
   * after transcript generation is complete, making it the most reliable signal.
   * Webhooks with status "in-progress" or "failed" fall through to the poll/sync path.
   *
   * Falls back to the full-sync approach when:
   *   - status is not "done"
   *   - batch_call_id is absent from webhook metadata
   *   - direct batch DB lookup finds nothing
   */
  private async processBatchCallWebhook(webhookBody: any) {
    this.logBatchPostCallTranscriptionWebhook(webhookBody);

    const data = webhookBody?.data;
    const phoneNumber: string | undefined = data?.metadata?.phone_call?.external_number || data?.user_id;
    const elevenLabsConvId: string | undefined = data?.conversation_id;
    const callStatus: string = String(data?.status || '').toLowerCase();

    if (!phoneNumber) {
      console.log('[ElevenLabs Webhook] Outbound webhook missing phoneNumber – skipping');
      return;
    }

    const webhookTranscript: any[] = Array.isArray(data?.transcript) ? data.transcript : [];
    const duration: number = data?.metadata?.call_duration_secs || 0;

    console.log(
      `[ElevenLabs Webhook] 📞 Outbound call for ${phoneNumber}` +
      (elevenLabsConvId ? ` (conv: ${elevenLabsConvId})` : '') +
      ` – status: ${callStatus}, transcript turns: ${webhookTranscript.length}, duration: ${duration}s`
    );

    const BatchCall = (await import('../models/BatchCall')).default;

    // ── FAST PATH: status=done + batch_call_id in metadata ────────────────────
    // ElevenLabs sets status="done" only after transcript generation completes,
    // so this is the most reliable gate. batch_call_id and dynamic_variables are
    // both available directly in the webhook — no getBatchJobStatus call needed.
    if (callStatus === 'done') {
      const elevenLabsBatchId: string | undefined = data?.metadata?.batch_call?.batch_call_id;
      const webhookDynamicVars: Record<string, any> =
        data?.conversation_initiation_client_data?.dynamic_variables || {};

      if (elevenLabsBatchId) {
        const batch = await BatchCall.findOne({ batch_call_id: elevenLabsBatchId }).lean();
        if (batch) {
          const orgId =
            (batch as any).organizationId?.toString() ||
            (batch as any).userId?.toString();

          if (orgId) {
            try {
              const processed = await this.processOutboundRecipientFromWebhook({
                batch,
                organizationId: orgId,
                phoneNumber,
                elevenLabsConvId: elevenLabsConvId || '',
                webhookTranscript,
                duration,
                dynamicVars: webhookDynamicVars,
                webhookData: data
              });

              if (processed) {
                console.log(
                  `[ElevenLabs Webhook] ✅ Per-call automation done for ${phoneNumber} (batch: ${elevenLabsBatchId})`
                );
                return;
              }
            } catch (err: any) {
              console.error(
                `[ElevenLabs Webhook] ⚠️ Per-call processing failed for ${phoneNumber} (batch: ${elevenLabsBatchId}):`,
                err.message
              );
            }
          }
        }
      }
    }

    // ── FALLBACK: status not done, batch_call_id missing, or direct path failed ─
    //
    // IMPORTANT: We only ever sync the ONE batch that owns this call.
    // The previous approach fetched up to 15 active batches and synced every
    // matching one (plus the most-recent as a catch-all), which caused every
    // completed call webhook to trigger N×recipients HTTP calls to the Python
    // conversation API — hammering it continuously.
    if (callStatus !== 'done') {
      console.log(
        `[ElevenLabs Webhook] ⏭️ Status "${callStatus}" (not done) – falling back to batch sync`
      );
    }

    // Give ElevenLabs 5s to update recipient status before querying batch API.
    await new Promise(resolve => setTimeout(resolve, 5000));

    const { batchCallingService } = await import('../services/batchCalling.service');

    // ── Tier 1: batch_call_id is in the webhook metadata — direct lookup, no scan ──
    const webhookBatchId: string | undefined = data?.metadata?.batch_call?.batch_call_id;
    if (webhookBatchId) {
      const batch = await BatchCall.findOne({ batch_call_id: webhookBatchId }).lean();
      if (batch) {
        const orgId =
          (batch as any).organizationId?.toString() ||
          (batch as any).userId?.toString();
        if (orgId) {
          console.log(`[ElevenLabs Webhook] 🔄 Fallback sync for batch (from metadata): ${webhookBatchId}`);
          try {
            await batchCallingService.syncBatchCallConversations(webhookBatchId, orgId);
          } catch (err: any) {
            console.error(`[ElevenLabs Webhook] ⚠️ Sync failed for ${webhookBatchId}:`, err.message);
          }
        }
      }
      return;
    }

    // ── Tier 2: no batch_call_id — match by phone/convId across recent batches ──
    // This path should be rare (ElevenLabs usually includes batch_call_id).
    // We stop as soon as we find ONE matching batch to avoid syncing unrelated batches.
    const normalizePhone = (p: string) => {
      const digits = String(p || '').replace(/\D/g, '');
      return digits.length >= 10 ? digits.slice(-10) : digits;
    };
    const phoneNorm = normalizePhone(phoneNumber);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const candidateBatches = await BatchCall.find({
      conversations_synced: { $ne: true },
      status: { $nin: ['cancelled', 'canceled', 'failed'] },
      createdAt: { $gte: oneDayAgo }
    })
      .sort({ createdAt: -1 })
      .limit(15)
      .lean();

    if (candidateBatches.length === 0) {
      console.log('[ElevenLabs Webhook] No active batch found – skipping fallback sync');
      return;
    }

    for (const batch of candidateBatches) {
      const batchId = (batch as any).batch_call_id;
      const orgId =
        (batch as any).organizationId?.toString() ||
        (batch as any).userId?.toString();
      if (!orgId || !batchId) continue;

      try {
        const status = await batchCallingService.getBatchJobStatus(batchId);
        const recipients = status.recipients || [];
        const matches = recipients.some((r: any) => {
          if (elevenLabsConvId && r.conversation_id === elevenLabsConvId) return true;
          return normalizePhone(r.phone_number) === phoneNorm;
        });
        if (!matches) continue;

        console.log(`[ElevenLabs Webhook] 🔄 Fallback sync for batch (phone match): ${batchId}`);
        await batchCallingService.syncBatchCallConversations(batchId, orgId);
        return; // stop after the first matching batch — do NOT fall through to others
      } catch (err: any) {
        console.error(`[ElevenLabs Webhook] ⚠️ Sync failed for ${batchId}:`, err.message);
      }
    }

    console.log(`[ElevenLabs Webhook] ⚠️ No matching batch found for phone ${phoneNumber} – skipping fallback sync`);
  }

  /**
   * Process a single outbound recipient using the transcript that arrived in the
   * post_call_transcription webhook body. This avoids polling and eliminates the
   * "empty transcript at trigger time" bug for the primary path.
   *
   * Returns true if automation was successfully triggered (phone marked done).
   * Returns false on any error so the caller can fall back to full sync.
   */
  private async processOutboundRecipientFromWebhook(params: {
    batch: any;
    organizationId: string;
    phoneNumber: string;
    elevenLabsConvId: string;
    webhookTranscript: any[];
    duration: number;
    dynamicVars: Record<string, any>;
    webhookData: any;
  }): Promise<boolean> {
    const {
      batch,
      organizationId,
      phoneNumber,
      elevenLabsConvId,
      webhookTranscript,
      duration,
      dynamicVars,
      webhookData
    } = params;

    const batchId = batch.batch_call_id;

    try {
      const BatchCall = (await import('../models/BatchCall')).default;
      const Conversation = (await import('../models/Conversation')).default;
      const Customer = (await import('../models/Customer')).default;
      const Message = (await import('../models/Message')).default;
      const mongoose = (await import('mongoose')).default;
      const { automationService } = await import('../services/automation.service');

      const orgObjectId = new mongoose.Types.ObjectId(organizationId);
      const userId = batch.userId?.toString() || organizationId;

      const normalizePhoneKey = (p: string) => {
        const digits = String(p || '').replace(/\D/g, '');
        return digits.length >= 10 ? digits.slice(-10) : digits;
      };
      const phoneKey = normalizePhoneKey(phoneNumber);

      // ── Dedup: skip if automation already triggered for this phone ────────────
      const batchDoc = await BatchCall.findOne(
        { batch_call_id: batchId },
        { automation_triggered_phones: 1 }
      ).lean() as any;

      const alreadyDone = (batchDoc?.automation_triggered_phones || []).some(
        (p: string) => normalizePhoneKey(p) === phoneKey
      );
      if (alreadyDone) {
        console.log(
          `[ElevenLabs Webhook] ⏭️ Automation already done for ${phoneNumber} in batch ${batchId}`
        );
        return true;
      }

      // ── Transcript: use webhook payload; fall back to a single ElevenLabs fetch ──
      //
      // post_call_transcription fires after ElevenLabs finishes generating the
      // transcript, so data.transcript should always be populated. However, there
      // is an occasional ~2–5s propagation gap where the API serves an empty result
      // even after the webhook fires. When the webhook transcript is empty (but the
      // call had real duration), we wait briefly and fetch once from the ElevenLabs
      // conversation API before saving to Mongo. This protects the local-LLM fallback
      // path in extraction which reads transcript from the DB.
      let finalTranscript = webhookTranscript;
      if (webhookTranscript.length === 0 && elevenLabsConvId && duration > 0) {
        console.log(
          `[ElevenLabs Webhook] ⚠️ Empty transcript in webhook for ${phoneNumber} – fetching from ElevenLabs in 3s`
        );
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
          const { batchCallingService } = await import('../services/batchCalling.service');
          const convDetail = await batchCallingService.getConversationDetail(elevenLabsConvId);
          const fetched: any[] =
            convDetail?.transcript?.items ||
            convDetail?.transcript?.messages ||
            (Array.isArray(convDetail?.transcript) ? convDetail.transcript : []);
          if (fetched.length > 0) {
            console.log(
              `[ElevenLabs Webhook] ✅ Fetched ${fetched.length} transcript items from ElevenLabs API for ${phoneNumber}`
            );
            finalTranscript = fetched;
          }
          // If still empty: proceed anyway — Python extract will call ElevenLabs
          // directly using conv_xxx and will retry on its own timeout.
        } catch (_) { /* non-fatal, Python extract will fetch from ElevenLabs directly */ }
      }

      // ── Contact info from dynamic variables (CSV columns) ─────────────────────
      const firstName =
        dynamicVars.first_name || dynamicVars.customer_first_name || '';
      const lastName =
        dynamicVars.last_name || dynamicVars.customer_last_name || '';
      const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
      const name =
        fullName || dynamicVars.name || dynamicVars.customer_name || `Caller ${phoneNumber}`;
      const email = dynamicVars.email || dynamicVars.customer_email;
      const csvAddress =
        dynamicVars.address ||
        dynamicVars.full_address ||
        dynamicVars.customer_address ||
        dynamicVars.home_address ||
        '';

      // ── Find or create Customer ───────────────────────────────────────────────
      let customer = await Customer.findOne({ phone: phoneNumber, organizationId: orgObjectId });
      if (!customer) {
        customer = await Customer.create({
          name,
          phone: phoneNumber,
          email,
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

      const contactId = customer._id.toString();

      // ── Recording URL (proxied through our backend for inline playback) ───────
      const backendPublicBase = (
        process.env.BACKEND_URL ||
        process.env.PUBLIC_API_URL ||
        `http://localhost:${process.env.PORT || 5001}`
      ).replace(/\/+$/, '');
      const recordingUrl = elevenLabsConvId
        ? `${backendPublicBase}/api/v1/conversations/recording/${elevenLabsConvId}`
        : '';

      const endReason = webhookData?.metadata?.termination_reason || '';
      const startTimeUnix: number = webhookData?.metadata?.start_time_unix_secs || 0;

      // ── Find or create Conversation ───────────────────────────────────────────
      let existing: any = null;
      if (elevenLabsConvId) {
        existing = await Conversation.findOne({
          organizationId: orgObjectId,
          channel: 'phone',
          'metadata.batch_call_id': batchId,
          'metadata.conversation_id': elevenLabsConvId
        });
      }
      if (!existing) {
        const batchConvs = await Conversation.find({
          organizationId: orgObjectId,
          channel: 'phone',
          'metadata.batch_call_id': batchId
        }).lean();
        existing =
          batchConvs.find(
            (c: any) => normalizePhoneKey(c?.metadata?.phone_number) === phoneKey
          ) || null;
      }

      let conversationMongoId: string;

      if (existing) {
        conversationMongoId = existing._id.toString();
        await Conversation.updateOne(
          { _id: existing._id },
          {
            $set: {
              transcript: finalTranscript,
              'metadata.duration_seconds': duration,
              'metadata.call_duration_secs': duration,
              'metadata.end_reason': endReason,
              'metadata.conversation_id': elevenLabsConvId,
              'metadata.recording_url': recordingUrl,
              'metadata.audio_url': recordingUrl
            }
          }
        );

        // Upsert messages only if none exist yet
        const existingMsgCount = await Message.countDocuments({
          conversationId: existing._id,
          type: 'message'
        });
        if (existingMsgCount === 0 && finalTranscript.length > 0) {
          await Message.insertMany(
            this.buildMessagesFromTranscript(existing._id, finalTranscript, startTimeUnix, batchId)
          );
        }
      } else {
        const conversation = await Conversation.create({
          organizationId: orgObjectId,
          customerId: customer._id,
          channel: 'phone',
          status: 'closed',
          transcript: finalTranscript,
          isAiManaging: true,
          unread: false,
          metadata: {
            batch_call_id: batchId,
            conversation_id: elevenLabsConvId,
            phone_number: phoneNumber,
            callerId: elevenLabsConvId,
            duration_seconds: duration,
            call_duration_secs: duration,
            call_successful: true,
            end_reason: endReason,
            recording_url: recordingUrl,
            audio_url: recordingUrl,
            callInitiated: startTimeUnix
              ? new Date(startTimeUnix * 1000)
              : new Date(duration ? Date.now() - duration * 1000 : Date.now()),
            callCompletedAt: new Date(),
            source: 'batch'
          }
        });

        conversationMongoId = conversation._id.toString();

        if (finalTranscript.length > 0) {
          await Message.insertMany(
            this.buildMessagesFromTranscript(conversation._id, finalTranscript, startTimeUnix, batchId)
          );
        }
      }

      // ── Trigger automation ────────────────────────────────────────────────────
      const triggerResults = await automationService.triggerByEvent(
        'batch_call_completed',
        {
          event: 'batch_call_completed',
          batch_id: batchId,
          conversation_id: conversationMongoId,
          contactId,
          organizationId,
          source: 'batch_call',
          recording_url: recordingUrl,
          audio_url: recordingUrl,
          dynamic_variables: dynamicVars,
          selected_dynamic_variable_keys: batch.selected_dynamic_variable_keys || [],
          freshContactData: {
            name,
            first_name: firstName,
            last_name: lastName,
            email,
            phone: phoneNumber,
            address: csvAddress
          }
        },
        { userId, organizationId }
      );

      const workflowNames =
        (triggerResults || []).map((r: any) => r?.name).filter(Boolean).join(', ') || 'none';
      console.log(
        `[ElevenLabs Webhook] ✅ AUTOMATION TRIGGERED | contact: ${name} | phone: ${phoneNumber} | batch: ${batchId} | conv: ${elevenLabsConvId} | workflow(s): ${workflowNames}`
      );

      // ── Mark phone done so sync/poll skip it ──────────────────────────────────
      await BatchCall.updateOne(
        { batch_call_id: batchId },
        { $addToSet: { automation_triggered_phones: phoneNumber } }
      );

      return true;
    } catch (err: any) {
      console.error(
        `[ElevenLabs Webhook] ❌ processOutboundRecipientFromWebhook failed | phone: ${phoneNumber} | batch: ${batchId}:`,
        err.message
      );
      return false;
    }
  }

  /**
   * Build Message documents from a post_call_transcription transcript array.
   * Transcript items have the shape: { role, message, time_in_call_secs, interrupted, … }
   */
  private buildMessagesFromTranscript(
    conversationId: any,
    transcript: any[],
    startTimeUnix: number,
    batchId: string
  ): any[] {
    const msgs: any[] = [];
    for (let i = 0; i < transcript.length; i++) {
      const item = transcript[i];
      const text = (item.message || item.content || item.text || '').trim();
      if (!text) continue;
      const role = item.role || '';
      const sender = role === 'agent' || role === 'assistant' ? 'ai' : 'customer';
      const timestamp =
        startTimeUnix && item.time_in_call_secs != null
          ? new Date((startTimeUnix + item.time_in_call_secs) * 1000)
          : new Date();
      msgs.push({
        conversationId,
        sender,
        text,
        type: 'message',
        attachments: [],
        sourcesUsed: [],
        topics: [],
        timestamp,
        metadata: {
          fromBatchCall: true,
          from_transcript: true,
          time_in_call_secs: item.time_in_call_secs,
          interrupted: item.interrupted,
          transcriptItemId: `${batchId}_${i}`
        }
      });
    }
    return msgs;
  }
}

export const elevenlabsWebhookController = new ElevenLabsWebhookController();

