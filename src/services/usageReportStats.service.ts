import Organization from '../models/Organization';
import Conversation from '../models/Conversation';
import UsageReportStats, {
  IUsageReportStats,
  UsageByOrganizationRow,
  UsageReportRangeKey
} from '../models/UsageReportStats';
import { usageTrackerService, UsageDateRange } from './usage/usageTracker.service';
import { dashboardStatsService } from './dashboardStats.service';
import { logger } from '../utils/logger.util';

export const USAGE_REPORT_RANGE_KEYS: UsageReportRangeKey[] = ['all', '7d', '30d', '90d'];

const REDIS_KEY_PREFIX = 'usage-report:stats:v1:';
const REDIS_STALE_PREFIX = 'usage-report:stats:stale:v1:';
const REDIS_TTL_SEC = 600;
const REDIS_STALE_TTL_SEC = 7 * 24 * 3600;
const LOCAL_TTL_MS = 60_000;
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export type UsageReportSnapshot = {
  totalCallMinutes: number;
  totalChatConversations: number;
  organizationCount: number;
  conversationsByChannel: Record<string, number>;
  usageByOrganization: UsageByOrganizationRow[];
  computedAt?: Date;
  computeDurationMs?: number;
};

type CachedSnapshot = { value: UsageReportSnapshot; expiresAt: number };

const localSnapshots = new Map<UsageReportRangeKey, CachedSnapshot>();
const refreshInFlight = new Map<UsageReportRangeKey, Promise<void>>();
let schedulerStarted = false;

/** Map API date filters to one of the precomputed range keys (matches admin analytics UI). */
export function resolveUsageReportRangeKey(dateFrom?: string, dateTo?: string): UsageReportRangeKey {
  if (!dateFrom && !dateTo) return 'all';
  if (!dateFrom) return 'all';

  const from = new Date(dateFrom);
  const to = dateTo ? new Date(dateTo) : new Date();
  if (Number.isNaN(from.getTime())) return 'all';

  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (days >= 6 && days <= 8) return '7d';
  if (days >= 28 && days <= 32) return '30d';
  if (days >= 88 && days <= 92) return '90d';
  return 'all';
}

function dateRangeForKey(key: UsageReportRangeKey): UsageDateRange | undefined {
  if (key === 'all') return undefined;
  const days = parseInt(key, 10);
  const dateTo = new Date();
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - days);
  return { dateFrom, dateTo };
}

function redisKey(key: UsageReportRangeKey): string {
  return `${REDIS_KEY_PREFIX}${key}`;
}

function redisStaleKey(key: UsageReportRangeKey): string {
  return `${REDIS_STALE_PREFIX}${key}`;
}

