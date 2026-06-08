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

/** In-process fallback cache used when Redis is unavailable. TTL = 60 s. */
const localUsageCache = new Map<string, { value: any; expiresAt: number }>();
const LOCAL_USAGE_TTL_MS = 60_000;

/** One in-flight profile usage recompute per org (authInstant background warm). */
const profileUsageWarmInFlight = new Set<string>();

export type UsageDateRange = { dateFrom?: Date; dateTo?: Date };

/** Normalize analytics DateRange (string | Date) for usage aggregations. */
export function toUsageDateRange(range?: {
  dateFrom?: string | Date;
  dateTo?: string | Date;
}): UsageDateRange | undefined {
  if (!range?.dateFrom && !range?.dateTo) return undefined;
  return {
    dateFrom: range.dateFrom ? new Date(range.dateFrom) : undefined,
    dateTo: range.dateTo ? new Date(range.dateTo) : undefined
  };
}

function conversationDateMatch(dateRange?: UsageDateRange): Record<string, unknown> {
  if (!dateRange?.dateFrom && !dateRange?.dateTo) return {};
  const createdAt: Record<string, Date> = {};
  if (dateRange.dateFrom) createdAt.$gte = dateRange.dateFrom;
  if (dateRange.dateTo) createdAt.$lte = dateRange.dateTo;
  return { createdAt };
}

function messageTimestampMatch(dateRange?: UsageDateRange): Record<string, unknown> {
  if (!dateRange?.dateFrom && !dateRange?.dateTo) return {};
  const timestamp: Record<string, Date> = {};
  if (dateRange.dateFrom) timestamp.$gte = dateRange.dateFrom;
  if (dateRange.dateTo) timestamp.$lte = dateRange.dateTo;
  return { timestamp };
}

/** Completed voice calls with stored duration (indexed path — no transcript blob scan). */
function voiceCallDurationMatch(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: 'phone',
    $or: [
      { callDurationSeconds: { $gt: 0 } },
      { 'metadata.duration_seconds': { $gt: 0 } }
    ],
    ...extra
  };
}

/** Seconds to bill for one conversation — prefers denormalized top-level field. */
function callDurationSecondsExpr(): Record<string, unknown> {
  return {
    $cond: [
      { $gt: [{ $ifNull: ['$callDurationSeconds', 0] }, 0] },
      '$callDurationSeconds',
      { $ifNull: ['$metadata.duration_seconds', 0] }
    ]
  };
}

