import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { batchCallingService } from '../services/batchCalling.service';
import mongoose from 'mongoose';

const MAX_RECIPIENTS = 10000;
const ELEVENLABS_BATCH_SIZE = 500;

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
        sender_email
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
      const phoneNumber = await PhoneNumber.findOne({
        phone_number_id,
        $or: [
          { organizationId },
          { userId }
        ]
      }).lean();

      if (!phoneNumber) {
        return res.status(404).json({
          success: false,
          error: "Phone number not found",
          detail: `Phone number with ID ${phone_number_id} not found`
        });
      }

      // Get ElevenLabs phone_number_id (required for batch calling)
      let elevenlabsPhoneNumberId = phoneNumber.elevenlabs_phone_number_id;

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

      if (shouldUseQueue) {
        console.log('[Batch Calling Controller] 🚀 Queue available - enqueueing batch call job for background processing');
        console.log('[Batch Calling Controller] Recipients count:', recipients.length);

        const queuedJobs: string[] = [];

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
            userId,
            organizationId
          });

          if (job) {
            queuedJobs.push(job.id.toString());
          } else {
            console.warn('[Batch Calling Controller] ⚠️  Failed to enqueue one chunk, falling back to synchronous processing');
            queuedJobs.length = 0;
            break;
          }
        }

        if (queuedJobs.length === totalChunks) {
          console.log('[Batch Calling Controller] ✅ All batch call chunks enqueued:', queuedJobs.length);
          return res.status(202).json({
            success: true,
            message: isChunkedSubmission
              ? `Batch call split into ${totalChunks} jobs and enqueued`
              : 'Batch call job enqueued for processing',
            job_ids: queuedJobs,
            total_jobs: queuedJobs.length,
            recipients_count: recipients.length,
            chunk_size: ELEVENLABS_BATCH_SIZE,
            status: 'queued'
          });
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
              conversations_synced: false
            });

            try {
              const { enqueueBatchPoll } = await import('../queues/batchCallSync.queue');
              const enqueued = await enqueueBatchPoll(chunk.result.id, organizationIdStr);
              if (enqueued) {
                console.log('[Batch Calling Controller] 🚀 Background polling started for batch:', chunk.result.id);
              } else {
                console.log('[Batch Calling Controller] ℹ️  Queue not available - batch will rely on BatchCallMonitor fallback');
              }
            } catch (queueError: any) {
              console.warn('[Batch Calling Controller] ⚠️  Failed to enqueue batch poll:', queueError.message);
            }
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
      const organizationId = req.user?.organizationId || req.user?._id;

      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const batchCall = await BatchCall.findOne({
        batch_call_id: jobId,
        organizationId: organizationId instanceof mongoose.Types.ObjectId
          ? organizationId
          : new mongoose.Types.ObjectId(organizationId.toString())
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

      // If batch call is completed and conversations haven't been synced, fetch results and create conversations
      if (result.status === 'completed' && updatedBatchCall && !updatedBatchCall.conversations_synced) {
        console.log('[Batch Calling Controller] 🚀 Batch call completed! Fetching results and creating conversations...');

        // Process results asynchronously (don't block the response)
        batchCallingService.syncBatchCallConversations(jobId, organizationId.toString()).catch((error: any) => {
          console.error('[Batch Calling Controller] ❌ Failed to sync batch call conversations:', error.message);
          // Don't throw - we don't want to fail the status request
        });
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
      const organizationId = req.user?.organizationId || req.user?._id;

      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const batchCall = await BatchCall.findOne({
        batch_call_id: jobId,
        organizationId: organizationId instanceof mongoose.Types.ObjectId
          ? organizationId
          : new mongoose.Types.ObjectId(organizationId.toString())
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
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const batchCall = await BatchCall.findOne({
        batch_call_id: jobId,
        organizationId: organizationId instanceof mongoose.Types.ObjectId
          ? organizationId
          : new mongoose.Types.ObjectId(organizationId.toString())
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
   * Get all batch calls for the user's organization
   * GET /api/v1/batch-calling
   * Syncs status from Python API for each batch call
   */
  async getBatchCalls(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
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
        organizationId: organizationId instanceof mongoose.Types.ObjectId
          ? organizationId
          : new mongoose.Types.ObjectId(organizationId.toString())
      };
      if (!includeCancelled) {
        query.status = { $ne: 'cancelled' };
      }

      const batchCalls = await BatchCall.find(query)
        .sort({ createdAt: -1 })
        .lean();

      // Sync status from Python API for each batch call
      const syncedBatchCalls = await Promise.all(
        batchCalls.map(async (batchCall) => {
          try {
            // Fetch latest status from Python API
            const latestStatus = await batchCallingService.getBatchJobStatus(batchCall.batch_call_id);

            // Update database with latest status if it changed
            const statusChanged =
              batchCall.status !== latestStatus.status ||
              batchCall.total_calls_dispatched !== latestStatus.total_calls_dispatched ||
              batchCall.total_calls_scheduled !== latestStatus.total_calls_scheduled ||
              batchCall.total_calls_finished !== latestStatus.total_calls_finished;

            if (statusChanged) {
              await BatchCall.updateOne(
                { batch_call_id: batchCall.batch_call_id },
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

              // Return updated data
              return {
                ...batchCall,
                status: latestStatus.status,
                total_calls_dispatched: latestStatus.total_calls_dispatched,
                total_calls_scheduled: latestStatus.total_calls_scheduled,
                total_calls_finished: latestStatus.total_calls_finished,
                last_updated_at_unix: latestStatus.last_updated_at_unix
              };
            }

            return batchCall;
          } catch (error: any) {
            // If Python API call fails, return the database record as-is
            console.warn(`[Batch Calling Controller] ⚠️ Failed to sync status for batch call ${batchCall.batch_call_id}:`, error.message);
            return batchCall;
          }
        })
      );

      res.status(200).json({
        success: true,
        data: syncedBatchCalls
      });
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
      const organizationId = req.user?.organizationId || req.user?._id;

      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const batchCall = await BatchCall.findOne({
        batch_call_id: jobId,
        organizationId: organizationId instanceof mongoose.Types.ObjectId
          ? organizationId
          : new mongoose.Types.ObjectId(organizationId.toString())
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
      const organizationId = req.user?.organizationId || req.user?._id;

      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const batchCall = await BatchCall.findOne({
        batch_call_id: jobId,
        organizationId: organizationId instanceof mongoose.Types.ObjectId
          ? organizationId
          : new mongoose.Types.ObjectId(organizationId.toString())
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
      const organizationId = req.user?.organizationId || req.user?._id;

      if (!organizationId) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          detail: "Organization ID or User ID not found"
        });
      }

      const batchCall = await BatchCall.findOne({
        batch_call_id: jobId,
        organizationId: organizationId instanceof mongoose.Types.ObjectId
          ? organizationId
          : new mongoose.Types.ObjectId(organizationId.toString())
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
   * Get complete per-contact batch details
   * GET /api/v1/batch-calling/:jobId/details
   */
  async getBatchJobDetails(req: AuthRequest, res: Response, next: NextFunction) {
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

      const organizationId = req.user?.organizationId || req.user?._id;
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

      const orgObjectId = organizationId instanceof mongoose.Types.ObjectId
        ? organizationId
        : new mongoose.Types.ObjectId(organizationId.toString());

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

      const [
        statusResult,
        callsResult,
        resultsResult,
        failedCallsResult,
        busyCallsResult,
        noAnswerCallsResult,
        voicemailCallsResult
      ] = await Promise.all([
        batchCallingService.getBatchJobStatus(jobId).catch(() => null),
        batchCallingService.getBatchJobCalls(jobId, { page_size: 100 }).catch(() => ({ calls: [] })),
        batchCallingService.getBatchJobResults(jobId, true).catch(() => null),
        batchCallingService.getBatchJobCalls(jobId, { status: 'failed', page_size: 100 }).catch(() => ({ calls: [] })),
        batchCallingService.getBatchJobCalls(jobId, { status: 'busy', page_size: 100 }).catch(() => ({ calls: [] })),
        batchCallingService.getBatchJobCalls(jobId, { status: 'no_answer', page_size: 100 }).catch(() => ({ calls: [] })),
        batchCallingService.getBatchJobCalls(jobId, { status: 'voicemail', page_size: 100 }).catch(() => ({ calls: [] }))
      ]);

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

      const normalizeCallStatus = (rawStatus: string, reason: string): string => {
        const status = (rawStatus || '').toLowerCase().trim();
        const failureReason = (reason || '').toLowerCase();

        if (status.includes('busy') || status === 'rejected_busy') return 'busy';
        if (status.includes('voicemail') || status.includes('voice_mail')) return 'voicemail';
        if (status.includes('no_answer') || status.includes('no-answer')) return 'no_answer';
        if (status.includes('reject') || status.includes('decline')) return 'failed';

        // SIP 486 / busy line should be surfaced clearly in UI.
        if (
          failureReason.includes('busy here') ||
          failureReason.includes('line busy') ||
          failureReason.includes('user busy') ||
          failureReason.includes('sip status: 486') ||
          failureReason.includes('sip 486')
        ) {
          return 'busy';
        }

        if (
          failureReason.includes('voicemail') ||
          failureReason.includes('voice mail') ||
          failureReason.includes('answered by voicemail')
        ) {
          return 'voicemail';
        }

        if (
          failureReason.includes('no answer') ||
          failureReason.includes('did not answer') ||
          failureReason.includes('timeout')
        ) {
          return 'no_answer';
        }

        if (
          failureReason.includes('failed') ||
          failureReason.includes('error') ||
          failureReason.includes('rejected') ||
          failureReason.includes('declined') ||
          failureReason.includes('invalid number')
        ) {
          return 'failed';
        }

        return status || 'pending';
      };

      const pickBestReason = (...rows: any[]): string => {
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
            if (value && String(value).trim()) return String(value).trim();
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
              if (value && String(value).trim()) return String(value).trim();
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

      // Live conversation details help resolve final status when batch endpoint still says "initiated".
      const liveConversationIds = Array.from(
        new Set(
          [
            ...recipientRows.map((r: any) => r?.conversation_id).filter(Boolean),
            ...callRows.map((r: any) => r?.conversation_id || r?.conversationId).filter(Boolean),
            ...resultRows.map((r: any) => r?.conversation_id || r?.conversationId || r?.id).filter(Boolean)
          ].map(String)
        )
      ).slice(0, 150);

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
      }).lean();

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

      const allPhones = new Set<string>();
      const allConversationIds = new Set<string>();
      recipientRows.forEach((r: any) => r?.phone_number && allPhones.add(r.phone_number));
      callRows.forEach((r: any) => r?.phone_number && allPhones.add(r.phone_number));
      resultRows.forEach((r: any) => (r?.phone_number || r?.phone) && allPhones.add(r.phone_number || r.phone));
      dbConversations.forEach((c: any) => c?.metadata?.phone_number && allPhones.add(c.metadata.phone_number));
      recipientRows.forEach((r: any) => r?.conversation_id && allConversationIds.add(r.conversation_id));
      callRows.forEach((r: any) => (r?.conversation_id || r?.conversationId) && allConversationIds.add(r.conversation_id || r.conversationId));
      resultRows.forEach((r: any) => (r?.conversation_id || r?.conversationId || r?.id) && allConversationIds.add(r.conversation_id || r.conversationId || r.id));
      dbConversations.forEach((c: any) => c?.metadata?.conversation_id && allConversationIds.add(c.metadata.conversation_id));

      const contacts = [...allPhones].map((phone) => {
        const normalizedPhone = normalizePhoneForCompare(phone);
        const statusRow = recipientRows.find((r: any) => normalizePhoneForCompare(r?.phone_number) === normalizedPhone) || byPhone.get(normalizedPhone) || {};
        const statusRecipientId = statusRow?.id ? String(statusRow.id) : '';
        const callRow =
          callRows.find((r: any) => normalizePhoneForCompare(r?.phone_number || r?.phone) === normalizedPhone) ||
          (statusRecipientId ? byRecipientId.get(statusRecipientId) : null) ||
          {};
        const resultRow =
          resultRows.find((r: any) => normalizePhoneForCompare(r?.phone_number || r?.phone) === normalizedPhone) ||
          (statusRecipientId ? byRecipientId.get(statusRecipientId) : null) ||
          {};
        const conversationId = statusRow?.conversation_id || callRow?.conversation_id || callRow?.conversationId || resultRow?.conversation_id || resultRow?.conversationId || resultRow?.id;
        const liveConversation = conversationId ? liveConversationMap.get(String(conversationId)) : null;
        const dbConversation = dbByPhone.get(phone) || (conversationId ? dbByConversationId.get(conversationId) : null);
        const customer = dbConversation?.customerId ? customerMap.get(String(dbConversation.customerId)) : null;
        const transcript =
          resultRow?.transcript ||
          callRow?.transcript ||
          dbConversation?.transcript ||
          null;

        const dynamicVars = statusRow?.conversation_initiation_client_data?.dynamic_variables || {};
        const displayName = statusRow?.name || callRow?.name || resultRow?.name || dynamicVars.name || dynamicVars.customer_name || customer?.name || 'Unknown';
        const email = statusRow?.email || callRow?.email || resultRow?.email || dynamicVars.email || dynamicVars.customer_email || customer?.email || '';
        const rawStatus =
          liveConversation?.status ||
          statusRow?.status ||
          callRow?.status ||
          callRow?.call_status ||
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
        const failedReason = reasonText;
        const summary =
          resultRow?.analysis?.summary ||
          resultRow?.summary ||
          resultRow?.call_summary ||
          '';
        // If provider marks batch completed but recipient stays initiated with no final reason,
        // avoid showing initiated forever in UI.
        const statusForNormalization =
          (statusResult?.status === 'completed' && String(rawStatus).toLowerCase() === 'initiated' && !failedReason && !endReason)
            ? 'failed'
            : rawStatus;
        const resolvedStatus = normalizeCallStatus(statusForNormalization, `${failedReason} ${endReason}`);
        const resolvedFailedReason = failedReason || defaultReasonFromStatus(resolvedStatus, rawStatus);
        const resolvedEndReason = endReason || defaultReasonFromStatus(resolvedStatus, rawStatus);

        return {
          phone_number: phone,
          name: displayName,
          email,
          status: resolvedStatus,
          raw_status: rawStatus,
          conversation_id: conversationId || dbConversation?.metadata?.conversation_id || null,
          recipient_id: statusRow?.id || statusRow?.recipient_id || null,
          duration_seconds: durationSeconds,
          end_reason: resolvedEndReason,
          failed_reason: resolvedFailedReason,
          summary,
          transcript,
          metadata: {
            sip_call_sid: resultRow?.metadata?.call_sid || callRow?.call_sid || null,
            recording_url: resultRow?.recording_url || resultRow?.audio_url || dbConversation?.metadata?.recording_url || dbConversation?.metadata?.audio_url || null,
            raw_reason: failedReason || endReason || null,
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
          const rawStatus = liveConversation?.status || row?.status || row?.call_status || 'completed';
          const reasonText = pickBestReason(
            liveConversation,
            liveConversation?.metadata,
            liveConversation?.analysis,
            row,
            row?.metadata,
            row?.analysis,
            dbConversation?.metadata
          );
          const failedReason = reasonText;
          const endReason =
            liveConversation?.metadata?.termination_reason ||
            row?.metadata?.termination_reason ||
            row?.end_reason ||
            dbConversation?.metadata?.end_reason ||
            reasonText ||
            '';
          const resolvedStatus = normalizeCallStatus(rawStatus, `${failedReason} ${endReason}`);
          const resolvedFailedReason = failedReason || defaultReasonFromStatus(resolvedStatus, rawStatus);
          const resolvedEndReason = endReason || defaultReasonFromStatus(resolvedStatus, rawStatus);
          return {
            phone_number: row?.phone_number || dbConversation?.metadata?.phone_number || '',
            name: row?.name || customer?.name || 'Unknown',
            email: row?.email || customer?.email || '',
            status: resolvedStatus,
            raw_status: rawStatus,
            conversation_id: conversationId,
            recipient_id: row?.id || null,
            duration_seconds: row?.metadata?.call_duration_secs || row?.call_duration_secs || dbConversation?.metadata?.duration_seconds || 0,
            end_reason: resolvedEndReason,
            failed_reason: resolvedFailedReason,
            summary: row?.analysis?.summary || row?.summary || '',
            transcript: row?.transcript || dbConversation?.transcript || null,
            metadata: {
              sip_call_sid: row?.metadata?.call_sid || row?.call_sid || null,
              recording_url: row?.recording_url || row?.audio_url || dbConversation?.metadata?.recording_url || dbConversation?.metadata?.audio_url || null,
              raw_reason: failedReason || endReason || null,
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
          contacts: mergedContacts
        }
      });
    } catch (error) {
      next(error);
    }
  }
}

export const batchCallingController = new BatchCallingController();
