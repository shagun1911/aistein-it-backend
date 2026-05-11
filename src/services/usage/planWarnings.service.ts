import Organization from '../../models/Organization';
import { usageTrackerService } from './usageTracker.service';
import { logger } from '../../utils/logger.util';

export interface PlanWarning {
  type: 'callMinutes' | 'chatConversations' | 'automations';
  level: 'warning' | 'critical' | 'exceeded';
  message: string;
  current: number;
  limit: number;
  percentage: number;
}

class PlanWarningsService {
  /**
   * Get warnings and lock status for an organization based on their plan usage
   */
  async getWarningsAndLockStatus(organizationId: string): Promise<{ warnings: PlanWarning[], lockStatus: { locked: boolean, reason: string | null } }> {
    try {
      const org = await Organization.findById(organizationId).populate('planId').lean();
      
      if (!org || !org.planId) {
        return { warnings: [], lockStatus: { locked: false, reason: null } };
      }

      const plan = org.planId as any;
      // Fetch usage once and pass it to both the warning checks and the lock check
      // to avoid computing it twice (previously caused a double full-aggregation).
      const usage = await usageTrackerService.getOrganizationUsage(organizationId);
      const warnings: PlanWarning[] = [];
      const { locked, reason } = await usageTrackerService.isOrganizationLocked(organizationId, usage);

      // Check call minutes
      if (plan.features?.callMinutes !== -1) {
        const percentage = (usage.callMinutes / plan.features.callMinutes) * 100;
        if (percentage >= 100) {
          warnings.push({
            type: 'callMinutes',
            level: 'exceeded',
            message: `You have exceeded your plan limit of ${plan.features.callMinutes} call minutes. Calls are now blocked.`,
            current: usage.callMinutes,
            limit: plan.features.callMinutes,
            percentage: 100
          });
        } else if (percentage >= 90) {
          warnings.push({
            type: 'callMinutes',
            level: 'critical',
            message: `You have used ${usage.callMinutes} of ${plan.features.callMinutes} call minutes (${percentage.toFixed(0)}%). Your plan is almost full!`,
            current: usage.callMinutes,
            limit: plan.features.callMinutes,
            percentage
          });
        } else if (percentage >= 75) {
          warnings.push({
            type: 'callMinutes',
            level: 'warning',
            message: `You have used ${usage.callMinutes} of ${plan.features.callMinutes} call minutes (${percentage.toFixed(0)}%)`,
            current: usage.callMinutes,
            limit: plan.features.callMinutes,
            percentage
          });
        }
      }

      // Check chat conversations
      if (plan.features?.chatConversations !== -1) {
        const percentage = (usage.chatMessages / plan.features.chatConversations) * 100;
        if (percentage >= 100) {
          warnings.push({
            type: 'chatConversations',
            level: 'exceeded',
            message: `You have exceeded your plan limit of ${plan.features.chatConversations} chat conversations. Chat is now blocked.`,
            current: usage.chatMessages,
            limit: plan.features.chatConversations,
            percentage: 100
          });
        } else if (percentage >= 90) {
          warnings.push({
            type: 'chatConversations',
            level: 'critical',
            message: `You have used ${usage.chatMessages} of ${plan.features.chatConversations} chat conversations (${percentage.toFixed(0)}%). Your plan is almost full!`,
            current: usage.chatMessages,
            limit: plan.features.chatConversations,
            percentage
          });
        } else if (percentage >= 75) {
          warnings.push({
            type: 'chatConversations',
            level: 'warning',
            message: `You have used ${usage.chatMessages} of ${plan.features.chatConversations} chat conversations (${percentage.toFixed(0)}%)`,
            current: usage.chatMessages,
            limit: plan.features.chatConversations,
            percentage
          });
        }
      }

      // Check automations
      if (plan.features?.automations !== -1) {
        const percentage = (usage.automations / plan.features.automations) * 100;
        if (percentage >= 100) {
          warnings.push({
            type: 'automations',
            level: 'exceeded',
            message: `You have reached your plan limit of ${plan.features.automations} automations. You cannot create more.`,
            current: usage.automations,
            limit: plan.features.automations,
            percentage: 100
          });
        } else if (percentage >= 90) {
          warnings.push({
            type: 'automations',
            level: 'critical',
            message: `You have ${usage.automations} of ${plan.features.automations} automations (${percentage.toFixed(0)}%). Your plan is almost full!`,
            current: usage.automations,
            limit: plan.features.automations,
            percentage
          });
        } else if (percentage >= 75) {
          warnings.push({
            type: 'automations',
            level: 'warning',
            message: `You have ${usage.automations} of ${plan.features.automations} automations (${percentage.toFixed(0)}%)`,
            current: usage.automations,
            limit: plan.features.automations,
            percentage
          });
        }
      }

      return { warnings, lockStatus: { locked, reason } };
    } catch (error: any) {
      logger.error('[Plan Warnings] Error getting warnings and lock status:', error.message);
      return { warnings: [], lockStatus: { locked: false, reason: null } };
    }
  }

  /**
   * Get warnings for an organization based on their plan usage (Legacy backward compatibility)
   */
  async getWarnings(organizationId: string): Promise<PlanWarning[]> {
    const { warnings } = await this.getWarningsAndLockStatus(organizationId);
    return warnings;
  }

  /**
   * Check if organization can perform an action
   */
  async canPerformAction(
    organizationId: string,
    action: 'call' | 'chat' | 'automation'
  ): Promise<{ allowed: boolean; reason?: string }> {
    try {
      const org = await Organization.findById(organizationId).populate('planId').lean();
      
      if (!org || !org.planId) {
        return { allowed: true };
      }

      const plan = org.planId as any;
      const usage = await usageTrackerService.getOrganizationUsage(organizationId);

      switch (action) {
        case 'call':
          if (plan.features?.callMinutes === -1) return { allowed: true };
          if (usage.callMinutes >= plan.features?.callMinutes) {
            return {
              allowed: false,
              reason: `You have reached your plan limit of ${plan.features?.callMinutes} call minutes. Please upgrade your plan.`
            };
          }
          break;

        case 'chat':
          if (plan.features?.chatConversations === -1) return { allowed: true };
          if (usage.chatMessages >= plan.features?.chatConversations) {
            return {
              allowed: false,
              reason: `You have reached your plan limit of ${plan.features?.chatConversations} chat conversations. Please upgrade your plan.`
            };
          }
          break;

        case 'automation':
          if (plan.features?.automations === -1) return { allowed: true };
          if (usage.automations >= plan.features?.automations) {
            return {
              allowed: false,
              reason: `You have reached your plan limit of ${plan.features?.automations} automations. Please upgrade your plan.`
            };
          }
          break;
      }

      return { allowed: true };
    } catch (error: any) {
      logger.error('[Plan Warnings] Error checking action:', error.message);
      return { allowed: true }; // Allow by default on error
    }
  }
}

export const planWarningsService = new PlanWarningsService();
