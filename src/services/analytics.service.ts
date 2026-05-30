import mongoose from 'mongoose';
import Conversation from '../models/Conversation';
import Message from '../models/Message';
import Profile from '../models/Profile';
import User from '../models/User';
import redisClient, { isRedisAvailable } from '../config/redis';
import { AppError } from '../middleware/error.middleware';
import { Parser } from 'json2csv';
import { analyticsService as centralizedAnalyticsService } from './analytics/analytics.service';
import { callMetricsService } from './analytics/callMetrics.service';
import { chatMetricsService } from './analytics/chatMetrics.service';
import { logger } from '../utils/logger.util';

import { usageTrackerService, UsageDateRange } from './usage/usageTracker.service';

type GroupBy = 'hour' | 'day' | 'week' | 'month';

function buildOrgDateQuery(
  organizationId: string,
  dateFrom?: string,
  dateTo?: string,
  channel?: string
): Record<string, unknown> {
  const orgId = new mongoose.Types.ObjectId(organizationId);
  const dateQuery: Record<string, unknown> = { organizationId: orgId };
  if (dateFrom || dateTo) {
    const createdAt: Record<string, Date> = {};
    if (dateFrom) createdAt.$gte = new Date(dateFrom);
    if (dateTo) createdAt.$lte = new Date(dateTo);
    dateQuery.createdAt = createdAt;
  }
  if (channel && channel !== 'all') {
    if (channel === 'instagram' || channel === 'facebook') {
      dateQuery.channel = 'social';
      dateQuery['metadata.platform'] = channel;
    } else if (channel === 'telegram') {
      dateQuery.channel = 'social';
      dateQuery['metadata.platform'] = 'telegram';
    } else {
      dateQuery.channel = channel;
    }
  }
  return dateQuery;
}

function toUsageRange(dateFrom?: string, dateTo?: string): UsageDateRange | undefined {
  if (!dateFrom && !dateTo) return undefined;
  return {
    dateFrom: dateFrom ? new Date(dateFrom) : undefined,
    dateTo: dateTo ? new Date(dateTo) : undefined
  };
}

function getPreviousPeriod(dateFrom?: string, dateTo?: string): UsageDateRange | undefined {
  if (!dateFrom || !dateTo) return undefined;
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  const durationMs = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - durationMs);
  return { dateFrom: prevFrom, dateTo: prevTo };
}

function pctChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function buildPeriodList(
  groupBy: GroupBy,
  dateFrom?: string,
  dateTo?: string
): string[] {
  const fromDate = new Date(dateFrom || Date.now() - 7 * 24 * 60 * 60 * 1000);
  const toDate = new Date(dateTo || Date.now());
  const periods: string[] = [];

  if (groupBy === 'hour') {
    const current = new Date(fromDate);
    current.setMinutes(0, 0, 0);
    const end = new Date(toDate);
    end.setMinutes(59, 59, 999);
    while (current <= end) {
      const y = current.getFullYear();
      const m = String(current.getMonth() + 1).padStart(2, '0');
      const d = String(current.getDate()).padStart(2, '0');
      const h = String(current.getHours()).padStart(2, '0');
      periods.push(`${y}-${m}-${d} ${h}:00`);
      current.setHours(current.getHours() + 1);
    }
    return periods;
  }

  const current = new Date(fromDate);
  current.setHours(12, 0, 0, 0);
  const end = new Date(toDate);
  end.setHours(12, 0, 0, 0);

  while (current <= end) {
    if (groupBy === 'day') {
      periods.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    } else if (groupBy === 'week') {
      const oneJan = new Date(current.getFullYear(), 0, 1);
      const week = Math.ceil(
        ((current.getTime() - oneJan.getTime()) / 86400000 + oneJan.getDay() + 1) / 7
      );
      periods.push(`${current.getFullYear()}-W${String(week).padStart(2, '0')}`);
      current.setDate(current.getDate() + 7);
    } else {
      periods.push(`${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`);
      current.setMonth(current.getMonth() + 1);
    }
  }

  return periods.length ? periods : [toDate.toISOString().split('T')[0]];
}

