import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import argon2 from 'argon2';
import { createApp } from '../src/app';
import { getDatabase, closeDatabase, getFileById } from '../src/db/sqlite';
import { env } from '../src/config/env';
import { s3Client, S3_BUCKET, deleteStorageObject } from '../src/storage/s3';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

describe('Uploads Integration Tests (against real MinIO)', () => {
  const app = createApp();
  const createdS3Keys: string[] = [];

  beforeAll(() => {
    getDatabase();
  });

  afterAll(async () => {
    // Cleanup any created S3 objects
    for (const key of createdS3Keys) {
      await deleteStorageObject(key).catch(() => {});
    }
    closeDatabase();
  });

  describe('POST /api/uploads/init', () => {
    it('initializes upload session with valid payload and binds ContentType and ContentLength into presigned PUT URL', async () => {
      const payload = {
        filename: 'confidential_report.pdf',
        fileSize: 2048,
        contentType: 'application/pdf',
        expiryValue: 24,
        expiryUnit: 'hours',
        maxDownloads: 5,
        password: 'SecurePassword123!',
      };

      const res = await request(app)
        .post('/api/uploads/init')
        .send(payload)
        .expect('Content-Type', /json/)
        .expect(201);

      expect(res.body).toHaveProperty('uploadId');
      expect(res.body.uploadId).toMatch(/^upl_[a-f0-9]+$/);
      expect(res.body).toHaveProperty('uploadUrl');
      expect(res.body.uploadUrl).toContain(env.S3_BUCKET);
      expect(res.body.uploadMethod).toBe('PUT');
      expect(res.body.requiredHeaders).toEqual({
        'Content-Type': 'application/pdf',
      });
      expect(res.body).toHaveProperty('expiresAt');

      // Verify row in database
      const row = getFileById(res.body.uploadId);
      expect(row).toBeDefined();
      expect(row!.status).toBe('pending');
      expect(row!.original_name).toBe('confidential_report.pdf');
      expect(row!.size_bytes).toBe(2048);
      expect(row!.mime).toBe('application/pdf');
      expect(row!.token).toBeNull();
      expect(row!.password_hash).toBeNull();
      expect(row!.pending_password).toBe('SecurePassword123!');
      expect(row!.max_downloads).toBe(5);
      expect(row!.remaining_downloads).toBe(5);

      // Verify S3 key is a valid random UUID and NEVER includes the filename
      expect(row!.s3_key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(row!.s3_key).not.toContain('confidential_report');
      expect(row!.s3_key).not.toContain('.pdf');

      createdS3Keys.push(row!.s3_key);

      // Verify presigned PUT URL signature includes content-type and content-length
      const signedHeadersMatch = res.body.uploadUrl.match(/X-Amz-SignedHeaders=([^&]+)/);
      expect(signedHeadersMatch).not.toBeNull();
      const signedHeaders = decodeURIComponent(signedHeadersMatch![1]).toLowerCase();
      expect(signedHeaders).toContain('content-type');
      expect(signedHeaders).toContain('content-length');

      // Test real upload to MinIO using the presigned URL
      const fileBytes = Buffer.alloc(2048, 'A');
      const putRes = await fetch(res.body.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': '2048',
        },
        body: fileBytes,
      });
      expect(putRes.status).toBe(200);

      // Confirm object exists in real MinIO storage
      const head = await s3Client.send(
        new HeadObjectCommand({ Bucket: S3_BUCKET, Key: row!.s3_key })
      );
      expect(head.ContentLength).toBe(2048);
      expect(head.ContentType).toBe('application/pdf');
    });

    it('rejects upload with 413 FILE_TOO_LARGE when fileSize exceeds MAX_FILE_MB from env', async () => {
      // MAX_FILE_MB is 1024, so 1025 MB exceeds the limit
      const oversizedBytes = (env.MAX_FILE_MB + 1) * 1024 * 1024;

      const res = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'huge_backup.iso',
          fileSize: oversizedBytes,
          contentType: 'application/octet-stream',
          expiryValue: 1,
          expiryUnit: 'days',
          maxDownloads: 1,
        })
        .expect(413);

      expect(res.body).toEqual({
        error: {
          code: 'FILE_TOO_LARGE',
          message: expect.stringContaining(`exceeds maximum server limit of ${env.MAX_FILE_MB} MB`),
        },
      });
    });

    it('clamps maxDownloads to sane maximum of 100', async () => {
      const res = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'clamped_downloads.zip',
          fileSize: 100,
          contentType: 'application/zip',
          expiryValue: 2,
          expiryUnit: 'hours',
          maxDownloads: 9999, // exceeds 100
        })
        .expect(201);

      const row = getFileById(res.body.uploadId);
      expect(row).toBeDefined();
      expect(row!.max_downloads).toBe(100);
      expect(row!.remaining_downloads).toBe(100);

      createdS3Keys.push(row!.s3_key);
    });

    it('clamps expiry duration to sane maximum of 30 days', async () => {
      const res = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'long_expiry.txt',
          fileSize: 50,
          contentType: 'text/plain',
          expiryValue: 365, // 1 year
          expiryUnit: 'days',
          maxDownloads: 1,
        })
        .expect(201);

      const row = getFileById(res.body.uploadId);
      expect(row).toBeDefined();

      const expiresAtMs = new Date(row!.expires_at).getTime();
      const maxAllowedExpiryMs = Date.now() + 30 * 24 * 3600 * 1000 + 5000;
      expect(expiresAtMs).toBeLessThanOrEqual(maxAllowedExpiryMs);

      createdS3Keys.push(row!.s3_key);
    });

    it('returns 400 VALIDATION_ERROR on missing or invalid fields', async () => {
      // Empty filename
      await request(app)
        .post('/api/uploads/init')
        .send({
          filename: '   ',
          fileSize: 100,
          contentType: 'text/plain',
          expiryValue: 1,
          expiryUnit: 'hours',
          maxDownloads: 1,
        })
        .expect(400)
        .expect((res) => {
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        });

      // Filename > 255 chars
      await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'a'.repeat(256),
          fileSize: 100,
          contentType: 'text/plain',
          expiryValue: 1,
          expiryUnit: 'hours',
          maxDownloads: 1,
        })
        .expect(400);

      // Invalid fileSize <= 0
      await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'file.txt',
          fileSize: 0,
          contentType: 'text/plain',
          expiryValue: 1,
          expiryUnit: 'hours',
          maxDownloads: 1,
        })
        .expect(400);

      // Invalid contentType
      await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'file.txt',
          fileSize: 100,
          contentType: 'not-a-valid-mime',
          expiryValue: 1,
          expiryUnit: 'hours',
          maxDownloads: 1,
        })
        .expect(400);

      // Invalid expiryUnit
      await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'file.txt',
          fileSize: 100,
          contentType: 'text/plain',
          expiryValue: 1,
          expiryUnit: 'centuries',
          maxDownloads: 1,
        })
        .expect(400);

      // Password too short (< 4 chars)
      await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'file.txt',
          fileSize: 100,
          contentType: 'text/plain',
          expiryValue: 1,
          expiryUnit: 'hours',
          maxDownloads: 1,
          password: 'abc',
        })
        .expect(400);
    });
  });

  describe('POST /api/uploads/:id/finalize', () => {
    it('successfully finalizes upload, confirms S3 object and size, hashes password with argon2, and returns share link', async () => {
      const fileSize = 512;
      const fileBytes = Buffer.alloc(fileSize, 'F');
      const plainPassword = 'CorrectHorseBatteryStaple!9';

      // 1. Initialize upload session
      const initRes = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'financials.pdf',
          fileSize,
          contentType: 'application/pdf',
          expiryValue: 12,
          expiryUnit: 'hours',
          maxDownloads: 3,
          password: plainPassword,
        })
        .expect(201);

      const { uploadId, uploadUrl } = initRes.body;
      const initialRow = getFileById(uploadId)!;
      createdS3Keys.push(initialRow.s3_key);

      // 2. Upload real payload to MinIO via pre-signed URL
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': String(fileSize),
        },
        body: fileBytes,
      });
      expect(putRes.status).toBe(200);

      // 3. Finalize upload
      const finalizeRes = await request(app)
        .post(`/api/uploads/${uploadId}/finalize`)
        .send({})
        .expect('Content-Type', /json/)
        .expect(201);

      expect(finalizeRes.body).toHaveProperty('token');
      const token = finalizeRes.body.token;

      // Token generated with crypto.randomBytes(24) base64url has 32 chars
      expect(token).toHaveLength(32);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

      expect(finalizeRes.body.sharePath).toBe(`/d/${token}`);
      expect(finalizeRes.body.shareUrl).toContain(`/d/${token}`);
      expect(finalizeRes.body.maxDownloads).toBe(3);
      expect(finalizeRes.body.isPasswordProtected).toBe(true);

      // 4. Verify DB updates
      const updatedRow = getFileById(uploadId)!;
      expect(updatedRow.status).toBe('active');
      expect(updatedRow.token).toBe(token);
      expect(updatedRow.pending_password).toBeNull();
      expect(updatedRow.password_hash).not.toBeNull();

      // Verify argon2 password hash
      const isPasswordValid = await argon2.verify(updatedRow.password_hash!, plainPassword);
      expect(isPasswordValid).toBe(true);
    });

    it('successfully finalizes upload without password (isPasswordProtected false)', async () => {
      const fileSize = 128;
      const fileBytes = Buffer.alloc(fileSize, 'Z');

      const initRes = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'public_note.txt',
          fileSize,
          contentType: 'text/plain',
          expiryValue: 1,
          expiryUnit: 'hours',
          maxDownloads: 10,
        })
        .expect(201);

      const { uploadId, uploadUrl } = initRes.body;
      const row = getFileById(uploadId)!;
      createdS3Keys.push(row.s3_key);

      // Upload bytes
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(fileSize),
        },
        body: fileBytes,
      });
      expect(putRes.status).toBe(200);

      const finalizeRes = await request(app)
        .post(`/api/uploads/${uploadId}/finalize`)
        .send({})
        .expect(201);

      expect(finalizeRes.body.isPasswordProtected).toBe(false);

      const updatedRow = getFileById(uploadId)!;
      expect(updatedRow.status).toBe('active');
      expect(updatedRow.password_hash).toBeNull();
    });

    it('fails with 400 VALIDATION_ERROR if object was never uploaded to S3', async () => {
      const initRes = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'never_uploaded.png',
          fileSize: 500,
          contentType: 'image/png',
          expiryValue: 1,
          expiryUnit: 'hours',
          maxDownloads: 1,
        })
        .expect(201);

      const { uploadId } = initRes.body;

      // Call finalize without performing S3 PUT
      const finalizeRes = await request(app)
        .post(`/api/uploads/${uploadId}/finalize`)
        .send({})
        .expect(400);

      expect(finalizeRes.body.error.code).toBe('VALIDATION_ERROR');
      expect(finalizeRes.body.error.message).toContain('does not exist');

      // Status must remain pending
      const row = getFileById(uploadId)!;
      expect(row.status).toBe('pending');
    });

    it('fails with 400 VALIDATION_ERROR if uploaded size does not match declared size', async () => {
      const declaredSize = 1000;
      const actualSize = 400; // mismatch!

      const initRes = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'size_mismatch.dat',
          fileSize: declaredSize,
          contentType: 'application/octet-stream',
          expiryValue: 1,
          expiryUnit: 'hours',
          maxDownloads: 1,
        })
        .expect(201);

      const { uploadId } = initRes.body;
      const row = getFileById(uploadId)!;
      createdS3Keys.push(row.s3_key);

      // Directly put a mismatched object into S3 using s3Client
      await s3Client.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: row.s3_key,
          ContentType: 'application/octet-stream',
          Body: Buffer.alloc(actualSize, 'X'),
        })
      );

      // Finalize should fail because actual size in S3 (400) != declared size (1000)
      const finalizeRes = await request(app)
        .post(`/api/uploads/${uploadId}/finalize`)
        .send({})
        .expect(400);

      expect(finalizeRes.body.error.code).toBe('VALIDATION_ERROR');
      expect(finalizeRes.body.error.message).toContain('does not match declared size');

      const updatedRow = getFileById(uploadId)!;
      expect(updatedRow.status).toBe('pending');
    });

    it('returns 404 UPLOAD_NOT_FOUND if session ID does not exist', async () => {
      const nonExistentId = 'upl_0000000000000000000000';
      const res = await request(app)
        .post(`/api/uploads/${nonExistentId}/finalize`)
        .send({})
        .expect(404);

      expect(res.body.error.code).toBe('UPLOAD_NOT_FOUND');
    });

    it('returns 404 UPLOAD_NOT_FOUND when attempting to finalize an already active upload', async () => {
      const fileSize = 64;
      const initRes = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'double_finalize.txt',
          fileSize,
          contentType: 'text/plain',
          expiryValue: 1,
          expiryUnit: 'hours',
          maxDownloads: 1,
        })
        .expect(201);

      const { uploadId, uploadUrl } = initRes.body;
      const row = getFileById(uploadId)!;
      createdS3Keys.push(row.s3_key);

      await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain', 'Content-Length': String(fileSize) },
        body: Buffer.alloc(fileSize, 'D'),
      });

      // First finalize succeeds
      await request(app).post(`/api/uploads/${uploadId}/finalize`).send({}).expect(201);

      // Second finalize should fail with 404 UPLOAD_NOT_FOUND
      const secondRes = await request(app)
        .post(`/api/uploads/${uploadId}/finalize`)
        .send({})
        .expect(404);

      expect(secondRes.body.error.code).toBe('UPLOAD_NOT_FOUND');
    });

    it('treats pending rows older than 1 hour as abandoned (marks dead and returns 404 UPLOAD_NOT_FOUND)', async () => {
      const db = getDatabase();
      const abandonedId = `upl_${crypto.randomUUID().replace(/-/g, '')}`;
      const abandonedKey = crypto.randomUUID();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      // Insert an abandoned pending row created 2 hours ago
      db.prepare(`
        INSERT INTO files (
          id, token, s3_key, original_name, size_bytes, mime,
          password_hash, pending_password, expires_at,
          max_downloads, remaining_downloads, status, created_at
        ) VALUES (
          ?, NULL, ?, 'abandoned.pdf', 100, 'application/pdf',
          NULL, NULL, ?, 1, 1, 'pending', ?
        )
      `).run(abandonedId, abandonedKey, futureExpiry, twoHoursAgo);

      // Attempting to finalize an abandoned upload should fail
      const res = await request(app)
        .post(`/api/uploads/${abandonedId}/finalize`)
        .send({})
        .expect(404);

      expect(res.body.error.code).toBe('UPLOAD_NOT_FOUND');

      // Verify the row status has been flipped to 'dead'
      const row = getFileById(abandonedId)!;
      expect(row.status).toBe('dead');
    });
  });
});
