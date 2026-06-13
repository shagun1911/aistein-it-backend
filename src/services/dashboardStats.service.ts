import Organization from '../models/Organization';
import User from '../models/User';
import Automation from '../models/Automation';
import AutomationExecution from '../models/AutomationExecution';
import GoogleIntegration from '../models/GoogleIntegration';
import SocialIntegration from '../models/SocialIntegration';
import Settings from '../models/Settings';
import DashboardStats, { IDashboardStats } from '../models/DashboardStats';
import { usageTrackerService, mapWithConcurrency } from './usage/usageTracker.service';
import { logger } from '../utils/logger.util';

export const PLATFORM_STATS_KEY = 'platform';

const REDIS_STATS_KEY = 'dashboard:stats:platform:v1';
const REDIS_STATS_STALE_KEY = 'dashboard:stats:platform:stale:v1';
const REDIS_TTL_SEC = 300;
const REDIS_STALE_TTL_SEC = 7 * 24 * 3600;
const LOCAL_TTL_MS = 60_000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const COUNT_CONCURRENCY = 4;

export type DashboardCountsSnapshot = Pick<
  IDashboardStats,
  | 'totalOrganizations'
  | 'activeOrganizations'
  | 'totalUsers'
  | 'totalAutomations'
  | 'activeAutomations'
  | 'totalExecutions'
  | 'failedExecutions'
  | 'googleIntegrations'
  | 'whatsappIntegrations'
  | 'instagramIntegrations'
  | 'facebookIntegrations'
  | 'ecommerceIntegrations'
>;

export type DashboardUsageSnapshot = Pick<
  IDashboardStats,
  'totalCallMinutes' | 'totalChatConversations'
>;

type StatsSnapshot = DashboardCountsSnapshot &
  DashboardUsageSnapshot & {
    computedAt?: Date;
    computeDurationMs?: number;
  };

let localSnapshot: { value: StatsSnapshot; expiresAt: number } | null = null;
let refreshInFlight: Promise<void> | null = null;
let schedulerStarted = false;

