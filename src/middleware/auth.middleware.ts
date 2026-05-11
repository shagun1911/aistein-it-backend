import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User';
import { AppError } from './error.middleware';

export interface AuthRequest extends Request {
  user?: any;
  file?: Express.Multer.File;
  files?: Express.Multer.File[] | { [fieldname: string]: Express.Multer.File[] };
}

/**
 * Avoids running heavy usage aggregation on every API call.
 * TTL is 5 minutes — lock status changes are rare events (plan upgrades / limit exhaustion).
 * When lock status changes (e.g. user upgrades), call clearOrgLockCache(orgId) to evict.
 */
const orgLockCache = new Map<
  string,
  { at: number; locked: boolean; reason: string | null }
>();
const ORG_LOCK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearOrgLockCache(organizationId: string): void {
  orgLockCache.delete(organizationId);
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError(401, 'UNAUTHORIZED', 'No token provided');
    }

    const token = authHeader.substring(7);

    const jwtSecret = process.env.JWT_SECRET || 'your_super_secret_jwt_key_change_in_production';
    const decoded: any = jwt.verify(token, jwtSecret);

    const user = await User.findById(decoded.userId).select('-passwordHash');

    if (!user || user.status !== 'active') {
      throw new AppError(401, 'UNAUTHORIZED', 'User not found or inactive');
    }

    req.user = user;

    // --- GLOBAL PLAN LOCK ENFORCEMENT ---
    // Intercept requests if organization limits are exceeded
    // Skip for admins
    if (user.role !== 'admin' && user.organizationId) {
      // Exempt core routes needed for upgrading and viewing lock status
      const path = req.originalUrl || req.path;
      const isExemptPath = 
        path.includes('/profile') || 
        path.includes('/plan-warnings') || 
        path.includes('/plans') || 
        path.includes('/payment') ||
        path.includes('/auth') ||
        path.includes('/webhooks'); // Allow webhooks to process or self-terminate correctly

      if (!isExemptPath) {
        const orgKey = user.organizationId.toString();
        const now = Date.now();
        const cached = orgLockCache.get(orgKey);

        if (cached && now - cached.at < ORG_LOCK_CACHE_TTL_MS) {
          if (cached.locked) {
            throw new AppError(
              403,
              'PLAN_LIMIT_EXCEEDED',
              cached.reason ||
                'Your organization is locked because you have exceeded your plan limits. Please upgrade to continue using our services.'
            );
          }
        } else {
          const { usageTrackerService } = await import('../services/usage/usageTracker.service');
          const lockStatus = await usageTrackerService.isOrganizationLocked(orgKey);
          orgLockCache.set(orgKey, {
            at: now,
            locked: lockStatus.locked,
            reason: lockStatus.reason
          });

          if (lockStatus.locked) {
            throw new AppError(
              403,
              'PLAN_LIMIT_EXCEEDED',
              lockStatus.reason ||
                'Your organization is locked because you have exceeded your plan limits. Please upgrade to continue using our services.'
            );
          }
        }
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Check if user has specific permission
export const authorize = (...permissions: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Not authenticated'));
    }

    if (req.user.role === 'admin') {
      return next(); // Admins have all permissions
    }

    const hasPermission = permissions.some(permission => 
      req.user.permissions.includes(permission)
    );

    if (!hasPermission) {
      return next(new AppError(403, 'FORBIDDEN', 'Insufficient permissions'));
    }

    next();
  };
};
