import mongoose from 'mongoose';
import Message from '../../models/Message';
import Conversation from '../../models/Conversation';
import Automation from '../../models/Automation';
import Campaign from '../../models/Campaign';
import { logger } from '../../utils/logger.util';
import { getEffectiveFeatureLimits } from '../../config/planLimits';

/**
 * SINGLE SOURCE OF TRUTH FOR USAGE TRACKING
 * 
 * Rules:
 * - No duplicate counting
 * - No manual increments
 * - No frontend calculations
 * - All counts derived from stored events/transcripts
 */

export class UsageTrackerService {
  /**
   * Calculate call minutes from actual phone conversations
   * 
   * Call minute = conversation with channel='phone' + actual transcript duration
   */
  async calculateCallMinutes(organizationId: string): Promise<number> {
    try {
      const conversations = await Conversation.find({
        organizationId,
        channel: 'phone'
      }).lean();

      let totalMinutes = 0;

      for (const conv of conversations) {
        let duration = 0;

        // Method 1: Calculate from transcript items (most accurate)
        const transcriptItems = Array.isArray(conv.transcript)
          ? conv.transcript
          : (conv.transcript as any)?.messages;

        if (Array.isArray(transcriptItems)) {
          const timestamps = transcriptItems
            .map((item: any) => item.timestamp || item.time || item.created_at)
            .filter(Boolean)
            .map((ts: any) => new Date(ts).getTime())
            .sort((a: number, b: number) => a - b);

          if (timestamps.length >= 2) {
            const firstTime = timestamps[0];
            const lastTime = timestamps[timestamps.length - 1];
            duration = Math.ceil((lastTime - firstTime) / 1000 / 60); // Round up to minutes
          }
        }

        // Method 2: Use metadata duration fields if available
        if (duration === 0 && conv.metadata) {
          const meta = conv.metadata as any;
          const rawDuration = meta.duration || meta.duration_seconds || meta.call_duration_secs || meta.call_duration_seconds;

          if (rawDuration !== undefined && rawDuration !== null) {
            const metaDuration = parseInt(String(rawDuration), 10);
            if (!isNaN(metaDuration)) {
              duration = Math.ceil(metaDuration / 60);
            }
          }

          // Fallback: Calculate from metadata timestamps
          if (duration === 0) {
            const start = meta.callInitiated || meta.AcceptedAt || meta.accepted_time_unix_secs;
            const end = meta.callCompletedAt || meta.CompletedAt || meta.end_time_unix_secs;

            if (start && end) {
              const startTime = typeof start === 'number' ? start * 1000 : new Date(start).getTime();
              const endTime = typeof end === 'number' ? end * 1000 : new Date(end).getTime();
              const diffSeconds = (endTime - startTime) / 1000;
              if (diffSeconds > 0 && diffSeconds < 7200) {
                duration = Math.ceil(diffSeconds / 60);
              }
            }
          }
        }

        // Method 3: Calculate from createdAt to updatedAt (with reasonable cap)
        if (duration === 0 && conv.createdAt && conv.updatedAt) {
          const start = new Date(conv.createdAt).getTime();
          const end = new Date(conv.updatedAt).getTime();
          const diffSeconds = (end - start) / 1000;

          // Only count if duration is reasonable (0s to 2 hours)
          if (diffSeconds > 0 && diffSeconds < 7200) {
            duration = Math.ceil(diffSeconds / 60);
          }
        }

        totalMinutes += duration;
      }

      logger.info(`[Usage Tracker] Org ${organizationId}: ${totalMinutes} call minutes from ${conversations.length} phone conversations`);
      return totalMinutes;

    } catch (error: any) {
      logger.error('[Usage Tracker] Error calculating call minutes:', error.message);
      return 0;
    }
  }

