import Bull from 'bull';
import { batchCallingService } from '../services/batchCalling.service';
import { isRedisAvailable, bullCreateClient } from '../config/redis';
import mongoose from 'mongoose';

/**
 * Batch Call Queue
 * 
 * Processes batch call submissions in the background to avoid HTTP timeouts
 * and handle large batches (e.g., 468+ recipients) efficiently.
 * 
 * Flow:
 * - Controller enqueues job with batch call data
 * - Queue processor submits to Python API
 * - Stores result in database
 * - Triggers polling for batch completion
 */

// Create batch call queue (will fail gracefully if Redis is unavailable)
let batchCallQueue: Bull.Queue | null = null;

// Initialize queue function - called after Redis connection attempt
const createQueueIfAvailable = () => {
  // Check if Redis is actually available
  if (!isRedisAvailable()) {
    console.log('[Batch Call Queue] ⚠️  Redis not available - queue not created (will use synchronous submission)');
    batchCallQueue = null;
    return;
  }

  if (!process.env.REDIS_URL) {
    console.log('[Batch Call Queue] ⚠️  REDIS_URL not set - queue not created');
    batchCallQueue = null;
    return;
  }

  try {
    batchCallQueue = new Bull('batch-call', {
      createClient: bullCreateClient,
      settings: {
        maxStalledCount: 1,
        retryProcessDelay: 5000,
        lockDuration: 300000,
        lockRenewTime: 60000
      },
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 200
      }
    });

    // Handle connection errors gracefully
    batchCallQueue.on('error', (error) => {
      console.error('[Batch Call Queue] ❌ Queue connection error:', error.message);
    });

    console.log('[Batch Call Queue] ✅ Queue created successfully');
    
    // Set up processor after queue is created
    setupQueueProcessor();
  } catch (error: any) {
    console.log('[Batch Call Queue] ⚠️  Queue creation failed:', error.message);
    batchCallQueue = null;
  }
};

// Try to create queue after a delay (to allow Redis connection to complete)
// This will be called from server.ts after Redis connection attempt
setTimeout(() => {
  createQueueIfAvailable();
}, 3000);

export { batchCallQueue };

