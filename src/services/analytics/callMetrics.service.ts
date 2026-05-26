/**
 * Call Metrics Service
 * Centralized logic for calculating call minutes from transcripts
 */

import Conversation from '../../models/Conversation';
import mongoose from 'mongoose';
import { logger } from '../../utils/logger.util';
import { CallMetrics, DateRange } from './analytics.types';
import { usageTrackerService, toUsageDateRange } from '../usage/usageTracker.service';

export class CallMetricsService {
  /**
   * Calculate call minutes from transcript timestamps
   * Call minutes = (last transcript timestamp - first transcript timestamp) rounded up to nearest minute
   */
  private calculateDurationFromTranscript(transcript: any): number | null {
    try {
      const items = Array.isArray(transcript)
        ? transcript
        : (transcript?.items || transcript?.messages);

      if (!Array.isArray(items) || items.length === 0) {
        return null;
      }

      const itemsWithTime = items.filter((item: any) => item.timestamp || item.time || item.created_at);
      if (itemsWithTime.length < 2) {
        return null;
      }

      // Sort by timestamp
      itemsWithTime.sort((a: any, b: any) => {
        const timeA = new Date(a.timestamp || a.time || a.created_at).getTime();
        const timeB = new Date(b.timestamp || b.time || b.created_at).getTime();
        return timeA - timeB;
      });

      const firstTimestamp = new Date(itemsWithTime[0].timestamp || itemsWithTime[0].time || itemsWithTime[0].created_at).getTime();
      const lastTimestamp = new Date(itemsWithTime[itemsWithTime.length - 1].timestamp || itemsWithTime[itemsWithTime.length - 1].time || itemsWithTime[itemsWithTime.length - 1].created_at).getTime();
      const durationMs = lastTimestamp - firstTimestamp;
      const durationMinutes = Math.ceil(durationMs / (1000 * 60)); // Round UP to nearest minute

      return durationMinutes > 0 ? durationMinutes : null;
    } catch (error: any) {
      logger.warn('[CallMetrics] Error calculating duration from transcript:', error.message);
      return null;
    }
  }

  /**
   * Get duration from conversation metadata or transcript
   * Priority: transcript timestamps > metadata.duration > null (don't count if no valid data)
   */
  public getCallDuration(conversation: any): number | null {
    // Priority 1: Calculate from transcript timestamps
    if (conversation.transcript) {
      const duration = this.calculateDurationFromTranscript(conversation.transcript);
      if (duration !== null && duration > 0) {
        return duration;
      }
    }

    // Priority 2: Use metadata duration fields
    if (conversation.metadata) {
      const meta = conversation.metadata as any;
      const rawDuration = meta.duration || meta.duration_seconds || meta.call_duration_secs || meta.call_duration_seconds;

      if (rawDuration !== undefined && rawDuration !== null) {
        const metaDuration = parseInt(String(rawDuration), 10);
        if (!isNaN(metaDuration)) {
          return Math.ceil(metaDuration / 60);
        }
      }

      // Fallback: Calculate from metadata timestamps
      const start = meta.callInitiated || meta.AcceptedAt || meta.accepted_time_unix_secs;
      const end = meta.callCompletedAt || meta.CompletedAt || meta.end_time_unix_secs;

      if (start && end) {
        const startTime = typeof start === 'number' ? start * 1000 : new Date(start).getTime();
        const endTime = typeof end === 'number' ? end * 1000 : new Date(end).getTime();
        const diffSeconds = (endTime - startTime) / 1000;
        if (diffSeconds > 0 && diffSeconds < 7200) {
          return Math.ceil(diffSeconds / 60);
        }
      }
    }

    // Priority 3: Use time difference ONLY if reasonable
    if (conversation.createdAt && conversation.updatedAt) {
      const diffMs = new Date(conversation.updatedAt).getTime() - new Date(conversation.createdAt).getTime();
      const diffSeconds = diffMs / 1000;
      // Only count if between 1 second and 120 minutes
      if (diffSeconds > 0 && diffSeconds <= 7200) {
        return Math.ceil(diffSeconds / 60);
      }
    }

    // No valid data found - don't count this call
    return null;
  }

