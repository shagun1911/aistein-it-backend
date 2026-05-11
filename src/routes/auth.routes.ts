import { Router, Request, Response, NextFunction } from 'express';
import { body } from 'express-validator';
import { authController } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import passport from '../config/passport';

const router = Router();

/** Logs shape of body before express-validator (reaches controller only if validation passes). */
const logAuthHit =
  (routeLabel: string) => (req: Request, _res: Response, next: NextFunction) => {
    const b = req.body ?? {};
    console.log(`0 - ${routeLabel} (pre-validation)`, {
      hasEmail: !!b.email,
      hasPassword: !!b.password,
      hasCaptchaToken: !!b.captchaToken,
      hasName: !!b.name,
      contentType: req.headers['content-type']
    });
    next();
  };

// Validation rules
const signupValidation = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email')
    .trim()
    .customSanitizer((value) => value?.replace(/\s/g, '') ?? '')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('captchaToken').trim().notEmpty().withMessage('Captcha verification is required')
];

const loginValidation = [
  body('email')
    .trim()
    .customSanitizer((value) => (typeof value === 'string' ? value.replace(/\s/g, '') : value))
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  body('password').trim().notEmpty().withMessage('Password is required'),
  body('captchaToken').trim().notEmpty().withMessage('Captcha verification is required')
];

const refreshTokenValidation = [
  body('refreshToken').notEmpty().withMessage('Refresh token is required')
];

// Routes
router.post(
  '/signup',
  logAuthHit('POST /signup'),
  validate(signupValidation),
  authController.signup
);
router.post(
  '/login',
  logAuthHit('POST /login'),
  validate(loginValidation),
  authController.login
);
router.post('/refresh', validate(refreshTokenValidation), authController.refreshToken);
router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.getCurrentUser);
router.post('/onboarding', authenticate, authController.completeOnboarding);
router.delete('/account', authenticate, authController.deleteAccount);

// Google OAuth Routes
router.get('/google', 
  passport.authenticate('google', { 
    scope: ['profile', 'email'],
    session: false 
  })
);

router.get('/google/callback',
  passport.authenticate('google', { 
    session: false,
    failureRedirect: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/signin?error=google_auth_failed`
  }),
  authController.googleCallback
);

export default router;
