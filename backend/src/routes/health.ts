import { Router, Request, Response } from 'express';

export const healthRouter = Router();

/**
 * Health check endpoint as defined in /docs/API.md
 * GET /health
 */
healthRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});