  /**
   * Calculate total chat messages sent + received
   * 
   * Chat message = every message in non-phone channels
   */
  async calculateChatMessages(organizationId: string): Promise<number> {
    try {
      // Find all conversation IDs for this organization that are NOT phone conversations
      const nonPhoneConversations = await Conversation.find({
        organizationId: new mongoose.Types.ObjectId(organizationId),
        channel: { $ne: 'phone' }
      }).distinct('_id');

      const count = await Message.countDocuments({
        conversationId: { $in: nonPhoneConversations }
      });

      logger.info(`[Usage Tracker] Org ${organizationId}: ${count} chat messages from ${nonPhoneConversations.length} non-phone conversations`);
      return count;

    } catch (error: any) {
      logger.error('[Usage Tracker] Error calculating chat messages:', error.message);
      return 0;
    }
  }

  /**
   * Calculate conversations count
   * 
   * Conversation = at least 1 user message + 1 bot/system reply
   */
  async calculateConversations(organizationId: string): Promise<number> {
    try {
      const conversations = await Conversation.aggregate([
        {
          $match: {
            organizationId: new mongoose.Types.ObjectId(organizationId)
          }
        },
        {
          $lookup: {
            from: 'messages',
            localField: '_id',
            foreignField: 'conversationId',
            as: 'messages'
          }
        },
        {
          $match: {
            'messages.1': { $exists: true } // At least 2 messages
          }
        },
        {
          $count: 'total'
        }
      ]);

      const count = conversations[0]?.total || 0;
      logger.info(`[Usage Tracker] Org ${organizationId}: ${count} conversations`);
      return count;

    } catch (error: any) {
      logger.error('[Usage Tracker] Error calculating conversations:', error.message);
      return 0;
    }
  }

  /**
   * Count active automations
   */
  async calculateActiveAutomations(organizationId: string): Promise<number> {
    try {
      const count = await Automation.countDocuments({
        organizationId,
        isActive: true
      });

      logger.info(`[Usage Tracker] Org ${organizationId}: ${count} active automations`);
      return count;

    } catch (error: any) {
      logger.error('[Usage Tracker] Error calculating automations:', error.message);
      return 0;
    }
  }

  /**
   * Count campaign sends (total messages sent via campaigns)
   */
  async calculateCampaignSends(organizationId: string): Promise<number> {
    try {
      const campaigns = await Campaign.find({ organizationId }).lean();

      let totalSends = 0;
      for (const campaign of campaigns) {
        // Count from contactIds array length or totalContacts field
        totalSends += (campaign as any).contactIds?.length || (campaign as any).totalContacts || 0;
      }

      logger.info(`[Usage Tracker] Org ${organizationId}: ${totalSends} campaign sends`);
      return totalSends;

    } catch (error: any) {
      logger.error('[Usage Tracker] Error calculating campaign sends:', error.message);
      return 0;
    }
  }

