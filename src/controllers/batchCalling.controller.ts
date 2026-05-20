import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { batchCallingService, isActiveBatchStatus } from '../services/batchCalling.service';
import mongoose from 'mongoose';

const MAX_RECIPIENTS = 10000;
const ELEVENLABS_BATCH_SIZE = 500;

const resolveOrganizationObjectId = async (req: AuthRequest): Promise<mongoose.Types.ObjectId | null> => {
  const userId = req.user?._id;
  if (!userId) return null;

  const { profileService } = await import('../services/profile.service');
  const organizationIdStr = await profileService.ensureOrganizationForUser(userId.toString());
  return new mongoose.Types.ObjectId(organizationIdStr);
};

export class BatchCallingController {

  /**
   * Submit batch calling job
   * POST /api/v1/batch-calling/submit
   */
  async submitBatchCall(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const {
        agent_id,
        call_name,
        recipients,
        phone_number_id,
        retry_count,
        scheduled_at,
        timezone,
        target_concurrency_limit,
        sender_email,
        selected_dynamic_variable_keys
      } = req.body;

      console.log('[Batch Calling Controller] ===== SUBMIT BATCH CALL REQUEST =====');
      console.log('[Batch Calling Controller] Endpoint:', req.method, req.originalUrl);
      console.log('[Batch Calling Controller] Request body:', {
        agent_id,
        call_name,
        recipients_count: recipients?.length || 0,
        phone_number_id,
        retry_count,
        scheduled_at: scheduled_at || null,
        timezone: timezone || null,
        target_concurrency_limit:
          target_concurrency_limit !== undefined ? target_concurrency_limit : null,
        has_sender_email: Boolean(sender_email)
      });

      // Validate required fields
      if (!agent_id || !call_name || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(422).json({
          detail: [{
            loc: ["body"],
            msg: "agent_id, call_name, and recipients (non-empty array) are required",
            type: "value_error"
          }]
        });
      }

      // Validate phone_number_id is provided
      if (!phone_number_id) {
        return res.status(422).json({
          detail: [{
            loc: ["body", "phone_number_id"],
            msg: "phone_number_id is required",
            type: "value_error"
          }]
        });
      }

      // Get phone number from database and resolve to ElevenLabs phone_number_id
      const PhoneNumber = (await import('../models/PhoneNumber')).default;
      if (!req.user?._id) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "User ID not found"
        });
      }
      const userId = req.user._id;
      const { profileService } = await import('../services/profile.service');
      const organizationIdStr = await profileService.ensureOrganizationForUser(userId.toString());
      const organizationId = new mongoose.Types.ObjectId(organizationIdStr);

      // Find by phone_number_id and (organizationId or userId) so we match legacy records stored with userId
      const requestedPhoneId = String(phone_number_id).trim();
      const phoneNumber = await PhoneNumber.findOne({
        $and: [
          {
            $or: [
              { phone_number_id: requestedPhoneId },
              { elevenlabs_phone_number_id: requestedPhoneId }
            ]
          },
          {
            $or: [
              { organizationId },
              { userId }
            ]
          }
        ]
      }).lean();

      if (!phoneNumber) {
        return res.status(404).json({
          success: false,
          error: "Phone number not found",
          detail: `Phone number with ID ${requestedPhoneId} not found`
        });
      }

      // Get ElevenLabs phone_number_id (required for batch calling)
      let elevenlabsPhoneNumberId =
        phoneNumber.elevenlabs_phone_number_id ||
        (phoneNumber.phone_number_id === requestedPhoneId ? requestedPhoneId : '');

      // If caller passed a direct ElevenLabs phone_number_id, trust and use it.
      if (phoneNumber.elevenlabs_phone_number_id === requestedPhoneId) {
        elevenlabsPhoneNumberId = requestedPhoneId;
      }

      // If not registered, try to register it (for Twilio numbers)
      if (!elevenlabsPhoneNumberId && phoneNumber.provider === 'twilio' && phoneNumber.sid && phoneNumber.token) {
        console.log('[Batch Calling Controller] Phone number not registered, attempting auto-registration...');
        try {
          const { sipTrunkService } = await import('../services/sipTrunk.service');
          const registrationResponse = await sipTrunkService.registerTwilioPhoneNumberWithElevenLabs({
            label: phoneNumber.label,
            phone_number: phoneNumber.phone_number,
            sid: phoneNumber.sid,
            token: phoneNumber.token,
            supports_inbound: phoneNumber.supports_inbound || false,
            supports_outbound: phoneNumber.supports_outbound || false
          });

          // Update phone number with ElevenLabs ID
          await PhoneNumber.updateOne(
            { phone_number_id },
            { $set: { elevenlabs_phone_number_id: registrationResponse.phone_number_id } }
          );

          elevenlabsPhoneNumberId = registrationResponse.phone_number_id;
          console.log('[Batch Calling Controller] ✅ Phone number registered:', elevenlabsPhoneNumberId);
        } catch (registerError: any) {
          console.error('[Batch Calling Controller] ❌ Failed to register phone number:', registerError.message);
          return res.status(registerError.statusCode || 500).json({
            success: false,
            error: {
              code: registerError.code || 'REGISTRATION_ERROR',
              message: `Phone number ${phone_number_id} is not registered with ElevenLabs. Please register it first.`
            }
          });
        }
      }

      if (!elevenlabsPhoneNumberId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'PHONE_NUMBER_NOT_REGISTERED',
            message: `Phone number ${phone_number_id} is not registered with ElevenLabs. Please register it first via POST /api/v1/phone-numbers/${phone_number_id}/register`
          }
        });
      }

      // Validate recipients structure
      for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i];
        if (!recipient.phone_number || !recipient.name) {
          return res.status(422).json({
            detail: [{
              loc: ["body", "recipients", i],
              msg: "phone_number and name are required for each recipient",
              type: "value_error"
            }]
          });
        }
      }

      if (recipients.length > MAX_RECIPIENTS) {
        return res.status(422).json({
          detail: [{
            loc: ["body", "recipients"],
            msg: `Maximum ${MAX_RECIPIENTS} recipients allowed per submission`,
            type: "value_error"
          }]
        });
      }

      // Helper to prepare recipients payload
      const prepareRecipients = (recipientsList: any[]) => {
        return recipientsList.map((r: any) => {
          const recipient: any = {
            phone_number: r.phone_number,
            name: r.name
          };

          // Extract email from dynamic_variables if present and add it as a top-level field
          const email = r.email || r.dynamic_variables?.email || r.dynamic_variables?.customer_email || r.dynamic_variables?.['contact.email'];
          if (email) {
            recipient.email = email;
          }

          // Include dynamic_variables ONLY if provided (preserve exactly as received)
          if (r.dynamic_variables !== undefined && r.dynamic_variables !== null) {
            recipient.dynamic_variables = r.dynamic_variables;
          }
          return recipient;
        });
      };

      // Split recipients into ElevenLabs-safe chunks (max 500 each)
      const chunkRecipients = (list: any[], chunkSize: number) => {
        const chunks: any[][] = [];
        for (let i = 0; i < list.length; i += chunkSize) {
          chunks.push(list.slice(i, i + chunkSize));
        }
        return chunks;
      };

      const getChunkCallName = (baseName: string, chunkIndex: number, totalChunks: number) => {
        if (totalChunks <= 1) return baseName;
        return `${baseName} (Batch ${chunkIndex + 1}/${totalChunks})`;
      };

      const preparedRecipients = prepareRecipients(recipients);
      const recipientChunks = chunkRecipients(preparedRecipients, ELEVENLABS_BATCH_SIZE);
      const totalChunks = recipientChunks.length;
      const isChunkedSubmission = totalChunks > 1;

      // Helper to submit batch call (used for initial attempt and retry after re-register)
      const doSubmit = (elevenLabsId: string, chunkRecipientsPayload: any[], chunkCallName: string) => {
        // Build payload with ONLY the required fields - no transformations, no enrichment
        const payload: any = {
          agent_id,
          call_name: chunkCallName,
          phone_number_id: elevenLabsId,
          recipients: chunkRecipientsPayload
        };

        if (retry_count !== undefined) payload.retry_count = retry_count;
        if (scheduled_at) payload.scheduled_at = scheduled_at;
        if (timezone) payload.timezone = timezone;
        if (target_concurrency_limit !== undefined) payload.target_concurrency_limit = target_concurrency_limit;
        if (sender_email) payload.sender_email = sender_email;

        // Log summary only (no PII – do not log full recipient list)
        console.log('[Batch Calling Controller] Submitting batch:', {
          recipients_count: payload.recipients.length,
          agent_id: payload.agent_id,
          phone_number_id: payload.phone_number_id,
          retry_count: payload.retry_count ?? null,
          scheduled_at: payload.scheduled_at ?? null,
          timezone: payload.timezone ?? null,
          target_concurrency_limit: payload.target_concurrency_limit ?? null,
          has_sender_email: Boolean(payload.sender_email)
        });

        return batchCallingService.submitBatchCall(payload);
      };

      // Check if queue is available.
      // For chunked submissions, use synchronous path so all chunk records are created
      // immediately and visible in the UI (e.g. 700 -> Batch 1/2 and Batch 2/2).
      const { enqueueBatchCall, isBatchCallQueueAvailable } = await import('../queues/batchCall.queue');
      const queueAvailable = isBatchCallQueueAvailable();
      const shouldUseQueue = queueAvailable && !isChunkedSubmission;
      const queueCompletionTimeoutMs = 15000;

      if (shouldUseQueue) {
        console.log('[Batch Calling Controller] 🚀 Queue available - enqueueing batch call job for background processing');
        console.log('[Batch Calling Controller] Recipients count:', recipients.length);

        const queuedJobIds: string[] = [];
        const queuedJobs: any[] = [];

        for (let i = 0; i < recipientChunks.length; i++) {
          const recipientsChunk = recipientChunks[i];
          const chunkCallName = getChunkCallName(call_name, i, totalChunks);

          const job = await enqueueBatchCall({
            agent_id,
            call_name: chunkCallName,
            recipients: recipientsChunk,
            phone_number_id: elevenlabsPhoneNumberId,
            retry_count,
            scheduled_at,
            timezone,
            target_concurrency_limit,
            sender_email,
            selected_dynamic_variable_keys,
            userId,
            organizationId
          });

          if (job) {
            queuedJobIds.push(job.id.toString());
            queuedJobs.push(job);
          } else {
            console.warn('[Batch Calling Controller] ⚠️  Failed to enqueue one chunk, falling back to synchronous processing');
            queuedJobIds.length = 0;
            queuedJobs.length = 0;
            break;
          }
        }

        if (queuedJobs.length === totalChunks) {
          console.log('[Batch Calling Controller] ✅ All batch call chunks enqueued:', queuedJobs.length);

          // Try fast-path completion first. If the queue is healthy, jobs should complete quickly.
          const completionResults = await Promise.all(
            queuedJobs.map(async (job) => {
              try {
                const finishedResult = await Promise.race([
                  job.finished(),
                  new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('QUEUE_COMPLETION_TIMEOUT')), queueCompletionTimeoutMs)
                  )
                ]);
                return { ok: true as const, finishedResult };
              } catch {
                return { ok: false as const, finishedResult: null };
              }
            })
          );

          const allCompletedQuickly = completionResults.every((result) => result.ok);
          if (allCompletedQuickly) {
            // Safety net: ensure DB rows exist even if queue worker persistence raced/failed.
            try {
              const BatchCall = (await import('../models/BatchCall')).default;
              const finishedPayloads = completionResults
                .map((item) => item.finishedResult as any)
                .filter(Boolean);
              const userObjectId = userId instanceof mongoose.Types.ObjectId
                ? userId
                : new mongoose.Types.ObjectId(userId.toString());

              for (const payload of finishedPayloads) {
                const result = payload?.result || payload;
                const batchId = result?.id || payload?.batch_call_id;
                if (!batchId) continue;

                await BatchCall.updateOne(
                  { batch_call_id: batchId },
                  {
                    $setOnInsert: {
                      userId: userObjectId,
                      organizationId,
                      batch_call_id: batchId,
                      name: result.name || call_name,
                      agent_id: result.agent_id || agent_id,
                      status: result.status || 'pending',
                      phone_number_id: result.phone_number_id || elevenlabsPhoneNumberId,
                      phone_provider: result.phone_provider || 'twilio',
                      created_at_unix: result.created_at_unix || Math.floor(Date.now() / 1000),
                      scheduled_time_unix: result.scheduled_time_unix || Math.floor(Date.now() / 1000),
                      timezone: result.timezone || timezone || 'UTC',
                      total_calls_dispatched: result.total_calls_dispatched || 0,
                      total_calls_scheduled: result.total_calls_scheduled || 0,
                      total_calls_finished: result.total_calls_finished || 0,
                      last_updated_at_unix: result.last_updated_at_unix || Math.floor(Date.now() / 1000),
                      retry_count: result.retry_count ?? (retry_count ?? 0),
                      agent_name: result.agent_name || '',
                      call_name,
                      recipients_count: recipients.length,
                      conversations_synced: false
                    }
                  },
                  { upsert: true }
                );
              }
            } catch (queuePersistSafetyError: any) {
              console.warn('[Batch Calling Controller] ⚠️ Queue completion safety persistence failed:', queuePersistSafetyError.message);
            }

            console.log('[Batch Calling Controller] ✅ Queue jobs completed within timeout:', queueCompletionTimeoutMs);
            return res.status(202).json({
              success: true,
              message: 'Batch call processed via queue',
              job_ids: queuedJobIds,
              total_jobs: queuedJobIds.length,
              recipients_count: recipients.length,
              chunk_size: ELEVENLABS_BATCH_SIZE,
              status: 'queued_completed'
            });
          }

          console.warn('[Batch Calling Controller] ⚠️ Queue jobs did not complete quickly. Attempting safe fallback to synchronous processing...');

          // Remove only jobs that have not started yet to avoid duplicate submissions.
          let canFallbackSafely = true;
          for (const job of queuedJobs) {
            try {
              const state = await job.getState();
              if (state === 'waiting' || state === 'delayed' || state === 'paused') {
                await job.remove();
              } else if (state === 'active' || state === 'completed') {
                canFallbackSafely = false;
              }
            } catch (queueStateError: any) {
              console.warn('[Batch Calling Controller] ⚠️ Failed to inspect/remove queued job:', queueStateError.message);
              canFallbackSafely = false;
            }
          }

          if (!canFallbackSafely) {
            console.log('[Batch Calling Controller] ℹ️ Some queued jobs already started; keeping queue path to avoid duplicate provider submissions');
            return res.status(202).json({
              success: true,
              message: 'Batch call is still processing in queue',
              job_ids: queuedJobIds,
              total_jobs: queuedJobIds.length,
              recipients_count: recipients.length,
              chunk_size: ELEVENLABS_BATCH_SIZE,
              status: 'queued'
            });
          }

          console.log('[Batch Calling Controller] 🔁 Queue jobs removed before start; falling back to synchronous submission now');
        }
      } else {
        if (isChunkedSubmission && queueAvailable) {
          console.log('[Batch Calling Controller] ℹ️  Queue is available but chunked submission detected - using synchronous processing to persist all chunks immediately');
        } else {
          console.log('[Batch Calling Controller] ℹ️  Queue not available - using synchronous processing');
        }
      }

      // Synchronous processing (fallback or when queue unavailable)
      console.log('[Batch Calling Controller] Calling Python service synchronously...');
      console.log('[Batch Calling Controller] Using ElevenLabs phone_number_id:', elevenlabsPhoneNumberId);
      const submitChunkWithRetry = async (chunkRecipientsPayload: any[], chunkCallName: string) => {
        try {
          return await doSubmit(elevenlabsPhoneNumberId, chunkRecipientsPayload, chunkCallName);
        } catch (submitError: any) {
          const is404NotFound =
            submitError?.statusCode === 404 &&
            (submitError?.message?.includes('not found') || submitError?.message?.includes('Document with id'));
          if (!is404NotFound) throw submitError;

          console.log('[Batch Calling Controller] Phone number not found in voice service (404). Attempting re-registration...');
          const { sipTrunkService } = await import('../services/sipTrunk.service');
          let newElevenLabsId: string;

          if (phoneNumber.provider === 'twilio' && phoneNumber.sid && phoneNumber.token) {
            const reg = await sipTrunkService.registerTwilioPhoneNumberWithElevenLabs({
              label: phoneNumber.label,
              phone_number: phoneNumber.phone_number,
              sid: phoneNumber.sid,
              token: phoneNumber.token,
              supports_inbound: phoneNumber.supports_inbound || false,
              supports_outbound: phoneNumber.supports_outbound || false
            });
            newElevenLabsId = reg.phone_number_id;
          } else if (
            (phoneNumber.provider === 'sip_trunk' || phoneNumber.provider === 'sip') &&
            phoneNumber.outbound_trunk_config
          ) {
            const reg = await sipTrunkService.registerSipPhoneNumberWithElevenLabs({
              label: phoneNumber.label,
              phone_number: phoneNumber.phone_number,
              provider: (phoneNumber.provider as 'sip_trunk' | 'sip') || 'sip_trunk',
              supports_inbound: phoneNumber.supports_inbound || false,
              supports_outbound: phoneNumber.supports_outbound || false,
              inbound_trunk_config: phoneNumber.inbound_trunk_config,
              outbound_trunk_config: phoneNumber.outbound_trunk_config
            });
            newElevenLabsId = reg.phone_number_id;
          } else {
            throw {
              statusCode: 400,
              code: 'PHONE_NUMBER_NOT_REGISTERED',
              message:
                'This phone number is not registered with the voice service. Please open Phone Settings (Configuration → Phone), register this number, then try the batch call again.'
            };
          }

          await PhoneNumber.updateOne(
            { phone_number_id, $or: [{ organizationId }, { userId }] },
            { $set: { elevenlabs_phone_number_id: newElevenLabsId } }
          );
          console.log('[Batch Calling Controller] ✅ Re-registered phone number. New ElevenLabs ID:', newElevenLabsId);
          return await doSubmit(newElevenLabsId, chunkRecipientsPayload, chunkCallName);
        }
      };

      const submittedChunkResults: any[] = [];
      for (let i = 0; i < recipientChunks.length; i++) {
        const recipientsChunk = recipientChunks[i];
        const chunkCallName = getChunkCallName(call_name, i, totalChunks);
        const result = await submitChunkWithRetry(recipientsChunk, chunkCallName);
        submittedChunkResults.push({
          result,
          recipientsCount: recipientsChunk.length,
          chunkCallName
        });
      }

      for (const chunk of submittedChunkResults) {
        console.log('[Batch Calling Controller] ✅ Batch call submitted:', { id: chunk.result?.id, status: chunk.result?.status });
      }

      // Store batch call responses in database
      try {
        const BatchCall = (await import('../models/BatchCall')).default;
        const userId = req.user?._id;

        if (userId && organizationId) {
          for (const chunk of submittedChunkResults) {
            await BatchCall.create({
              userId: userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(userId.toString()),
              organizationId,
              batch_call_id: chunk.result.id,
              name: chunk.result.name,
              agent_id: chunk.result.agent_id,
              status: chunk.result.status,
              phone_number_id: chunk.result.phone_number_id,
              phone_provider: chunk.result.phone_provider,
              created_at_unix: chunk.result.created_at_unix,
              scheduled_time_unix: chunk.result.scheduled_time_unix,
              timezone: chunk.result.timezone || 'UTC',
              total_calls_dispatched: chunk.result.total_calls_dispatched,
              total_calls_scheduled: chunk.result.total_calls_scheduled,
              total_calls_finished: chunk.result.total_calls_finished,
              last_updated_at_unix: chunk.result.last_updated_at_unix,
              retry_count: chunk.result.retry_count,
              agent_name: chunk.result.agent_name,
              call_name: chunk.chunkCallName,
              recipients_count: chunk.recipientsCount,
              conversations_synced: false,
              ...(Array.isArray(selected_dynamic_variable_keys) && selected_dynamic_variable_keys.length > 0 && {
                selected_dynamic_variable_keys
              })
            });

            console.log(
              '[Batch Calling Controller] Batch submitted – completion handled via post_call_transcription webhooks:',
              chunk.result.id
            );
          }
        } else {
          console.warn('[Batch Calling Controller] ⚠️ Could not store batch call - userId or organizationId missing');
        }
      } catch (dbError: any) {
        console.error('[Batch Calling Controller] ⚠️ Failed to store batch call in database:', dbError.message);
      }

      if (submittedChunkResults.length === 1) {
        return res.status(201).json(submittedChunkResults[0].result);
      }

      return res.status(201).json({
        success: true,
        message: `Batch call split into ${submittedChunkResults.length} ElevenLabs batches`,
        total_requested_recipients: recipients.length,
        chunk_size: ELEVENLABS_BATCH_SIZE,
        total_batches_created: submittedChunkResults.length,
        batch_ids: submittedChunkResults.map((chunk) => chunk.result.id)
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get batch job status
   * GET /api/v1/batch-calling/:jobId
   */
  async getBatchJobStatus(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_JOB_ID',
            message: 'Job ID is required'
          }
        });
      }

      // Verify the batch call belongs to the user's organization
      const BatchCall = (await import('../models/BatchCall')).default;
      const organizationId = await resolveOrganizationObjectId(req);

      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const batchCall = await BatchCall.findOne({
        batch_call_id: jobId,
        organizationId
      }).lean();

      if (!batchCall) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'BATCH_CALL_NOT_FOUND',
            message: 'Batch call not found or does not belong to your organization'
          }
        });
      }

      // Fetch latest status from Python API
      const result = await batchCallingService.getBatchJobStatus(jobId);

      // Update database with latest status
      let updatedBatchCall: any = null;
      try {
        updatedBatchCall = await BatchCall.findOneAndUpdate(
          { batch_call_id: jobId },
          {
            $set: {
              status: result.status,
              total_calls_dispatched: result.total_calls_dispatched,
              total_calls_scheduled: result.total_calls_scheduled,
              total_calls_finished: result.total_calls_finished,
              last_updated_at_unix: result.last_updated_at_unix
            }
          },
          { new: true }
        );
      } catch (dbError: any) {
        console.warn('[Batch Calling Controller] ⚠️ Failed to update batch call status in database:', dbError.message);
        // Don't fail the request if database update fails
      }

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Cancel batch job
   * POST /api/v1/batch-calling/:jobId/cancel
   */
  async cancelBatchJob(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_JOB_ID',
            message: 'Job ID is required'
          }
        });
      }

      // Verify the batch call belongs to the user's organization
      const BatchCall = (await import('../models/BatchCall')).default;
      const organizationId = await resolveOrganizationObjectId(req);

      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const batchCall = await BatchCall.findOne({
        batch_call_id: jobId,
        organizationId
      }).lean();

      if (!batchCall) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'BATCH_CALL_NOT_FOUND',
            message: 'Batch call not found or does not belong to your organization'
          }
        });
      }

      // Cancel the batch job via Python API
      const result = await batchCallingService.cancelBatchJob(jobId);

      // Update database status
      try {
        await BatchCall.updateOne(
          { batch_call_id: jobId },
          {
            $set: {
              status: 'cancelled',
              last_updated_at_unix: Math.floor(Date.now() / 1000)
            }
          }
        );
      } catch (dbError: any) {
        console.warn('[Batch Calling Controller] ⚠️ Failed to update batch call status in database:', dbError.message);
        // Don't fail the request if database update fails
      }

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Resume batch job
   * POST /api/v1/batch-calling/:jobId/resume
   */
  async resumeBatchJob(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_JOB_ID',
            message: 'Job ID is required'
          }
        });
      }

      const BatchCall = (await import('../models/BatchCall')).default;
      const organizationId = await resolveOrganizationObjectId(req);
      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const batchCall = await BatchCall.findOne({
        batch_call_id: jobId,
        organizationId
      }).lean();

      if (!batchCall) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'BATCH_CALL_NOT_FOUND',
            message: 'Batch call not found or does not belong to your organization'
          }
        });
      }

      const result = await batchCallingService.resumeBatchJob(jobId);

      try {
        await BatchCall.updateOne(
          { batch_call_id: jobId },
          {
            $set: {
              status: 'in_progress',
              last_updated_at_unix: Math.floor(Date.now() / 1000)
            }
          }
        );
      } catch (dbError: any) {
        console.warn('[Batch Calling Controller] ⚠️ Failed to update resumed batch status in database:', dbError.message);
      }

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Retry batch job (failed and no-response recipients)
   * POST /api/v1/batch-calling/:jobId/retry
   */
  async retryBatchJob(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      console.log('[Batch Calling Controller] ===== RETRY BATCH JOB REQUEST =====');
      console.log('[Batch Calling Controller] Job ID:', jobId);

      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: { code: 'MISSING_JOB_ID', message: 'Job ID is required' }
        });
      }

      const BatchCall = (await import('../models/BatchCall')).default;
      const organizationId = await resolveOrganizationObjectId(req);

      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const batchCall = await BatchCall.findOne({ batch_call_id: jobId, organizationId }).lean();

      if (!batchCall) {
        console.log('[Batch Calling Controller] ❌ Batch call not found for job ID:', jobId);
        return res.status(404).json({
          success: false,
          error: {
            code: 'BATCH_CALL_NOT_FOUND',
            message: 'Batch call not found or does not belong to your organization'
          }
        });
      }

      console.log('[Batch Calling Controller] Found batch call:', {
        batch_call_id: batchCall.batch_call_id,
        name: batchCall.name,
        current_status: batchCall.status
      });

      // Update status to "retrying" immediately so UI shows the change
      try {
        await BatchCall.updateOne(
          { batch_call_id: jobId },
          { $set: { status: 'retrying', last_updated_at_unix: Math.floor(Date.now() / 1000) } }
        );
        console.log('[Batch Calling Controller] ✅ Database status updated to: retrying (immediate)');
      } catch (dbError: any) {
        console.warn('[Batch Calling Controller] ⚠️ Failed to update retrying status in database:', dbError.message);
      }

      let result;
      try {
        result = await batchCallingService.retryBatchJob(jobId);

        console.log('[Batch Calling Controller] ✅ Retry API call successful:', {
          job_id: jobId,
          new_status: result.status,
          total_calls_scheduled: result.total_calls_scheduled,
          total_calls_finished: result.total_calls_finished
        });

        // Update status to the actual status returned from Python API
        try {
          const newStatus = result.status || 'in_progress';
          await BatchCall.updateOne(
            { batch_call_id: jobId },
            { $set: { status: newStatus, last_updated_at_unix: Math.floor(Date.now() / 1000) } }
          );
          console.log('[Batch Calling Controller] ✅ Database status updated to:', newStatus);
        } catch (dbError: any) {
          console.warn('[Batch Calling Controller] ⚠️ Failed to update retried batch status in database:', dbError.message);
        }
      } catch (retryError: any) {
        console.error('[Batch Calling Controller] ❌ Retry API call failed:', retryError);
        // Revert status to previous status if retry fails
        try {
          await BatchCall.updateOne(
            { batch_call_id: jobId },
            { $set: { status: batchCall.status, last_updated_at_unix: Math.floor(Date.now() / 1000) } }
          );
          console.log('[Batch Calling Controller] ✅ Database status reverted to:', batchCall.status);
        } catch (revertError: any) {
          console.warn('[Batch Calling Controller] ⚠️ Failed to revert batch status in database:', revertError.message);
        }
        throw retryError;
      }

      res.status(200).json(result);
    } catch (error) {
      console.error('[Batch Calling Controller] ❌ Retry batch job error:', error);
      next(error);
    }
  }

  /**
   * Get all batch calls for the user's organization
   * GET /api/v1/batch-calling
   *
   * Returns MongoDB records immediately. Only in-flight batches are refreshed from
   * the Python API (summary fields only) so listing stays fast with many completed
   * 500-contact batches.
   */
  async getBatchCalls(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const organizationId = await resolveOrganizationObjectId(req);
      const includeCancelled = req.query.includeCancelled === 'true';

      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const BatchCall = (await import('../models/BatchCall')).default;
      const query: any = {
        organizationId
      };
      if (!includeCancelled) {
        query.status = { $ne: 'cancelled' };
      }

      const batchCalls = await BatchCall.find(query)
        .sort({ createdAt: -1 })
        .lean();

      // Respond immediately from Mongo — never block on Python.
      // Active-batch counts are refreshed in the background so the next
      // frontend poll (15 s) will see updated numbers.
      res.status(200).json({ success: true, data: batchCalls });

      // Background refresh: update Mongo for any in-flight batches.
      const activeBatches = batchCalls.filter((b) => isActiveBatchStatus(b.status));
      if (activeBatches.length > 0) {
        setImmediate(() => {
          void Promise.all(
            activeBatches.map(async (b) => {
              try {
                await batchCallingService.refreshBatchSummaryInDb(b.batch_call_id);
              } catch {
                // best-effort; next poll will retry
              }
            })
          );
        });
      }
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get batch job calls (individual call results)
   * GET /api/v1/batch-calling/:jobId/calls
   */
  async getBatchJobCalls(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;
      const { status, cursor, page_size } = req.query;

      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_JOB_ID',
            message: 'Job ID is required'
          }
        });
      }

      // Verify the batch call belongs to the user's organization
      const BatchCall = (await import('../models/BatchCall')).default;
      const organizationId = await resolveOrganizationObjectId(req);

      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const batchCall = await BatchCall.findOne({
        batch_call_id: jobId,
        organizationId
      }).lean();

      if (!batchCall) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'BATCH_CALL_NOT_FOUND',
            message: 'Batch call not found or does not belong to your organization'
          }
        });
      }

      // Fetch calls from Python API
      const result = await batchCallingService.getBatchJobCalls(jobId, {
        status: status as string | undefined,
        cursor: cursor as string | undefined,
        page_size: page_size ? parseInt(page_size as string, 10) : undefined
      });

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Manually sync batch call conversations
   * POST /api/v1/batch-calling/:jobId/sync
   */
  async syncBatchCallConversations(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_JOB_ID',
            message: 'Job ID is required'
          }
        });
      }

      // Verify the batch call belongs to the user's organization
      const BatchCall = (await import('../models/BatchCall')).default;
      const organizationId = await resolveOrganizationObjectId(req);

      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const batchCall = await BatchCall.findOne({
        batch_call_id: jobId,
        organizationId
      }).lean();

      if (!batchCall) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'BATCH_CALL_NOT_FOUND',
            message: 'Batch call not found or does not belong to your organization'
          }
        });
      }

      console.log(`[Batch Calling Controller] 🔄 Manually syncing conversations for batch call: ${jobId}`);

      // Sync conversations
      await batchCallingService.syncBatchCallConversations(jobId, organizationId.toString());

      res.status(200).json({
        success: true,
        message: 'Batch call conversations synced successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get batch job results with transcripts
   * GET /api/v1/batch-calling/:jobId/results
   */
  async getBatchJobResults(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;
      const { include_transcript } = req.query;

      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_JOB_ID',
            message: 'Job ID is required'
          }
        });
      }

      // Verify the batch call belongs to the user's organization
      const BatchCall = (await import('../models/BatchCall')).default;
      const organizationId = await resolveOrganizationObjectId(req);

      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const batchCall = await BatchCall.findOne({
        batch_call_id: jobId,
        organizationId
      }).lean();

      if (!batchCall) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'BATCH_CALL_NOT_FOUND',
            message: 'Batch call not found or does not belong to your organization'
          }
        });
      }

      // Parse include_transcript query parameter (default: true)
      let includeTranscript = true; // Default to true
      if (include_transcript !== undefined) {
        if (typeof include_transcript === 'string') {
          includeTranscript = include_transcript.toLowerCase() === 'true';
        } else if (Array.isArray(include_transcript)) {
          includeTranscript = include_transcript[0]?.toString().toLowerCase() === 'true';
        } else {
          includeTranscript = String(include_transcript).toLowerCase() === 'true';
        }
      }

      // Fetch results with transcripts from Python API
      const result = await batchCallingService.getBatchJobResults(jobId, includeTranscript);

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Lazy-load transcript for one batch contact (from Mongo messages).
   * GET /api/v1/batch-calling/:jobId/contacts/:conversationId/transcript
   */
  async getBatchContactTranscript(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { jobId, conversationId } = req.params;
      if (!jobId || !conversationId) {
        return res.status(400).json({
          success: false,
          error: { code: 'MISSING_PARAMS', message: 'Job ID and conversation ID are required' }
        });
      }

      const organizationId = await resolveOrganizationObjectId(req);
      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
          detail: 'Organization ID or User ID not found'
        });
      }

      const Conversation = (await import('../models/Conversation')).default;
      const Message = (await import('../models/Message')).default;

      const conversation = await Conversation.findOne({
        organizationId,
        channel: 'phone',
        'metadata.batch_call_id': jobId,
        'metadata.conversation_id': conversationId
      })
        .select('_id')
        .lean();

      if (!conversation) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Conversation not found for this batch contact' }
        });
      }

      const messages = await Message.find({
        conversationId: conversation._id,
        type: 'message'
      })
        .sort({ timestamp: 1 })
        .select('sender text timestamp')
        .lean();

      const transcript = messages.map((m: any) => ({
        role: m.sender === 'customer' ? 'user' : 'agent',
        message: m.text,
        timestamp: m.timestamp
      }));

      return res.status(200).json({
        success: true,
        data: { conversation_id: conversationId, transcript }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get paginated per-contact batch details (summary only; transcripts loaded separately).
   * GET /api/v1/batch-calling/:jobId/details?page=1&page_size=50
   */
  async getBatchJobDetails(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;
      const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
      const pageSize = Math.min(
        100,
        Math.max(1, parseInt(String(req.query.page_size || '50'), 10) || 50)
      );
      const includeTranscript = req.query.include_transcript === 'true';

      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_JOB_ID',
            message: 'Job ID is required'
          }
        });
      }

      const organizationId = await resolveOrganizationObjectId(req);
      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const BatchCall = (await import('../models/BatchCall')).default;
      const Conversation = (await import('../models/Conversation')).default;
      const Message = (await import('../models/Message')).default;
      const Customer = (await import('../models/Customer')).default;

      const orgObjectId = organizationId;

      const batchCall = await BatchCall.findOne({
        batch_call_id: jobId,
        organizationId: orgObjectId
      }).lean();

      if (!batchCall) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'BATCH_CALL_NOT_FOUND',
            message: 'Batch call not found or does not belong to your organization'
          }
        });
      }

      // Primary source: Mongo conversations (synced by webhook, always fast).
      // Python status is only fetched for in-flight batches AND with a short timeout
      // so a slow Python never blocks the response.
      const batchIsActive = isActiveBatchStatus(batchCall.status);

      const pythonStatusPromise = batchIsActive
        ? batchCallingService.getBatchJobStatus(jobId)
            .then((r) => r)
            .catch(() => null)
        : Promise.resolve(null);

      // Race Python against a 5-second wall clock so a slow comm-api never hangs the page.
      const statusResult: any = await Promise.race([
        pythonStatusPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
      ]);

      const resultsResult = includeTranscript && batchIsActive
        ? await batchCallingService.getBatchJobResults(jobId, true).catch(() => null)
        : null;
      const callsResult = { calls: [] as any[] };
      const failedCallsResult = { calls: [] as any[] };
      const busyCallsResult = { calls: [] as any[] };
      const noAnswerCallsResult = { calls: [] as any[] };
      const voicemailCallsResult = { calls: [] as any[] };

      const extractArray = (input: any): any[] => {
        if (Array.isArray(input)) return input;
        if (!input || typeof input !== 'object') return [];
        const candidates = [
          input.recipients,
          input.results,
          input.calls,
          input.items,
          input.data?.results,
          input.data?.calls,
          input.data?.items
        ];
        for (const c of candidates) {
          if (Array.isArray(c)) return c;
        }
        return [];
      };

      /**
       * Normal call endings that sometimes appear in failure_* / reason fields (not a real error):
       * - agent `end_call` tool, callee hangup ("remote party"), etc.
       */
      const isBenignAgentTerminationReason = (text: string): boolean => {
        const s = (text || '').toLowerCase();
        if (!s.trim()) return false;
        if (/\bend_call\b/.test(s)) return true;
        if (s.includes('end call tool')) return true;
        if (s.includes('tool was called') && /end/.test(s)) return true;
        if (s.includes('remote party') || s.includes('ended by remote')) return true;
        if (s.includes('customer ended') || s.includes('user hung up') || s.includes('hangup by user')) return true;
        return false;
      };

      const friendlyBenignEndReason = (reasonA: string, reasonB: string): string => {
        const low = `${reasonA} ${reasonB}`.toLowerCase();
        if (low.includes('remote party') || low.includes('ended by remote')) return 'Customer ended the call';
        if (/\bend_call\b/.test(low) || low.includes('end call tool') || (low.includes('tool was called') && /end/.test(low)))
          return 'Call ended by agent';
        return 'Call completed';
      };

      /**
       * Detect dial outcome (busy / voicemail / no_answer) from a status string OR free-text reason.
       * Returns one of: 'busy' | 'voicemail' | 'no_answer' | '' (empty = no specific dial outcome detected).
       */
      const detectDialOutcome = (rawStatus: string, reason: string): '' | 'busy' | 'voicemail' | 'no_answer' => {
        const status = (rawStatus || '').toLowerCase().trim();
        const statusFlat = status.replace(/_/g, ' ').replace(/-/g, ' ');
        const r = (reason || '').toLowerCase();

        const busy =
          statusFlat.includes('busy') ||
          status === 'rejected_busy' ||
          r.includes('busy here') ||
          r.includes('line busy') ||
          r.includes('user busy') ||
          r.includes('subscriber busy') ||
          r.includes('sip status: 486') ||
          r.includes('sip 486') ||
          r.includes('486 busy') ||
          r.includes('sip 603') ||
          r.includes('sip status: 603');
        if (busy) return 'busy';

        const vm =
          statusFlat.includes('voicemail') ||
          statusFlat.includes('voice mail') ||
          status.includes('voice_mail') ||
          r.includes('voicemail') ||
          r.includes('voice mail') ||
          r.includes('answered by voicemail') ||
          r.includes('machine detection') ||
          r.includes('amd');
        if (vm) return 'voicemail';

        const na =
          statusFlat.includes('no answer') ||
          statusFlat.includes('noanswer') ||
          status === 'unanswered' ||
          statusFlat.includes('not answered') ||
          statusFlat.includes('ring timeout') ||
          statusFlat.includes('ringing timeout') ||
          statusFlat.includes('no pickup') ||
          status.includes('no_answer') ||
          status.includes('no-answer') ||
          r.includes('no answer') ||
          r.includes('did not answer') ||
          r.includes('didnt answer') ||
          r.includes('not answered') ||
          r.includes('unanswered') ||
          r.includes('no pickup') ||
          r.includes('not picked') ||
          r.includes('ring timeout') ||
          r.includes('ringing timeout') ||
          r.includes('call timeout');
        if (na) return 'no_answer';

        return '';
      };

      /**
       * Backward-compatible wrapper kept for any external callers — the new outcome
       * resolver below (`resolveCallOutcome`) is what the controller actually uses.
       */
      const normalizeCallStatus = (rawStatus: string, reason: string): string => {
        const dial = detectDialOutcome(rawStatus, reason);
        if (dial) return dial;
        const status = (rawStatus || '').toLowerCase().trim();
        if (
          status === 'done' ||
          status === 'completed' ||
          status === 'complete' ||
          status === 'finished' ||
          status === 'success' ||
          status === 'successful'
        ) {
          return 'completed';
        }
        return status || 'pending';
      };

      const pickBestReason = (...rows: any[]): string => {
        const normalizeReasonValue = (value: any): string => {
          if (value === null || value === undefined) return '';
          if (typeof value === 'string') return value.trim();
          if (typeof value === 'number' || typeof value === 'boolean') return String(value);
          if (Array.isArray(value)) {
            for (const item of value) {
              const normalized = normalizeReasonValue(item);
              if (normalized) return normalized;
            }
            return '';
          }
          if (typeof value === 'object') {
            const preferredKeys = [
              'message',
              'detail',
              'reason',
              'error',
              'description',
              'status_reason',
              'termination_reason',
              'hangup_cause'
            ];
            for (const key of preferredKeys) {
              const nested = normalizeReasonValue((value as any)?.[key]);
              if (nested) return nested;
            }
            try {
              const serialized = JSON.stringify(value);
              return serialized === '{}' ? '' : serialized;
            } catch {
              return '';
            }
          }
          return '';
        };

        const keys = [
          'failure_reason',
          'error_reason',
          'error_message',
          'error',
          'reason',
          'disposition',
          'termination_reason',
          'sip_response_reason',
          'sip_status_reason',
          'status_reason',
          'hangup_cause',
          'call_end_reason'
        ];
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          for (const key of keys) {
            const value = row?.[key];
            const normalized = normalizeReasonValue(value);
            if (normalized) return normalized;
          }
          const nestedCandidates = [
            row?.metadata,
            row?.analysis,
            row?.call,
            row?.result,
            row?.recipient,
            row?.phone_call
          ];
          for (const nested of nestedCandidates) {
            if (!nested || typeof nested !== 'object') continue;
            for (const key of keys) {
              const value = nested?.[key];
              const normalized = normalizeReasonValue(value);
              if (normalized) return normalized;
            }
          }
        }
        return '';
      };

      const defaultReasonFromStatus = (status: string, rawStatus: string): string => {
        const normalized = (status || '').toLowerCase();
        const raw = (rawStatus || '').toLowerCase();
        if (normalized === 'busy') return 'Line busy (SIP 486 Busy Here)';
        if (normalized === 'voicemail') return 'Call reached voicemail';
        if (normalized === 'no_answer') return 'No answer from recipient';
        if (normalized === 'failed') {
          if (raw.includes('busy')) return 'Line busy';
          if (raw.includes('voice')) return 'Call reached voicemail';
          if (raw.includes('no_answer') || raw.includes('no answer')) return 'No answer from recipient';
          if (raw.includes('reject')) return 'Call rejected by recipient';
          if (raw.includes('decline')) return 'Call declined by recipient';
          return 'Call failed before completion';
        }
        return '';
      };

      const normalizePhoneForCompare = (value: any): string => {
        if (!value) return '';
        const str = String(value).trim();
        const digits = str.replace(/\D/g, '');
        if (!digits) return '';
        // Compare by digits only to avoid +, spaces, and formatting mismatches.
        return digits;
      };

      const recipientRows = extractArray(statusResult?.recipients || statusResult);

      const batchStatusLowerEarly = String(statusResult?.status || '').toLowerCase();
      const scheduledEarly = Number(statusResult?.total_calls_scheduled ?? 0);
      const finishedEarly = Number(statusResult?.total_calls_finished ?? 0);
      const batchStillRunningEarly =
        batchStatusLowerEarly === 'pending' ||
        batchStatusLowerEarly === 'in_progress' ||
        batchStatusLowerEarly === 'running' ||
        batchStatusLowerEarly === 'queued' ||
        batchStatusLowerEarly === 'processing';
      const batchExplicitlyCompleteEarly =
        batchStatusLowerEarly === 'completed' ||
        batchStatusLowerEarly === 'done' ||
        batchStatusLowerEarly === 'finished';
      const batchNotDoneEarly =
        !batchExplicitlyCompleteEarly &&
        (batchStillRunningEarly ||
          (statusResult != null &&
            scheduledEarly > 0 &&
            Number.isFinite(finishedEarly) &&
            finishedEarly < scheduledEarly));

      const dedupeRows = (rows: any[]): any[] => {
        const seen = new Set<string>();
        const out: any[] = [];
        for (const row of rows) {
          const key = String(
            row?.id ||
            row?.call_id ||
            row?.conversation_id ||
            row?.conversationId ||
            `${row?.phone_number || row?.phone || ''}_${row?.status || row?.call_status || ''}_${row?.updated_at_unix || row?.created_at_unix || ''}`
          );
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(row);
        }
        return out;
      };
      const callRows = dedupeRows([
        ...extractArray(callsResult),
        ...extractArray(failedCallsResult),
        ...extractArray(busyCallsResult),
        ...extractArray(noAnswerCallsResult),
        ...extractArray(voicemailCallsResult)
      ]);
      const resultRows = extractArray(resultsResult);

      const recipientByPhone = new Map<string, any>();
      for (const r of recipientRows) {
        const key = normalizePhoneForCompare(r?.phone_number || r?.phone);
        if (key && !recipientByPhone.has(key)) recipientByPhone.set(key, r);
      }
      const resultByPhone = new Map<string, any>();
      for (const r of resultRows) {
        const key = normalizePhoneForCompare(r?.phone_number || r?.phone);
        if (key && !resultByPhone.has(key)) resultByPhone.set(key, r);
      }

      // Live conversation fetches are expensive — only for in-flight recipients while batch is running.
      const terminalRecipientStatuses = new Set([
        'completed',
        'complete',
        'done',
        'finished',
        'success',
        'successful',
        'failed',
        'busy',
        'no_answer',
        'no-answer',
        'voicemail',
        'cancelled',
        'canceled'
      ]);
      const liveConversationIds = batchNotDoneEarly
        ? Array.from(
            new Set(
              recipientRows
                .filter((r: any) => {
                  const s = String(r?.status || '').toLowerCase().trim();
                  return r?.conversation_id && !terminalRecipientStatuses.has(s);
                })
                .map((r: any) => String(r.conversation_id))
            )
          ).slice(0, 25)
        : [];

      const liveConversationMap = new Map<string, any>();
      if (liveConversationIds.length > 0) {
        const liveDetails = await Promise.allSettled(
          liveConversationIds.map(async (conversationId) => ({
            conversationId,
            detail: await batchCallingService.getConversationDetail(conversationId)
          }))
        );

        for (const item of liveDetails) {
          if (item.status === 'fulfilled' && item.value?.detail) {
            liveConversationMap.set(item.value.conversationId, item.value.detail);
          }
        }
      }

      const byConversationId = new Map<string, any>();
      const byPhone = new Map<string, any>();
      const byRecipientId = new Map<string, any>();

      const addIndex = (row: any) => {
        const conversationId = row?.conversation_id || row?.conversationId || row?.call_sid || row?.id;
        const phone = row?.phone_number || row?.phone || row?.to_number || row?.customer_phone_number;
        const recipientId = row?.recipient_id || row?.id;
        if (conversationId && !byConversationId.has(conversationId)) byConversationId.set(conversationId, row);
        const normalizedPhone = normalizePhoneForCompare(phone);
        if (normalizedPhone && !byPhone.has(normalizedPhone)) byPhone.set(normalizedPhone, row);
        if (recipientId && !byRecipientId.has(String(recipientId))) byRecipientId.set(String(recipientId), row);
      };

      recipientRows.forEach(addIndex);
      callRows.forEach(addIndex);
      resultRows.forEach(addIndex);

      const dbConversations = await Conversation.find({
        organizationId: orgObjectId,
        channel: 'phone',
        'metadata.batch_call_id': jobId
      })
        .select('_id customerId status channel metadata createdAt updatedAt')
        .lean();

      const conversationIds = dbConversations.map((c: any) => c._id);
      const [messageCounts, customers] = await Promise.all([
        Message.aggregate([
          { $match: { conversationId: { $in: conversationIds }, type: 'message' } },
          { $group: { _id: '$conversationId', count: { $sum: 1 } } }
        ]),
        Customer.find({
          _id: { $in: dbConversations.map((c: any) => c.customerId).filter(Boolean) }
        }).lean()
      ]);

      const messageCountMap = new Map<string, number>(
        messageCounts.map((m: any) => [String(m._id), m.count || 0])
      );
      const customerMap = new Map<string, any>(
        customers.map((c: any) => [String(c._id), c])
      );
      const dbByPhone = new Map<string, any>();
      const dbByConversationId = new Map<string, any>();
      for (const c of dbConversations) {
        const phone = c?.metadata?.phone_number;
        const convId = c?.metadata?.conversation_id;
        if (phone && !dbByPhone.has(phone)) dbByPhone.set(phone, c);
        if (convId && !dbByConversationId.has(convId)) dbByConversationId.set(convId, c);
      }

      const phoneOrdered: string[] = [];
      const seenPhoneKeys = new Set<string>();
      for (const r of recipientRows) {
        const raw = r?.phone_number || r?.phone;
        if (!raw) continue;
        const key = normalizePhoneForCompare(raw);
        if (!key || seenPhoneKeys.has(key)) continue;
        seenPhoneKeys.add(key);
        phoneOrdered.push(String(raw));
      }
      for (const c of dbConversations) {
        const raw = c?.metadata?.phone_number;
        if (!raw) continue;
        const key = normalizePhoneForCompare(raw);
        if (!key || seenPhoneKeys.has(key)) continue;
        seenPhoneKeys.add(key);
        phoneOrdered.push(String(raw));
      }

      const allConversationIds = new Set<string>();
      recipientRows.forEach((r: any) => r?.conversation_id && allConversationIds.add(r.conversation_id));
      callRows.forEach((r: any) => (r?.conversation_id || r?.conversationId) && allConversationIds.add(r.conversation_id || r.conversationId));
      resultRows.forEach((r: any) => (r?.conversation_id || r?.conversationId || r?.id) && allConversationIds.add(r.conversation_id || r.conversationId || r.id));
      dbConversations.forEach((c: any) => c?.metadata?.conversation_id && allConversationIds.add(c.metadata.conversation_id));

      const scheduledBatch = Number(statusResult?.total_calls_scheduled ?? 0);
      const finishedBatch = Number(statusResult?.total_calls_finished ?? 0);
      const batchStatusLower = String(statusResult?.status || '').toLowerCase();
      const batchJobStillRunning =
        batchStatusLower === 'pending' ||
        batchStatusLower === 'in_progress' ||
        batchStatusLower === 'running' ||
        batchStatusLower === 'queued' ||
        batchStatusLower === 'processing';
      /** ElevenLabs explicitly says the batch job is finished. Trust this even if the
       *  finished/scheduled counts haven't caught up yet (they often lag behind the
       *  status flip by several seconds). */
      const batchExplicitlyComplete =
        batchStatusLower === 'completed' ||
        batchStatusLower === 'done' ||
        batchStatusLower === 'finished';
      const batchHasOutstandingCalls =
        !batchExplicitlyComplete &&
        statusResult != null &&
        scheduledBatch > 0 &&
        Number.isFinite(finishedBatch) &&
        finishedBatch < scheduledBatch;
      /** Batch not fully settled yet — don't show terminal failed tags mid-dial. */
      const batchNotDoneYet = batchJobStillRunning || batchHasOutstandingCalls;
      /** Batch fully settled — every recipient must end up in a terminal tag (no "in_progress"). */
      const batchFullyDone =
        !batchNotDoneYet &&
        (batchExplicitlyComplete ||
          (statusResult != null && scheduledBatch > 0 && finishedBatch >= scheduledBatch));

      /** Mid-dial states only — NOT "dispatched" (often stays set after the call ends). */
      const recipientLooksInFlight = (raw: string): boolean => {
        const s = String(raw || '')
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
      };

      /**
       * Single source of truth for a contact's final tag.
       * Priority ladder (highest → lowest):
       *   1. Explicit dial outcome (busy / voicemail / no_answer) detected from status or reason text.
       *   2. Any evidence the call actually ran (duration, transcript, messages, terminal live status) → completed.
       *   3. Raw status that is itself a "completed/done" terminal → completed.
       *   4. Mid-dial state while the batch is still running → in_progress.
       *   5. Batch fully done with a conversation_id but no terminal hint → completed (avoid stuck "in progress").
       *   6. Explicit failure (rawStatus === 'failed' with concrete reason, not benign) → failed.
       *   7. Batch fully done with no evidence of any call → no_answer (call never connected).
       *   8. Otherwise → 'pending' / raw status passthrough.
       *
       * Never returns 'failed' just because data is missing — only when there is concrete failure evidence.
       */
      const resolveCallOutcome = (args: {
        rawStatus: string;
        reasonText: string;
        endReasonText: string;
        durationSeconds: number;
        hasTranscript: boolean;
        hasMessages: boolean;
        hasConversationId: boolean;
        liveStatus: string;
      }): { status: string; failed_reason: string; end_reason: string } => {
        const raw = String(args.rawStatus || '').toLowerCase().trim();
        const reasonAll = `${args.reasonText || ''} ${args.endReasonText || ''}`.trim();
        const liveLow = String(args.liveStatus || '').toLowerCase();
        // Strong evidence the call actually connected:
        //   • duration > 0     (Twilio confirmed audio seconds)
        //   • transcript text  (the agent + customer exchanged words)
        //   • DB messages      (conversation was persisted)
        // We do NOT count `liveConversation.status === 'completed'` as evidence —
        // ElevenLabs marks the conversation as completed for unanswered calls too
        // (because the dispatch completed, not because the call was answered).
        const hasProgress =
          args.durationSeconds >= 1 || args.hasTranscript || args.hasMessages;
        const benign =
          isBenignAgentTerminationReason(args.reasonText) ||
          isBenignAgentTerminationReason(args.endReasonText);
        const friendlyEnd = benign
          ? friendlyBenignEndReason(args.reasonText || '', args.endReasonText || '')
          : (args.endReasonText || args.reasonText || '');

        // 1) Explicit dial outcome wins immediately
        const dial = detectDialOutcome(args.rawStatus, reasonAll);
        if (dial === 'busy') {
          return {
            status: 'busy',
            failed_reason: 'Line busy',
            end_reason: 'Recipient was on another call'
          };
        }
        if (dial === 'voicemail') {
          return {
            status: 'voicemail',
            failed_reason: 'Reached voicemail',
            end_reason: 'Call sent to voicemail'
          };
        }
        if (dial === 'no_answer') {
          return {
            status: 'no_answer',
            failed_reason: 'No answer',
            end_reason: 'Recipient did not answer'
          };
        }

        // 2) Any evidence the call ran → completed (clear any noisy failure copy)
        if (hasProgress) {
          return {
            status: 'completed',
            failed_reason: '',
            end_reason: friendlyEnd || 'Call completed'
          };
        }

        // 3) Raw status itself is terminal "done" → completed
        if (
          raw === 'completed' ||
          raw === 'complete' ||
          raw === 'done' ||
          raw === 'finished' ||
          raw === 'success' ||
          raw === 'successful'
        ) {
          return {
            status: 'completed',
            failed_reason: '',
            end_reason: friendlyEnd || 'Call completed'
          };
        }

        // 4) Mid-dial while batch is still running → in_progress
        const inFlight = recipientLooksInFlight(args.rawStatus) || raw === 'dispatched';
        if (inFlight && batchNotDoneYet) {
          return { status: 'in_progress', failed_reason: '', end_reason: '' };
        }

        // 5) Explicit failure (NOT benign agent end-call) — must come BEFORE the
        //    "batch done → completed" fallback so a real failure still wins.
        const explicitFailRaw =
          raw === 'failed' ||
          raw === 'error' ||
          raw === 'rejected' ||
          raw === 'declined' ||
          raw.includes('reject') ||
          raw.includes('decline');
        const explicitFailReason =
          !benign &&
          /\b(failed|error|rejected|declined|invalid number|cannot connect|carrier rejected)\b/.test(
            reasonAll.toLowerCase()
          );
        if ((explicitFailRaw || explicitFailReason) && !benign) {
          const failedCopy = String(args.reasonText || args.endReasonText || '').trim();
          return {
            status: 'failed',
            failed_reason: failedCopy || 'Call failed',
            end_reason: friendlyEnd || 'Call failed'
          };
        }

        // 6) Batch is fully done — recipient MUST end up in a terminal tag.
        //    Discriminator: REAL call progress (duration / transcript / messages).
        //    A `conversation_id` alone is NOT enough — ElevenLabs creates one on
        //    dispatch even for unanswered calls.
        if (batchFullyDone) {
          if (hasProgress) {
            return {
              status: 'completed',
              failed_reason: '',
              end_reason: friendlyEnd || 'Call completed'
            };
          }
          // No real call activity → call didn't connect.
          // Show a neutral "no answer" tag; the next sync cycle will upgrade
          // this to 'busy' / 'voicemail' / 'failed' once ElevenLabs flips the
          // recipient row to a more specific reason.
          return {
            status: 'no_answer',
            failed_reason: 'No answer',
            end_reason: 'Recipient did not answer'
          };
        }

        // 7) Otherwise — still pending
        return { status: raw || 'pending', failed_reason: '', end_reason: '' };
      };

      const contacts = phoneOrdered.map((phone) => {
        const normalizedPhone = normalizePhoneForCompare(phone);
        const statusRow = recipientByPhone.get(normalizedPhone) || byPhone.get(normalizedPhone) || {};
        const statusRecipientId = statusRow?.id ? String(statusRow.id) : '';
        const callRow =
          (statusRecipientId ? byRecipientId.get(statusRecipientId) : null) || {};
        const resultRow =
          (includeTranscript ? resultByPhone.get(normalizedPhone) : null) ||
          (statusRecipientId ? byRecipientId.get(statusRecipientId) : null) ||
          {};
        const conversationId = statusRow?.conversation_id || callRow?.conversation_id || callRow?.conversationId || resultRow?.conversation_id || resultRow?.conversationId || resultRow?.id;
        const liveConversation = conversationId ? liveConversationMap.get(String(conversationId)) : null;
        const dbConversation = dbByPhone.get(phone) || (conversationId ? dbByConversationId.get(conversationId) : null);
        const customer = dbConversation?.customerId ? customerMap.get(String(dbConversation.customerId)) : null;
        const transcript = includeTranscript
          ? resultRow?.transcript ||
            callRow?.transcript ||
            dbConversation?.transcript ||
            null
          : undefined;

        const dynamicVars = statusRow?.conversation_initiation_client_data?.dynamic_variables || {};
        const displayName = statusRow?.name || callRow?.name || resultRow?.name || dynamicVars.name || dynamicVars.customer_name || customer?.name || 'Unknown';
        const email = statusRow?.email || callRow?.email || resultRow?.email || dynamicVars.email || dynamicVars.customer_email || customer?.email || '';
        // Prefer batch recipient / call row status over conversation GET — the latter is often
        // "completed" for every terminal dial outcome (including busy / no-answer / voicemail).
        const rawStatus =
          statusRow?.status ||
          callRow?.status ||
          callRow?.call_status ||
          liveConversation?.status ||
          resultRow?.status ||
          (dbConversation ? 'completed' : 'pending');
        const durationSeconds =
          liveConversation?.metadata?.call_duration_secs ||
          liveConversation?.call_duration_secs ||
          resultRow?.metadata?.call_duration_secs ||
          resultRow?.call_duration_secs ||
          callRow?.duration ||
          dbConversation?.metadata?.duration_seconds ||
          0;
        const reasonText = pickBestReason(
          liveConversation,
          liveConversation?.metadata,
          liveConversation?.analysis,
          resultRow,
          resultRow?.metadata,
          resultRow?.analysis,
          callRow,
          callRow?.metadata,
          statusRow,
          statusRow?.metadata,
          dbConversation?.metadata
        );
        const endReason =
          liveConversation?.metadata?.termination_reason ||
          liveConversation?.end_reason ||
          resultRow?.metadata?.termination_reason ||
          resultRow?.end_reason ||
          dbConversation?.metadata?.end_reason ||
          reasonText ||
          '';
        const summary =
          resultRow?.analysis?.summary ||
          resultRow?.summary ||
          resultRow?.call_summary ||
          '';

        const msgCountForContact = dbConversation
          ? messageCountMap.get(String(dbConversation._id)) || 0
          : 0;
        const hasTranscriptContent = (() => {
          const t = transcript;
          if (!t) return false;
          if (typeof t === 'string') return t.trim().length > 0;
          if (Array.isArray(t)) return t.length > 0;
          if (typeof t === 'object') {
            const arr = (t as any).messages || (t as any).items;
            return Array.isArray(arr) && arr.length > 0;
          }
          return false;
        })();

        const outcome = resolveCallOutcome({
          rawStatus,
          reasonText,
          endReasonText: String(endReason || ''),
          durationSeconds,
          hasTranscript: hasTranscriptContent,
          hasMessages: msgCountForContact > 0,
          hasConversationId: !!conversationId,
          liveStatus: String(liveConversation?.status || '')
        });

        return {
          phone_number: phone,
          name: displayName,
          email,
          status: outcome.status,
          raw_status: rawStatus,
          conversation_id: conversationId || dbConversation?.metadata?.conversation_id || null,
          recipient_id: statusRow?.id || statusRow?.recipient_id || null,
          duration_seconds: durationSeconds,
          end_reason: outcome.end_reason,
          failed_reason: outcome.failed_reason,
          summary,
          transcript,
          metadata: {
            sip_call_sid: resultRow?.metadata?.call_sid || callRow?.call_sid || null,
            recording_url: resultRow?.recording_url || resultRow?.audio_url || dbConversation?.metadata?.recording_url || dbConversation?.metadata?.audio_url || null,
            raw_reason: reasonText || endReason || null,
            created_at_unix: statusRow?.created_at_unix || callRow?.created_at_unix || null,
            updated_at_unix: statusRow?.updated_at_unix || callRow?.updated_at_unix || null
          },
          conversation: dbConversation ? {
            id: dbConversation._id,
            status: dbConversation.status,
            channel: dbConversation.channel,
            createdAt: dbConversation.createdAt,
            updatedAt: dbConversation.updatedAt,
            message_count: messageCountMap.get(String(dbConversation._id)) || 0
          } : null
        };
      });

      const contactsWithoutPhone = [...allConversationIds]
        .filter((conversationId) => !contacts.some((c) => c.conversation_id === conversationId))
        .map((conversationId) => {
          const row = byConversationId.get(conversationId) || {};
          const liveConversation = liveConversationMap.get(String(conversationId)) || null;
          const dbConversation = dbByConversationId.get(conversationId) || null;
          const customer = dbConversation?.customerId ? customerMap.get(String(dbConversation.customerId)) : null;
          const rawStatus = row?.status || row?.call_status || liveConversation?.status || 'completed';
          const reasonText = pickBestReason(
            liveConversation,
            liveConversation?.metadata,
            liveConversation?.analysis,
            row,
            row?.metadata,
            row?.analysis,
            dbConversation?.metadata
          );
          const endReason =
            liveConversation?.metadata?.termination_reason ||
            row?.metadata?.termination_reason ||
            row?.end_reason ||
            dbConversation?.metadata?.end_reason ||
            reasonText ||
            '';
          const durationSecondsRow =
            row?.metadata?.call_duration_secs || row?.call_duration_secs || dbConversation?.metadata?.duration_seconds || 0;
          const transcriptRow = includeTranscript
            ? row?.transcript || dbConversation?.transcript || null
            : undefined;
          const msgRow = dbConversation ? messageCountMap.get(String(dbConversation._id)) || 0 : 0;
          const hasTranscriptRow = (() => {
            const t = transcriptRow;
            if (!t) return false;
            if (typeof t === 'string') return t.trim().length > 0;
            if (Array.isArray(t)) return t.length > 0;
            if (typeof t === 'object') {
              const arr = (t as any).messages || (t as any).items;
              return Array.isArray(arr) && arr.length > 0;
            }
            return false;
          })();
          const outcomeRow = resolveCallOutcome({
            rawStatus,
            reasonText,
            endReasonText: String(endReason || ''),
            durationSeconds: durationSecondsRow,
            hasTranscript: hasTranscriptRow,
            hasMessages: msgRow > 0,
            hasConversationId: !!conversationId,
            liveStatus: String(liveConversation?.status || '')
          });
          return {
            phone_number: row?.phone_number || dbConversation?.metadata?.phone_number || '',
            name: row?.name || customer?.name || 'Unknown',
            email: row?.email || customer?.email || '',
            status: outcomeRow.status,
            raw_status: rawStatus,
            conversation_id: conversationId,
            recipient_id: row?.id || null,
            duration_seconds: durationSecondsRow,
            end_reason: outcomeRow.end_reason,
            failed_reason: outcomeRow.failed_reason,
            summary: row?.analysis?.summary || row?.summary || '',
            transcript: transcriptRow,
            metadata: {
              sip_call_sid: row?.metadata?.call_sid || row?.call_sid || null,
              recording_url: row?.recording_url || row?.audio_url || dbConversation?.metadata?.recording_url || dbConversation?.metadata?.audio_url || null,
              raw_reason: reasonText || endReason || null,
              created_at_unix: row?.created_at_unix || null,
              updated_at_unix: row?.updated_at_unix || null
            },
            conversation: dbConversation ? {
              id: dbConversation._id,
              status: dbConversation.status,
              channel: dbConversation.channel,
              createdAt: dbConversation.createdAt,
              updatedAt: dbConversation.updatedAt,
              message_count: messageCountMap.get(String(dbConversation._id)) || 0
            } : null
          };
        });

      const mergedContacts = [...contacts, ...contactsWithoutPhone]
        .sort((a, b) => {
          const aDone = a.status === 'completed' ? 1 : 0;
          const bDone = b.status === 'completed' ? 1 : 0;
          if (aDone !== bDone) return aDone - bDone;
          return (a.name || '').localeCompare(b.name || '');
        });

      const totalContacts = mergedContacts.length;
      const totalPages = Math.max(1, Math.ceil(totalContacts / pageSize));
      const safePage = Math.min(page, totalPages);
      const startIndex = (safePage - 1) * pageSize;
      const pagedContacts = mergedContacts.slice(startIndex, startIndex + pageSize);

      res.status(200).json({
        success: true,
        data: {
          batch: {
            ...batchCall,
            live_status: statusResult?.status || batchCall.status,
            live_total_calls_dispatched: statusResult?.total_calls_dispatched ?? batchCall.total_calls_dispatched,
            live_total_calls_scheduled: statusResult?.total_calls_scheduled ?? batchCall.total_calls_scheduled,
            live_total_calls_finished: statusResult?.total_calls_finished ?? batchCall.total_calls_finished
          },
          contacts: pagedContacts,
          pagination: {
            page: safePage,
            page_size: pageSize,
            total_contacts: totalContacts,
            total_pages: totalPages
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }
}

export const batchCallingController = new BatchCallingController();
