import { Request, Response, NextFunction } from 'express';
import { validationResult, ValidationChain } from 'express-validator';
import { AppError } from './error.middleware';

export const validate = (validations: ValidationChain[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Run all validations
    await Promise.all(validations.map(validation => validation.run(req)));

    const errors = validationResult(req);
    if (errors.isEmpty()) {
      return next();
    }

    const extractedErrors = errors.array().map(err => ({
      field: err.type === 'field' ? err.path : 'unknown',
      message: err.msg
    }));

    if (req.path === '/login' || req.path === '/signup') {
      console.log(`[Auth] validation failed ${req.method} ${req.path}`, extractedErrors);
    }

    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', extractedErrors);
  };
};