async function redisGet(key: string): Promise<UsageReportSnapshot | null> {
  try {
    const { default: redisClient, isRedisAvailable } = await import('../config/redis');
    if (!isRedisAvailable()) return null;
    const raw = await redisClient.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as UsageReportSnapshot;
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: UsageReportSnapshot, ttlSec: number): Promise<void> {
  try {
    const { default: redisClient, isRedisAvailable } = await import('../config/redis');
    if (!isRedisAvailable()) return;
    await redisClient.setEx(key, ttlSec, JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}

function setLocalSnapshot(rangeKey: UsageReportRangeKey, snapshot: UsageReportSnapshot): void {
  localSnapshots.set(rangeKey, { value: snapshot, expiresAt: Date.now() + LOCAL_TTL_MS });
}

function getLocalSnapshot(rangeKey: UsageReportRangeKey): UsageReportSnapshot | null {
  const entry = localSnapshots.get(rangeKey);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  return null;
}

function getExpiredLocalSnapshot(rangeKey: UsageReportRangeKey): UsageReportSnapshot | null {
  return localSnapshots.get(rangeKey)?.value ?? null;
}

function docToSnapshot(doc: IUsageReportStats | null): UsageReportSnapshot | null {
  if (!doc) return null;
  return {
    totalCallMinutes: doc.totalCallMinutes ?? 0,
    totalChatConversations: doc.totalChatConversations ?? 0,
    organizationCount: doc.organizationCount ?? 0,
    conversationsByChannel: (doc.conversationsByChannel as Record<string, number>) ?? {},
    usageByOrganization: doc.usageByOrganization ?? [],
    computedAt: doc.computedAt,
    computeDurationMs: doc.computeDurationMs
  };
}

async function readFromMongo(rangeKey: UsageReportRangeKey): Promise<UsageReportSnapshot | null> {
  const doc = await UsageReportStats.findOne({ key: rangeKey }).lean();
  return docToSnapshot(doc as IUsageReportStats | null);
}

async function readFromMongoSafe(rangeKey: UsageReportRangeKey): Promise<UsageReportSnapshot | null> {
  try {
    return await readFromMongo(rangeKey);
  } catch (err: any) {
    logger.warn('[UsageReportStats] findOne failed', { key: rangeKey, error: err?.message });
    return null;
  }
}

async function resolveStaleSnapshot(rangeKey: UsageReportRangeKey): Promise<UsageReportSnapshot | null> {
  return (
    (await redisGet(redisStaleKey(rangeKey))) ??
    (await redisGet(redisKey(rangeKey))) ??
    getExpiredLocalSnapshot(rangeKey)
  );
}

async function computeConversationsByChannel(
  dateRange?: UsageDateRange
): Promise<Record<string, number>> {
  const match: Record<string, unknown> = {};
  if (dateRange?.dateFrom || dateRange?.dateTo) {
    match.createdAt = {};
    if (dateRange.dateFrom) (match.createdAt as any).$gte = dateRange.dateFrom;
    if (dateRange.dateTo) (match.createdAt as any).$lte = dateRange.dateTo;
  }

  const rows = await Conversation.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    { $group: { _id: { $ifNull: ['$channel', 'unknown'] }, count: { $sum: 1 } } }
  ]);

  return rows.reduce((acc: Record<string, number>, row: { _id: string; count: number }) => {
    acc[row._id || 'unknown'] = row.count;
    return acc;
  }, {});
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        logger.warn(`[UsageReportStats] ${label} failed, retrying...`, {
          attempt: i + 1,
          error: (err as Error)?.message
        });
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr;
}

/**
 * Background compute for one date range. Uses batch org aggregations (3 queries) instead
 * of N×3 per-org queries. Queries run sequentially to avoid saturating the Mongo pool.
 * Platform totals for "all" reuse dashboard_stats when available.
 */
async function computeUsageReportSnapshot(rangeKey: UsageReportRangeKey): Promise<
  Omit<UsageReportSnapshot, 'computedAt' | 'computeDurationMs'>
> {
  const dateRange = dateRangeForKey(rangeKey);

  const organizations = await Organization.find({ status: { $ne: 'deleted' } })
    .select('_id name')
    .lean();

  // Sequential — avoids 5 parallel heavy aggregations competing for pool connections.
  const callMinutesByOrg = await withRetry('callMinutesByOrg', () =>
    usageTrackerService.calculateCallMinutesByOrganization(dateRange)
  );
  const chatByOrg = await withRetry('chatByOrg', () =>
    usageTrackerService.calculateChatConversationsByOrganization(dateRange)
  );
  const userCountByOrg = await withRetry('userCountByOrg', () =>
    usageTrackerService.calculateActiveUserCountByOrganization()
  );
  const conversationsByChannel = await withRetry('conversationsByChannel', () =>
    computeConversationsByChannel(dateRange)
  );
  const organizationCount = await Organization.countDocuments({ status: { $ne: 'deleted' } });

  let totalCallMinutes: number;
  let totalChatConversations: number;

  if (rangeKey === 'all') {
    try {
      const usage = await dashboardStatsService.getUsage();
      totalCallMinutes = usage.totalCallMinutes;
      totalChatConversations = usage.totalChatConversations;
    } catch {
      [totalCallMinutes, totalChatConversations] = await Promise.all([
        usageTrackerService.calculatePlatformCallMinutes(dateRange),
        usageTrackerService.calculatePlatformChatConversations(dateRange)
      ]);
    }
  } else {
    [totalCallMinutes, totalChatConversations] = await Promise.all([
      usageTrackerService.calculatePlatformCallMinutes(dateRange),
      usageTrackerService.calculatePlatformChatConversations(dateRange)
    ]);
  }

  const usageByOrganization: UsageByOrganizationRow[] = organizations.map((org) => {
    const orgId = org._id.toString();
    return {
      _id: orgId,
      name: org.name,
      totalCallMinutes: callMinutesByOrg.get(orgId) ?? 0,
      totalChatConversations: chatByOrg.get(orgId) ?? 0,
      userCount: userCountByOrg.get(orgId) ?? 0
    };
  });

  return {
    totalCallMinutes,
    totalChatConversations,
    organizationCount,
    conversationsByChannel,
    usageByOrganization
  };
}

async function persistSnapshot(
  rangeKey: UsageReportRangeKey,
  snapshot: Omit<UsageReportSnapshot, 'computedAt' | 'computeDurationMs'>,
  computeDurationMs: number
): Promise<UsageReportSnapshot> {
  const computedAt = new Date();
  const payload: UsageReportSnapshot = { ...snapshot, computedAt, computeDurationMs };

  await UsageReportStats.findOneAndUpdate(
    { key: rangeKey },
    { key: rangeKey, ...snapshot, computedAt, computeDurationMs },
    { upsert: true, new: true }
  );

  setLocalSnapshot(rangeKey, payload);
  void redisSet(redisKey(rangeKey), payload, REDIS_TTL_SEC);
  void redisSet(redisStaleKey(rangeKey), payload, REDIS_STALE_TTL_SEC);
  return payload;
}

export class UsageReportStatsService {
  /** Hot path: L1 memory → L2 Redis → L3 usage_report_stats.findOne(). No live aggregations. */
  async getSnapshot(rangeKey: UsageReportRangeKey): Promise<UsageReportSnapshot> {
    const local = getLocalSnapshot(rangeKey);
    if (local) return local;

    const redisHit = await redisGet(redisKey(rangeKey));
    if (redisHit) {
      setLocalSnapshot(rangeKey, redisHit);
      return redisHit;
    }

    const mongoHit = await readFromMongoSafe(rangeKey);
    if (mongoHit) {
      setLocalSnapshot(rangeKey, mongoHit);
      void redisSet(redisKey(rangeKey), mongoHit, REDIS_TTL_SEC);
      return mongoHit;
    }

    const stale = await resolveStaleSnapshot(rangeKey);
    if (stale) {
      logger.warn('[UsageReportStats] Serving stale snapshot', { key: rangeKey });
      setLocalSnapshot(rangeKey, stale);
      return stale;
    }

    const inFlight = refreshInFlight.get(rangeKey);
    if (inFlight) {
      await Promise.race([inFlight, new Promise((resolve) => setTimeout(resolve, 8000))]);
      const afterRefresh = await readFromMongoSafe(rangeKey);
      if (afterRefresh) {
        setLocalSnapshot(rangeKey, afterRefresh);
        return afterRefresh;
      }
      const staleAfter = await resolveStaleSnapshot(rangeKey);
      if (staleAfter) return staleAfter;
    }

    logger.info('[UsageReportStats] No snapshot — starting background refresh', { key: rangeKey });
    void this.refreshRange(rangeKey).catch((err: any) => {
      logger.warn('[UsageReportStats] Background refresh failed', { key: rangeKey, error: err?.message });
    });
    throw new Error('Usage reports are being computed. Please retry in a few seconds.');
  }

  async getSummary(rangeKey: UsageReportRangeKey): Promise<
    Omit<UsageReportSnapshot, 'usageByOrganization'>
  > {
    const snap = await this.getSnapshot(rangeKey);
    return {
      totalCallMinutes: snap.totalCallMinutes,
      totalChatConversations: snap.totalChatConversations,
      organizationCount: snap.organizationCount,
      conversationsByChannel: snap.conversationsByChannel,
      computedAt: snap.computedAt,
      computeDurationMs: snap.computeDurationMs
    };
  }

  async getFullReport(rangeKey: UsageReportRangeKey): Promise<UsageReportSnapshot> {
    return this.getSnapshot(rangeKey);
  }

  async refreshRange(rangeKey: UsageReportRangeKey): Promise<UsageReportSnapshot> {
    const existing = refreshInFlight.get(rangeKey);
    if (existing) {
      await existing;
      const doc = await readFromMongo(rangeKey);
      if (!doc) throw new Error(`Refresh completed but no snapshot for ${rangeKey}`);
      return doc;
    }

    let persisted: UsageReportSnapshot | undefined;

    const job = (async () => {
      const t0 = Date.now();
      try {
        logger.info('[UsageReportStats] Refreshing snapshot...', { key: rangeKey });
        const snapshot = await computeUsageReportSnapshot(rangeKey);
        const durationMs = Date.now() - t0;
        persisted = await persistSnapshot(rangeKey, snapshot, durationMs);
        logger.info('[UsageReportStats] Snapshot refreshed', {
          key: rangeKey,
          computeDurationMs: durationMs,
          totalCallMinutes: persisted.totalCallMinutes,
          orgRows: persisted.usageByOrganization.length
        });
      } catch (err: any) {
        logger.error('[UsageReportStats] Refresh failed', { key: rangeKey, error: err?.message });
        throw err;
      } finally {
        refreshInFlight.delete(rangeKey);
      }
    })();

    refreshInFlight.set(rangeKey, job);
    await job;
    if (!persisted) throw new Error(`Refresh completed without snapshot for ${rangeKey}`);
    return persisted;
  }

  /** Refresh all UI date ranges sequentially to avoid saturating the Mongo pool. */
  async refreshAllRanges(): Promise<void> {
    for (const key of USAGE_REPORT_RANGE_KEYS) {
      try {
        await this.refreshRange(key);
      } catch (err: any) {
        logger.warn('[UsageReportStats] Range refresh failed (continuing)', { key, error: err?.message });
      }
    }
  }

  async warmOnStartup(): Promise<void> {
    try {
      const existing = await UsageReportStats.findOne({ key: 'all' }).lean();
      if (existing?.computedAt) {
        const snap = docToSnapshot(existing as unknown as IUsageReportStats)!;
        setLocalSnapshot('all', snap);
        void redisSet(redisKey('all'), snap, REDIS_TTL_SEC);

        const ageMs = Date.now() - new Date(existing.computedAt).getTime();
        logger.info('[UsageReportStats] Loaded existing snapshot', {
          key: 'all',
          ageSec: Math.round(ageMs / 1000)
        });
        if (ageMs < REFRESH_INTERVAL_MS) return;
      }
      void this.refreshAllRanges();
    } catch (err: any) {
      logger.warn('[UsageReportStats] Startup warm failed (non-fatal)', { error: err?.message });
    }
  }

  startScheduler(): void {
    if (schedulerStarted) return;
    schedulerStarted = true;

    // Rotate one range every 2.5 min → all 4 refreshed within 10 min, spread load.
    let tick = 0;
    setInterval(() => {
      const key = USAGE_REPORT_RANGE_KEYS[tick % USAGE_REPORT_RANGE_KEYS.length];
      tick += 1;
      void this.refreshRange(key).catch((err: any) => {
        logger.warn('[UsageReportStats] Scheduled range refresh failed', { key, error: err?.message });
      });
    }, REFRESH_INTERVAL_MS / USAGE_REPORT_RANGE_KEYS.length);

    logger.info('[UsageReportStats] Scheduler started (one range every 2.5 min, full cycle 10 min)');
  }
}

export const usageReportStatsService = new UsageReportStatsService();
