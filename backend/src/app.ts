import express, { Express } from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { logger } from './config/logger';
import { healthRouter } from './routes/health';
import { uploadsRouter } from './routes/uploads';
import { linksRouter } from './routes/links';
import { notFoundHandler } from './middleware/not-found';
import { errorHandler } from './middleware/error-handler';

export function createApp(): Express {
  const app = express();

  // CORS middleware allowing web clients
  app.use(cors());

  // Request logging with pino-http (suppressed for /health to keep logs clean)
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === '/health',
      },
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Routes
  app.use(healthRouter);
  app.use(uploadsRouter);
  app.use(linksRouter);

  // Fallback 404 handler
  app.use(notFoundHandler);

  // Centralized Error handler
  app.use(errorHandler);

  return app;
}