/** Run async work over items with bounded concurrency. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => worker())
  );
  return results;
}

function localCacheGet(key: string): any | null {
  const entry = localUsageCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  if (entry) localUsageCache.delete(key);
  return null;
}

function localCacheSet(key: string, value: any): void {
  localUsageCache.set(key, { value, expiresAt: Date.now() + LOCAL_USAGE_TTL_MS });
}

export class UsageTrackerService {
  /**
   * Calculate call minutes from completed voice calls (non-null transcript).
   * Sums metadata.duration_seconds in MongoDB — no transcript blobs loaded into Node.
   */
  async calculateCallMinutes(organizationId: string, dateRange?: UsageDateRange): Promise<number> {
    try {
      const result = await Conversation.aggregate([
        {
          $match: voiceCallDurationMatch({
            organizationId: new mongoose.Types.ObjectId(organizationId),
            ...conversationDateMatch(dateRange)
          })
        },
        {
          $group: {
            _id: null,
            totalSeconds: { $sum: callDurationSecondsExpr() },
            count: { $sum: 1 }
          }
        }
      ]);

      if (!result.length) return 0;

      const totalMinutes = Math.round(result[0].totalSeconds / 60);
      logger.info(`[Usage Tracker] Org ${organizationId}: ${totalMinutes} call minutes from ${result[0].count} phone conversations`);
      return totalMinutes;

    } catch (error: any) {
      logger.error('[Usage Tracker] Error calculating call minutes:', error.message);
      return 0;
    }
  }

  /** Call minutes + completed voice call count (same fast aggregation as calculateCallMinutes). */
  async calculateCallMinutesStats(
    organizationId: string,
    dateRange?: UsageDateRange,
    channel?: string
  ): Promise<{ minutes: number; callCount: number }> {
    try {
      const match = voiceCallDurationMatch({
        organizationId: new mongoose.Types.ObjectId(organizationId),
        ...conversationDateMatch(dateRange),
        ...this.channelConversationMatch(channel)
      });

      const result = await Conversation.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            totalSeconds: { $sum: callDurationSecondsExpr() },
            count: { $sum: 1 }
          }
        }
      ]);

      if (!result.length) return { minutes: 0, callCount: 0 };
      return {
        minutes: Math.round(result[0].totalSeconds / 60),
        callCount: result[0].count ?? 0
      };
    } catch (error: any) {
      logger.error('[Usage Tracker] Error calculating call minutes stats:', error.message);
      return { minutes: 0, callCount: 0 };
    }
  }

  /** Time-bucketed call minutes for analytics charts (admin-speed aggregation). */
  async calculateCallMinutesByPeriod(
    organizationId: string,
    dateRange: UsageDateRange | undefined,
    groupBy: 'hour' | 'day' | 'week' | 'month' = 'day',
    channel?: string
  ): Promise<Array<{ period: string; minutes: number; callCount: number }>> {
    const dateFormat: Record<string, string> = {
      hour: '%Y-%m-%d %H:00',
      day: '%Y-%m-%d',
      week: '%Y-W%V',
      month: '%Y-%m'
    };

    try {
      const match = voiceCallDurationMatch({
        organizationId: new mongoose.Types.ObjectId(organizationId),
        ...conversationDateMatch(dateRange),
        ...this.channelConversationMatch(channel)
      });

      const rows = await Conversation.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              $dateToString: { format: dateFormat[groupBy], date: '$createdAt' }
            },
            totalSeconds: { $sum: callDurationSecondsExpr() },
            callCount: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]);

      return rows.map((r) => ({
        period: r._id as string,
        minutes: Math.round((r.totalSeconds ?? 0) / 60),
        callCount: r.callCount ?? 0
      }));
    } catch (error: any) {
      logger.error('[Usage Tracker] Error calculating call minutes by period:', error.message);
      return [];
    }
  }

  private channelConversationMatch(channel?: string): Record<string, unknown> {
    if (!channel || channel === 'all') return {};
    if (channel === 'instagram' || channel === 'facebook') {
      return { channel: 'social', 'metadata.platform': channel };
    }
    if (channel === 'telegram') {
      return { channel: 'social', 'metadata.platform': 'telegram' };
    }
    return { channel };
  }

  /**
   * Calculate total chat messages sent + received (non-phone channels).
   *
   * Runs the count in parallel with the phone-conversation lookup so the two
   * round-trips don't serialize. Uses the denormalized organizationId on
   * Message (post-backfill) for an index-only count.
   * Falls back to the two-step path for messages not yet backfilled.
   */
  async calculateChatMessages(organizationId: string): Promise<number> {
    try {
      const orgObjectId = new mongoose.Types.ObjectId(organizationId);

      // Run both lookups in parallel — they have no dependency on each other.
      const [directCount, phoneConvIds] = await Promise.all([
        Message.countDocuments({ organizationId: orgObjectId }),
        Conversation.find({
          organizationId: orgObjectId,
          channel: 'phone'
        }).distinct('_id')
      ]);

      if (directCount > 0) {
        const phoneMessageCount = phoneConvIds.length > 0
          ? await Message.countDocuments({
              organizationId: orgObjectId,
              conversationId: { $in: phoneConvIds }
            })
          : 0;

        const count = Math.max(0, directCount - phoneMessageCount);
        logger.info(`[Usage Tracker] Org ${organizationId}: ${count} chat messages (direct query)`);
        return count;
      }

      // Fallback for orgs whose messages predate the backfill — derive non-phone
      // conversation IDs from the data we already fetched above.
      const nonPhoneConversations = await Conversation.find({
        organizationId: orgObjectId,
        channel: { $ne: 'phone' }
      }).distinct('_id');

      const count = nonPhoneConversations.length > 0
        ? await Message.countDocuments({
            conversationId: { $in: nonPhoneConversations }
          })
        : 0;

      logger.info(`[Usage Tracker] Org ${organizationId}: ${count} chat messages (fallback query)`);
      return count;

    } catch (error: any) {
      logger.error('[Usage Tracker] Error calculating chat messages:', error.message);
      return 0;
    }
  }

  /**
   * Calculate conversations count.
   * Conversation = has at least 2 messages (1 user + 1 bot/system reply).
   *
   * Uses organizationId on Message directly when available (post-backfill),
   * falling back to the two-step path otherwise.
   */
  async calculateConversations(organizationId: string): Promise<number> {
    try {
      const orgObjectId = new mongoose.Types.ObjectId(organizationId);

      // Fast path: aggregate directly on Message using denormalized organizationId
      const sampleCheck = await Message.findOne({ organizationId: orgObjectId }).select('_id').lean();
      if (sampleCheck) {
        const result = await Message.aggregate([
          { $match: { organizationId: orgObjectId } },
          { $group: { _id: '$conversationId', count: { $sum: 1 } } },
          { $match: { count: { $gte: 2 } } },
          { $count: 'total' }
        ]);
        const count = result[0]?.total || 0;
        logger.info(`[Usage Tracker] Org ${organizationId}: ${count} conversations (direct query)`);
        return count;
      }

      // Fallback: two-step for orgs whose messages predate the backfill
      const convDocs = await Conversation.find({ organizationId: orgObjectId })
        .select('_id')
        .lean();

      if (convDocs.length === 0) return 0;

      const convIds = convDocs.map((c) => c._id);
      const result = await Message.aggregate([
        { $match: { conversationId: { $in: convIds } } },
        { $group: { _id: '$conversationId', count: { $sum: 1 } } },
        { $match: { count: { $gte: 2 } } },
        { $count: 'total' }
      ]);

      const count = result[0]?.total || 0;
      logger.info(`[Usage Tracker] Org ${organizationId}: ${count} conversations (fallback query)`);
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
   * Read precomputed usage from Redis/local cache only (no DB aggregation).
   * Used by auth middleware for plan-lock checks so API requests are not blocked on cold cache.
   */
  async peekUsageFromCache(organizationId: string): Promise<any | null> {
    const fullKey = `usage:org:${organizationId}`;
    const profileKey = `usage:org:${organizationId}:profile`;
    try {
      const { default: redisClient, isRedisAvailable } = await import('../../config/redis');
      if (isRedisAvailable()) {
        const fullRaw = await redisClient.get(fullKey);
        if (fullRaw) {
          return JSON.parse(fullRaw);
        }
        const profileRaw = await redisClient.get(profileKey);
        if (profileRaw) {
          return JSON.parse(profileRaw);
        }
      }
    } catch (e: any) {
      logger.debug(`[Usage Tracker] peekUsageFromCache redis: ${e?.message}`);
    }
    const localFull = localCacheGet(fullKey);
    if (localFull) {
      return localFull;
    }
    const localProfile = localCacheGet(profileKey);
    if (localProfile) {
      return localProfile;
    }
    return null;
  }

  /**
   * Get comprehensive usage for an organization (with optional caching).
   *
   * Cache hierarchy:
   *   1. Redis (shared across instances, 60 s TTL) — primary
   *   2. In-process Map (per-instance, 60 s TTL) — fallback when Redis is down
   *   3. Full recompute — only when both caches miss
   */
  /**
   * @param options.profileOnly — Skip expensive counts not needed for auth profile
   *   (thread-style conversation count, campaign sends). Uses a separate cache key.
   * @param options.authInstant — Login / profile path: on cache miss, return `authFallback` immediately
   *   and recompute usage in the background so auth never blocks on heavy aggregates.
   */
  async getOrganizationUsage(
    organizationId: string,
    useCache: boolean = true,
    options?: {
      profileOnly?: boolean;
      authInstant?: boolean;
      authFallback?: { callMinutes: number; chatMessages: number; automations: number };
    }
  ) {
    try {
      const profileOnly = !!options?.profileOnly;
      const authInstant = !!options?.authInstant;
      const cacheKey = profileOnly ? `usage:org:${organizationId}:profile` : `usage:org:${organizationId}`;

      if (useCache) {
        // 1. Try Redis
        try {
          const { default: redisClient, isRedisAvailable } = await import('../../config/redis');
          if (isRedisAvailable()) {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
              return JSON.parse(cachedData);
            }
          }
        } catch (cacheError) {
          logger.warn(`[Usage Tracker] Redis fetch failed for ${organizationId}:`, (cacheError as any).message);
        }

        // 2. Try in-process fallback cache
        const localHit = localCacheGet(cacheKey);
        if (localHit) {
          logger.debug(`[Usage Tracker] Local cache hit for ${organizationId}`);
          return localHit;
        }
      }

      if (authInstant && options?.authFallback) {
        const fb = options.authFallback;
        const stale = {
          callMinutes: fb.callMinutes,
          chatMessages: fb.chatMessages,
          conversations: 0,
          automations: fb.automations,
          campaignSends: 0,
          calculatedAt: new Date()
        };
        if (!profileUsageWarmInFlight.has(organizationId)) {
          profileUsageWarmInFlight.add(organizationId);
          void this.getOrganizationUsage(organizationId, true, { profileOnly })
            .catch((err: any) => {
              logger.warn(`[Usage Tracker] Background usage warm failed for ${organizationId}:`, err?.message);
            })
            .finally(() => {
              profileUsageWarmInFlight.delete(organizationId);
            });
        }
        logger.debug(`[Usage Tracker] authInstant stale usage for org ${organizationId} (background warm if not in flight)`);
        return stale;
      }

      const [callMinutes, chatMessages, conversations, automations, campaignSends] = profileOnly
        ? await Promise.all([
            this.calculateCallMinutes(organizationId),
            this.calculateChatMessages(organizationId),
            Promise.resolve(0),
            this.calculateActiveAutomations(organizationId),
            Promise.resolve(0)
          ])
        : await Promise.all([
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

      if (useCache) {
        // Store in Redis (primary)
        try {
          const { default: redisClient, isRedisAvailable } = await import('../../config/redis');
          if (isRedisAvailable()) {
            await redisClient.setEx(cacheKey, 60, JSON.stringify(usageData));
          }
        } catch (cacheError) {
          logger.warn(`[Usage Tracker] Redis store failed for ${organizationId}:`, (cacheError as any).message);
        }

        // Always store in local fallback cache
        localCacheSet(cacheKey, usageData);
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
    localUsageCache.delete(`usage:org:${organizationId}`);
    localUsageCache.delete(`usage:org:${organizationId}:profile`);
    try {
      const { default: redisClient, isRedisAvailable } = await import('../../config/redis');
      if (isRedisAvailable()) {
        await redisClient.del(`usage:org:${organizationId}`);
        await redisClient.del(`usage:org:${organizationId}:profile`);
        logger.debug(`[Usage Tracker] Cleared usage cache for org ${organizationId}`);
      }
    } catch (error: any) {
      logger.error(`[Usage Tracker] Failed to clear usage cache for ${organizationId}:`, error.message);
    }
  }

  /**
   * Check if organization has exceeded plan limits.
   * Pass `precomputedUsage` to skip a redundant getOrganizationUsage call when
   * the caller already has fresh usage data (e.g. planWarnings service).
   */
  async checkLimits(
    organizationId: string,
    plan: any,
    org?: { plan?: string } | null,
    precomputedUsage?: any
  ): Promise<{
    exceeded: boolean;
    limits: {
      callMinutes: { used: number; limit: number; exceeded: boolean };
      chatMessages: { used: number; limit: number; exceeded: boolean };
      automations: { used: number; limit: number; exceeded: boolean };
    };
  }> {
    try {
      const usage = precomputedUsage ?? await this.getOrganizationUsage(organizationId);

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
   * Check if organization is "locked" due to limit exhaustion.
   * Pass `precomputedUsage` to skip a redundant getOrganizationUsage call.
   */
  async isOrganizationLocked(
    organizationId: string,
    precomputedUsage?: any
  ): Promise<{ locked: boolean; reason: string | null }> {
    try {
      const Organization = mongoose.model('Organization');
      const org: any = await Organization.findById(organizationId).populate('planId').lean();

      if (!org) {
        return { locked: false, reason: null };
      }

      const plan = org.planId;
      const { exceeded, limits } = await this.checkLimits(organizationId, plan, org, precomputedUsage);

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

  /**
   * Platform-wide call minutes for admin dashboard.
   * Uses callDurationSeconds / metadata.duration_seconds — no transcript scan.
   */
  async calculatePlatformCallMinutes(dateRange?: UsageDateRange): Promise<number> {
    try {
      const result = await Conversation.aggregate([
        { $match: voiceCallDurationMatch(conversationDateMatch(dateRange)) },
        {
          $group: {
            _id: null,
            totalSeconds: { $sum: callDurationSecondsExpr() }
          }
        }
      ]);

      if (!result.length) return 0;
      return Math.round(result[0].totalSeconds / 60);
    } catch (error: any) {
      logger.error('[Usage Tracker] Error calculating platform call minutes:', error.message);
      return 0;
    }
  }

  /**
   * Platform-wide completed chat conversations for admin dashboard.
   * A conversation counts when it has at least one customer message and one AI reply (non-phone).
   */
  /**
   * Completed chat conversations for one org (customer + AI message, non-phone).
   */
  async calculateOrganizationChatConversations(
    organizationId: string,
    dateRange?: UsageDateRange
  ): Promise<number> {
    try {
      const orgObjectId = new mongoose.Types.ObjectId(organizationId);
      const result = await Message.aggregate([
        {
          $match: {
            organizationId: orgObjectId,
            type: 'message',
            sender: { $in: ['customer', 'ai'] },
            ...messageTimestampMatch(dateRange)
          }
        },
        {
          $group: {
            _id: '$conversationId',
            hasCustomer: { $max: { $cond: [{ $eq: ['$sender', 'customer'] }, 1, 0] } },
            hasAi: { $max: { $cond: [{ $eq: ['$sender', 'ai'] }, 1, 0] } }
          }
        },
        { $match: { hasCustomer: 1, hasAi: 1 } },
        {
          $lookup: {
            from: 'conversations',
            localField: '_id',
            foreignField: '_id',
            as: 'conv',
            pipeline: [
              {
                $match: {
                  organizationId: orgObjectId,
                  channel: { $ne: 'phone' }
                }
              },
              { $project: { _id: 1 } }
            ]
          }
        },
        { $match: { 'conv.0': { $exists: true } } },
        { $count: 'total' }
      ]);

      return result[0]?.total || 0;
    } catch (error: any) {
      logger.error('[Usage Tracker] Error calculating org chat conversations:', error.message);
      return 0;
    }
  }

  /**
   * Platform-wide chat conversations for admin dashboard.
   * Uses indexed countDocuments on conversations (non-phone with activity) — avoids
   * scanning the entire messages collection which times out on large datasets.
   */
  async calculatePlatformChatConversations(dateRange?: UsageDateRange): Promise<number> {
    try {
      return await Conversation.countDocuments({
        channel: { $in: ['whatsapp', 'website', 'email', 'social'] },
        'lastMessage.timestamp': { $exists: true },
        ...conversationDateMatch(dateRange)
      });
    } catch (error: any) {
      logger.error('[Usage Tracker] Error calculating platform chat conversations:', error.message);
      return 0;
    }
  }

}

export const usageTrackerService = new UsageTrackerService();
