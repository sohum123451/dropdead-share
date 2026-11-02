import { Router, Request, Response, NextFunction } from 'express';
import argon2 from 'argon2';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import {
  getFileByToken,
  markFileDead,
  atomicDecrementDownloads,
} from '../db/sqlite';
import { createPresignedDownloadUrl, deleteStorageObject } from '../storage/s3';
import {
  createDownloadGrantToken,
  verifyDownloadGrantToken,
} from '../utils/grant-token';

export const linksRouter = Router();

// Rate limiter for /api/links/:token/verify:
// 5 failed attempts per 15 minutes per IP + token
const verifyRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${req.ip}_${req.params.token}`,
  validate: { ip: false, keyGeneratorIpFallback: false },
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(
      AppError.rateLimited(
        'Too many incorrect password attempts. Please try again in 15 minutes.'
      )
    );
  },
});

/**
 * GET /api/links/:token/info
 * Retrieves metadata only. Lazy-enforces expiry on every request.
 */
linksRouter.get(
  '/api/links/:token/info',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.params;
      const file = getFileByToken(token);

      if (!file) {
        throw AppError.linkNotFound();
      }

      const now = new Date().toISOString();

      // Lazy check: expired past validity window
      if (now > file.expires_at) {
        if (file.status !== 'dead') {
          markFileDead(file.id);
          deleteStorageObject(file.s3_key).catch(() => {});
        }
        throw AppError.linkExpired();
      }

      // Lazy check: downloads exhausted or marked dead
      if (file.status === 'dead' || file.remaining_downloads <= 0) {
        if (file.status !== 'dead') {
          markFileDead(file.id);
          deleteStorageObject(file.s3_key).catch(() => {});
        }
        throw AppError.downloadsExhausted();
      }

      if (file.status !== 'active') {
        throw AppError.linkNotFound();
      }

      // Revealed metadata only: filename, size, expiresAt, remaining, passwordRequired
      res.status(200).json({
        filename: file.original_name,
        fileSize: file.size_bytes,
        contentType: file.mime,
        isPasswordProtected: Boolean(file.password_hash),
        expiresAt: file.expires_at,
        remainingDownloads: file.remaining_downloads,
      });
    } catch (err) {
      next(err);
    }
  }
);

const verifyPasswordSchema = z.object({
  password: z.string({ required_error: 'password is required' }).min(1, 'password cannot be empty'),
});

/**
 * POST /api/links/:token/verify
 * Verifies the password against argon2 and returns a short-lived download grant token (5 min).
 */
linksRouter.post(
  '/api/links/:token/verify',
  verifyRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.params;
      const validated = verifyPasswordSchema.parse(req.body);

      const file = getFileByToken(token);
      if (!file) {
        throw AppError.linkNotFound();
      }

      const now = new Date().toISOString();

      if (now > file.expires_at) {
        if (file.status !== 'dead') {
          markFileDead(file.id);
          deleteStorageObject(file.s3_key).catch(() => {});
        }
        throw AppError.linkExpired();
      }

      if (file.status === 'dead' || file.remaining_downloads <= 0) {
        if (file.status !== 'dead') {
          markFileDead(file.id);
          deleteStorageObject(file.s3_key).catch(() => {});
        }
        throw AppError.downloadsExhausted();
      }

      if (file.status !== 'active') {
        throw AppError.linkNotFound();
      }

      if (!file.password_hash) {
        // Link does not require a password
        const grantToken = createDownloadGrantToken(token, 300);
        res.status(200).json({
          verified: true,
          downloadGrantToken: grantToken,
          expiresIn: 300,
        });
        return;
      }

      // Verify Argon2 password hash
      const isValid = await argon2.verify(file.password_hash, validated.password);
      if (!isValid) {
        throw AppError.wrongPassword();
      }

      const downloadGrantToken = createDownloadGrantToken(token, 300);
      res.status(200).json({
        verified: true,
        downloadGrantToken,
        expiresIn: 300,
      });
    } catch (err) {
      next(err);
    }
  }
);

const downloadSchema = z.object({
  password: z.string().optional(),
  downloadGrantToken: z.string().optional(),
});

/**
 * POST /api/links/:token/download
 * Atomically decrements remaining downloads and returns a 60-second pre-signed GET URL.
 */
linksRouter.post(
  '/api/links/:token/download',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.params;
      const body = downloadSchema.parse(req.body ?? {});

      const file = getFileByToken(token);
      if (!file) {
        throw AppError.linkNotFound();
      }

      const now = new Date().toISOString();

      if (now > file.expires_at) {
        if (file.status !== 'dead') {
          markFileDead(file.id);
          deleteStorageObject(file.s3_key).catch(() => {});
        }
        throw AppError.linkExpired();
      }

      if (file.status === 'dead' || file.remaining_downloads <= 0) {
        if (file.status !== 'dead') {
          markFileDead(file.id);
          deleteStorageObject(file.s3_key).catch(() => {});
        }
        throw AppError.downloadsExhausted();
      }

      if (file.status !== 'active') {
        throw AppError.linkNotFound();
      }

      // Password verification if file is password protected
      if (file.password_hash) {
        const { password, downloadGrantToken } = body;

        if (!password && !downloadGrantToken) {
          throw AppError.passwordRequired();
        }

        if (downloadGrantToken) {
          const isValidGrant = verifyDownloadGrantToken(downloadGrantToken, token);
          if (!isValidGrant) {
            throw AppError.wrongPassword('Invalid or expired download grant token.');
          }
        } else if (password) {
          const isValidPass = await argon2.verify(file.password_hash, password);
          if (!isValidPass) {
            throw AppError.wrongPassword();
          }
        }
      }

      // Atomic and race-safe download count decrement
      const result = atomicDecrementDownloads(token, now);
      if (!result.success) {
        if (result.reason === 'EXPIRED') {
          deleteStorageObject(file.s3_key).catch(() => {});
          throw AppError.linkExpired();
        }
        if (result.reason === 'EXHAUSTED') {
          deleteStorageObject(file.s3_key).catch(() => {});
          throw AppError.downloadsExhausted();
        }
        throw AppError.linkNotFound();
      }

      const updatedFile = result.file!;

      // Schedule S3 object deletion after the pre-signed GET URL validity window (65s)
      // so the recipient can complete downloading the bytes, while the status in DB
      // is already flipped to 'dead' to block any subsequent requests.
      if (updatedFile.remaining_downloads === 0) {
        setTimeout(() => {
          deleteStorageObject(updatedFile.s3_key).catch(() => {});
        }, 65 * 1000).unref();
      }

      // Generate pre-signed GET URL valid for 60s
      const downloadUrl = await createPresignedDownloadUrl(
        updatedFile.s3_key,
        updatedFile.original_name,
        60
      );

      res.status(200).json({
        downloadUrl,
        expiresIn: 60,
        remainingDownloads: updatedFile.remaining_downloads,
      });
    } catch (err) {
      next(err);
    }
  }
);
