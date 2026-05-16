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

  /**
   * When ElevenLabs fires post_call_transcription for an outbound (batch) call the full
   * transcript array is already in the webhook payload. We use it directly to:
   *   1. Find the matching batch (by conv_id or phone).
   *   2. Create/update the Conversation + Messages in Mongo.
   *   3. Trigger automation immediately — no polling delay, no extra API call needed.
   *
   * The 30-second poll / BatchCallMonitor still run as a safety net. Because the phone
   * number is added to automation_triggered_phones before returning, those jobs simply
   * skip it on their next tick.
   *
   * Falls back to the old full-sync approach only when the webhook transcript is empty
   * (e.g. zero-second hangup) or no matching batch can be identified.
   */
  private async processBatchCallWebhook(webhookBody: any) {
    const data = webhookBody?.data;
    const phoneNumber: string | undefined = data?.metadata?.phone_call?.external_number || data?.user_id;
    const elevenLabsConvId: string | undefined = data?.conversation_id;

    if (!phoneNumber) {
      console.log('[ElevenLabs Webhook] Outbound webhook missing phoneNumber – skipping');
      return;
    }

    // The post_call_transcription payload already contains the transcript.
    const webhookTranscript: any[] = Array.isArray(data?.transcript) ? data.transcript : [];
    const duration: number = data?.metadata?.call_duration_secs || 0;
    const hasContent = webhookTranscript.length > 0 || duration > 0;

    console.log(
      `[ElevenLabs Webhook] 📞 Outbound call for ${phoneNumber}` +
      (elevenLabsConvId ? ` (conv: ${elevenLabsConvId})` : '') +
      ` – transcript turns: ${webhookTranscript.length}, duration: ${duration}s`
    );

    const BatchCall = (await import('../models/BatchCall')).default;
    const { batchCallingService } = await import('../services/batchCalling.service');

    const normalizePhone = (p: string) => {
      const digits = String(p || '').replace(/\D/g, '');
      return digits.length >= 10 ? digits.slice(-10) : digits;
    };
    const phoneNorm = normalizePhone(phoneNumber);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const activeBatches = await BatchCall.find({
      conversations_synced: { $ne: true },
      status: { $nin: ['cancelled', 'canceled', 'failed'] },
      createdAt: { $gte: oneDayAgo }
    })
      .sort({ createdAt: -1 })
      .limit(15)
      .lean();

    if (activeBatches.length === 0) {
      console.log('[ElevenLabs Webhook] No active batch found – skipping');
      return;
    }

    // ── FAST PATH: transcript in webhook → process per-call directly ──────────
    if (hasContent) {
      for (const batch of activeBatches) {
        const batchId = (batch as any).batch_call_id;
        const orgId =
          (batch as any).organizationId?.toString() ||
          (batch as any).userId?.toString();
        if (!orgId || !batchId) continue;

        try {
          const status = await batchCallingService.getBatchJobStatus(batchId);
          const recipients = status.recipients || [];
          const recipient = recipients.find((r: any) => {
            if (elevenLabsConvId && r.conversation_id === elevenLabsConvId) return true;
            return normalizePhone(r.phone_number) === phoneNorm;
          });
          if (!recipient) continue;

          const dynamicVars =
            recipient.conversation_initiation_client_data?.dynamic_variables || {};

          const processed = await this.processOutboundRecipientFromWebhook({
            batch,
            organizationId: orgId,
            phoneNumber,
            elevenLabsConvId: elevenLabsConvId || recipient.conversation_id || '',
            webhookTranscript,
            duration,
            dynamicVars,
            webhookData: data
          });

          if (processed) {
            console.log(
              `[ElevenLabs Webhook] ✅ Per-call automation done for ${phoneNumber} (batch: ${batchId})`
            );
            return;
          }
        } catch (err: any) {
          console.error(
            `[ElevenLabs Webhook] ⚠️ Per-call processing failed for batch ${(batch as any).batch_call_id}:`,
            err.message
          );
        }
      }
    }

    // ── FALLBACK: no content or no batch matched → full batch sync ─────────────
    // Give ElevenLabs 5s to update recipient status before we query it.
    await new Promise(resolve => setTimeout(resolve, 5000));

    let synced = 0;
    for (const batch of activeBatches) {
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

        console.log(`[ElevenLabs Webhook] 🔄 Fallback sync for batch: ${batchId}`);
        await batchCallingService.syncBatchCallConversations(batchId, orgId);
        synced++;
      } catch (err: any) {
        console.error(`[ElevenLabs Webhook] ⚠️ Sync failed for ${batchId}:`, err.message);
      }
    }

    if (synced === 0) {
      const fallback = activeBatches[0] as any;
      const orgId = fallback.organizationId?.toString() || fallback.userId?.toString();
      if (orgId && fallback.batch_call_id) {
        console.log(`[ElevenLabs Webhook] 🔄 No phone match – syncing latest batch: ${fallback.batch_call_id}`);
        try {
          await batchCallingService.syncBatchCallConversations(fallback.batch_call_id, orgId);
        } catch (err: any) {
          console.error(`[ElevenLabs Webhook] ⚠️ Fallback sync failed:`, err.message);
        }
      }
    }
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
              transcript: webhookTranscript,
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
        if (existingMsgCount === 0 && webhookTranscript.length > 0) {
          await Message.insertMany(
            this.buildMessagesFromTranscript(existing._id, webhookTranscript, startTimeUnix, batchId)
          );
        }
      } else {
        const conversation = await Conversation.create({
          organizationId: orgObjectId,
          customerId: customer._id,
          channel: 'phone',
          status: 'closed',
          transcript: webhookTranscript,
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

        if (webhookTranscript.length > 0) {
          await Message.insertMany(
            this.buildMessagesFromTranscript(conversation._id, webhookTranscript, startTimeUnix, batchId)
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

