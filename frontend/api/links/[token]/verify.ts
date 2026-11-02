import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRecordByToken } from '../../_lib/db.js';
import { verifyPasswordHash, createDownloadGrantToken } from '../../_lib/auth.js';
import { checkRateLimit } from '../../_lib/rate-limiter.js';
import { deleteBlob } from '../../_lib/storage.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: { code: 'VALIDATION_ERROR', message: 'Method not allowed' },
    });
  }

  const { token } = req.query;
  const linkToken = Array.isArray(token) ? token[0] : token;

  if (!linkToken) {
    return res.status(404).json({
      error: { code: 'LINK_NOT_FOUND', message: 'Share link not found.' },
    });
  }

  // Rate Limiting by IP and Token
  const clientIp =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'anonymous';
  const rateLimitKey = `${clientIp}:${linkToken}`;
  const rate = checkRateLimit(rateLimitKey, 5, 900);

  res.setHeader('RateLimit-Remaining', String(rate.attemptsLeft));
  res.setHeader('RateLimit-Reset', String(rate.retryAfterSeconds));

  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    return res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many incorrect attempts. Please try again later.',
        retryAfterSeconds: rate.retryAfterSeconds,
      },
    });
  }

  try {
    const record = await getRecordByToken(linkToken);

    if (!record || record.status === 'pending') {
      return res.status(404).json({
        error: { code: 'LINK_NOT_FOUND', message: 'Share link not found.' },
      });
    }

    if (new Date() >= new Date(record.expiresAt)) {
      await deleteBlob(record.blobUrl);
      return res.status(410).json({
        error: { code: 'LINK_EXPIRED', message: 'This link has expired.' },
      });
    }

    if (record.remainingDownloads <= 0 || record.status === 'dead') {
      await deleteBlob(record.blobUrl);
      return res.status(410).json({
        error: { code: 'DOWNLOADS_EXHAUSTED', message: 'Download quota for this link is exhausted.' },
      });
    }

    if (!record.passwordHash) {
      // No password required; issue token directly
      const grantToken = createDownloadGrantToken(linkToken, 300);
      return res.status(200).json({
        verified: true,
        downloadGrantToken: grantToken,
        expiresIn: 300,
      });
    }

    const { password } = req.body || {};
    if (!password || typeof password !== 'string') {
      return res.status(401).json({
        error: {
          code: 'WRONG_PASSWORD',
          message: 'Incorrect password.',
          attemptsLeft: rate.attemptsLeft,
        },
      });
    }

    const isValid = await verifyPasswordHash(password, record.passwordHash);
    if (!isValid) {
      return res.status(401).json({
        error: {
          code: 'WRONG_PASSWORD',
          message: 'Incorrect password.',
          attemptsLeft: rate.attemptsLeft,
        },
      });
    }

    const downloadGrantToken = createDownloadGrantToken(linkToken, 300);
    return res.status(200).json({
      verified: true,
      downloadGrantToken,
      expiresIn: 300,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Verification failed.';
    return res.status(500).json({
      error: { code: 'UNKNOWN_ERROR', message: msg },
    });
  }
}

