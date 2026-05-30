import { Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { AuthRequest } from '../middleware/auth.middleware';
import { AnalyticsService } from '../services/analytics.service';
import { TopicService } from '../services/topic.service';
import { successResponse } from '../utils/response.util';
import { AppError } from '../middleware/error.middleware';
import Conversation from '../models/Conversation';
import Message from '../models/Message';

export class AnalyticsController {
  private analyticsService: AnalyticsService;
  private topicService: TopicService;

  constructor() {
    this.analyticsService = new AnalyticsService();
    this.topicService = new TopicService();
  }

  // Fast summary metrics (admin-speed usageTracker path)
  getSummary = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const { dateFrom, dateTo, channel, comparePrevious } = req.query;
      const summary = await this.analyticsService.getSummaryMetrics(
        organizationId.toString(),
        dateFrom as string,
        dateTo as string,
        channel as string,
        comparePrevious !== 'false'
      );
      res.json(successResponse(summary));
    } catch (error) {
      next(error);
    }
  };

  // Dashboard Metrics
  getDashboard = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // Use organizationId if available, otherwise fall back to userId
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const { dateFrom, dateTo, channel } = req.query;
      const metrics = await this.analyticsService.getDashboardMetrics(
        organizationId.toString(),
        dateFrom as string,
        dateTo as string,
        channel as string
      );
      res.json(successResponse(metrics));
    } catch (error) {
      next(error);
    }
  };

  // Conversation Trends
  getTrends = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // Use organizationId if available, otherwise fall back to userId
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const { groupBy = 'day', dateFrom, dateTo, channel } = req.query;
      const trends = await this.analyticsService.getConversationTrends(
        organizationId.toString(),
        groupBy as 'hour' | 'day' | 'week' | 'month',
        dateFrom as string,
        dateTo as string,
        channel as string
      );
      res.json(successResponse(trends));
    } catch (error) {
      next(error);
    }
  };

  // Quality trends (lazy insights row)
  getQualityTrends = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const { groupBy = 'day', dateFrom, dateTo, channel } = req.query;
      const trends = await this.analyticsService.getQualityTrends(
        organizationId.toString(),
        groupBy as 'hour' | 'day' | 'week' | 'month',
        dateFrom as string,
        dateTo as string,
        channel as string
      );
      res.json(successResponse(trends));
    } catch (error) {
      next(error);
    }
  };

  // Performance Metrics
  getPerformance = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // Use organizationId if available, otherwise fall back to userId
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const { dateFrom, dateTo, operatorId } = req.query;
      const performance = await this.analyticsService.getPerformanceMetrics(
        organizationId.toString(),
        dateFrom as string,
        dateTo as string,
        operatorId as string
      );
      res.json(successResponse(performance));
    } catch (error) {
      next(error);
    }
  };

  // Export Data
  exportData = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // Use organizationId if available, otherwise fall back to userId
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const { format = 'json', ...filters } = req.query;
      const result = await this.analyticsService.exportData(
        organizationId.toString(),
        format as 'csv' | 'json',
        filters
      );

      if (result.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=conversations-export.csv');
        res.send(result.data);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=conversations-export.json');
        res.json(result.data);
      }
    } catch (error) {
      next(error);
    }
  };

  // Topics Management
  getAllTopics = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const topics = await this.topicService.findAll();
      res.json(successResponse(topics));
    } catch (error) {
      next(error);
    }
  };

  getTopicById = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const topic = await this.topicService.findById(req.params.topicId);
      res.json(successResponse(topic));
    } catch (error) {
      next(error);
    }
  };

  createTopic = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const topic = await this.topicService.create(req.body);
      res.status(201).json(successResponse(topic, 'Topic created'));
    } catch (error) {
      next(error);
    }
  };

  updateTopic = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const topic = await this.topicService.update(req.params.topicId, req.body);
      res.json(successResponse(topic, 'Topic updated'));
    } catch (error) {
      next(error);
    }
  };

  deleteTopic = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await this.topicService.delete(req.params.topicId);
      res.json(successResponse(result));
    } catch (error) {
      next(error);
    }
  };

  detectTopics = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { conversationId, analyzeAll } = req.body;
      const result = await this.topicService.detectTopics(
        conversationId,
        analyzeAll
      );
      res.json(successResponse(result));
    } catch (error) {
      next(error);
    }
  };

  getTopicStats = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { topicName } = req.params;
      const { dateFrom, dateTo } = req.query;
      const stats = await this.topicService.getTopicStats(
        topicName,
        dateFrom as string,
        dateTo as string
      );
      res.json(successResponse(stats));
    } catch (error) {
      next(error);
    }
  };

  // Get top topics for analytics
  getTopTopics = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const { dateFrom, dateTo, limit = 10, channel } = req.query;
      const orgObjectId = new mongoose.Types.ObjectId(organizationId.toString());

      const msgMatch: Record<string, unknown> = {
        organizationId: orgObjectId,
        topics: { $exists: true, $ne: [] }
      };

      if (dateFrom || dateTo) {
        const timestamp: Record<string, Date> = {};
        if (dateFrom) timestamp.$gte = new Date(dateFrom as string);
        if (dateTo) timestamp.$lte = new Date(dateTo as string);
        msgMatch.timestamp = timestamp;
      }

      const convPipelineMatch: Record<string, unknown> = {
        organizationId: orgObjectId
      };
      if (dateFrom || dateTo) {
        const createdAt: Record<string, Date> = {};
        if (dateFrom) createdAt.$gte = new Date(dateFrom as string);
        if (dateTo) createdAt.$lte = new Date(dateTo as string);
        convPipelineMatch.createdAt = createdAt;
      }
      if (channel && channel !== 'all') {
        if (channel === 'instagram' || channel === 'facebook') {
          convPipelineMatch.channel = 'social';
          convPipelineMatch['metadata.platform'] = channel;
        } else if (channel === 'telegram') {
          convPipelineMatch.channel = 'social';
          convPipelineMatch['metadata.platform'] = 'telegram';
        } else {
          convPipelineMatch.channel = channel;
        }
      }

      const topics = await Message.aggregate([
        { $match: msgMatch },
        {
          $lookup: {
            from: 'conversations',
            localField: 'conversationId',
            foreignField: '_id',
            as: 'conv',
            pipeline: [{ $match: convPipelineMatch }, { $project: { _id: 1 } }]
          }
        },
        { $match: { 'conv.0': { $exists: true } } },
        { $unwind: '$topics' },
        { $group: { _id: '$topics', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: parseInt(limit as string, 10) }
      ]);

      const topTopics = topics.map((item: { _id: string; count: number }) => ({
        topic: item._id,
        count: item.count
      }));

      res.json(successResponse(topTopics));
    } catch (error) {
      next(error);
    }
  };
}

export const analyticsController = new AnalyticsController();

