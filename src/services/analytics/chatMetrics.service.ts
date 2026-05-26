/**
 * Chat Metrics Service
 * Centralized logic for calculating conversations and chats
 */

import Conversation from '../../models/Conversation';
import Message from '../../models/Message';
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
      if (!channel || channel === 'all') {
        const totalConversations = await usageTrackerService.calculateOrganizationChatConversations(
          organizationId,
          toUsageDateRange(dateRange)
        );
        return {
          totalConversations,
          totalChats: 0,
          totalUserMessages: 0,
          totalBotMessages: 0,
          averageMessagesPerConversation: 0
        };
      }

      const query: any = {
        organizationId: new mongoose.Types.ObjectId(organizationId)
      };

      if (channel && channel !== 'all') {
        if (channel === 'instagram' || channel === 'facebook') {
          query.channel = 'social';
          query['metadata.platform'] = channel;
        } else {
          query.channel = channel;
        }
      } else {
        query.channel = { $ne: 'phone' }; // Default: exclude phone
      }

      // Add date filter if provided
      if (dateRange?.dateFrom || dateRange?.dateTo) {
        query.createdAt = {};
        if (dateRange.dateFrom) {
          query.createdAt.$gte = new Date(dateRange.dateFrom);
        }
        if (dateRange.dateTo) {
          query.createdAt.$lte = new Date(dateRange.dateTo);
        }
      }

      // Get completed conversations (user + bot messages)
      const completedConversations = await Conversation.aggregate([
        {
          $match: query
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
          $project: {
            hasCustomerMessage: {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: '$messages',
                      as: 'msg',
                      cond: {
                        $and: [
                          { $eq: ['$$msg.sender', 'customer'] },
                          { $eq: ['$$msg.type', 'message'] }
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            hasAiMessage: {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: '$messages',
                      as: 'msg',
                      cond: {
                        $and: [
                          { $eq: ['$$msg.sender', 'ai'] },
                          { $eq: ['$$msg.type', 'message'] }
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            conversationId: '$_id'
          }
        },
        {
          $match: {
            hasCustomerMessage: true,
            hasAiMessage: true
          }
        },
        {
          $project: {
            conversationId: 1
          }
        }
      ]);

      const conversationIds = completedConversations.map((c: any) => c.conversationId);

      // Get total message counts
      const messageQuery: any = {
        conversationId: { $in: conversationIds },
        type: 'message' // Exclude internal notes
      };

      // Add date filter for messages if provided
      if (dateRange?.dateFrom || dateRange?.dateTo) {
        messageQuery.timestamp = {};
        if (dateRange.dateFrom) {
          messageQuery.timestamp.$gte = new Date(dateRange.dateFrom);
        }
        if (dateRange.dateTo) {
          messageQuery.timestamp.$lte = new Date(dateRange.dateTo);
        }
      }

      const [totalChats, userMessages, botMessages] = await Promise.all([
        Message.countDocuments(messageQuery),
        Message.countDocuments({
          ...messageQuery,
          sender: 'customer'
        }),
        Message.countDocuments({
          ...messageQuery,
          sender: 'ai'
        })
      ]);

      const totalConversations = completedConversations.length;
      const averageMessagesPerConversation = totalConversations > 0
        ? Math.round((totalChats / totalConversations) * 100) / 100
        : 0;

      return {
        totalConversations,
        totalChats,
        totalUserMessages: userMessages,
        totalBotMessages: botMessages,
        averageMessagesPerConversation
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