async function redisGet(key: string): Promise<StatsSnapshot | null> {
  try {
    const { default: redisClient, isRedisAvailable } = await import('../config/redis');
    if (!isRedisAvailable()) return null;
    const raw = await redisClient.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as StatsSnapshot;
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: StatsSnapshot, ttlSec: number): Promise<void> {
  try {
    const { default: redisClient, isRedisAvailable } = await import('../config/redis');
    if (!isRedisAvailable()) return;
    await redisClient.setEx(key, ttlSec, JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}

function toCounts(doc: StatsSnapshot): DashboardCountsSnapshot {
  return {
    totalOrganizations: doc.totalOrganizations ?? 0,
    activeOrganizations: doc.activeOrganizations ?? 0,
    totalUsers: doc.totalUsers ?? 0,
    totalAutomations: doc.totalAutomations ?? 0,
    activeAutomations: doc.activeAutomations ?? 0,
    totalExecutions: doc.totalExecutions ?? 0,
    failedExecutions: doc.failedExecutions ?? 0,
    googleIntegrations: doc.googleIntegrations ?? 0,
    whatsappIntegrations: doc.whatsappIntegrations ?? 0,
    instagramIntegrations: doc.instagramIntegrations ?? 0,
    facebookIntegrations: doc.facebookIntegrations ?? 0,
    ecommerceIntegrations: doc.ecommerceIntegrations ?? 0
  };
}

function toUsage(doc: StatsSnapshot): DashboardUsageSnapshot {
  return {
    totalCallMinutes: doc.totalCallMinutes ?? 0,
    totalChatConversations: doc.totalChatConversations ?? 0
  };
}

function setLocalSnapshot(snapshot: StatsSnapshot): void {
  localSnapshot = { value: snapshot, expiresAt: Date.now() + LOCAL_TTL_MS };
}

function getLocalSnapshot(): StatsSnapshot | null {
  if (localSnapshot && localSnapshot.expiresAt > Date.now()) {
    return localSnapshot.value;
  }
  return null;
}

/** Last in-process snapshot even if TTL expired — used when Mongo/Redis blip. */
function getExpiredLocalSnapshot(): StatsSnapshot | null {
  return localSnapshot?.value ?? null;
}

async function readFromMongoSafe(): Promise<StatsSnapshot | null> {
  try {
    return await readFromMongo();
  } catch (err: any) {
    logger.warn('[DashboardStats] dashboard_stats findOne failed', { error: err?.message });
    return null;
  }
}

async function resolveStaleSnapshot(): Promise<StatsSnapshot | null> {
  return (
    (await redisGet(REDIS_STATS_STALE_KEY)) ??
    (await redisGet(REDIS_STATS_KEY)) ??
    getExpiredLocalSnapshot()
  );
}

/**
 * Fast execution total for background refresh — reads collection metadata (~ms),
 * not a full scan of ~1.4M docs. Falls back to the last stored value on failure.
 */
async function estimatedTotalExecutionsCount(previousValue = 0): Promise<number> {
  try {
    const estimate = await AutomationExecution.estimatedDocumentCount();
    if (Number.isFinite(estimate) && estimate >= 0) return estimate;
  } catch (err: any) {
    logger.warn('[DashboardStats] estimatedDocumentCount failed', { error: err?.message });
  }

  if (previousValue > 0) {
    logger.warn('[DashboardStats] Keeping previous totalExecutions after estimate failure', {
      previousValue
    });
    return previousValue;
  }

  return 0;
}

async function exactTotalExecutionsCount(): Promise<number> {
  return AutomationExecution.countDocuments();
}

/**
 * Background refresh path — runs platform aggregations off the admin HTTP hot path.
 * totalExecutions uses estimatedDocumentCount() to avoid holding a connection for ~30s+
 * on 1.4M+ documents; failedExecutions stays exact (small filtered set).
 */
async function computeStatsFromMongo(previousTotalExecutions = 0): Promise<StatsSnapshot> {
  const countJobs: Array<{ key: keyof DashboardCountsSnapshot; run: () => Promise<number> }> = [
    { key: 'totalOrganizations', run: () => Organization.countDocuments({ status: { $ne: 'deleted' } }) },
    { key: 'activeOrganizations', run: () => Organization.countDocuments({ status: 'active' }) },
    { key: 'totalUsers', run: () => User.countDocuments({ status: 'active' }) },
    { key: 'totalAutomations', run: () => Automation.countDocuments() },
    { key: 'activeAutomations', run: () => Automation.countDocuments({ isActive: true }) },
    { key: 'totalExecutions', run: () => estimatedTotalExecutionsCount(previousTotalExecutions) },
    { key: 'failedExecutions', run: () => AutomationExecution.countDocuments({ status: 'failed' }) },
    { key: 'googleIntegrations', run: () => GoogleIntegration.countDocuments({ status: 'active' }) },
    { key: 'whatsappIntegrations', run: () => SocialIntegration.countDocuments({ platform: 'whatsapp', status: 'connected' }) },
    { key: 'instagramIntegrations', run: () => SocialIntegration.countDocuments({ platform: 'instagram', status: 'connected' }) },
    { key: 'facebookIntegrations', run: () => SocialIntegration.countDocuments({ platform: 'facebook', status: 'connected' }) },
    {
      key: 'ecommerceIntegrations',
      run: () => Settings.countDocuments({ 'ecommerceIntegration.platform': { $exists: true, $ne: null } })
    }
  ];

  const [countResults, callMinutes, chatConversations] = await Promise.all([
    mapWithConcurrency(countJobs, COUNT_CONCURRENCY, async (job) => ({
      key: job.key,
      value: await job.run()
    })),
    usageTrackerService.calculatePlatformCallMinutes(),
    usageTrackerService.calculatePlatformChatConversations()
  ]);

  const counts = countResults.reduce((acc, { key, value }) => {
    acc[key] = value;
    return acc;
  }, {} as DashboardCountsSnapshot);

  return {
    ...counts,
    totalCallMinutes: callMinutes,
    totalChatConversations: chatConversations
  };
}

function docToSnapshot(doc: IDashboardStats | null): StatsSnapshot | null {
  if (!doc) return null;
  return {
    totalOrganizations: doc.totalOrganizations,
    activeOrganizations: doc.activeOrganizations,
    totalUsers: doc.totalUsers,
    totalAutomations: doc.totalAutomations,
    activeAutomations: doc.activeAutomations,
    totalExecutions: doc.totalExecutions,
    failedExecutions: doc.failedExecutions,
    googleIntegrations: doc.googleIntegrations,
    whatsappIntegrations: doc.whatsappIntegrations,
    instagramIntegrations: doc.instagramIntegrations,
    facebookIntegrations: doc.facebookIntegrations,
    ecommerceIntegrations: doc.ecommerceIntegrations,
    totalCallMinutes: doc.totalCallMinutes,
    totalChatConversations: doc.totalChatConversations,
    computedAt: doc.computedAt,
    computeDurationMs: doc.computeDurationMs
  };
}

async function readFromMongo(): Promise<StatsSnapshot | null> {
  const doc = await DashboardStats.findOne({ key: PLATFORM_STATS_KEY }).lean();
  return docToSnapshot(doc as IDashboardStats | null);
}

async function persistSnapshot(snapshot: StatsSnapshot, computeDurationMs: number): Promise<void> {
  const computedAt = new Date();
  const payload = {
    ...snapshot,
    computedAt,
    computeDurationMs
  };

  await DashboardStats.findOneAndUpdate(
    { key: PLATFORM_STATS_KEY },
    { key: PLATFORM_STATS_KEY, ...payload },
    { upsert: true, new: true }
  );

  setLocalSnapshot(snapshot);
  void redisSet(REDIS_STATS_KEY, snapshot, REDIS_TTL_SEC);
  void redisSet(REDIS_STATS_STALE_KEY, snapshot, REDIS_STALE_TTL_SEC);
}

export class DashboardStatsService {
  /**
   * Hot path: L1 memory → L2 Redis → L3 dashboard_stats.findOne().
   * Never runs live aggregations on the request thread.
   */
  async getSnapshot(): Promise<StatsSnapshot> {
    const local = getLocalSnapshot();
    if (local) return local;

    const redisHit = await redisGet(REDIS_STATS_KEY);
    if (redisHit) {
      setLocalSnapshot(redisHit);
      return redisHit;
    }

    const mongoHit = await readFromMongoSafe();
    if (mongoHit) {
      setLocalSnapshot(mongoHit);
      void redisSet(REDIS_STATS_KEY, mongoHit, REDIS_TTL_SEC);
      return mongoHit;
    }

    const stale = await resolveStaleSnapshot();
    if (stale) {
      logger.warn('[DashboardStats] Serving stale snapshot after read failure');
      setLocalSnapshot(stale);
      return stale;
    }

    // Refresh already running — wait briefly then read whatever was persisted
    if (refreshInFlight) {
      await Promise.race([
        refreshInFlight,
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
      const afterRefresh = await readFromMongoSafe();
      if (afterRefresh) {
        setLocalSnapshot(afterRefresh);
        return afterRefresh;
      }
      const staleAfter = await resolveStaleSnapshot();
      if (staleAfter) return staleAfter;
    }

    logger.info('[DashboardStats] No snapshot — starting background refresh');
    void this.refreshStats().catch((err: any) => {
      logger.warn('[DashboardStats] Background refresh failed', { error: err?.message });
    });
    throw new Error('Dashboard stats are being computed. Please retry in a few seconds.');
  }

  async getCounts(): Promise<DashboardCountsSnapshot> {
    return toCounts(await this.getSnapshot());
  }

  async getUsage(): Promise<DashboardUsageSnapshot> {
    return toUsage(await this.getSnapshot());
  }

  /** Full dashboard payload from a single findOne read. */
  async getDashboardPayload(): Promise<
    DashboardCountsSnapshot &
      DashboardUsageSnapshot & { computedAt?: Date; stale?: boolean }
  > {
    const snapshot = await this.getSnapshot();
    return {
      ...toCounts(snapshot),
      ...toUsage(snapshot),
      computedAt: snapshot.computedAt
    };
  }

  /**
   * Same queries as the 5-min background refresh (estimatedDocumentCount for executions).
   */
  async computeRefreshStats(previousTotalExecutions = 0): Promise<StatsSnapshot> {
    return computeStatsFromMongo(previousTotalExecutions);
  }

  /**
   * Exact stats computation with countDocuments() on executions. Slow (~30s+ at scale).
   * For verification scripts only — refresh uses estimatedDocumentCount() instead.
   */
  async computeExactStats(): Promise<StatsSnapshot> {
    const countJobs: Array<{ key: keyof DashboardCountsSnapshot; run: () => Promise<number> }> = [
      { key: 'totalOrganizations', run: () => Organization.countDocuments({ status: { $ne: 'deleted' } }) },
      { key: 'activeOrganizations', run: () => Organization.countDocuments({ status: 'active' }) },
      { key: 'totalUsers', run: () => User.countDocuments({ status: 'active' }) },
      { key: 'totalAutomations', run: () => Automation.countDocuments() },
      { key: 'activeAutomations', run: () => Automation.countDocuments({ isActive: true }) },
      { key: 'totalExecutions', run: () => exactTotalExecutionsCount() },
      { key: 'failedExecutions', run: () => AutomationExecution.countDocuments({ status: 'failed' }) },
      { key: 'googleIntegrations', run: () => GoogleIntegration.countDocuments({ status: 'active' }) },
      { key: 'whatsappIntegrations', run: () => SocialIntegration.countDocuments({ platform: 'whatsapp', status: 'connected' }) },
      { key: 'instagramIntegrations', run: () => SocialIntegration.countDocuments({ platform: 'instagram', status: 'connected' }) },
      { key: 'facebookIntegrations', run: () => SocialIntegration.countDocuments({ platform: 'facebook', status: 'connected' }) },
      {
        key: 'ecommerceIntegrations',
        run: () => Settings.countDocuments({ 'ecommerceIntegration.platform': { $exists: true, $ne: null } })
      }
    ];

    const [countResults, callMinutes, chatConversations] = await Promise.all([
      mapWithConcurrency(countJobs, COUNT_CONCURRENCY, async (job) => ({
        key: job.key,
        value: await job.run()
      })),
      usageTrackerService.calculatePlatformCallMinutes(),
      usageTrackerService.calculatePlatformChatConversations()
    ]);

    const counts = countResults.reduce((acc, { key, value }) => {
      acc[key] = value;
      return acc;
    }, {} as DashboardCountsSnapshot);

    return {
      ...counts,
      totalCallMinutes: callMinutes,
      totalChatConversations: chatConversations
    };
  }

  /**
   * Recompute all stats from MongoDB and persist to dashboard_stats + Redis.
   * Safe to call from cron, startup, or manual script.
   * Returns the snapshot that was persisted.
   */
  async refreshStats(): Promise<StatsSnapshot> {
    if (refreshInFlight) {
      await refreshInFlight;
      const doc = await readFromMongo();
      if (!doc) throw new Error('Refresh in flight completed but no snapshot found');
      return doc;
    }

    let persisted: StatsSnapshot | undefined;

    refreshInFlight = (async () => {
      const t0 = Date.now();
      try {
        const previous = await readFromMongoSafe();
        logger.info('[DashboardStats] Refreshing platform snapshot (estimated executions)...');
        const snapshot = await computeStatsFromMongo(previous?.totalExecutions ?? 0);
        const durationMs = Date.now() - t0;
        await persistSnapshot(snapshot, durationMs);
        persisted = snapshot;
        logger.info('[DashboardStats] Snapshot refreshed', {
          computeDurationMs: durationMs,
          totalOrganizations: snapshot.totalOrganizations,
          totalExecutions: snapshot.totalExecutions,
          totalExecutionsSource: 'estimatedDocumentCount',
          totalCallMinutes: snapshot.totalCallMinutes
        });
      } catch (err: any) {
        logger.error('[DashboardStats] Refresh failed', { error: err?.message });
        throw err;
      } finally {
        refreshInFlight = null;
      }
    })();

    await refreshInFlight;
    if (!persisted) throw new Error('Refresh completed without snapshot');
    return persisted;
  }

  /** Startup: ensure dashboard_stats row exists; refresh if missing or older than interval. */
  async warmOnStartup(): Promise<void> {
    try {
      const existing = await readFromMongo();
      if (existing?.computedAt) {
        const ageMs = Date.now() - new Date(existing.computedAt).getTime();
        setLocalSnapshot(existing);
        void redisSet(REDIS_STATS_KEY, existing, REDIS_TTL_SEC);
        logger.info('[DashboardStats] Loaded existing snapshot', {
          ageSec: Math.round(ageMs / 1000),
          totalOrganizations: existing.totalOrganizations
        });
        if (ageMs < REFRESH_INTERVAL_MS) return;
      }
      await this.refreshStats();
    } catch (err: any) {
      logger.warn('[DashboardStats] Startup warm failed (non-fatal)', { error: err?.message });
    }
  }

  startScheduler(): void {
    if (schedulerStarted) return;
    schedulerStarted = true;

    setInterval(() => {
      void this.refreshStats().catch((err: any) => {
        logger.warn('[DashboardStats] Scheduled refresh failed', { error: err?.message });
      });
    }, REFRESH_INTERVAL_MS);

    logger.info('[DashboardStats] Scheduler started (every 5 minutes)');
  }
}

export const dashboardStatsService = new DashboardStatsService();
