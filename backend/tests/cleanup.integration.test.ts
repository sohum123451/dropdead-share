import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { getDatabase, getFileById } from '../src/db/sqlite';
import { s3Client, S3_BUCKET, checkObjectExists } from '../src/storage/s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { runCleanupSweep } from '../src/jobs/cleanup';

describe('Cleanup Job Integration Tests (Prompt B4)', () => {
  beforeAll(() => {
    getDatabase();
  });

  it('creates an expired file in MinIO, runs the sweep, and asserts the object is gone from the bucket', async () => {
    const db = getDatabase();
    const id = `upl_expired_${crypto.randomUUID().replace(/-/g, '')}`;
    const token = crypto.randomBytes(24).toString('base64url');
    const s3Key = `test-sweep-${crypto.randomUUID()}`;
    const content = Buffer.from('This file has expired and must be purged by cron.');
    const expiredAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago

    // 1. Put object directly into MinIO
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: content,
        ContentType: 'text/plain',
      })
    );

    // 2. Insert active file row with expired timestamp
    db.prepare(`
      INSERT INTO files (
        id, token, s3_key, original_name, size_bytes, mime,
        password_hash, expires_at, max_downloads, remaining_downloads,
        status, created_at
      ) VALUES (
        ?, ?, ?, 'expired_report.txt', ?, 'text/plain',
        NULL, ?, 5, 5,
        'active', ?
      )
    `).run(id, token, s3Key, content.byteLength, expiredAt, expiredAt);

    // 3. Confirm object exists in MinIO prior to sweep
    expect(await checkObjectExists(s3Key)).toBe(true);
    expect(getFileById(id)).not.toBeNull();

    // 4. Run the cleanup sweep
    const result = await runCleanupSweep();
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    // 5. Assert the object is permanently deleted from MinIO
    const existsAfterSweep = await checkObjectExists(s3Key);
    expect(existsAfterSweep).toBe(false);

    // 6. Assert the database record is purged
    expect(getFileById(id)).toBeNull();
  });

  it('purges abandoned pending uploads older than 1 hour', async () => {
    const db = getDatabase();
    const id = `upl_abandoned_${crypto.randomUUID().replace(/-/g, '')}`;
    const s3Key = `test-abandoned-${crypto.randomUUID()}`;
    const content = Buffer.from('Abandoned pending upload file in storage.');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    // S3 object present
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: content,
        ContentType: 'text/plain',
      })
    );

    // Pending DB row created 2 hours ago
    db.prepare(`
      INSERT INTO files (
        id, token, s3_key, original_name, size_bytes, mime,
        password_hash, expires_at, max_downloads, remaining_downloads,
        status, created_at
      ) VALUES (
        ?, NULL, ?, 'abandoned.pdf', ?, 'application/pdf',
        NULL, ?, 1, 1,
        'pending', ?
      )
    `).run(id, s3Key, content.byteLength, twoHoursAgo, twoHoursAgo);

    expect(await checkObjectExists(s3Key)).toBe(true);

    // Run sweep
    await runCleanupSweep();

    // Object and row should be gone
    expect(await checkObjectExists(s3Key)).toBe(false);
    expect(getFileById(id)).toBeNull();
  });
});

