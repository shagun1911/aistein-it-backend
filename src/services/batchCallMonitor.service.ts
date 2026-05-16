import { batchCallingService } from '../services/batchCalling.service';

/**
 * Background monitor that checks for completed batch calls
 * and automatically syncs their conversations
 */
export class BatchCallMonitor {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private checkIntervalMs = 30000; // Check every 30 seconds

  /**
   * Start the batch call monitor
   */
  start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    
    // Run immediately on start
    this.checkAndSyncBatchCalls();

    // Then run on interval
    this.intervalId = setInterval(() => {
      this.checkAndSyncBatchCalls();
    }, this.checkIntervalMs);
  }

  /**
   * Stop the batch call monitor
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
  }

  /**
   * Check for active/completed batch calls and run an incremental sync pass.
   * Handles both in_progress batches (partial transcripts arriving) and
   * completed batches that still have pending transcripts.
   */
  private async checkAndSyncBatchCalls() {
    try {
      const BatchCall = (await import('../models/BatchCall')).default;

      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Pick up any batch that is either still running OR completed but not yet fully synced.
      // The incremental sync is idempotent – already-processed calls (in processed_call_ids) are skipped.
      const activeBatches = await BatchCall.find({
        conversations_synced: { $ne: true },
        status: { $nin: ['cancelled', 'canceled', 'failed'] },
        createdAt: { $gte: oneDayAgo },
        $or: [
          { syncErrorCount: { $exists: false } },
          { syncErrorCount: { $lt: 5 } }
        ]
      })
      .select('batch_call_id organizationId status createdAt')
      .lean();

      if (activeBatches.length === 0) {
        return;
      }

      for (const batch of activeBatches) {
        const batchId = batch.batch_call_id;
        const orgId = (batch as any).organizationId?.toString();
        if (!orgId) {
          continue;
        }

        try {
          await batchCallingService.syncBatchCallConversations(batchId, orgId);
        } catch (error: any) {
          console.error(`[Batch Call Monitor] Failed to sync ${batchId}:`, error.message);
        }
      }

    } catch (error: any) {
      console.error('[Batch Call Monitor] Error during sync check:', error.message);
    }
  }

  /**
   * Manually trigger a sync check (for testing)
   */
  async triggerSync() {
    await this.checkAndSyncBatchCalls();
  }

  /**
   * Update check interval
   */
  setCheckInterval(intervalMs: number) {
    this.checkIntervalMs = intervalMs;
    
    // Restart with new interval if already running
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }

  /**
   * Get monitor status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      checkIntervalMs: this.checkIntervalMs,
      checkIntervalSeconds: this.checkIntervalMs / 1000
    };
  }
}

// Export singleton instance
export const batchCallMonitor = new BatchCallMonitor();
