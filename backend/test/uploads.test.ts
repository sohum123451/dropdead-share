import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { getDatabase } from '../src/db/sqlite';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, S3_BUCKET } from '../src/storage/s3';

describe('Upload Flow Integration Tests (Live MinIO)', () => {
  const app = createApp();

  beforeAll(() => {
    getDatabase();
  });

  describe('POST /api/uploads/init', () => {
    it('initializes upload session and returns pre-signed PUT URL', async () => {
      const res = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'test_document.pdf',
          fileSize: 1024,
          contentType: 'application/pdf',
          expiryValue: 2,
          expiryUnit: 'hours',
          maxDownloads: 5,
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('uploadId');
      expect(res.body.uploadId).toMatch(/^upl_[a-f0-9]{32}$/);
      expect(res.body).toHaveProperty('uploadUrl');
      expect(res.body.uploadUrl).toContain('http://localhost:9000/file-share/');
      expect(res.body.uploadMethod).toBe('PUT');
      expect(res.body.requiredHeaders).toEqual({ 'Content-Type': 'application/pdf' });
      expect(res.body).toHaveProperty('expiresAt');
    });

    it('rejects files larger than MAX_FILE_MB with 413 FILE_TOO_LARGE', async () => {
      const res = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'giant_movie.iso',
          fileSize: 2 * 1024 * 1024 * 1024, // 2 GB > 1024 MB
          contentType: 'application/octet-stream',
          expiryValue: 1,
          expiryUnit: 'days',
          maxDownloads: 1,
        });

      expect(res.status).toBe(413);
      expect(res.body.error).toEqual({
        code: 'FILE_TOO_LARGE',
        message: expect.stringContaining('exceeds maximum server limit'),
      });
    });

    it('rejects invalid parameters with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: '',
          fileSize: -5,
          contentType: 'invalid-mime',
          expiryValue: 0,
          expiryUnit: 'centuries',
          maxDownloads: 0,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Upload -> S3 Direct PUT -> POST /api/uploads/:id/finalize', () => {
    it('successfully uploads file directly to MinIO and finalizes active link', async () => {
      const content = Buffer.from('Integration test file content for self-destructing share.');
      const fileSize = content.byteLength;

      // 1. Init upload
      const initRes = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'contract.txt',
          fileSize: fileSize,
          contentType: 'text/plain',
          expiryValue: 30,
          expiryUnit: 'minutes',
          maxDownloads: 3,
          password: 'SecretPassword123!',
        });

      expect(initRes.status).toBe(201);
      const { uploadId, uploadUrl } = initRes.body;

      // 2. Direct upload to MinIO pre-signed PUT URL
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': fileSize.toString(),
        },
        body: content,
      });

      expect(putRes.status).toBe(200);

      // 3. Finalize upload
      const finalizeRes = await request(app)
        .post(`/api/uploads/${uploadId}/finalize`)
        .send({});

      expect(finalizeRes.status).toBe(201);
      expect(finalizeRes.body).toHaveProperty('token');
      expect(finalizeRes.body.token.length).toBeGreaterThanOrEqual(32);
      expect(finalizeRes.body.sharePath).toBe(`/d/${finalizeRes.body.token}`);
      expect(finalizeRes.body.maxDownloads).toBe(3);
      expect(finalizeRes.body.isPasswordProtected).toBe(true);
      expect(finalizeRes.body).toHaveProperty('expiresAt');
    });

    it('fails finalize if object was not uploaded to S3', async () => {
      // 1. Init upload but never upload the payload
      const initRes = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'missing.txt',
          fileSize: 50,
          contentType: 'text/plain',
          expiryValue: 1,
          expiryUnit: 'hours',
          maxDownloads: 1,
        });

      const { uploadId } = initRes.body;

      // 2. Finalize immediately
      const finalizeRes = await request(app)
        .post(`/api/uploads/${uploadId}/finalize`)
        .send({});

      expect(finalizeRes.status).toBe(400);
      expect(finalizeRes.body.error).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'S3 object does not exist in storage.',
      });
    });

    it('fails finalize if uploaded size does not match declared size', async () => {
      const declaredSize = 500;
      const actualContent = Buffer.from('Much shorter content'); // 20 bytes

      // 1. Init upload
      const initRes = await request(app)
        .post('/api/uploads/init')
        .send({
          filename: 'mismatch.txt',
          fileSize: declaredSize,
          contentType: 'text/plain',
          expiryValue: 1,
          expiryUnit: 'hours',
          maxDownloads: 1,
        });

      const { uploadId, uploadUrl } = initRes.body;

      // 2. Upload mismatched size
      // Note: Since ContentLength was bound into signature for 500, we write directly to S3 with PutObjectCommand to simulate size mismatch
      const db = getDatabase();
      const row = db.prepare('SELECT s3_key FROM files WHERE id = ?').get(uploadId) as { s3_key: string };
      await s3Client.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: row.s3_key,
          ContentType: 'text/plain',
          Body: actualContent,
        })
      );

      // 3. Finalize
      const finalizeRes = await request(app)
        .post(`/api/uploads/${uploadId}/finalize`)
        .send({});

      expect(finalizeRes.status).toBe(400);
      expect(finalizeRes.body.error.code).toBe('VALIDATION_ERROR');
      expect(finalizeRes.body.error.message).toContain('does not match declared size');
    });

    it('returns 404 UPLOAD_NOT_FOUND for non-existent session ID', async () => {
      const res = await request(app)
        .post('/api/uploads/upl_nonexistent12345/finalize')
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toEqual({
        code: 'UPLOAD_NOT_FOUND',
        message: 'The upload session ID was not found or has already been finalized.',
      });
    });

    it('rejects finalize for abandoned pending upload older than 1 hour', async () => {
      const db = getDatabase();
      const uploadId = 'upl_abandoned_test_12345';
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      db.prepare(`
        INSERT INTO files (
          id, token, s3_key, original_name, size_bytes, mime,
          password_hash, expires_at, max_downloads, remaining_downloads,
          status, created_at
        ) VALUES (
          ?, NULL, 'uploads/abandoned-key', 'abandoned.pdf', 100, 'application/pdf',
          NULL, ?, 1, 1, 'pending', ?
        )
      `).run(uploadId, twoHoursAgo, twoHoursAgo);

      const res = await request(app)
        .post(`/api/uploads/${uploadId}/finalize`)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toEqual({
        code: 'UPLOAD_NOT_FOUND',
        message: 'The upload session has expired without upload and was abandoned.',
      });

      // Assert status was transitioned to 'dead'
      const updated = db.prepare('SELECT status FROM files WHERE id = ?').get(uploadId) as { status: string };
      expect(updated.status).toBe('dead');
    });
  });
});

