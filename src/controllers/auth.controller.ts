import { Response, NextFunction, Request } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { AuthService } from '../services/auth.service';
import { successResponse } from '../utils/response.util';
import { IUser } from '../models/User';

export class AuthController {
  private authService: AuthService;

  constructor() {
    this.authService = new AuthService();
  }

  signup = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      console.log('1 - signup request received');
      const { name, email, password, captchaToken } = req.body;
      const result = await this.authService.signup(name, email, password, captchaToken, req.ip);
      res.json(successResponse(result, 'Signup successful'));
    } catch (error) {
      next(error);
    }
  };

  login = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      console.log('1 - login request received');
      const { email, password, captchaToken } = req.body;
      const result = await this.authService.login(email, password, captchaToken, req.ip);
      res.json(successResponse(result, 'Login successful'));
    } catch (error) {
      next(error);
    }
  };

  refreshToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body;
      const result = await this.authService.refreshToken(refreshToken);
      res.json(successResponse(result, 'Token refreshed'));
    } catch (error) {
      next(error);
    }
  };

  logout = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await this.authService.logout(req.user._id);
      res.json(successResponse(result));
    } catch (error) {
      next(error);
    }
  };

  getCurrentUser = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const user = await this.authService.getCurrentUser(req.user._id);
      res.json(successResponse(user));
    } catch (error) {
      next(error);
    }
  };

  // Google OAuth Callback
  googleCallback = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as IUser;
      if (!user) {
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/signin?error=authentication_failed`);
      }

      const result = await this.authService.oauthLogin(user);
      
      // Redirect to frontend with tokens
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const redirectUrl = `${frontendUrl}/auth/callback?token=${result.token}&refreshToken=${result.refreshToken}`;
      
      res.redirect(redirectUrl);
    } catch (error) {
      next(error);
    }
  };

  // Delete account
  deleteAccount = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await this.authService.deleteAccount(req.user!._id);
      res.json(successResponse(result, 'Account deleted successfully'));
    } catch (error) {
      next(error);
    }
  };

  // Complete onboarding
  completeOnboarding = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { name, email, phone, companyName, companyWebsite, vat, street, city, state, country } = req.body;
      
      // Validate required fields
      if (!name || !email || !phone || !street || !city || !state || !country) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Missing required fields: name, email, phone, street, city, state, and country are required'
          }
        });
      }

      if (!req.user || !req.user._id) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User not authenticated'
          }
        });
      }

      const userId = (req.user._id as any).toString();
      const result = await this.authService.completeOnboarding(userId, {
        name,
        email,
        phone,
        companyName,
        companyWebsite,
        vat,
        street,
        city,
        state,
        country
      });
      res.json(successResponse(result, 'Onboarding completed successfully'));
    } catch (error: any) {
      console.error('[Auth Controller] Onboarding error:', error);
      next(error);
    }
  };
}

export const authController = new AuthController();
