import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { AdminService } from '../services/admin.service';
import { successResponse, paginatedResponse } from '../utils/response.util';
import { AppError } from '../middleware/error.middleware';

export class AdminController {
  private adminService: AdminService;

  constructor() {
    this.adminService = new AdminService();
  }

  /**
   * Fast dashboard counts (all indexed countDocuments — returns in <500ms)
   */
  getDashboardMetrics = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const counts = await this.adminService.getDashboardCounts();
      res.json(successResponse(counts));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Slow dashboard usage totals (call minutes + chat conversations)
   * Loaded separately so the main dashboard is never blocked by heavy aggregations
   */
  getDashboardUsage = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const usage = await this.adminService.getDashboardUsage();
      res.json(successResponse(usage));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get all automations
   */
  getAllAutomations = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const filters = {
        organizationId: req.query.organizationId as string,
        status: req.query.status as string,
        search: req.query.search as string
      };

      const result = await this.adminService.getAllAutomations(page, limit, filters);
      res.json(paginatedResponse(result.items, page, limit, result.pagination.total));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get automation by ID
   */
  getAutomationById = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const automation = await this.adminService.getAutomationById(req.params.id);
      res.json(successResponse(automation));
    } catch (error: any) {
      if (error.message === 'Automation not found') {
        return next(new AppError(404, 'NOT_FOUND', error.message));
      }
      next(error);
    }
  };

  /**
   * Toggle automation status
   */
  toggleAutomation = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { isActive } = req.body;
      if (typeof isActive !== 'boolean') {
        return next(new AppError(400, 'BAD_REQUEST', 'isActive must be a boolean'));
      }

      const automation = await this.adminService.toggleAutomation(req.params.id, isActive);
      res.json(successResponse(automation, `Automation ${isActive ? 'enabled' : 'disabled'}`));
    } catch (error: any) {
      if (error.message === 'Automation not found') {
        return next(new AppError(404, 'NOT_FOUND', error.message));
      }
      next(error);
    }
  };

  /**
   * Get execution logs
   */
  getExecutionLogs = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const filters = {
        organizationId: req.query.organizationId as string,
        automationId: req.query.automationId as string,
        status: req.query.status as string,
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string
      };

      const result = await this.adminService.getExecutionLogs(page, limit, filters);
      res.json(paginatedResponse(result.items, page, limit, result.pagination.total));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get execution by ID
   */
  getExecutionById = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const execution = await this.adminService.getExecutionById(req.params.id);
      res.json(successResponse(execution));
    } catch (error: any) {
      if (error.message === 'Execution not found') {
        return next(new AppError(404, 'NOT_FOUND', error.message));
      }
      next(error);
    }
  };

  /**
   * Re-run execution
   */
  rerunExecution = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const execution = await this.adminService.rerunExecution(req.params.id);
      res.json(successResponse(execution, 'Execution queued for retry'));
    } catch (error: any) {
      if (error.message === 'Execution not found' || error.message === 'Automation not found or inactive') {
        return next(new AppError(404, 'NOT_FOUND', error.message));
      }
      next(error);
    }
  };

  /**
   * Get integrations status
   */
  getIntegrationsStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const status = await this.adminService.getIntegrationsStatus();
      res.json(successResponse(status));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get all organizations with usage analytics
   */
  getOrganizations = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const filters = {
        plan: req.query.plan as string,
        status: req.query.status as string
      };
      const organizations = await this.adminService.getOrganizations(filters);
      res.json(successResponse(organizations));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get organization usage analytics
   */
  getOrganizationUsage = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.query.organizationId as string;
      const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom as string) : undefined;
      const dateTo = req.query.dateTo ? new Date(req.query.dateTo as string) : undefined;

      const usage = await this.adminService.getOrganizationUsage(organizationId, {
        from: dateFrom,
        to: dateTo
      });

      res.json(successResponse(usage));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get all users with profile and usage information
   */
  getAllUsers = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const filters = {
        role: req.query.role as string,
        status: req.query.status as string,
        search: req.query.search as string
      };
      const users = await this.adminService.getAllUsers(filters);
      res.json(successResponse(users));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get user details
   */
  getUserDetails = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;
      const userDetails = await this.adminService.getUserDetails(userId);
      res.json(successResponse(userDetails));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Upgrade user billing plan
   */
  upgradeUserPlan = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;
      const { profileType, organizationPlan } = req.body;

      if (!profileType || !['free', 'mileva', 'nobel', 'aistein'].includes(profileType)) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_PROFILE_TYPE',
          message: 'Invalid profile type. Must be one of: free, mileva, nobel, aistein'
        });
      }

      const result = await this.adminService.upgradeUserPlan(userId, profileType);
      res.json(successResponse(result));
    } catch (error: any) {
      next(error);
    }
  };

  /**
   * Get usage report summary (platform totals + channels — fast)
   */
  getUsageReportsSummary = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const dateFrom = req.query.dateFrom as string;
      const dateTo = req.query.dateTo as string;
      const summary = await this.adminService.getUsageReportsSummary(dateFrom, dateTo);
      res.json(successResponse(summary));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get usage reports (full, includes per-organization table)
   */
  getUsageReports = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const dateFrom = req.query.dateFrom as string;
      const dateTo = req.query.dateTo as string;
      const reports = await this.adminService.getUsageReports(dateFrom, dateTo);
      res.json(successResponse(reports));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get billing overview
   */
  getBillingOverview = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const overview = await this.adminService.getBillingOverview();
      res.json(successResponse(overview));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get system settings
   */
  getSystemSettings = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const settings = await this.adminService.getSystemSettings();
      res.json(successResponse(settings));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Update system settings
   */
  updateSystemSettings = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await this.adminService.updateSystemSettings(req.body);
      res.json(successResponse(result, 'System settings updated'));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get audit logs
   */
  getAuditLogs = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const filters = {
        action: req.query.action as string,
        userId: req.query.userId as string,
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string,
        page,
        limit
      };
      const logs = await this.adminService.getAuditLogs(filters);
      res.json(paginatedResponse(logs.logs, page, limit, logs.total));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get system alerts
   */
  getSystemAlerts = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const alerts = await this.adminService.getSystemAlerts();
      res.json(successResponse(alerts));
    } catch (error) {
      next(error);
    }
  };
}

export const adminController = new AdminController();
