import cron, { ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { getFilesForCleanup, deleteFileRecord } from '../db/sqlite';
import { deleteStorageObject } from '../storage/s3';

let isRunning = false;

/**
 * Executes a single sweep of expired, exhausted, or abandoned files.
 * Idempotent, safe against overlapping runs, and deletes S3 object first.
 */
export async function runCleanupSweep(): Promise<{
  processed: number;
  deleted: number;
  errors: number;
}> {
  if (isRunning) {
    logger.warn('Cleanup sweep already running, skipping overlapping run');
    return { processed: 0, deleted: 0, errors: 0 };
  }

  isRunning = true;
  const nowIso = new Date().toISOString();
  let deletedCount = 0;
  let errorCount = 0;

  try {
    const candidates = getFilesForCleanup(nowIso);

    for (const file of candidates) {
      try {
        // Delete S3 object first
        await deleteStorageObject(file.s3_key);

        // Delete / tombstone DB row only upon S3 success
        deleteFileRecord(file.id);
        deletedCount++;
      } catch (err) {
        logger.error(
          { err, fileId: file.id, s3Key: file.s3_key },
          'Failed to cleanup storage object, will retry next run'
        );
        errorCount++;
      }
    }

    logger.info(
      {
        totalCandidates: candidates.length,
        deleted: deletedCount,
        errors: errorCount,
      },
      'Cleanup sweep completed'
    );

    return { processed: candidates.length, deleted: deletedCount, errors: errorCount };
  } finally {
    isRunning = false;
  }
}

let cronTask: ScheduledTask | null = null;

export function startCleanupCron(): ScheduledTask {
  if (cronTask) {
    return cronTask;
  }

  logger.info({ schedule: env.CLEANUP_CRON_SCHEDULE }, 'Scheduling cleanup cron job');

  cronTask = cron.schedule(env.CLEANUP_CRON_SCHEDULE, async () => {
    try {
      await runCleanupSweep();
    } catch (err) {
      logger.error({ err }, 'Error during scheduled cleanup sweep');
    }
  });

  return cronTask;
}

export function stopCleanupCron(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    logger.info('Cleanup cron job stopped');
  }
}

