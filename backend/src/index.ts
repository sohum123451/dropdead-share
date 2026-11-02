import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { getDatabase, closeDatabase } from './db/sqlite';
import { startCleanupCron, stopCleanupCron } from './jobs/cleanup';

function startServer() {
  try {
    // Initialize SQLite Database schema
    getDatabase();

    // Start background cleanup cron job
    startCleanupCron();

    const app = createApp();

    const server = app.listen(env.PORT, () => {
      logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server listening');
    });

    const shutdown = (signal: string) => {
      logger.info({ signal }, 'Graceful shutdown initiated');
      stopCleanupCron();
      server.close(() => {
        closeDatabase();
        logger.info('Server successfully closed');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }
}

startServer();
