import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/admin.middleware';
import { adminController } from '../controllers/admin.controller';

const router = Router();

// All admin routes require authentication and admin role
router.use(authenticate);
router.use(requireAdmin);

// Dashboard
router.get('/dashboard', adminController.getDashboard);
router.get('/dashboard/metrics', adminController.getDashboardMetrics);
router.get('/dashboard/usage/call-minutes', adminController.getDashboardCallMinutes);
router.get('/dashboard/usage/chat-conversations', adminController.getDashboardChatConversations);
router.get('/dashboard/usage', adminController.getDashboardUsage);

// Automations
router.get('/automations', adminController.getAllAutomations);
router.get('/automations/:id', adminController.getAutomationById);
router.patch('/automations/:id/toggle', adminController.toggleAutomation);

// Executions
router.get('/executions', adminController.getExecutionLogs);
router.get('/executions/:id', adminController.getExecutionById);
router.post('/executions/:id/rerun', adminController.rerunExecution);

// Integrations
router.get('/integrations/status', adminController.getIntegrationsStatus);

// Organizations
router.get('/organizations', adminController.getOrganizations);
router.get('/organizations/usage', adminController.getOrganizationUsage);

// Users
router.get('/users', adminController.getAllUsers);
router.get('/users/:userId', adminController.getUserDetails);
router.patch('/users/:userId/upgrade-plan', adminController.upgradeUserPlan);

// Analytics
router.get('/analytics/usage-reports/summary', adminController.getUsageReportsSummary);
router.get('/analytics/usage-reports', adminController.getUsageReports);

// Billing
router.get('/billing/overview', adminController.getBillingOverview);

// System Settings
router.get('/settings', adminController.getSystemSettings);
router.put('/settings', adminController.updateSystemSettings);

// Audit Logs
router.get('/audit/logs', adminController.getAuditLogs);

// Alerts
router.get('/alerts', adminController.getSystemAlerts);

export default router;
