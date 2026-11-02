import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import argon2 from 'argon2';
import { z } from 'zod';
import { env } from '../config/env';
import { AppError } from '../errors/app-error';
import { createPresignedUploadUrl, getObjectMetadata, deleteStorageObject } from '../storage/s3';
import {
  createPendingFile,
  getFileById,
  finalizePendingFile,
  markFileAbandoned,
} from '../db/sqlite';

export const uploadsRouter = Router();

const initUploadSchema = z
  .object({
    filename: z
      .string({ required_error: 'filename is required' })
      .trim()
      .min(1, 'filename cannot be empty')
      .max(255, 'filename must be at most 255 characters'),
    fileSize: z.coerce
      .number()
      .int('fileSize must be an integer')
      .positive('fileSize must be greater than 0')
      .optional(),
    size: z.coerce
      .number()
      .int('size must be an integer')
      .positive('size must be greater than 0')
      .optional(),
    contentType: z
      .string({ required_error: 'contentType is required' })
      .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/, 'Invalid MIME type for contentType'),
    expiryValue: z.coerce
      .number({ required_error: 'expiryValue is required' })
      .int('expiryValue must be an integer')
      .min(1, 'expiryValue must be at least 1'),
    expiryUnit: z.enum(['minutes', 'hours', 'days'], {
      errorMap: () => ({ message: 'expiryUnit must be one of: minutes, hours, days' }),
    }),
    maxDownloads: z.coerce
      .number({ required_error: 'maxDownloads is required' })
      .int('maxDownloads must be an integer')
      .min(1, 'maxDownloads must be at least 1'),
    password: z
      .string()
      .min(4, 'password must be between 4 and 128 characters')
      .max(128, 'password must be between 4 and 128 characters')
      .optional()
      .nullable(),
  })
  .refine((data) => data.fileSize !== undefined || data.size !== undefined, {
    message: 'fileSize is required',
    path: ['fileSize'],
  });

/**
 * POST /api/uploads/init
 * Initializes an upload session, creates a pending row, and returns a pre-signed PUT URL.
 */
uploadsRouter.post('/api/uploads/init', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = initUploadSchema.parse(req.body);
    const size = validated.fileSize ?? validated.size!;

    // Enforce MAX_FILE_MB from environment
    const maxBytes = env.MAX_FILE_MB * 1024 * 1024;
    if (size > maxBytes) {
      throw AppError.fileTooLarge(
        `Declared file size (${size} bytes) exceeds maximum server limit of ${env.MAX_FILE_MB} MB.`
      );
    }

    // Clamp download limits (sane maximum: 100)
    const clampedMaxDownloads = Math.min(Math.max(1, validated.maxDownloads), 100);

    // Calculate expiry duration and clamp to sane maximum (sane maximum: 30 days = 2,592,000s)
    let durationSeconds = 0;
    if (validated.expiryUnit === 'minutes') {
      durationSeconds = validated.expiryValue * 60;
    } else if (validated.expiryUnit === 'hours') {
      durationSeconds = validated.expiryValue * 3600;
    } else if (validated.expiryUnit === 'days') {
      durationSeconds = validated.expiryValue * 86400;
    }

    const MAX_EXPIRY_SECONDS = 30 * 24 * 3600; // 30 days sane maximum
    const MIN_EXPIRY_SECONDS = 60; // 1 minute sane minimum
    const clampedDurationSeconds = Math.min(
      Math.max(MIN_EXPIRY_SECONDS, durationSeconds),
      MAX_EXPIRY_SECONDS
    );

    const expiresAt = new Date(Date.now() + clampedDurationSeconds * 1000).toISOString();

    // Generate random UUID for S3 key - NEVER use user's filename in the key
    const s3Key = crypto.randomUUID();

    // Generate upload session ID
    const uploadId = `upl_${crypto.randomUUID().replace(/-/g, '')}`;

    // Create pre-signed PUT URL valid for 10 minutes (600 seconds) with ContentType and ContentLength bound
    const uploadUrl = await createPresignedUploadUrl(
      s3Key,
      validated.contentType,
      size,
      600
    );

    // Create 'pending' database row
    createPendingFile({
      id: uploadId,
      s3Key,
      originalName: validated.filename,
      sizeBytes: size,
      mime: validated.contentType,
      pendingPassword: validated.password ?? null,
      expiresAt,
      maxDownloads: clampedMaxDownloads,
    });

    res.status(201).json({
      uploadId,
      uploadUrl,
      uploadMethod: 'PUT',
      requiredHeaders: {
        'Content-Type': validated.contentType,
      },
      expiresAt,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/uploads/:id/finalize
 * Confirms S3 object existence and size, hashes password with argon2 if provided,
 * flips status to active, generates 24-byte base64url token, and returns share link.
 */
uploadsRouter.post(
  '/api/uploads/:id/finalize',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const file = getFileById(id);

      if (!file || file.status !== 'pending') {
        throw AppError.uploadNotFound(
          'The upload session ID was not found or has already been finalized.'
        );
      }

      // Abandonment check: pending rows not finalized within 1 hour must be treated as abandoned
      const createdAtMs = new Date(file.created_at).getTime();
      const ONE_HOUR_MS = 60 * 60 * 1000;
      if (Date.now() - createdAtMs > ONE_HOUR_MS) {
        markFileAbandoned(file.id);
        await deleteStorageObject(file.s3_key).catch(() => {});
        throw AppError.uploadNotFound(
          'The upload session has expired without upload and was abandoned.'
        );
      }

      // HEAD the object in S3, confirm existence and size matches declared size
      const metadata = await getObjectMetadata(file.s3_key);
      if (!metadata.exists) {
        throw AppError.validationError('S3 object does not exist in storage.');
      }

      if (metadata.size !== file.size_bytes) {
        throw AppError.validationError(
          `Uploaded object size (${metadata.size} bytes) does not match declared size (${file.size_bytes} bytes).`
        );
      }

      // Hash password with argon2 if provided
      const rawPassword = file.pending_password || req.body?.password;
      let passwordHash: string | null = null;
      if (rawPassword) {
        passwordHash = await argon2.hash(rawPassword);
      }

      // Generate token with crypto.randomBytes(24) base64url
      const token = crypto.randomBytes(24).toString('base64url');

      // Flip status to active in database
      const updated = finalizePendingFile(file.id, token, passwordHash);
      if (!updated) {
        throw AppError.uploadNotFound(
          'The upload session ID was not found or has already been finalized.'
        );
      }

      const baseUrl = env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      const sharePath = `/d/${token}`;
      const shareUrl = `${baseUrl}${sharePath}`;

      res.status(201).json({
        token,
        sharePath,
        shareUrl,
        expiresAt: updated.expires_at,
        maxDownloads: updated.max_downloads,
        isPasswordProtected: Boolean(passwordHash),
      });
    } catch (err) {
      next(err);
    }
  }
);
