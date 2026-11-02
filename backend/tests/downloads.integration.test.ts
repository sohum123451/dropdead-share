import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import crypto from 'crypto';
import { createApp } from '../src/app';
import { getDatabase, getFileByToken } from '../src/db/sqlite';
import { s3Client, S3_BUCKET, checkObjectExists } from '../src/storage/s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';

describe('Download & Expiry Logic (Prompt B3)', () => {
  const app = createApp();

  beforeAll(() => {
    getDatabase();
  });

  // Helper to create an active file in MinIO and DB
  async function seedActiveFile(options: {
    filename: string;
    content: string;
    maxDownloads: number;
    remainingDownloads?: number;
    password?: string;
    expiresAt?: string;
    status?: 'pending' | 'active' | 'dead';
  }) {
    const db = getDatabase();
    const id = `upl_${crypto.randomUUID().replace(/-/g, '')}`;
    const token = crypto.randomBytes(24).toString('base64url');
    const s3Key = `test-${crypto.randomUUID()}`;
    const body = Buffer.from(options.content, 'utf8');

    // Upload object to MinIO
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: body,
        ContentType: 'text/plain',
      })
    );

    const passwordHash = options.password ? await argon2.hash(options.password) : null;
    const expiresAt =
      options.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const remaining = options.remainingDownloads ?? options.maxDownloads;
    const status = options.status ?? 'active';

    db.prepare(`
      INSERT INTO files (
        id, token, s3_key, original_name, size_bytes, mime,
        password_hash, expires_at, max_downloads, remaining_downloads,
        status, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, 'text/plain',
        ?, ?, ?, ?,
        ?, datetime('now')
      )
    `).run(
      id,
      token,
      s3Key,
      options.filename,
      body.byteLength,
      passwordHash,
      expiresAt,
      options.maxDownloads,
      remaining,
      status
    );

    return { id, token, s3Key, body };
  }

  describe('GET /api/links/:token/info', () => {
    it('reveals metadata for active link without exposing file payload or storage URL', async () => {
      const { token } = await seedActiveFile({
        filename: 'report.txt',
        content: 'Confidential Report Data',
        maxDownloads: 5,
        password: 'Password999!',
      });

      const res = await request(app).get(`/api/links/${token}/info`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        filename: 'report.txt',
        fileSize: Buffer.byteLength('Confidential Report Data'),
        contentType: 'text/plain',
        isPasswordProtected: true,
        expiresAt: expect.any(String),
        remainingDownloads: 5,
      });
      // Ensure no private S3 keys or internal paths are leaked
      expect(res.body).not.toHaveProperty('s3Key');
      expect(res.body).not.toHaveProperty('s3_key');
      expect(res.body).not.toHaveProperty('id');
    });

    it('returns 404 for unknown token', async () => {
      const res = await request(app).get('/api/links/nonexistent_token_1234567890/info');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('LINK_NOT_FOUND');
    });

    it('returns 410 LINK_EXPIRED for expired link and does not reveal metadata', async () => {
      const pastDate = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
      const { token } = await seedActiveFile({
        filename: 'old.txt',
        content: 'expired',
        maxDownloads: 5,
        expiresAt: pastDate,
      });

      const res = await request(app).get(`/api/links/${token}/info`);
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('LINK_EXPIRED');
      expect(res.body).not.toHaveProperty('filename');
    });

    it('returns 410 DOWNLOADS_EXHAUSTED when downloads are 0', async () => {
      const { token } = await seedActiveFile({
        filename: 'depleted.txt',
        content: 'no downloads left',
        maxDownloads: 2,
        remainingDownloads: 0,
        status: 'dead',
      });

      const res = await request(app).get(`/api/links/${token}/info`);
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('DOWNLOADS_EXHAUSTED');
      expect(res.body).not.toHaveProperty('filename');
    });
  });

  describe('Password Verification Flow (/verify)', () => {
    it('verifies correct password and returns downloadGrantToken valid for 5 min', async () => {
      const { token } = await seedActiveFile({
        filename: 'locked.txt',
        content: 'Vault contents',
        maxDownloads: 5,
        password: 'TopSecretPassword!',
      });

      const res = await request(app)
        .post(`/api/links/${token}/verify`)
        .send({ password: 'TopSecretPassword!' });

      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
      expect(res.body.downloadGrantToken).toMatch(/^dgt_/);
      expect(res.body.expiresIn).toBe(300);
    });

    it('returns 401 WRONG_PASSWORD for incorrect password', async () => {
      const { token } = await seedActiveFile({
        filename: 'locked.txt',
        content: 'Vault contents',
        maxDownloads: 5,
        password: 'TopSecretPassword!',
      });

      const res = await request(app)
        .post(`/api/links/${token}/verify`)
        .send({ password: 'WrongPassword' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('WRONG_PASSWORD');
    });

    it('rate limits wrong password attempts after 5 failures with 429 RATE_LIMITED', async () => {
      const { token } = await seedActiveFile({
        filename: 'brute.txt',
        content: 'Protected',
        maxDownloads: 5,
        password: 'CorrectPassword123',
      });

      // Send 5 wrong attempts
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post(`/api/links/${token}/verify`)
          .send({ password: `BadGuess_${i}` });
        expect(res.status).toBe(401);
      }

      // 6th attempt should trigger 429 RATE_LIMITED
      const blockedRes = await request(app)
        .post(`/api/links/${token}/verify`)
        .send({ password: 'BadGuess_6' });

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('Download & Atomic Decrement (/download)', () => {
    it('requires password or downloadGrantToken for password-protected link', async () => {
      const { token } = await seedActiveFile({
        filename: 'guarded.txt',
        content: 'Guarded',
        maxDownloads: 5,
        password: 'SecretPassword!',
      });

      const res = await request(app)
        .post(`/api/links/${token}/download`)
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('PASSWORD_REQUIRED');
    });

    it('succeeds with valid downloadGrantToken from /verify', async () => {
      const { token } = await seedActiveFile({
        filename: 'grant_access.txt',
        content: 'File accessed via grant',
        maxDownloads: 5,
        password: 'SecretPassword!',
      });

      const verifyRes = await request(app)
        .post(`/api/links/${token}/verify`)
        .send({ password: 'SecretPassword!' });

      const grantToken = verifyRes.body.downloadGrantToken;

      const downloadRes = await request(app)
        .post(`/api/links/${token}/download`)
        .send({ downloadGrantToken: grantToken });

      expect(downloadRes.status).toBe(200);
      expect(downloadRes.body).toHaveProperty('downloadUrl');
      expect(downloadRes.body.downloadUrl).toContain('response-content-disposition');
      expect(downloadRes.body.expiresIn).toBe(60);
      expect(downloadRes.body.remainingDownloads).toBe(4);
    });

    it('immediately destroys S3 object and marks status dead when remaining downloads hit 0', async () => {
      const { token, s3Key } = await seedActiveFile({
        filename: 'self_destruct.txt',
        content: 'Destruct immediately after 1 download',
        maxDownloads: 1,
      });

      // Verify object exists in S3 prior to download
      expect(await checkObjectExists(s3Key)).toBe(true);

      const res = await request(app)
        .post(`/api/links/${token}/download`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.remainingDownloads).toBe(0);

      // Verify DB row status flipped to 'dead'
      const record = getFileByToken(token);
      expect(record?.status).toBe('dead');
      expect(record?.remaining_downloads).toBe(0);

      // Verify S3 object was deleted
      expect(await checkObjectExists(s3Key)).toBe(false);

      // Subsequent attempt must return 410 DOWNLOADS_EXHAUSTED
      const nextAttempt = await request(app)
        .post(`/api/links/${token}/download`)
        .send({});
      expect(nextAttempt.status).toBe(410);
      expect(nextAttempt.body.error.code).toBe('DOWNLOADS_EXHAUSTED');
    });
  });

  describe('Prompt B3 Core Requirement: 20 Concurrent Downloads at max_downloads=3', () => {
    it('fires 20 concurrent download requests at a link with max_downloads=3 and asserts EXACTLY 3 succeed', async () => {
      const { token, s3Key } = await seedActiveFile({
        filename: 'concurrency_target.txt',
        content: 'High-concurrency race condition testing',
        maxDownloads: 3,
      });

      // Confirm S3 object exists before race
      expect(await checkObjectExists(s3Key)).toBe(true);

      // Fire 20 requests concurrently in parallel
      const requests = Array.from({ length: 20 }, () =>
        request(app).post(`/api/links/${token}/download`).send({})
      );

      const responses = await Promise.all(requests);

      const successes = responses.filter((r) => r.status === 200);
      const exhausted = responses.filter((r) => r.status === 410);

      // Assert exactly 3 succeed with 200 OK
      expect(successes.length).toBe(3);

      // Assert remaining 17 fail with 410 Gone (DOWNLOADS_EXHAUSTED)
      expect(exhausted.length).toBe(17);
      exhausted.forEach((r) => {
        expect(r.body.error.code).toBe('DOWNLOADS_EXHAUSTED');
      });

      // Check DB row state
      const finalRecord = getFileByToken(token);
      expect(finalRecord?.remaining_downloads).toBe(0);
      expect(finalRecord?.status).toBe('dead');

      // Check that MinIO object was purged upon reaching 0
      expect(await checkObjectExists(s3Key)).toBe(false);
    });
  });
});

