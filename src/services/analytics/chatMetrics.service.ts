/**
 * Chat Metrics Service
 * Centralized logic for calculating conversations and chats
 */

import Conversation from '../../models/Conversation';
import mongoose from 'mongoose';
import { logger } from '../../utils/logger.util';
import { ChatMetrics, DateRange } from './analytics.types';
import { usageTrackerService, toUsageDateRange } from '../usage/usageTracker.service';

export class ChatMetricsService {
  /**
   * Get chat metrics for a specific organization
   * 
   * Definitions:
   * - Conversation: User sends at least 1 message AND bot/system sends at least 1 reply
   * - Chats: Total number of messages (user + bot + system)
   */
  async getOrganizationChatMetrics(
    organizationId: string,
    dateRange?: DateRange,
    channel?: string
  ): Promise<ChatMetrics> {
    try {
      // Build the conversation-level match filter (channel + date) and delegate to
      // the fast Conversation.countDocuments path used everywhere else.
      // The old implementation loaded ALL messages for every matched conversation via
      // $lookup (O(conversations × messages)), which timed out on production-sized data.
      const usageRange = toUsageDateRange(dateRange);

      const totalConversations = await usageTrackerService.calculateOrganizationChatConversations(
        organizationId,
        usageRange
      );

      // For channel-filtered metrics we do a direct Conversation countDocuments so the
      // caller gets a channel-specific number rather than the org-wide total.
      if (channel && channel !== 'all') {
        const orgObjectId = new mongoose.Types.ObjectId(organizationId);
        const convMatch: Record<string, unknown> = {
          organizationId: orgObjectId,
          'lastMessage.timestamp': { $exists: true }
        };
        if (channel === 'instagram' || channel === 'facebook') {
          convMatch.channel = 'social';
          convMatch['metadata.platform'] = channel;
        } else if (channel === 'telegram') {
          convMatch.channel = 'social';
          convMatch['metadata.platform'] = 'telegram';
        } else {
          convMatch.channel = channel;
        }
        if (dateRange?.dateFrom || dateRange?.dateTo) {
          const createdAt: Record<string, Date> = {};
          if (dateRange.dateFrom) createdAt.$gte = new Date(dateRange.dateFrom);
          if (dateRange.dateTo) createdAt.$lte = new Date(dateRange.dateTo);
          convMatch.createdAt = createdAt;
        }
        const channelCount = await Conversation.countDocuments(convMatch);
        return {
          totalConversations: channelCount,
          totalChats: 0,
          totalUserMessages: 0,
          totalBotMessages: 0,
          averageMessagesPerConversation: 0
        };
      }

      return {
        totalConversations,
        totalChats: 0,
        totalUserMessages: 0,
        totalBotMessages: 0,
        averageMessagesPerConversation: 0
      };
    } catch (error: any) {
      logger.error('[ChatMetrics] Error getting organization chat metrics:', error.message);
      throw error;
    }
  }

  /**
   * Get chat metrics for a specific user
   */
  async getUserChatMetrics(
    userId: string,
    dateRange?: DateRange
  ): Promise<ChatMetrics> {
    try {
      const User = mongoose.model('User');
      const user = await User.findById(userId).select('organizationId').lean() as any;

      if (!user || !user.organizationId) {
        return {
          totalConversations: 0,
          totalChats: 0,
          totalUserMessages: 0,
          totalBotMessages: 0,
          averageMessagesPerConversation: 0
        };
      }

      return this.getOrganizationChatMetrics(user.organizationId.toString(), dateRange);
    } catch (error: any) {
      logger.error('[ChatMetrics] Error getting user chat metrics:', error.message);
      throw error;
    }
  }

  /**
   * Get platform-wide chat metrics (admin)
   */
  async getPlatformChatMetrics(dateRange?: DateRange): Promise<ChatMetrics> {
    try {
      const totalConversations = await usageTrackerService.calculatePlatformChatConversations(
        toUsageDateRange(dateRange)
      );
      return {
        totalConversations,
        totalChats: 0,
        totalUserMessages: 0,
        totalBotMessages: 0,
        averageMessagesPerConversation: 0
      };
    } catch (error: any) {
      logger.error('[ChatMetrics] Error getting platform chat metrics:', error.message);
      throw error;
    }
  }
}

export const chatMetricsService = new ChatMetricsService();
