import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error';
import { logger } from '../config/logger';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  // Handle AppError
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, path: req.path }, 'Application error');
    } else {
      logger.warn({ code: err.code, message: err.message, path: req.path }, 'Client error handled');
    }

    const errorPayload: Record<string, unknown> = {
      code: err.code,
      message: err.message,
    };

    const remainingHeader = res.getHeader('ratelimit-remaining');
    if (remainingHeader !== undefined && remainingHeader !== null) {
      const remainingNum = parseInt(String(remainingHeader), 10);
      if (!isNaN(remainingNum)) {
        errorPayload.attemptsLeft = remainingNum;
      }
    }

    const resetHeader = res.getHeader('ratelimit-reset') || res.getHeader('retry-after');
    if (resetHeader !== undefined && resetHeader !== null) {
      const resetNum = parseInt(String(resetHeader), 10);
      if (!isNaN(resetNum)) {
        errorPayload.retryAfterSeconds = resetNum;
      }
    }

    res.status(err.statusCode).json({
      error: errorPayload,
    });
    return;
  }

  // Handle Zod Schema Validation Errors
  if (err instanceof ZodError) {
    const formattedMessage = err.errors
      .map((e) => {
        const field = e.path.join('.');
        return field ? `${field}: ${e.message}` : e.message;
      })
      .join('; ');

    logger.warn({ issues: err.issues, path: req.path }, 'Validation error');

    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: formattedMessage || 'Request validation failed.',
      },
    });
    return;
  }

  // Handle Express JSON Body Parsing Errors
  if (err instanceof SyntaxError && 'status' in err && (err as { status: number }).status === 400) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid JSON payload received in request body.',
      },
    });
    return;
  }

  // Unhandled / Internal Server Errors
  logger.error({ err, path: req.path }, 'Unhandled server error');

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal server error occurred.',
    },
  });
}