// Process batch call submission (only if queue is available)
const setupQueueProcessor = () => {
  if (!batchCallQueue) {
    console.log('[Batch Call Queue] ⚠️  Queue not available - processor not initialized');
    return;
  }

  console.log('[Batch Call Queue] ✅ Queue processor initialized');
  
  batchCallQueue.process('submit-batch-call', 5, async (job: Bull.Job) => {
    console.log('[Batch Call Queue] 🚀 Starting batch call job:', job.id);
    console.log('[Batch Call Queue] Job data:', {
      recipients_count: job.data.recipients?.length || 0,
      agent_id: job.data.agent_id,
      call_name: job.data.call_name,
      retry_count: job.data.retry_count ?? null,
      scheduled_at: job.data.scheduled_at ?? null,
      timezone: job.data.timezone ?? null,
      target_concurrency_limit: job.data.target_concurrency_limit ?? null,
      has_sender_email: Boolean(job.data.sender_email)
    });

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
      userId,
      organizationId
    } = job.data;

    try {
      // Update job progress
      job.progress(10);

      // Build payload
      const payload: any = {
        agent_id,
        call_name,
        phone_number_id: String(phone_number_id).trim(),
        recipients: recipients.map((recipient: any) => {
          const recipientPayload: any = {
            phone_number: recipient.phone_number,
            name: recipient.name
          };
          // Include email if provided
          if (recipient.email) {
            recipientPayload.email = recipient.email;
          }
          // Include dynamic_variables ONLY if provided
          if (recipient.dynamic_variables !== undefined && recipient.dynamic_variables !== null) {
            recipientPayload.dynamic_variables = recipient.dynamic_variables;
          }
          return recipientPayload;
        })
      };

      if (retry_count !== undefined) payload.retry_count = retry_count;
      if (scheduled_at) payload.scheduled_at = scheduled_at;
      if (timezone) payload.timezone = timezone;
      if (target_concurrency_limit !== undefined) payload.target_concurrency_limit = target_concurrency_limit;
      if (sender_email) payload.sender_email = sender_email;

      console.log('[Batch Call Queue] 📋 Submitting batch call to Python API...');
      console.log('[Batch Call Queue] Recipients count:', payload.recipients.length);

      // Update job progress
      job.progress(30);

      // Submit to Python API
      const result = await batchCallingService.submitBatchCall(payload);

      console.log('[Batch Call Queue] ✅ Batch call submitted successfully');
      console.log('[Batch Call Queue] Batch ID:', result.id);

      // Update job progress
      job.progress(60);

      // Store batch call response in database
      const BatchCall = (await import('../models/BatchCall')).default;
      const orgObjectId = organizationId instanceof mongoose.Types.ObjectId
        ? organizationId
        : new mongoose.Types.ObjectId(organizationId.toString());
      const userObjectId = userId instanceof mongoose.Types.ObjectId
        ? userId
        : new mongoose.Types.ObjectId(userId.toString());

      await BatchCall.create({
        userId: userObjectId,
        organizationId: orgObjectId,
        batch_call_id: result.id,
        name: result.name,
        agent_id: result.agent_id,
        status: result.status,
        phone_number_id: result.phone_number_id,
        phone_provider: result.phone_provider,
        created_at_unix: result.created_at_unix,
        scheduled_time_unix: result.scheduled_time_unix,
        timezone: result.timezone || 'UTC',
        total_calls_dispatched: result.total_calls_dispatched,
        total_calls_scheduled: result.total_calls_scheduled,
        total_calls_finished: result.total_calls_finished,
        last_updated_at_unix: result.last_updated_at_unix,
        retry_count: result.retry_count,
        agent_name: result.agent_name,
        call_name: call_name,
        recipients_count: recipients.length,
        conversations_synced: false
      });

      console.log('[Batch Call Queue] ✅ Batch call stored in database');

      // Update job progress
      job.progress(80);

      // Enqueue poll job for automatic batch completion detection
      try {
        const { enqueueBatchPoll } = await import('./batchCallSync.queue');
        const enqueued = await enqueueBatchPoll(result.id, organizationId.toString());
        
        if (enqueued) {
          console.log('[Batch Call Queue] 🚀 Background polling started for batch:', result.id);
        } else {
          console.log('[Batch Call Queue] ℹ️  Queue not available - batch will rely on BatchCallMonitor fallback');
        }
      } catch (queueError: any) {
        console.warn('[Batch Call Queue] ⚠️  Failed to enqueue batch poll:', queueError.message);
      }

      // Update job progress
      job.progress(100);

      return {
        success: true,
        batch_call_id: result.id,
        result
      };

    } catch (error: any) {
      console.error('[Batch Call Queue] ❌ Batch call submission error:', error);
      console.error('[Batch Call Queue] Error stack:', error.stack);
      
      // Update job with error
      job.progress(100);
      
      throw error; // Let Bull handle retry logic
    }
  });

  // Log queue events for debugging
  batchCallQueue.on('completed', (job: Bull.Job, result: any) => {
    console.log('[Batch Call Queue] ✅ Job completed:', {
      jobId: job.id,
      batch_call_id: result?.batch_call_id
    });
  });

  batchCallQueue.on('failed', (job: Bull.Job | undefined, err: Error) => {
    console.error('[Batch Call Queue] ❌ Job failed:', {
      jobId: job?.id,
      error: err.message,
      attempts: job?.attemptsMade
    });
  });

  batchCallQueue.on('stalled', (job: Bull.Job) => {
    console.warn('[Batch Call Queue] ⚠️  Job stalled:', job.id);
  });

  batchCallQueue.on('error', (error: Error) => {
    console.error('[Batch Call Queue] ❌ Queue error:', error.message);
  });
};

/**
 * Enqueue a batch call job
 * Returns job ID if enqueued, null if queue unavailable
 */
export const enqueueBatchCall = async (data: {
  agent_id: string;
  call_name: string;
  recipients: any[];
  phone_number_id: string;
  retry_count?: number;
  scheduled_at?: string;
  timezone?: string;
  target_concurrency_limit?: number;
  sender_email?: string;
  userId: string | mongoose.Types.ObjectId;
  organizationId: string | mongoose.Types.ObjectId;
}): Promise<Bull.Job | null> => {
  if (!batchCallQueue) {
    console.log('[Batch Call Queue] ⚠️  Queue not available - cannot enqueue batch call');
    return null;
  }

  try {
    const job = await batchCallQueue.add('submit-batch-call', {
      agent_id: data.agent_id,
      call_name: data.call_name,
      recipients: data.recipients,
      phone_number_id: data.phone_number_id,
      retry_count: data.retry_count,
      scheduled_at: data.scheduled_at,
      timezone: data.timezone,
      target_concurrency_limit: data.target_concurrency_limit,
      sender_email: data.sender_email,
      userId: data.userId,
      organizationId: data.organizationId
    }, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30000 // 30 seconds between retries
      },
      timeout: 600000 // 10 minutes timeout for large batches
    });

    console.log('[Batch Call Queue] ✅ Batch call job enqueued:', job.id);
    console.log('[Batch Call Queue] Recipients count:', data.recipients.length);
    
    return job;
  } catch (error: any) {
    console.error('[Batch Call Queue] ❌ Failed to enqueue batch call:', error.message);
    return null;
  }
};

/**
 * Check if queue is available
 */
export const isBatchCallQueueAvailable = (): boolean => {
  return batchCallQueue !== null;
};

/**
 * Get queue instance (for debugging/monitoring)
 */
export const getBatchCallQueue = (): Bull.Queue | null => {
  return batchCallQueue;
};