  /**
   * Get comprehensive usage for an organization (with optional caching)
   */
  async getOrganizationUsage(organizationId: string, useCache: boolean = true) {
    try {
      const cacheKey = `usage:org:${organizationId}`;

      // Try to get from cache first
      if (useCache) {
        try {
          const { default: redisClient, isRedisAvailable } = await import('../../config/redis');
          if (isRedisAvailable()) {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
              return JSON.parse(cachedData);
            }
          }
        } catch (cacheError) {
          logger.warn(`[Usage Tracker] Cache fetch failed for ${organizationId}:`, (cacheError as any).message);
        }
      }

      const [callMinutes, chatMessages, conversations, automations, campaignSends] = await Promise.all([
        this.calculateCallMinutes(organizationId),
        this.calculateChatMessages(organizationId),
        this.calculateConversations(organizationId),
        this.calculateActiveAutomations(organizationId),
        this.calculateCampaignSends(organizationId)
      ]);

      const usageData = {
        callMinutes,
        chatMessages,
        conversations,
        automations,
        campaignSends,
        calculatedAt: new Date()
      };

      // Store in cache for 60 seconds (Near Real-Time)
      if (useCache) {
        try {
          const { default: redisClient, isRedisAvailable } = await import('../../config/redis');
          if (isRedisAvailable()) {
            await redisClient.setEx(cacheKey, 60, JSON.stringify(usageData));
          }
        } catch (cacheError) {
          logger.warn(`[Usage Tracker] Cache store failed for ${organizationId}:`, (cacheError as any).message);
        }
      }

      return usageData;

    } catch (error: any) {
      logger.error('[Usage Tracker] Error getting organization usage:', error.message);
      throw error;
    }
  }

  /**
   * Clear usage cache for an organization (call this after significant events)
   */
  async clearUsageCache(organizationId: string): Promise<void> {
    try {
      const { default: redisClient, isRedisAvailable } = await import('../../config/redis');
      if (isRedisAvailable()) {
        await redisClient.del(`usage:org:${organizationId}`);
        logger.debug(`[Usage Tracker] Cleared usage cache for org ${organizationId}`);
      }
    } catch (error: any) {
      logger.error(`[Usage Tracker] Failed to clear usage cache for ${organizationId}:`, error.message);
    }
  }

  /**
   * Check if organization has exceeded plan limits
   */
  async checkLimits(organizationId: string, plan: any, org?: { plan?: string } | null): Promise<{
    exceeded: boolean;
    limits: {
      callMinutes: { used: number; limit: number; exceeded: boolean };
      chatMessages: { used: number; limit: number; exceeded: boolean };
      automations: { used: number; limit: number; exceeded: boolean };
    };
  }> {
    try {
      // Use cache for limit checks too, but maybe shorter? (currently uses default 60s)
      const usage = await this.getOrganizationUsage(organizationId);

      const features = getEffectiveFeatureLimits(org ?? { plan: plan?.slug }, plan);

      const limits = {
        callMinutes: {
          used: usage.callMinutes,
          limit: features.callMinutes,
          exceeded: features.callMinutes !== -1 && usage.callMinutes >= features.callMinutes
        },
        chatMessages: {
          used: usage.chatMessages,
          limit: features.chatConversations,
          exceeded: features.chatConversations !== -1 && usage.chatMessages >= features.chatConversations
        },
        automations: {
          used: usage.automations,
          limit: features.automations,
          exceeded: features.automations !== -1 && usage.automations >= features.automations
        }
      };

      const exceeded = limits.callMinutes.exceeded ||
        limits.chatMessages.exceeded ||
        limits.automations.exceeded;

      return { exceeded, limits };

    } catch (error: any) {
      logger.error('[Usage Tracker] Error checking limits:', error.message);
      throw error;
    }
  }

  /**
   * Check if organization is "locked" due to limit exhaustion
   * Especially strict for the free plan
   */
  async isOrganizationLocked(organizationId: string): Promise<{ locked: boolean; reason: string | null }> {
    try {
      const Organization = mongoose.model('Organization');
      const org: any = await Organization.findById(organizationId).populate('planId').lean();

      if (!org) {
        return { locked: false, reason: null };
      }

      const plan = org.planId;
      const { exceeded, limits } = await this.checkLimits(organizationId, plan, org);

      if (exceeded) {
        let reason = 'Plan limits exceeded';
        if (limits.callMinutes.exceeded) reason = `You have reached your limit of ${limits.callMinutes.limit} call minutes.`;
        else if (limits.chatMessages.exceeded) reason = `You have reached your limit of ${limits.chatMessages.limit} chat conversations.`;
        else if (limits.automations.exceeded) reason = `You have reached your limit of ${limits.automations.limit} automations.`;

        return { 
          locked: true, 
          reason: `${reason} Please upgrade your plan to continue using our services.` 
        };
      }

      return { locked: false, reason: null };
    } catch (error: any) {
      logger.error('[Usage Tracker] Error checking lock status:', error.message);
      return { locked: false, reason: null };
    }
  }
}

export const usageTrackerService = new UsageTrackerService();