function formatTrendSeries(
  data: Array<{ _id: string; [key: string]: unknown }>,
  allPeriods: string[],
  valueKey: string,
  aggregateKey = 'count'
) {
  return allPeriods.map((period) => {
    const entry = data.find((d) => d._id === period);
    let value = 0;
    if (entry) {
      if (entry[aggregateKey] !== undefined) value = Number(entry[aggregateKey]) || 0;
      else if (entry.count !== undefined) value = Number(entry.count) || 0;
    }
    return { period, [valueKey]: value };
  });
}

export class AnalyticsService {
  /** Fast org-scoped summary — same pattern as admin usage reports (<1s). */
  async getSummaryMetrics(
    organizationId: string,
    dateFrom?: string,
    dateTo?: string,
    channel?: string,
    comparePrevious = true
  ) {
    const cacheKey = `analytics_summary:${organizationId}:${dateFrom}:${dateTo}:${channel}:${comparePrevious}`;
    if (isRedisAvailable()) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) return JSON.parse(cached);
      } catch (_) { /* fall through */ }
    }

    const range = toUsageRange(dateFrom, dateTo);
    const dateQuery = buildOrgDateQuery(organizationId, dateFrom, dateTo, channel);

    const fetchCurrent = async () => {
      const [callStats, totalChatConversations, totalConversations, channelRows] =
        await Promise.all([
          usageTrackerService.calculateCallMinutesStats(organizationId, range, channel),
          usageTrackerService.calculateOrganizationChatConversations(organizationId, range),
          Conversation.countDocuments(dateQuery),
          Conversation.aggregate([
            { $match: dateQuery },
            {
              $project: {
                ch: {
                  $cond: {
                    if: { $eq: ['$channel', 'social'] },
                    then: {
                      $cond: {
                        if: { $eq: ['$metadata.platform', 'instagram'] },
                        then: 'instagram',
                        else: {
                          $cond: {
                            if: { $eq: ['$metadata.platform', 'facebook'] },
                            then: 'facebook',
                            else: {
                              $cond: {
                                if: { $eq: ['$metadata.platform', 'telegram'] },
                                then: 'telegram',
                                else: 'social'
                              }
                            }
                          }
                        }
                      }
                    },
                    else: '$channel'
                  }
                }
              }
            },
            { $group: { _id: '$ch', count: { $sum: 1 } } }
          ])
        ]);

      const conversationsByChannel = (channelRows as Array<{ _id: string; count: number }>).reduce(
        (acc, row) => {
          acc[row._id] = row.count;
          return acc;
        },
        {} as Record<string, number>
      );

      const activeChannels = Object.values(conversationsByChannel).filter((c) => c > 0).length;
      const avgCallDurationMinutes =
        callStats.callCount > 0
          ? Math.round((callStats.minutes / callStats.callCount) * 10) / 10
          : 0;

      return {
        totalCallMinutes: callStats.minutes,
        totalCallCount: callStats.callCount,
        avgCallDurationMinutes,
        totalChatConversations,
        totalConversations,
        conversationsByChannel,
        activeChannels
      };
    };

    const current = await fetchCurrent();

    let previous: typeof current | null = null;
    let changePercent: Record<string, number> | null = null;

    if (comparePrevious && dateFrom && dateTo) {
      const prevRange = getPreviousPeriod(dateFrom, dateTo);
      if (prevRange?.dateFrom && prevRange?.dateTo) {
        const prevFrom = prevRange.dateFrom.toISOString();
        const prevTo = prevRange.dateTo.toISOString();
        previous = await (async () => {
          const prevUsageRange = toUsageRange(prevFrom, prevTo);
          const prevDateQuery = buildOrgDateQuery(organizationId, prevFrom, prevTo, channel);
          const [callStats, totalChatConversations, totalConversations] = await Promise.all([
            usageTrackerService.calculateCallMinutesStats(organizationId, prevUsageRange, channel),
            usageTrackerService.calculateOrganizationChatConversations(organizationId, prevUsageRange),
            Conversation.countDocuments(prevDateQuery)
          ]);
          return {
            totalCallMinutes: callStats.minutes,
            totalCallCount: callStats.callCount,
            avgCallDurationMinutes:
              callStats.callCount > 0
                ? Math.round((callStats.minutes / callStats.callCount) * 10) / 10
                : 0,
            totalChatConversations,
            totalConversations,
            conversationsByChannel: {},
            activeChannels: 0
          };
        })();

        changePercent = {
          totalCallMinutes: pctChange(current.totalCallMinutes, previous.totalCallMinutes),
          totalConversations: pctChange(current.totalConversations, previous.totalConversations),
          totalChatConversations: pctChange(
            current.totalChatConversations,
            previous.totalChatConversations
          )
        };
      }
    }

    const result = { current, previous, changePercent };

    if (isRedisAvailable()) {
      try {
        await redisClient.setEx(cacheKey, 300, JSON.stringify(result));
      } catch (_) { /* ignore */ }
    }

    return result;
  }

  // Dashboard Metrics
  async getDashboardMetrics(organizationId: string, dateFrom?: string, dateTo?: string, channel?: string) {
    const cacheKey = `dashboard_metrics:${organizationId}:${dateFrom}:${dateTo}:${channel}`;

    // Check Redis cache first
    if (isRedisAvailable()) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) return JSON.parse(cached);
      } catch (_) { /* fall through */ }
    }

    const orgId = new mongoose.Types.ObjectId(organizationId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dateQuery: any = { organizationId: orgId };
    if (dateFrom || dateTo) {
      dateQuery.createdAt = {};
      if (dateFrom) dateQuery.createdAt.$gte = new Date(dateFrom);
      if (dateTo) dateQuery.createdAt.$lte = new Date(dateTo);
    }
    if (channel && channel !== 'all') {
      if (channel === 'instagram' || channel === 'facebook') {
        dateQuery.channel = 'social';
        dateQuery['metadata.platform'] = channel;
      } else {
        dateQuery.channel = channel;
      }
    }

    // Single $facet aggregation replaces 8+ separate Conversation queries
    const [convFacetResult] = await Conversation.aggregate([
      { $match: dateQuery },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                active: { $sum: { $cond: [{ $in: ['$status', ['open', 'unread', 'support_request']] }, 1, 0] } },
                closed: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } },
                aiManaged: { $sum: { $cond: ['$isAiManaging', 1, 0] } },
                humanManaged: { $sum: { $cond: [{ $not: '$isAiManaging' }, 1, 0] } },
                reopened: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $in: ['$status', ['open', 'unread', 'support_request']] },
                          { $ifNull: ['$resolvedAt', false] }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                }
              }
            }
          ],
          avgResponseTime: [
            { $match: { firstResponseAt: { $exists: true, $ne: null } } },
            {
              $group: {
                _id: null,
                avg: {
                  $avg: {
                    $divide: [{ $subtract: ['$firstResponseAt', '$createdAt'] }, 60000]
                  }
                }
              }
            }
          ],
          byStatus: [
            { $group: { _id: '$status', count: { $sum: 1 } } }
          ],
          byChannel: [
            {
              $project: {
                ch: {
                  $cond: {
                    if: { $eq: ['$channel', 'social'] },
                    then: {
                      $cond: {
                        if: { $eq: ['$metadata.platform', 'instagram'] },
                        then: 'instagram',
                        else: { $cond: { if: { $eq: ['$metadata.platform', 'facebook'] }, then: 'facebook', else: 'social' } }
                      }
                    },
                    else: '$channel'
                  }
                }
              }
            },
            { $group: { _id: '$ch', count: { $sum: 1 } } }
          ]
        }
      }
    ]);

    const totals = convFacetResult?.totals?.[0] ?? {};
    const avgResponseTime = Math.round(convFacetResult?.avgResponseTime?.[0]?.avg ?? 0);
    const statusBreakdown = (convFacetResult?.byStatus ?? []).reduce((acc: any, item: any) => {
      acc[item._id] = item.count; return acc;
    }, {} as Record<string, number>);
    const channelBreakdown = (convFacetResult?.byChannel ?? []).reduce((acc: any, item: any) => {
      acc[item._id] = item.count; return acc;
    }, {} as Record<string, number>);

    // Messages today: use organizationId on Message directly when available; Redis counter as fast override
    let messagesTodayCount = 0;
    if (isRedisAvailable()) {
      try {
        const redisTodayCount = await redisClient.get('messages_today_count');
        if (redisTodayCount) {
          messagesTodayCount = parseInt(redisTodayCount);
        }
      } catch (_) { /* fall through to DB */ }
    }
    if (messagesTodayCount === 0) {
      messagesTodayCount = await Message.countDocuments({
        organizationId: orgId,
        timestamp: { $gte: today }
      });
    }

    // Wrong answers and links: query Message directly by organizationId
    const msgDateFilter: any = {};
    if (dateFrom || dateTo) {
      msgDateFilter.timestamp = {};
      if (dateFrom) msgDateFilter.timestamp.$gte = new Date(dateFrom);
      if (dateTo) msgDateFilter.timestamp.$lte = new Date(dateTo);
    }

    const [wrongAnswers, linksClicked] = await Promise.all([
      Message.countDocuments({
        organizationId: orgId,
        sender: 'ai',
        ...msgDateFilter,
        $or: [
          { 'metadata.confidence': { $lt: 0.5 } },
          { 'metadata.feedback': 'negative' },
          { 'metadata.isWrongAnswer': true }
        ]
      }),
      Message.countDocuments({
        organizationId: orgId,
        ...msgDateFilter,
        text: { $regex: /https?:\/\/[^\s]+/i }
      })
    ]);

    // Use centralized analytics service for call/chat metrics
    const dateRange = (dateFrom || dateTo) ? {
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined
    } : undefined;

    let totalCallMinutes = 0;
    let chatConversationsCount = 0;

    if (channel && channel !== 'all') {
      if (channel === 'phone') {
        const callMetrics = await callMetricsService.getOrganizationCallMetrics(organizationId, dateRange);
        totalCallMinutes = callMetrics.totalCallMinutes;
      } else {
        const chatMetrics = await chatMetricsService.getOrganizationChatMetrics(organizationId, dateRange, channel);
        chatConversationsCount = chatMetrics.totalConversations;
      }
    } else {
      const orgMetrics = await centralizedAnalyticsService.getOrganizationMetrics(organizationId, dateRange);
      totalCallMinutes = orgMetrics.callMinutes;
      chatConversationsCount = orgMetrics.totalConversations;
    }

    const metrics = {
      totalConversations: totals.total ?? 0,
      activeConversations: totals.active ?? 0,
      closedConversations: totals.closed ?? 0,
      reopenedConversations: totals.reopened ?? 0,
      wrongAnswers,
      linksClicked,
      aiManaged: totals.aiManaged ?? 0,
      humanManaged: totals.humanManaged ?? 0,
      avgResponseTime,
      customerSatisfactionScore: null,
      messagesToday: messagesTodayCount,
      conversationsByChannel: channelBreakdown,
      conversationsByStatus: statusBreakdown,
      totalCallMinutes,
      totalChatConversations: chatConversationsCount
    };

    // Cache for 5 minutes
    if (isRedisAvailable()) {
      try { await redisClient.setEx(cacheKey, 300, JSON.stringify(metrics)); } catch (_) { }
    }

    return metrics;
  }

  // Conversation Trends (slim — chart metrics only, cached)
  async getConversationTrends(
    organizationId: string,
    groupBy: GroupBy = 'day',
    dateFrom?: string,
    dateTo?: string,
    channel?: string
  ) {
    const cacheKey = `analytics_trends:${organizationId}:${dateFrom}:${dateTo}:${channel}:${groupBy}`;
    if (isRedisAvailable()) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) return JSON.parse(cached);
      } catch (_) { /* fall through */ }
    }

    const dateQuery = buildOrgDateQuery(organizationId, dateFrom, dateTo, channel);
    const range = toUsageRange(dateFrom, dateTo);
    const dateFormat: Record<string, string> = {
      hour: '%Y-%m-%d %H:00',
      day: '%Y-%m-%d',
      week: '%Y-W%V',
      month: '%Y-%m'
    };

    const [newConversations, chatConversations, callMinutesByPeriod] = await Promise.all([
      Conversation.aggregate([
        { $match: dateQuery },
        {
          $group: {
            _id: { $dateToString: { format: dateFormat[groupBy], date: '$createdAt' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      Conversation.aggregate([
        {
          $match: {
            ...dateQuery,
            channel: { $ne: 'phone' }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: dateFormat[groupBy], date: '$createdAt' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      usageTrackerService.calculateCallMinutesByPeriod(organizationId, range, groupBy, channel)
    ]);

    const allPeriods = buildPeriodList(groupBy, dateFrom, dateTo);

    const callMinutesTrend = callMinutesByPeriod.map((r) => ({
      _id: r.period,
      minutes: r.minutes,
      callCount: r.callCount
    }));

    const result = {
      newConversations: formatTrendSeries(newConversations, allPeriods, 'count'),
      chatConversations: formatTrendSeries(chatConversations, allPeriods, 'count'),
      callMinutes: formatTrendSeries(callMinutesTrend, allPeriods, 'minutes', 'minutes'),
      callCounts: allPeriods.map((period) => {
        const entry = callMinutesByPeriod.find((r) => r.period === period);
        return { period, count: entry?.callCount ?? 0 };
      })
    };

    if (isRedisAvailable()) {
      try {
        await redisClient.setEx(cacheKey, 300, JSON.stringify(result));
      } catch (_) { /* ignore */ }
    }

    return result;
  }

  /** Lazy-loaded quality trends for insights row (response time + resolution rate). */
  async getQualityTrends(
    organizationId: string,
    groupBy: GroupBy = 'day',
    dateFrom?: string,
    dateTo?: string,
    channel?: string
  ) {
    const cacheKey = `analytics_quality:${organizationId}:${dateFrom}:${dateTo}:${channel}:${groupBy}`;
    if (isRedisAvailable()) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) return JSON.parse(cached);
      } catch (_) { /* fall through */ }
    }

    const dateQuery = buildOrgDateQuery(organizationId, dateFrom, dateTo, channel);
    const dateFormat: Record<string, string> = {
      hour: '%Y-%m-%d %H:00',
      day: '%Y-%m-%d',
      week: '%Y-W%V',
      month: '%Y-%m'
    };

    const [responseTimes, resolutionRates] = await Promise.all([
      Conversation.aggregate([
        {
          $match: {
            ...dateQuery,
            firstResponseAt: { $exists: true, $ne: null }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: dateFormat[groupBy], date: '$createdAt' } },
            avgResponseTime: {
              $avg: {
                $divide: [{ $subtract: ['$firstResponseAt', '$createdAt'] }, 60000]
              }
            }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      Conversation.aggregate([
        { $match: dateQuery },
        {
          $group: {
            _id: { $dateToString: { format: dateFormat[groupBy], date: '$createdAt' } },
            total: { $sum: 1 },
            resolved: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } }
          }
        },
        {
          $project: {
            resolutionRate: {
              $cond: {
                if: { $eq: ['$total', 0] },
                then: 0,
                else: {
                  $multiply: [{ $divide: ['$resolved', '$total'] }, 100]
                }
              }
            }
          }
        },
        { $sort: { _id: 1 } }
      ])
    ]);

    const allPeriods = buildPeriodList(groupBy, dateFrom, dateTo);
    const result = {
      responseTimes: formatTrendSeries(responseTimes, allPeriods, 'avgResponseTime', 'avgResponseTime').map(
        (row) => ({
          period: row.period,
          avgResponseTime: Math.round((row.avgResponseTime as number) || 0)
        })
      ),
      resolutionRates: formatTrendSeries(resolutionRates, allPeriods, 'resolutionRate', 'resolutionRate').map(
        (row) => ({
          period: row.period,
          resolutionRate: Math.round((row.resolutionRate as number) || 0)
        })
      )
    };

    if (isRedisAvailable()) {
      try {
        await redisClient.setEx(cacheKey, 300, JSON.stringify(result));
      } catch (_) { /* ignore */ }
    }

    return result;
  }

  // Performance Metrics
  async getPerformanceMetrics(
    organizationId: string,
    dateFrom?: string,
    dateTo?: string,
    operatorId?: string
  ) {
    const dateQuery: any = { organizationId };
    if (dateFrom || dateTo) {
      dateQuery.createdAt = {};
      if (dateFrom) dateQuery.createdAt.$gte = new Date(dateFrom);
      if (dateTo) dateQuery.createdAt.$lte = new Date(dateTo);
    }

    const conversationQuery: any = { ...dateQuery };
    if (operatorId) {
      conversationQuery.assignedOperatorId = operatorId;
    }

    const orgObjectId = new mongoose.Types.ObjectId(organizationId);

    const [firstResponseAgg, resolutionAgg] = await Promise.all([
      Conversation.aggregate([
        {
          $match: {
            ...conversationQuery,
            organizationId: orgObjectId,
            firstResponseAt: { $exists: true, $ne: null }
          }
        },
        {
          $group: {
            _id: null,
            avg: {
              $avg: {
                $divide: [{ $subtract: ['$firstResponseAt', '$createdAt'] }, 60000]
              }
            }
          }
        }
      ]),
      Conversation.aggregate([
        {
          $match: {
            ...conversationQuery,
            organizationId: orgObjectId,
            resolvedAt: { $exists: true, $ne: null }
          }
        },
        {
          $group: {
            _id: null,
            avg: {
              $avg: {
                $divide: [{ $subtract: ['$resolvedAt', '$createdAt'] }, 60000]
              }
            }
          }
        }
      ])
    ]);

    const avgFirstResponseTime = Math.round(firstResponseAgg[0]?.avg ?? 0);
    const avgResolutionTime = Math.round(resolutionAgg[0]?.avg ?? 0);

    // Conversations per operator
    const conversationsPerOperator = await Conversation.aggregate([
      { $match: { ...dateQuery, assignedOperatorId: { $exists: true } } },
      {
        $group: {
          _id: '$assignedOperatorId',
          totalHandled: { $sum: 1 },
          resolved: {
            $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] }
          }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'operator'
        }
      },
      { $unwind: '$operator' },
      {
        $project: {
          operatorId: '$_id',
          operatorName: {
            $concat: ['$operator.firstName', ' ', '$operator.lastName']
          },
          totalHandled: 1,
          resolved: 1,
          resolutionRate: {
            $multiply: [
              {
                $cond: {
                  if: { $eq: ['$totalHandled', 0] },
                  then: 0,
                  else: {
                    $divide: [
                      { $convert: { input: '$resolved', to: 'double', onError: 0, onNull: 0 } },
                      { $convert: { input: '$totalHandled', to: 'double', onError: 1, onNull: 1 } }
                    ]
                  }
                }
              },
              100
            ]
          }
        }
      },
      { $sort: { totalHandled: -1 } }
    ]);

    // AI vs Human performance
    const aiPerformance = await Conversation.aggregate([
      { $match: { ...dateQuery, isAiManaging: true } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          resolved: {
            $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] }
          }
        }
      }
    ]);

    const humanPerformance = await Conversation.aggregate([
      { $match: { ...dateQuery, isAiManaging: false } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          resolved: {
            $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] }
          }
        }
      }
    ]);

    // Busiest hours/days
    const busiestHours = await Conversation.aggregate([
      { $match: dateQuery },
      {
        $group: {
          _id: { $hour: '$createdAt' },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);

    const busiestDays = await Conversation.aggregate([
      { $match: dateQuery },
      {
        $group: {
          _id: { $dayOfWeek: '$createdAt' },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    return {
      avgFirstResponseTime,
      avgResolutionTime,
      conversationsPerOperator,
      aiVsHuman: {
        ai: {
          total: aiPerformance[0]?.total || 0,
          resolved: aiPerformance[0]?.resolved || 0,
          resolutionRate: aiPerformance[0]
            ? Math.round((aiPerformance[0].resolved / aiPerformance[0].total) * 100)
            : 0
        },
        human: {
          total: humanPerformance[0]?.total || 0,
          resolved: humanPerformance[0]?.resolved || 0,
          resolutionRate: humanPerformance[0]
            ? Math.round((humanPerformance[0].resolved / humanPerformance[0].total) * 100)
            : 0
        }
      },
      busiestHours: busiestHours.map(item => ({
        hour: `${item._id}:00`,
        count: item.count
      })),
      busiestDays: busiestDays.map(item => ({
        day: dayNames[item._id - 1],
        count: item.count
      }))
    };
  }

  // Export Data — hard-capped at 2000 rows to prevent N+1 query bomb
  async exportData(organizationId: string, format: 'csv' | 'json', filters: any = {}) {
    const EXPORT_LIMIT = 2000;
    const orgId = new mongoose.Types.ObjectId(organizationId);
    const query: any = { organizationId: orgId };

    if (filters.dateFrom || filters.dateTo) {
      query.createdAt = {};
      if (filters.dateFrom) query.createdAt.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) query.createdAt.$lte = new Date(filters.dateTo);
    }
    if (filters.status) query.status = filters.status;
    if (filters.channel) query.channel = filters.channel;

    const conversations = await Conversation.find(query)
      .populate('customerId', 'name email phone')
      .populate('assignedOperatorId', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .limit(EXPORT_LIMIT)
      .lean();

    const convIds = conversations.map((c: any) => c._id);

    // Fetch first + last message per conversation in a single aggregation — no N+1
    const msgSummaries = convIds.length > 0
      ? await Message.aggregate([
          { $match: { conversationId: { $in: convIds }, type: 'message' } },
          { $sort: { conversationId: 1, timestamp: 1 } },
          {
            $group: {
              _id: '$conversationId',
              count: { $sum: 1 },
              firstMessage: { $first: '$text' },
              lastMessage: { $last: '$text' }
            }
          }
        ])
      : [];

    const msgMap = new Map(msgSummaries.map((m: any) => [m._id.toString(), m]));

    const conversationsWithMessages = conversations.map((conv: any) => {
      const msgs = msgMap.get(conv._id.toString());
      return {
        conversationId: conv._id,
        customer: conv.customerId?.name || 'Unknown',
        customerEmail: conv.customerId?.email || '',
        customerPhone: conv.customerId?.phone || '',
        channel: conv.channel,
        status: conv.status,
        assignedTo: conv.assignedOperatorId
          ? `${conv.assignedOperatorId.firstName} ${conv.assignedOperatorId.lastName}`
          : 'AI',
        isAiManaged: conv.isAiManaging,
        messageCount: msgs?.count ?? 0,
        firstMessage: msgs?.firstMessage ?? '',
        lastMessage: msgs?.lastMessage ?? '',
        createdAt: conv.createdAt,
        resolvedAt: conv.resolvedAt || null
      };
    });

    if (format === 'json') {
      return {
        format: 'json',
        data: conversationsWithMessages
      };
    } else {
      // CSV format
      const fields = [
        'conversationId',
        'customer',
        'customerEmail',
        'customerPhone',
        'channel',
        'status',
        'assignedTo',
        'isAiManaged',
        'messageCount',
        'firstMessage',
        'lastMessage',
        'createdAt',
        'resolvedAt'
      ];

      const json2csvParser = new Parser({ fields });
      const csv = json2csvParser.parse(conversationsWithMessages);

      return {
        format: 'csv',
        data: csv
      };
    }
  }

  // Real-time counter methods
  async incrementMessagesToday() {
    if (isRedisAvailable()) {
      try {
        await redisClient.incr('messages_today_count');
      } catch (error) {
        // Silently fail if Redis is unavailable
      }
    }
  }

  async incrementConversationsToday() {
    if (isRedisAvailable()) {
      try {
        await redisClient.incr('conversations_today_count');
      } catch (error) {
        // Silently fail if Redis is unavailable
      }
    }
  }

  async updateActiveConversationsCount(delta: number) {
    if (isRedisAvailable()) {
      try {
        await redisClient.incrBy('active_conversations_count', delta);
      } catch (error) {
        // Silently fail if Redis is unavailable
      }
    }
  }

  async resetDailyCounters() {
    if (isRedisAvailable()) {
      try {
        await redisClient.set('messages_today_count', '0');
        await redisClient.set('conversations_today_count', '0');
      } catch (error) {
        // Silently fail if Redis is unavailable
      }
    }
  }
}

export const analyticsService = new AnalyticsService();

