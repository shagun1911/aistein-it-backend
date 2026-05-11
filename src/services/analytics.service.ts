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

export class AnalyticsService {
  // Dashboard Metrics
  async getDashboardMetrics(organizationId: string, dateFrom?: string, dateTo?: string, channel?: string) {
    const cacheKey = `dashboard_metrics:${organizationId}:${dateFrom}:${dateTo}:${channel}`;

    // Try to get from cache (only if Redis is available)
    if (isRedisAvailable()) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      } catch (error) {
        // Continue without cache if Redis fails
      }
    }

    const orgId = new mongoose.Types.ObjectId(organizationId);
    const dateQuery: any = { organizationId: orgId };
    if (dateFrom || dateTo) {
      dateQuery.createdAt = {};
      if (dateFrom) dateQuery.createdAt.$gte = new Date(dateFrom);
      if (dateTo) dateQuery.createdAt.$lte = new Date(dateTo);
    }

    // Apply channel filter
    if (channel && channel !== 'all') {
      if (channel === 'instagram' || channel === 'facebook') {
        dateQuery.channel = 'social';
        dateQuery['metadata.platform'] = channel;
      } else {
        dateQuery.channel = channel;
      }
    }

    // Total conversations
    const totalConversations = await Conversation.countDocuments(dateQuery);

    // Active conversations
    const activeConversations = await Conversation.countDocuments({
      ...dateQuery,
      status: { $in: ['open', 'unread', 'support_request'] }
    });

    // Closed conversations
    const closedConversations = await Conversation.countDocuments({
      ...dateQuery,
      status: 'closed'
    });

    // AI vs Human managed
    const aiManagedCount = await Conversation.countDocuments({
      ...dateQuery,
      isAiManaging: true
    });

    const humanManagedCount = await Conversation.countDocuments({
      ...dateQuery,
      isAiManaging: false
    });

    // Average response time (in minutes)
    const conversationsWithResponse = await Conversation.find({
      ...dateQuery,
      firstResponseAt: { $exists: true }
    }).select('createdAt firstResponseAt').lean();

    let avgResponseTime = 0;
    if (conversationsWithResponse.length > 0) {
      const totalResponseTime = conversationsWithResponse.reduce((sum, conv) => {
        const responseTime = (conv.firstResponseAt!.getTime() - conv.createdAt.getTime()) / 1000 / 60;
        return sum + responseTime;
      }, 0);
      avgResponseTime = totalResponseTime / conversationsWithResponse.length;
    }

    // Messages sent today — scoped to this organization.
    // The global Redis counter (messages_today_count) is kept for backward compatibility
    // but the DB fallback is now org-scoped to avoid a full collection scan.
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Org-scoped DB count: get today's conversation IDs first, then count messages within them.
    const todayConvIds = await Conversation.find({ organizationId: orgId })
      .select('_id')
      .lean();
    const todayConvIdArr = todayConvIds.map((c) => c._id);
    const messagesToday = todayConvIdArr.length > 0
      ? await Message.countDocuments({
          conversationId: { $in: todayConvIdArr },
          timestamp: { $gte: today }
        })
      : 0;

    // Prefer the Redis real-time counter when available (still used as a fast approximation)
    let messagesTodayCount = messagesToday;
    if (isRedisAvailable()) {
      try {
        const messagesTodayRedis = await redisClient.get('messages_today_count');
        messagesTodayCount = messagesTodayRedis ? parseInt(messagesTodayRedis) : messagesToday;
      } catch (error) {
        // Fall back to DB count
      }
    }

    // Conversations by channel (separate Instagram and Facebook from social)
    const conversationsByChannel = await Conversation.aggregate([
      { $match: dateQuery },
      {
        $project: {
          channel: {
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
                      else: 'social'
                    }
                  }
                }
              },
              else: '$channel'
            }
          }
        }
      },
      { $group: { _id: '$channel', count: { $sum: 1 } } }
    ]);

    const channelBreakdown = conversationsByChannel.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {} as Record<string, number>);

    // Conversations by status
    const conversationsByStatus = await Conversation.aggregate([
      { $match: dateQuery },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const statusBreakdown = conversationsByStatus.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {} as Record<string, number>);

    // Reopened conversations (conversations that were closed then reopened)
    const reopenedConversations = await Conversation.countDocuments({
      ...dateQuery,
      status: { $in: ['open', 'unread', 'support_request'] },
      resolvedAt: { $exists: true } // Was resolved but now open again
    });

    // Wrong answers (messages with low confidence or negative feedback)
    // Get conversation IDs first, then check messages
    const conversationIds = await Conversation.find(dateQuery).select('_id').lean();
    const convIds = conversationIds.map(c => c._id);

    const wrongAnswersQuery: any = {
      conversationId: { $in: convIds },
      sender: 'ai'
    };
    if (dateFrom || dateTo) {
      wrongAnswersQuery.timestamp = {};
      if (dateFrom) wrongAnswersQuery.timestamp.$gte = new Date(dateFrom);
      if (dateTo) wrongAnswersQuery.timestamp.$lte = new Date(dateTo);
    }
    wrongAnswersQuery.$or = [
      { 'metadata.confidence': { $lt: 0.5 } },
      { 'metadata.feedback': 'negative' },
      { 'metadata.isWrongAnswer': true }
    ];

    const wrongAnswers = await Message.countDocuments(wrongAnswersQuery);

    // Links clicked (messages containing URLs)
    const linksClickedQuery: any = {
      conversationId: { $in: convIds }
    };
    if (dateFrom || dateTo) {
      linksClickedQuery.timestamp = {};
      if (dateFrom) linksClickedQuery.timestamp.$gte = new Date(dateFrom);
      if (dateTo) linksClickedQuery.timestamp.$lte = new Date(dateTo);
    }
    // Match messages containing URLs (http:// or https://)
    linksClickedQuery.text = { $regex: /https?:\/\/[^\s]+/i };
    // Count all messages with URLs (we'll track clicks separately if needed)
    const linksClicked = await Message.countDocuments(linksClickedQuery);

    // Use centralized analytics service for consistent calculations
    const dateRange = dateFrom || dateTo ? {
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined
    } : undefined;

    // Filter centralized metrics by channel if requested
    let totalCallMinutes = 0;
    let chatConversationsCount = 0;

    if (channel && channel !== 'all') {
      if (channel === 'phone') {
        const callMetrics = await callMetricsService.getOrganizationCallMetrics(organizationId, dateRange);
        totalCallMinutes = callMetrics.totalCallMinutes;
        chatConversationsCount = 0;
      } else {
        const chatMetrics = await chatMetricsService.getOrganizationChatMetrics(organizationId, dateRange, channel);
        chatConversationsCount = chatMetrics.totalConversations;
        totalCallMinutes = 0;
      }
    } else {
      const orgMetrics = await centralizedAnalyticsService.getOrganizationMetrics(organizationId, dateRange);
      totalCallMinutes = orgMetrics.callMinutes;
      chatConversationsCount = orgMetrics.totalConversations;
    }

    const metrics = {
      totalConversations,
      activeConversations,
      closedConversations,
      reopenedConversations,
      wrongAnswers,
      linksClicked,
      aiManaged: aiManagedCount,
      humanManaged: humanManagedCount,
      avgResponseTime: Math.round(avgResponseTime),
      customerSatisfactionScore: null,
      messagesToday: messagesTodayCount,
      conversationsByChannel: channelBreakdown,
      conversationsByStatus: statusBreakdown,
      totalCallMinutes: totalCallMinutes,
      totalChatConversations: chatConversationsCount
    };

    // Cache for 5 minutes (only if Redis is available)
    if (isRedisAvailable()) {
      try {
        await redisClient.setEx(cacheKey, 300, JSON.stringify(metrics));
      } catch (error) { }
    }

    return metrics;
  }

  // Conversation Trends
  async getConversationTrends(
    organizationId: string,
    groupBy: 'hour' | 'day' | 'week' | 'month' = 'day',
    dateFrom?: string,
    dateTo?: string,
    channel?: string
  ) {
    const orgId = new mongoose.Types.ObjectId(organizationId);
    const dateQuery: any = { organizationId: orgId };
    if (dateFrom || dateTo) {
      dateQuery.createdAt = {};
      if (dateFrom) dateQuery.createdAt.$gte = new Date(dateFrom);
      if (dateTo) dateQuery.createdAt.$lte = new Date(dateTo);
    }

    // Apply channel filter
    if (channel && channel !== 'all') {
      if (channel === 'instagram' || channel === 'facebook') {
        dateQuery.channel = 'social';
        dateQuery['metadata.platform'] = channel;
      } else {
        dateQuery.channel = channel;
      }
    }

    // Format string for date grouping
    const dateFormat: Record<string, string> = {
      hour: '%Y-%m-%d %H:00',
      day: '%Y-%m-%d',
      week: '%Y-W%V',
      month: '%Y-%m'
    };

    // New conversations over time
    const newConversations = await Conversation.aggregate([
      { $match: dateQuery },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat[groupBy], date: '$createdAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Get conversation IDs for this organization in date range to filter messages
    const organizationConversations = await Conversation.find(dateQuery).select('_id').lean();
    const conversationIds = organizationConversations.map(c => c._id);

    // Messages sent over time
    const messagesSent = conversationIds.length > 0 ? await Message.aggregate([
      { $match: { conversationId: { $in: conversationIds } } },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat[groupBy], date: '$timestamp' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]) : [];

    // Chat conversations over time (excluding phone)
    const chatConversations = await Conversation.aggregate([
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
    ]);

    // Response times over time (ensure numeric for $divide)
    const responseTimes = await Conversation.aggregate([
      {
        $match: {
          ...dateQuery,
          firstResponseAt: { $exists: true, $ne: null },
          createdAt: { $exists: true, $ne: null }
        }
      },
      {
        $project: {
          period: { $dateToString: { format: dateFormat[groupBy], date: '$createdAt' } },
          responseTime: {
            $cond: {
              if: { $and: [{ $gte: [{ $subtract: ['$firstResponseAt', '$createdAt'] }, 0] }] },
              then: { $divide: [{ $subtract: ['$firstResponseAt', '$createdAt'] }, 60000] },
              else: 0
            }
          }
        }
      },
      {
        $group: {
          _id: '$period',
          avgResponseTime: { $avg: '$responseTime' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Resolution rates over time
    const resolutionRates = await Conversation.aggregate([
      { $match: dateQuery },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat[groupBy], date: '$createdAt' } },
          total: { $sum: 1 },
          resolved: {
            $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] }
          }
        }
      },
      {
        $project: {
          _id: 1,
          resolutionRate: {
            $multiply: [
              {
                $cond: {
                  if: { $eq: ['$total', 0] },
                  then: 0,
                  else: {
                    $divide: [
                      { $convert: { input: '$resolved', to: 'double', onError: 0, onNull: 0 } },
                      { $convert: { input: '$total', to: 'double', onError: 1, onNull: 1 } }
                    ]
                  }
                }
              },
              100
            ]
          }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Get phone conversations for trend calculation
    const phoneConversations = await Conversation.find({
      ...dateQuery,
      channel: 'phone'
    }).select('transcript metadata createdAt updatedAt').lean();

    // Group call minutes by period in JS for consistency with CallMetricsService
    const callMinutesByPeriod: Record<string, number> = {};
    for (const conv of phoneConversations) {
      const period = new Date(conv.createdAt).toISOString().split('T')[0]; // Simple day grouping for now
      // Use the service logic
      const duration = callMetricsService.getCallDuration(conv) || 0;
      callMinutesByPeriod[period] = (callMinutesByPeriod[period] || 0) + duration;
    }

    const callMinutesTrend = Object.entries(callMinutesByPeriod).map(([_id, minutes]) => ({
      _id,
      minutes
    }));

    // Generate ALL periods in requested range to ensure continuous graphs
    const allPeriods: string[] = [];
    const fromDate = new Date(dateFrom || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    const toDate = new Date(dateTo || Date.now());

    // Normalize to noon to avoid DST issues
    const current = new Date(fromDate);
    current.setHours(12, 0, 0, 0);
    const end = new Date(toDate);
    end.setHours(12, 0, 0, 0);

    while (current <= end) {
      allPeriods.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }

    if (allPeriods.length === 0) {
      // Emergency fallback
      const now = new Date();
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(now.getDate() - i);
        allPeriods.push(d.toISOString().split('T')[0]);
      }
    }

    const formatTrend = (data: any[], key: string, aggregateKey: string = 'count') => {
      return allPeriods.map(period => {
        const entry = data.find(d => d._id === period);
        if (!entry) return { period, [key]: 0 };

        let value = 0;
        if (entry[aggregateKey] !== undefined) value = entry[aggregateKey];
        else if (entry.count !== undefined) value = entry.count;
        else if (entry.value !== undefined) value = entry.value;

        return {
          period,
          [key]: value
        };
      });
    };

    return {
      newConversations: formatTrend(newConversations, 'count'),
      messagesSent: formatTrend(messagesSent, 'count'),
      chatConversations: formatTrend(chatConversations, 'count'),
      responseTimes: formatTrend(responseTimes, 'avgResponseTime', 'avgResponseTime'),
      resolutionRates: formatTrend(resolutionRates, 'resolutionRate', 'resolutionRate'),
      callMinutes: formatTrend(callMinutesTrend, 'minutes', 'minutes')
    };
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

    // Average first response time
    const firstResponseTimes = await Conversation.find({
      ...conversationQuery,
      firstResponseAt: { $exists: true }
    }).select('createdAt firstResponseAt').lean();

    let avgFirstResponseTime = 0;
    if (firstResponseTimes.length > 0) {
      const totalTime = firstResponseTimes.reduce((sum, conv) => {
        return sum + (conv.firstResponseAt!.getTime() - conv.createdAt.getTime()) / 1000 / 60;
      }, 0);
      avgFirstResponseTime = totalTime / firstResponseTimes.length;
    }

    // Average resolution time
    const resolutionTimes = await Conversation.find({
      ...conversationQuery,
      resolvedAt: { $exists: true }
    }).select('createdAt resolvedAt').lean();

    let avgResolutionTime = 0;
    if (resolutionTimes.length > 0) {
      const totalTime = resolutionTimes.reduce((sum, conv) => {
        return sum + (conv.resolvedAt!.getTime() - conv.createdAt.getTime()) / 1000 / 60;
      }, 0);
      avgResolutionTime = totalTime / resolutionTimes.length;
    }

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
      avgFirstResponseTime: Math.round(avgFirstResponseTime),
      avgResolutionTime: Math.round(avgResolutionTime),
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

  // Export Data
  async exportData(organizationId: string, format: 'csv' | 'json', filters: any = {}) {
    const query: any = { organizationId };

    if (filters.dateFrom || filters.dateTo) {
      query.createdAt = {};
      if (filters.dateFrom) query.createdAt.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) query.createdAt.$lte = new Date(filters.dateTo);
    }

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.channel) {
      query.channel = filters.channel;
    }

    const conversations = await Conversation.find(query)
      .populate('customerId', 'name email phone')
      .populate('assignedOperatorId', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .lean();

    // Get messages for each conversation
    const conversationsWithMessages = await Promise.all(
      conversations.map(async (conv: any) => {
        const messages = await Message.find({ conversationId: conv._id })
          .sort({ timestamp: 1 })
          .lean();

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
          messageCount: messages.length,
          firstMessage: messages[0]?.text || '',
          lastMessage: messages[messages.length - 1]?.text || '',
          createdAt: conv.createdAt,
          resolvedAt: conv.resolvedAt || null
        };
      })
    );

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