  /**
   * Parse duration string (e.g., "5:30", "5m 30s", "330s")
   */
  private parseDurationString(durationStr: string): number {
    try {
      // Format: "MM:SS" or "HH:MM:SS"
      const timeParts = durationStr.split(':');
      if (timeParts.length === 2) {
        const minutes = parseInt(timeParts[0], 10);
        const seconds = parseInt(timeParts[1], 10);
        return Math.ceil(minutes + seconds / 60);
      } else if (timeParts.length === 3) {
        const hours = parseInt(timeParts[0], 10);
        const minutes = parseInt(timeParts[1], 10);
        const seconds = parseInt(timeParts[2], 10);
        return Math.ceil(hours * 60 + minutes + seconds / 60);
      }

      // Format: "5m 30s" or "330s"
      const minutesMatch = durationStr.match(/(\d+)m/);
      const secondsMatch = durationStr.match(/(\d+)s/);
      const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;
      const seconds = secondsMatch ? parseInt(secondsMatch[1], 10) : 0;
      return Math.ceil(minutes + seconds / 60);
    } catch {
      return 0;
    }
  }

  /**
   * Get call metrics for a specific organization
   */
  async getOrganizationCallMetrics(
    organizationId: string,
    dateRange?: DateRange
  ): Promise<CallMetrics> {
    try {
      const query: any = {
        organizationId: new mongoose.Types.ObjectId(organizationId),
        channel: 'phone'
      };
      if (dateRange?.dateFrom || dateRange?.dateTo) {
        query.createdAt = {};
        if (dateRange.dateFrom) query.createdAt.$gte = new Date(dateRange.dateFrom);
        if (dateRange.dateTo) query.createdAt.$lte = new Date(dateRange.dateTo);
      }

      const [totalCallMinutes, totalCalls] = await Promise.all([
        usageTrackerService.calculateCallMinutes(organizationId, toUsageDateRange(dateRange)),
        Conversation.countDocuments(query)
      ]);

      return {
        totalCallMinutes,
        totalCalls,
        callsWithValidDuration: totalCalls,
        averageCallDuration: totalCalls > 0 ? Math.round((totalCallMinutes / totalCalls) * 100) / 100 : 0,
        callsWithTranscript: 0,
        callsWithoutTranscript: totalCalls
      };
    } catch (error: any) {
      logger.error('[CallMetrics] Error getting organization call metrics:', error.message);
      throw error;
    }
  }

  /**
   * Get call metrics for a specific user
   */
  async getUserCallMetrics(
    userId: string,
    dateRange?: DateRange
  ): Promise<CallMetrics> {
    try {
      const User = mongoose.model('User');
      const user = await User.findById(userId).select('organizationId').lean() as any;

      if (!user || !user.organizationId) {
        return {
          totalCallMinutes: 0,
          totalCalls: 0,
          callsWithValidDuration: 0,
          averageCallDuration: 0,
          callsWithTranscript: 0,
          callsWithoutTranscript: 0
        };
      }

      return this.getOrganizationCallMetrics(user.organizationId.toString(), dateRange);
    } catch (error: any) {
      logger.error('[CallMetrics] Error getting user call metrics:', error.message);
      throw error;
    }
  }

  /**
   * Get platform-wide call metrics (admin)
   */
  async getPlatformCallMetrics(dateRange?: DateRange): Promise<CallMetrics> {
    try {
      const query: any = { channel: 'phone' };
      if (dateRange?.dateFrom || dateRange?.dateTo) {
        query.createdAt = {};
        if (dateRange.dateFrom) query.createdAt.$gte = new Date(dateRange.dateFrom);
        if (dateRange.dateTo) query.createdAt.$lte = new Date(dateRange.dateTo);
      }

      const [totalCallMinutes, totalCalls] = await Promise.all([
        usageTrackerService.calculatePlatformCallMinutes(toUsageDateRange(dateRange)),
        Conversation.countDocuments(query)
      ]);

      return {
        totalCallMinutes,
        totalCalls,
        callsWithValidDuration: totalCalls,
        averageCallDuration: totalCalls > 0 ? Math.round((totalCallMinutes / totalCalls) * 100) / 100 : 0,
        callsWithTranscript: 0,
        callsWithoutTranscript: totalCalls
      };
    } catch (error: any) {
      logger.error('[CallMetrics] Error getting platform call metrics:', error.message);
      throw error;
    }
  }
}

export const callMetricsService = new CallMetricsService();
